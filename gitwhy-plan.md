# gitwhy: project plan

> Ask why a line of code exists. gitwhy reads the line's git history and explains it in plain English.

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
| 4 | Send all of it to Claude and stream the explanation to the terminal | Anthropic SDK |

## 3. Tech stack

- **Node.js and TypeScript.** You publish to npm, so anyone can run `npx gitwhy file:line` with no install.
  - To **develop** it you need Node **22.18+**, which runs `.ts` test files directly. Node 24 is ideal.
  - The **published** CLI runs on Node 20+.
- **`@anthropic-ai/sdk`** to call Claude (model `claude-opus-5-5`).
- **Git** must be installed. That's the only system requirement.
- No other dependencies. Argument parsing and git calls use Node's built-in modules.

**What it costs to run:** each run is one Claude API call. At Opus 5.5 prices ($4 per million input tokens, $20 per million output tokens), that should be roughly a few cents per run. Check the real number in the Anthropic Console after your first few runs.

## 4. Folder structure

```
gitwhy/
├─ src/
│  ├─ index.ts        # the CLI: parse arg → run git → ask Claude → print
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
2. **Milestone 2: the git part, no AI yet.** `gitwhy file:line --dry-run` prints the exact text that *would* be sent to Claude. Check it on a real repo. Keep this flag afterwards, since it's useful for debugging and lets users see what leaves their machine.
3. **Milestone 3: Claude.** Send that text to Claude and stream the answer.
4. **Milestone 4: polish.** Friendly errors, README, GIF, publish.

---

## 6. Build it step by step

### Step 1: Set up the project

```bash
mkdir gitwhy && cd gitwhy
git init
npm init -y
npm install @anthropic-ai/sdk
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
  "keywords": ["git", "blame", "cli", "ai", "claude"],
  "engines": { "node": ">=20" },
  "license": "MIT"
}
```

Keep the `dependencies` and `devDependencies` blocks that `npm install` added.

### Step 3: `tsconfig.json`

Tested with TypeScript 7.0. You can import files as `./parse.ts`, and the build rewrites the imports to `./parse.js`.

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
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
2. **Refuse files with uncommitted changes** (see the warning below).
3. **Gather the history:**
   - `git blame -L <start>,<end> -- <file>`
   - `git log -L<start>,<end>:<file> -n 10 --format=...` (the 10 most recent changes; pick a format that includes the SHA, author, date and full message)
4. **Read the code around the lines.** Mark the target lines with `>` so Claude knows which ones you mean.
5. **Build one prompt** from the file name, the code, the blame output and the history. With `--dry-run`, print it and stop.
6. **Call Claude with streaming,** so text appears as it's written.
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

#### Calling Claude

This snippet compiles against `@anthropic-ai/sdk` 0.131:

```ts
import Anthropic from "@anthropic-ai/sdk";

const SYSTEM = `You explain why code exists, using its git history.
Start with a one-sentence answer. Then give a short timeline of the changes that matter:
short commit SHA, author, date, and what changed and why.
Only use what the history and code show. If the history doesn't explain the reason, say so plainly instead of guessing.`;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
process.stderr.write("Reading the history...\n"); // Claude thinks before writing, so show something

const stream = client.beta.messages.stream({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default", // if Opus declines (rare), the API retries on a fallback model automatically
  system: SYSTEM,
  messages: [{ role: "user", content: prompt }],
});
stream.on("text", (text) => process.stdout.write(text));
const msg = await stream.finalMessage();
if (msg.stop_reason === "refusal") console.error("\nClaude declined to explain this one.");
process.stdout.write("\n");
```

Catch a missing or wrong API key: `err instanceof Anthropic.AuthenticationError` → print "Set ANTHROPIC_API_KEY. Get one at https://console.anthropic.com".

### Step 7: Run it locally

```bash
npm run build
npm link                 # makes `gitwhy` available everywhere on your machine
export ANTHROPIC_API_KEY=sk-ant-...   # PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
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
  - **requirements:** an Anthropic API key, roughly a few cents per run
  - **privacy note:** the selected code and its git history are sent to Anthropic's API (use `--dry-run` to see exactly what's sent). Developers at companies will check for this.
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
- **`--model` flag** so users can choose a cheaper model.
- **Whole-function mode:** `gitwhy src/a.ts --fn login` using `git log -L :login:src/a.ts`.
- **VS Code extension:** right-click a line → "Why does this exist?"
