import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor } from "./helpers.js";

test("answer refuses on a settled run and on a running run without a pending question", async () => {
  const root = initRepo("pf-ans-1-");
  await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"]);
  assert.equal((await runCli(["wait", "w", "--cwd", root, "--timeout", "30"])).code, 0);
  const settled = await runCli(["answer", "w", "--cwd", root, "--", "argon2"]);
  assert.equal(settled.code, 1);
  assert.match(settled.stderr, /is settled — nothing is waiting for an answer/);
  const empty = await runCli(["answer", "w", "--cwd", root]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /message required/);
}, { timeout: 60_000 });

test("answer refuses while nothing is pending on a running run", async () => {
  const root = initRepo("pf-ans-2-");
  const spawned = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const runId = firstRunId(root);
  await waitFor(() => (readState(root, runId).status === "running" ? true : undefined), { timeoutMs: 15_000 });
  const none = await runCli(["answer", "w", "--cwd", root, "--", "argon2"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /has no pending question/);
  assert.equal(fs.existsSync(path.join(fleetDirOf(root), "runs", runId, "control.jsonl")), false);
  await runCli(["stop", "w", "--cwd", root]);
  await runCli(["wait", "w", "--cwd", root, "--timeout", "15"]);
}, { timeout: 60_000 });

test("answer writes an answer control line with the explicit or pending question id", async () => {
  const root = initRepo("pf-ans-3-");
  const spawned = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_ASK: "1", FAKE_PI_ASK_TIMEOUT_MS: "20000", FAKE_PI_DELAY_MS: "200" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  // the worker's fleet_ask makes the monitor record a pending question
  const pending = await waitFor(() => readState(root, runId).pendingQuestion ?? undefined, { timeoutMs: 15_000 });

  const status = await runCli(["status", "w", "--cwd", root]);
  assert.equal(JSON.parse(status.stdout).status, "blocked");
  const table = await runCli(["status", "--cwd", root]);
  assert.match(table.stdout, /\bblocked\b/);

  // an explicit id is written as given, even though it is not the pending one
  const explicit = await runCli(["answer", "w", "--cwd", root, "--question", "q_explicit", "--", "not this one"]);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), "answer queued for w (question q_explicit)");
  // without --question the pending question is the target
  const implicit = await runCli(["answer", "w", "--cwd", root, "--", "use argon2"]);
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.equal(implicit.stdout.trim(), `answer queued for w (question ${pending.id})`);

  const control = fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(control.map((c) => [c.type, c.message, c.source, c.questionId]), [
    ["answer", "not this one", "orchestrator", "q_explicit"],
    ["answer", "use argon2", "orchestrator", pending.id],
  ]);
  assert.ok(control.every((c) => typeof c.id === "string"));
  const waited = await runCli(["wait", "w", "--cwd", root, "--timeout", "20"]);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match((await runCli(["report", "w", "--cwd", root])).stdout, /Answer received: use argon2/);
}, { timeout: 60_000 });
