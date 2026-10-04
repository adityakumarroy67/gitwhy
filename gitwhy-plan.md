# gitwhy: project plan

> Ask why a line of code exists. gitwhy reads the line's git history and explains it in plain English.

**Progress:** v1 PUBLISHED as **`gitwhy-ai@0.1.0`** on npm (2026-10-04); the command is `gitwhy`. Name `gitwhy` was blocked (`git-why` exists, a paid-Claude tool with 3 deps). npm 11.16 `npx` refuses packages younger than 7 days, so plain `npx gitwhy-ai` works from ~2026-10-11 (before that: `npx --min-release-age=0 gitwhy-ai`). v0.1.1 published with GitHub links; repo: https://github.com/adityakumarroy67/gitwhy. demo.gif recorded and in README. NEXT: step 4 = LinkedIn post (npm README picks up the GIF on the next publish). Also: rotate the Gemini key (it was pasted in a chat).
**Changed from the original plan:** uses Google's **free Gemini API** instead of paid Claude, so it costs nothing for you or your users. Zero dependencies (Node's built-in `fetch`).

```
$ gitwhy src/auth.ts:42

This line adds a 5-second buffer before token refresh to stop a double-refresh race condition.

- a3f9c1 (Priya, Mar 2025): added the refresh check after users got logged out randomly
- b72e0d (Sam, Jun 2025): added the 5s buffer when the bug came back on slow mobile networks
```

---

## 1. The problem

Every developer hits code that looks pointless or weird and wonders whether it's safe to delete. The answer usually sits in the git history (commit messages and the diffs around them), but digging through `git blame` and `git log` by hand is slow, so nobody does it.

## 2. What gitwhy does

One command, `gitwhy <file>:<line>` or `gitwhy <file>:<start>-<end>`, does the following:

| Step | What happens | Tool used |
|---|---|---|
| 1 | Find who last changed those lines | `git blame -L` |
| 2 | Get every past change to those exact lines, with commit messages | `git log -L` |
| 3 | Read the surrounding code (±15 lines) | Node `fs` |
| 4 | Send all of it to Gemini and stream the explanation to the terminal | Node `fetch` |

## 3. Tech stack

- **Node.js and TypeScript.** You publish to npm, so anyone can run `npx gitwhy file:line` with no install.
  - To **develop** it you need Node **22.18+**, which runs `.ts` test files directly. Node 24 is ideal.
  - The **published** CLI runs on Node 20+.
- **Google Gemini API** (model `gemini-3.5-flash-lite`: ~3 s per answer. `gemini-3.8-flash` was smarter but often overloaded on the free tier: 503 errors and 24–40 s answers in Oct 2026 testing), called with Node's built-in `fetch`. No SDK.
- **Git** must be installed. That's the only system requirement.
- Zero dependencies. Argument parsing (`parseArgs`), git calls and HTTP all use Node's built-in modules.

**What it costs to run:** nothing. Each user makes their own free key at https://aistudio.google.com/apikey (Google account, no credit card). The free tier is rate-limited (around 10 requests a minute, hundreds a day as of Sep 2026). Downside: on the free tier Google may use what's sent to improve its products, so the README must say so. Each run sends ~2–15 KB.

**Why not the others (checked Oct 2026):** Claude API costs money. Ollama is free but needs a ~3.5 GB download, too heavy for users. Groq's free tier allows only 6,000 tokens a minute, too small. GitHub Models shut down in July 2026.

## 4. Folder structure

```
gitwhy/
├─ src/
│  ├─ index.ts        # the CLI: parse arg → run git → ask Gemini → print
│  ├─ parse.ts        # turns "src/a.ts:10-20" into { file, start, end }
│  └─ parse.test.ts   # tiny test for the parser
├─ package.json
├─ tsconfig.json
├─ .gitignore
├─ LICENSE
└─ README.md
```

## 5. Build order (milestones)

Build it in this order so each step can be checked before the next one. Don't spend API money until the git part works.

1. **Milestone 1: the parser.** `parse.ts` plus its test passes (`npm test`).
2. **Milestone 2: the git part, no AI yet.** `gitwhy file:line --dry-run` prints the exact text that *would* be sent to Gemini. Check it on a real repo. Keep this flag afterwards, since it's useful for debugging and lets users see what leaves their machine.
3. **Milestone 3: Gemini.** Send that text to Gemini and stream the answer.
4. **Milestone 4: polish.** Friendly errors, README, GIF, publish.

---

## 6. Build it step by step

### Step 1: Set up the project

```bash
mkdir gitwhy && cd gitwhy
git init
npm init -y
npm install -D typescript @types/node
```

Create `.gitignore`:

```
node_modules
dist
```

Create a `LICENSE` file with the MIT license text. GitHub can generate it: Add file → Create new file → name it `LICENSE` → "Choose a license template".

### Step 2: `package.json`

Replace the generated file with this. The important parts are `bin`, which makes `gitwhy` a command, and `"type": "module"`. Without `"type": "module"`, the build fails.

```json
{
  "name": "gitwhy",
  "version": "0.1.0",
  "description": "Ask why a line of code exists. Reads its git history and explains it in plain English.",
  "type": "module",
  "bin": { "gitwhy": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "node --test",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["git", "blame", "cli", "ai", "gemini"],
  "engines": { "node": ">=20" },
  "license": "MIT"
}
```

Keep the `dependencies` and `devDependencies` blocks that `npm install` added.

### Step 3: `tsconfig.json`

Tested with TypeScript 7.0. You can import files as `./parse.ts`, and the build rewrites the imports to `./parse.js`. TypeScript 7 no longer loads Node's types by default, so `"types": ["node"]` is required.

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

### Step 4: `src/parse.ts` (argument parser)

```ts
// "src/a.ts:42" or "src/a.ts:10-20". Greedy (.+) keeps Windows drive colons in the path.
export function parseTarget(arg: string) {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(arg);
  if (!m) throw new Error(`Expected <file>:<line> or <file>:<start>-<end>, got "${arg}"`);
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (start < 1 || end < start) throw new Error(`Invalid line range in "${arg}"`);
  return { file: m[1], start, end };
}
```

### Step 5: `src/parse.test.ts`

Run it with `npm test`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarget } from "./parse.ts";

test("parseTarget", () => {
  assert.deepEqual(parseTarget("src/a.ts:42"), { file: "src/a.ts", start: 42, end: 42 });
  assert.deepEqual(parseTarget("src/a.ts:10-20"), { file: "src/a.ts", start: 10, end: 20 });
  assert.deepEqual(parseTarget("C:\\x\\a.ts:7"), { file: "C:\\x\\a.ts", start: 7, end: 7 });
  assert.throws(() => parseTarget("src/a.ts"));
  assert.throws(() => parseTarget("src/a.ts:0"));
  assert.throws(() => parseTarget("src/a.ts:20-10"));
});
```

### Step 6: `src/index.ts` (the CLI)

What it needs to do, in order:

1. **Read the arguments.**
   - Print usage if the target is missing or `--help` is given.
   - Support `--dry-run`.
   - Run the target through `parseTarget`. If it throws, print the message and exit.
2. **Run `git blame -L <start>,<end> -- <file>` first.** Besides finding who last changed the lines, it catches "not a git repository", "never committed" and "line past end of file" with clear git errors. (If the dirty check runs first, outside a repo it wrongly says "uncommitted changes".)
3. **Refuse files with uncommitted changes** (see the warning below).
4. **Get the history:** `git log -L<start>,<end>:<file> -n 10 --format=...` (the 10 most recent changes; pick a format that includes the SHA, author, date and full message).
5. **Read the code around the lines.** Mark the target lines with `>` so Gemini knows which ones you mean.
6. **Build one prompt** from the file name, the code, the blame output and the history. With `--dry-run`, print it and stop.
7. **Call Gemini with streaming,** so text appears as it's written.
7. **Handle errors clearly.** See the table below.

#### ⚠️ Gotcha: uncommitted changes break the line numbers (verified)

`git blame` reads the file **as it is on disk**, but `git log -L` reads it **as of the last commit**. If you've added a line at the top without committing, "line 42" means different lines to the two commands. gitwhy would then **confidently explain the wrong line**. For v1, detect this and refuse:

```ts
import { spawnSync } from "node:child_process";

// exit status 1 = the file differs from the last commit
const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--", file]).status === 1;
if (dirty) {
  console.error(`${file} has uncommitted changes, so line numbers won't match its history. Commit or stash first.`);
  process.exit(1);
}
```

Handling this properly is a v2 feature (see section 8), and a good story for interviews.

#### Running git safely

Use `execFileSync` with an **argument array**, never `exec` with a string, so a file name can't inject shell commands. If git fails, show git's own error message, which is already clear:

```ts
import { execFileSync } from "node:child_process";

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: any) {
    console.error(err.stderr?.toString().trim() || err.message);
    process.exit(1);
  }
}
```

The errors this covers for free (all tested):

| Situation | What git says |
|---|---|
| Not inside a git repo | `fatal: not a git repository` |
| File never committed | `fatal: There is no path X in the commit` |
| Line past end of file | `fatal: file X has only 3 lines` |

#### Calling Gemini

No SDK, just `fetch` (see the end of `src/index.ts`):

- `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse`
- The key goes in the `x-goog-api-key` header, **not the URL**, so it can't leak into logs or error messages.
- Body: `systemInstruction`, `contents`, and `generationConfig.thinkingConfig.thinkingLevel: "low"` (thinking is on by default, and "low" makes it answer faster).
- The answer streams back as server-sent events: lines like `data: {...}`. Print each `candidates[0].content.parts[].text` as it arrives. A chunk can end mid-line, so keep the unfinished piece for the next round.
- A 503 ("high demand") is retried twice, after 2 s and 4 s. It is common on the free tier.
- `finishReason` other than `STOP` (e.g. `SAFETY`) → say Gemini stopped early.
- No `GEMINI_API_KEY` → "Set GEMINI_API_KEY first. Get a free key at https://aistudio.google.com/apikey". A bad key → Google's own message ("API key not valid").

### Step 7: Run it locally

```bash
npm run build
npm link                 # makes `gitwhy` available everywhere on your machine
export GEMINI_API_KEY=...   # PowerShell: $env:GEMINI_API_KEY="..."  (or keep it in .env and run: node --env-file=.env dist/index.js ...)
cd some-real-repo
gitwhy src/somefile.ts:42 --dry-run   # check what would be sent first
gitwhy src/somefile.ts:42
```

**Test it on a real repo with real history.** Clone something like `expressjs/express`, find an odd-looking line, and run gitwhy on it. These make the best demo screenshots too.

Run `npm unlink -g gitwhy` when you're done testing the local version.

### Step 8: Publish

```bash
npm view gitwhy          # should 404. If someone took the name, pick another
npm pack --dry-run       # lists the files that will be published: only dist/ plus package.json, README and LICENSE
npm login
npm publish
```

npm requires two-factor authentication to publish, so set it up on npmjs.com first. Afterwards, anyone can run `npx gitwhy file:line`. To publish an update, bump the version with `npm version patch` and run `npm publish` again.

---

## 7. Make it portfolio-ready

- [ ] **README** with:
  - a one-line pitch and an animated GIF demo (record with ScreenToGif on Windows, or [vhs](https://github.com/charmbracelet/vhs))
  - install and usage: `npx gitwhy file:line`, plus `--dry-run`
  - **requirements:** a free Gemini API key (https://aistudio.google.com/apikey, no credit card)
  - **privacy note:** the selected code and its git history are sent to Google's Gemini API, and on the free tier Google may use them to improve its products (use `--dry-run` to see exactly what's sent). Developers at companies will check for this.
  - "How it works": the 4-step table from section 2
- [ ] **GitHub repo** with topics: `git`, `cli`, `ai`, `developer-tools`
- [ ] **Demo on a famous repo.** Run it on a strange line in React, Express, or the Linux kernel and screenshot the result.
- [ ] **LinkedIn post:**
  - the problem (one line)
  - the GIF
  - one hard thing you solved (e.g. the uncommitted-line-numbers bug, or following a line through history with `git log -L`)
  - the npm and GitHub links

## 8. Ideas for v2 (only after v1 is published)

- **Handle uncommitted changes properly.** Instead of refusing, use `git blame --porcelain`, which gives each line's original commit and its line number *in that commit*. Then run `git log -L` starting from that commit.
- **Pull request context.** Use `gh pr list --search <sha> --state merged` to add PR descriptions and review comments. This is the biggest upgrade to the "why".
- **`--model` flag** so users can pick another Gemini model (e.g. `gemini-3.8-flash` for smarter answers when it isn't overloaded).
- **Local mode with Ollama** for privacy-minded users who already have it installed: code never leaves the machine.
- **Whole-function mode:** `gitwhy src/a.ts --fn login` using `git log -L :login:src/a.ts`.
- **VS Code extension:** right-click a line → "Why does this exist?"
