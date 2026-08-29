import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRun } from "../src/spawn.js";
import { statusCore, reportCore, diffCore, printResult, ok, fail } from "../src/commands.js";

function mkTmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-core-")));
}

/** Count console.log/console.error calls while `fn` runs; cores must make none. */
async function withOutputSpy<T>(fn: () => Promise<T>): Promise<{ result: T; writes: number }> {
  const origLog = console.log;
  const origErr = console.error;
  let writes = 0;
  console.log = () => { writes += 1; };
  console.error = () => { writes += 1; };
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("statusCore on an empty fleet returns data without printing", async () => {
  const dir = mkTmp();
  const { result, writes } = await withOutputSpy(() => statusCore({ cwd: dir }));
  assert.equal(writes, 0);
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, ["(no runs)"]);
  assert.deepEqual(result.err, []);
  assert.deepEqual(result.data, { runs: [] });
});

test("reportCore returns code 2 with an error line when nothing was captured", async () => {
  const dir = mkTmp();
  await createRun({ name: "quiet", opts: { cwd: dir }, brief: "do nothing" });
  const { result, writes } = await withOutputSpy(() => reportCore({ name: "quiet", cwd: dir }));
  assert.equal(writes, 0);
  assert.equal(result.code, 2);
  assert.equal(result.data, null);
  assert.deepEqual(result.out, []);
  assert.match(result.err[0], /no report file and no captured output for quiet/);
});

test("diffCore on a run without a worktree is not applicable", async () => {
  const dir = mkTmp();
  await createRun({ name: "flat", opts: { cwd: dir }, brief: "no worktree here" });
  const { result } = await withOutputSpy(() => diffCore({ name: "flat", cwd: dir }));
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, ["not applicable (run has no isolated worktree)"]);
  assert.deepEqual(result.data, { applicable: false, text: "not applicable (run has no isolated worktree)", dirty: [] });
});

test("statusCore --json for one run carries the derived status in data and text", async () => {
  const dir = mkTmp();
  await createRun({ name: "solo", opts: { cwd: dir }, brief: "brief" });
  const { result } = await withOutputSpy(() => statusCore({ name: "solo", cwd: dir }));
  assert.equal(result.code, 0);
  assert.equal(result.data.runs.length, 1);
  assert.equal(result.data.runs[0].name, "solo");
  assert.equal(result.data.runs[0].status, "starting");
  assert.equal(JSON.parse(result.out[0]).name, "solo");
});

test("printResult writes out to stdout, err to stderr, and returns the code", () => {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (s: string) => { logs.push(s); };
  console.error = (s: string) => { errs.push(s); };
  try {
    assert.equal(printResult(ok({ x: 1 }, ["a", "b"], ["w"])), 0);
    assert.equal(printResult(fail(5, "boom")), 5);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.deepEqual(logs, ["a", "b"]);
  assert.deepEqual(errs, ["w", "boom"]);
});
