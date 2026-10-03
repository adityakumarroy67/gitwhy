#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseTarget } from "./parse.ts";

const USAGE = `Usage: gitwhy <file>:<line> [--dry-run]
       gitwhy <file>:<start>-<end> [--dry-run]

Explains why lines of code exist, using their git history.

Options:
  --dry-run   print what would be sent to Gemini, and stop
  -h, --help  show this help

Needs a free Gemini API key in GEMINI_API_KEY: https://aistudio.google.com/apikey`;

const CONTEXT_LINES = 15; // lines of code shown above and below the target
const MAX_COMMITS = 10; // how far back the history goes
const MODEL = "gemini-3.8-flash";
const SYSTEM = `You explain why code exists, using its git history.
Start with a one-sentence answer. Then give a short timeline of the changes that matter:
short commit SHA, author, date, and what changed and why.
Only use what the history and code show. If the history doesn't explain the reason, say so plainly instead of guessing.
Write plain text for a terminal: no markdown headings or bold.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Argument array, never a shell string, so a file name can't inject shell commands.
function git(...args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: any) {
    if (err.code === "ENOENT") fail("gitwhy needs git. Install it from https://git-scm.com");
    fail(err.stderr?.toString().trim() || err.message);
  }
}

// 1. Read the arguments. Unknown flags are errors, so a typo like --dryrun can't send code by accident.
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
} catch (err: any) {
  fail(`${err.message}\n\n${USAGE}`);
}
if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.positionals.length !== 1) fail(USAGE);

let target;
try {
  target = parseTarget(args.positionals[0]);
} catch (err: any) {
  fail(err.message);
}
const { file, start, end } = target;

// 2. Who last touched these lines. Runs first because it also catches
// "not a git repository", "never committed" and "line past end of file".
const blame = git("blame", "-L", `${start},${end}`, "--", file);

// 3. git blame reads the file on disk, but git log -L reads the last commit.
// If they differ, "line 42" means different lines to each, so refuse.
if (spawnSync("git", ["diff", "--quiet", "HEAD", "--", file]).status === 1) {
  fail(`${file} has uncommitted changes, so its line numbers won't match its history. Commit or stash first.`);
}

// 4. Every past change to these lines, with the diffs.
const history = git(
  "log",
  `-L${start},${end}:${file}`,
  "-n",
  String(MAX_COMMITS),
  "--format=commit %h%nAuthor: %an%nDate: %as%n%n%B",
);

// 5. The code around the target, with the target lines marked ">".
const lines = readFileSync(file, "utf8").split(/\r?\n/);
if (lines.at(-1) === "") lines.pop(); // the file's final newline isn't a line
const from = Math.max(1, start - CONTEXT_LINES);
const to = Math.min(lines.length, end + CONTEXT_LINES);
const code = lines
  .slice(from - 1, to)
  .map((text, i) => {
    const n = from + i;
    const mark = n >= start && n <= end ? ">" : " ";
    return `${mark} ${String(n).padStart(4)} | ${text}`;
  })
  .join("\n");

// 6. One prompt with everything Gemini needs.
const prompt = `Why do the lines marked ">" in ${file} (lines ${start}-${end}) exist?

<code>
${code}
</code>

<git_blame>
${blame.trimEnd()}
</git_blame>

<git_log>
${history.trimEnd()}
</git_log>`;

if (args.values["dry-run"]) {
  console.log(prompt);
  process.exit(0);
}

// 7. Ask Gemini, and print the answer as it's written.
const key = process.env.GEMINI_API_KEY;
if (!key) fail("Set GEMINI_API_KEY first. Get a free key at https://aistudio.google.com/apikey");

process.stderr.write("Reading the history...\n");
let res;
try {
  res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
    method: "POST",
    // The key goes in a header, not the URL, so it can't leak into logs or error messages.
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    }),
  });
} catch {
  fail("Couldn't reach Gemini. Check your internet connection.");
}
if (!res.ok) {
  const body = await res.json().catch(() => null);
  fail(`Gemini error (${res.status}): ${body?.error?.message ?? res.statusText}`);
}

// The answer arrives as server-sent events: lines like `data: {...json...}`.
let buffer = "";
let finish = "";
for await (const text of res.body!.pipeThrough(new TextDecoderStream())) {
  buffer += text;
  const eventLines = buffer.split("\n");
  buffer = eventLines.pop()!; // the last piece may be cut off mid-line, so keep it for the next round
  for (const line of eventLines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) process.stdout.write(part.text ?? "");
    finish = candidate?.finishReason ?? event.promptFeedback?.blockReason ?? finish;
  }
}
process.stdout.write("\n");
if (finish !== "STOP") fail(`Gemini stopped early (${finish || "no reason given"}).`);
