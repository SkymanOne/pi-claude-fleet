import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, TERMINAL } from "./helpers.js";

async function spawnSlow(prefix: string, name: string): Promise<{ root: string; runDir: string; runId: string }> {
  const root = initRepo(prefix);
  const r = await runCli(["spawn", name, "--cwd", root, "--no-worktree", "--", "create hello.txt"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "4000" }) });
  assert.equal(r.code, 0, r.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  // wait until the monitor is running and the fake pi has started its turn
  await waitFor(() => {
    const running = readState(root, runId).status === "running";
    const started = fs.existsSync(path.join(runDir, "events.jsonl")) &&
      /tool_execution_end/.test(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"));
    return running && started ? true : undefined;
  }, { timeoutMs: 15_000 });
  return { root, runDir, runId };
}

const settled = (root: string, runId: string) =>
  waitFor(() => {
    const s = readState(root, runId);
    return TERMINAL.includes(s.status) ? s : undefined;
  }, { timeoutMs: 30_000 });

const controlLine = (obj: Record<string, unknown>) => JSON.stringify({ ...obj, ts: new Date().toISOString() }) + "\n";

test("console steering mid-run → delivered event, steerCount/steeringLog, report reflects it", async () => {
  const { root, runDir, runId } = await spawnSlow("pf-steer-", "auth");
  fs.appendFileSync(path.join(runDir, "control.jsonl"),
    controlLine({ type: "steer", message: "use tabs not spaces", source: "console" }));
  fs.appendFileSync(path.join(runDir, "control.jsonl"),
    controlLine({ type: "follow_up", message: "then summarize", source: "orchestrator" }));
  const state = await settled(root, runId);
  assert.equal(state.status, "settled");
  assert.equal(state.steerCount, 2);
  assert.deepEqual(state.steeringLog.map((s: any) => [s.source, s.message]), [
    ["console", "use tabs not spaces"],
    ["orchestrator", "then summarize"],
  ]);
  assert.ok(state.steeringLog.every((s: any) => typeof s.ts === "string"));
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"steering_delivered".*"source":"console".*"use tabs not spaces"/);
  const report = fs.readFileSync(path.join(fleetDirOf(root), "reports", `${runId}.md`), "utf8");
  assert.match(report, /## Steering received\n- use tabs not spaces/);
}, { timeout: 60_000 });

test("abort via control.jsonl → abort_requested event and stopped state", async () => {
  const { root, runDir, runId } = await spawnSlow("pf-abort-", "auth");
  fs.appendFileSync(path.join(runDir, "control.jsonl"), controlLine({ type: "abort", message: null, source: "orchestrator" }));
  const state = await settled(root, runId);
  assert.equal(state.status, "stopped");
  assert.ok(state.settledAt);
  assert.match(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), /"abort_requested"/);
}, { timeout: 60_000 });

test("steering after settle is not forwarded or recorded", async () => {
  const root = initRepo("pf-late-");
  const r = await runCli(["spawn", "auth", "--cwd", root, "--no-worktree", "--", "x"]);
  assert.equal(r.code, 0, r.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  const state = await settled(root, runId);
  assert.equal(state.status, "settled");
  fs.appendFileSync(path.join(runDir, "control.jsonl"), controlLine({ type: "steer", message: "too late", source: "console" }));
  await new Promise((res) => setTimeout(res, 800));
  assert.equal(readState(root, runId).steerCount, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), /too late/);
}, { timeout: 60_000 });
