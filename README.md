# gitwhy

Ask why a line of code exists. gitwhy reads the line's git history and explains it in plain English. Free to use.

```
$ npx gitwhy lib/response.js:163

This line exists to check whether an ETag needs to be created, so Express can
avoid converting small string bodies into Buffers when no ETag is required.

Timeline of changes:

48940e61 Douglas Christopher Wilson 2017-09-25
Added the generateETag boolean to check if the response lacks an ETag header and
has an ETag generator function configured. This is used immediately below to skip
buffer encoding and just calculate byte length for small responses when an ETag
will not be generated.
```

<sub>Real output, run on [expressjs/express](https://github.com/expressjs/express).</sub>

## Why

Every codebase has lines that look pointless or weird. Before you delete one, you want to know why it's there. The answer is usually in the git history, but digging through `git blame` and `git log` by hand is slow, so nobody does it.

## Setup

You need **Node.js 20+**, **git**, and a **free Gemini API key**.

1. Get a key at <https://aistudio.google.com/apikey> (Google account, no credit card).
2. Save it as an environment variable:

   ```bash
   # macOS / Linux (add to ~/.bashrc or ~/.zshrc to keep it)
   export GEMINI_API_KEY=your-key
   ```

   ```powershell
   # Windows PowerShell (then open a new terminal)
   setx GEMINI_API_KEY "your-key"
   ```

## Usage

Run it from inside the git repo the file belongs to:

```bash
npx gitwhy <file>:<line>              # one line
npx gitwhy <file>:<start>-<end>       # a range of lines
npx gitwhy <file>:<line> --dry-run    # show what would be sent, send nothing
```

Or install it once with `npm install -g gitwhy` and run `gitwhy src/auth.ts:42`.

## How it works

| Step | What happens | Tool used |
|---|---|---|
| 1 | Find who last changed the lines | `git blame -L` |
| 2 | Get the last 10 changes to exactly those lines, with commit messages and diffs | `git log -L` |
| 3 | Read the code around them (±15 lines) | Node `fs` |
| 4 | Send it all to Gemini and stream the explanation | Node `fetch` |

No dependencies: just Node's built-in modules.

## Privacy

gitwhy sends the selected lines, the 15 lines around them, and their git history (commit messages, author names, diffs) to Google's Gemini API. **On the free tier, Google may use this data to improve its products**, so don't run it on code you're not allowed to share. Run with `--dry-run` to see exactly what would be sent.

## Limitations

- **Files with uncommitted changes are refused.** `git blame` reads the file on disk but `git log -L` reads the last commit, so their line numbers wouldn't match. Commit or stash first.
- **The free tier is rate-limited.** If you hit the limit, gitwhy shows Google's message. Wait a minute and try again.
- **It's only as good as the history.** If the commit messages just say "fix stuff", gitwhy is told to say the reason isn't recorded rather than guess.

## License

MIT
