import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, TERMINAL } from "./helpers.js";

const events = (runDir: string) =>
  fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("monitor mirrors worker questions/progress into state and events; answer resolves the block", async () => {
  const root = initRepo("pf-outbox-1-");
  const spawned = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_ASK: "1", FAKE_PI_PROGRESS: "1", FAKE_PI_DELAY_MS: "200" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);

  const pending = await waitFor(() => readState(root, runId).pendingQuestion ?? undefined, { timeoutMs: 15_000 });
  assert.equal(pending.question, "bcrypt or argon2?");
  assert.deepEqual(pending.options, ["bcrypt", "argon2"]);
  assert.equal(pending.context, null);
  assert.match(pending.id, /^q_fake_/);
  assert.match(pending.askedAt, /^\d{4}-/);
  assert.equal(readState(root, runId).lastProgress, "starting the work");

  const table = await runCli(["status", "--cwd", root]);
  assert.match(table.stdout, /\bblocked\b/);
  const one = await runCli(["status", "w", "--cwd", root]);
  assert.equal(JSON.parse(one.stdout).status, "blocked");
  const evs = events(runDir);
  const q = evs.find((e) => e.type === "worker_question");
  assert.equal(q.questionId, pending.id);
  assert.equal(q.question, "bcrypt or argon2?");
  assert.equal(evs.find((e) => e.type === "worker_progress").message, "starting the work");

  const answered = await runCli(["answer", "w", "--cwd", root, "--", "argon2"]);
  assert.equal(answered.code, 0, answered.stderr);
  await waitFor(() => (events(runDir).some((e) => e.type === "answer_delivered") ? true : undefined), { timeoutMs: 10_000 });
  await waitFor(() => (TERMINAL.includes(readState(root, runId).status) ? true : undefined), { timeoutMs: 20_000 });

  const state = readState(root, runId);
  assert.equal(state.status, "settled");
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.steerCount, 1);
  assert.equal(state.steeringLog[0].source, "orchestrator");
  assert.equal(state.steeringLog[0].message, `answer(${pending.id}): argon2`);
  const delivered = events(runDir).find((e) => e.type === "answer_delivered");
  assert.deepEqual([delivered.questionId, delivered.source, delivered.message], [pending.id, "orchestrator", "argon2"]);
  const resolved = events(runDir).find((e) => e.type === "worker_question_resolved");
  assert.deepEqual([resolved.questionId, resolved.how], [pending.id, "answered"]);
  const report = await runCli(["report", "w", "--cwd", root]);
  assert.match(report.stdout, /Answer received: argon2/);
  assert.match(report.stdout, /\[orchestrator\] .* answer\(q_fake_.*\): argon2/);
}, { timeout: 60_000 });

test("an unanswered question times out: block clears and the run still settles", async () => {
  const root = initRepo("pf-outbox-2-");
  const spawned = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_ASK: "1", FAKE_PI_ASK_TIMEOUT_MS: "600", FAKE_PI_DELAY_MS: "100" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  await waitFor(() => readState(root, runId).pendingQuestion ?? undefined, { timeoutMs: 15_000 });
  await waitFor(() => (TERMINAL.includes(readState(root, runId).status) ? true : undefined), { timeoutMs: 20_000 });
  const state = readState(root, runId);
  assert.equal(state.status, "settled");
  assert.equal(state.pendingQuestion, null);
  assert.equal(state.steerCount, 0);
  const resolved = events(runDir).find((e) => e.type === "worker_question_resolved");
  assert.equal(resolved.how, "timeout");
  assert.equal(events(runDir).some((e) => e.type === "answer_delivered"), false);
}, { timeout: 60_000 });
