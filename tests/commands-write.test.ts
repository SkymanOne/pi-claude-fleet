import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor } from "./helpers.js";

test("send/stop on a settled run refuse with a resume hint (exit 1); send without message exits 1", async () => {
  const root = initRepo("pf-wr-1-");
  await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"]);
  assert.equal((await runCli(["wait", "w", "--cwd", root, "--timeout", "30"])).code, 0);
  const send = await runCli(["send", "w", "--cwd", root, "--", "try again"]);
  assert.equal(send.code, 1);
  assert.match(send.stderr, /is settled — steering refused/);
  assert.match(send.stderr, /pi-fleet spawn w-2 --session/);
  const stop = await runCli(["stop", "w", "--cwd", root]);
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /nothing to stop/);
  const empty = await runCli(["send", "w", "--cwd", root]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /message required/);
  assert.equal(fs.existsSync(path.join(fleetDirOf(root), "runs", firstRunId(root), "control.jsonl")), false);
}, { timeout: 60_000 });

test("send + followup reach a running worker with orchestrator provenance; stop ends it stopped", async () => {
  const root = initRepo("pf-wr-2-");
  const spawned = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  await waitFor(() => (readState(root, runId).status === "running" ? true : undefined), { timeoutMs: 15_000 });

  const send = await runCli(["send", "w", "--cwd", root, "--", "use tabs"]);
  assert.equal(send.code, 0, send.stderr);
  assert.equal(send.stdout.trim(), "steer queued for w");
  const followup = await runCli(["followup", "w", "--cwd", root, "--", "then summarize"]);
  assert.equal(followup.code, 0, followup.stderr);
  const control = fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(control.map((c) => [c.type, c.message, c.source]), [
    ["steer", "use tabs", "orchestrator"],
    ["follow_up", "then summarize", "orchestrator"],
  ]);
  await waitFor(() => (readState(root, runId).steerCount === 2 ? true : undefined), { timeoutMs: 10_000 });

  const stop = await runCli(["stop", "w", "--cwd", root]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(stop.stdout.trim(), "abort requested for w");
  const waited = await runCli(["wait", "w", "--cwd", root, "--timeout", "15"]);
  assert.equal(waited.code, 4);
  assert.equal(waited.stdout.trim(), "w stopped");
  const state = readState(root, runId);
  assert.equal(state.status, "stopped");
  assert.equal(state.steerCount, 2);
}, { timeout: 60_000 });
