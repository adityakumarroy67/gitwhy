// "src/a.ts:42" or "src/a.ts:10-20". Greedy (.+) keeps Windows drive colons in the path.
export function parseTarget(arg: string) {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(arg);
  if (!m) throw new Error(`Expected <file>:<line> or <file>:<start>-<end>, got "${arg}"`);
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (start < 1 || end < start) throw new Error(`Invalid line range in "${arg}"`);
  return { file: m[1], start, end };
}
