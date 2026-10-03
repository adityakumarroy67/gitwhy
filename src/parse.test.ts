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
