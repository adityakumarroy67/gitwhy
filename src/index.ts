#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseTarget } from "./parse.ts";

const USAGE = `Usage: gitwhy <file>:<line> [--dry-run]
       gitwhy <file>:<start>-<end> [--dry-run]

Explains why lines of code exist, using their git history.

Options:
  --dry-run   print what would be sent to Claude, and stop
  -h, --help  show this help`;

const CONTEXT_LINES = 15; // lines of code shown above and below the target
const MAX_COMMITS = 10; // how far back the history goes

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

// 1. Read the arguments. Unknown flags are errors, so a typo like --dryrun can't spend money.
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

// 6. One prompt with everything Claude needs.
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

// Milestone 3 goes here: send the prompt to Claude.
fail("Calling Claude isn't built yet. Use --dry-run.");
