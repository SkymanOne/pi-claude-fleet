import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerCommand, parseAnswer, removeWorker } from "../src/tui/workerActions.js";
import { newRunState, type RunState } from "../src/state.js";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, tmpDir, TERMINAL } from "./helpers.js";

function mk(over: Partial<RunState> = {}): { runDir: string; state: RunState } {
  const runDir = tmpDir("pf-wa-");
  return {
    runDir,
    state: { ...newRunState({ fleetDir: "/f", runId: "db-1", name: "db", cwd: "/r" }), status: "running", pid: process.pid, ...over },
  };
}

const control = (runDir: string): any[] => {
  const p = path.join(runDir, "control.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("plain text steers, /followup queues, /stop aborts — all with console provenance", async () => {
  const { runDir, state } = mk();
  assert.deepEqual(await workerCommand({ runDir, state, input: "use tabs" }), { notice: "→ steer queued for db: use tabs", error: false });
  assert.deepEqual(await workerCommand({ runDir, state, input: "/followup then summarize" }), { notice: "→ follow-up queued for db: then summarize", error: false });
  assert.deepEqual(await workerCommand({ runDir, state, input: "/stop" }), { notice: "■ abort requested for db", error: false });
  assert.deepEqual(control(runDir).map((c) => [c.type, c.message, c.source]), [
    ["steer", "use tabs", "console"],
    ["follow_up", "then summarize", "console"],
    ["abort", null, "console"],
  ]);
  assert.deepEqual(await workerCommand({ runDir, state, input: "   " }), { notice: "", error: false });
});

test("/answer targets the pending question, or an explicit id", async () => {
  const pending = { id: "q_abc", question: "which?", options: null, context: null, askedAt: "t" };
  const { runDir, state } = mk({ pendingQuestion: pending });
  const r = await workerCommand({ runDir, state, input: "/answer use argon2" });
  assert.deepEqual(r, { notice: "→ answered db (q_abc): use argon2", error: false });
  await workerCommand({ runDir, state, input: "/answer q_other something else" });
  assert.deepEqual(control(runDir).map((c) => [c.questionId, c.message]), [
    ["q_abc", "use argon2"],
    ["q_other", "something else"],
  ]);
  assert.deepEqual(parseAnswer(" q_1 hello there", null), { questionId: "q_1", message: "hello there" });
  assert.deepEqual(parseAnswer(" just text", "q_pending"), { questionId: "q_pending", message: "just text" });
  assert.deepEqual(parseAnswer(" q_1", "q_pending"), { questionId: "q_pending", message: "q_1" }, "a lone id is treated as the answer text");
});

test("refusals: no pending question, finished runs, unknown commands, empty arguments", async () => {
  const running = mk();
  const noQuestion = await workerCommand({ runDir: running.runDir, state: running.state, input: "/answer x" });
  assert.equal(noQuestion.error, true);
  assert.match(noQuestion.notice, /has no pending question/);
  assert.deepEqual(control(running.runDir), []);

  const unknown = await workerCommand({ runDir: running.runDir, state: running.state, input: "/nope now" });
  assert.equal(unknown.error, true);
  assert.match(unknown.notice, /unknown command \/nope/);

  for (const input of ["/followup", "/answer"]) {
    const r = await workerCommand({ runDir: running.runDir, state: running.state, input });
    assert.equal(r.error, true);
    assert.match(r.notice, /usage:/);
  }

  const settled = mk({ status: "settled" });
  for (const input of ["steer me", "/followup later", "/answer x", "/stop"]) {
    const r = await workerCommand({ runDir: settled.runDir, state: settled.state, input });
    assert.equal(r.error, true, input);
    assert.match(r.notice, /is settled/);
  }
  assert.match((await workerCommand({ runDir: settled.runDir, state: settled.state, input: "steer me" })).notice, /pi-fleet spawn db-2 --session/);
  assert.deepEqual(control(settled.runDir), []);
});

test("/remove archives a finished, clean worker straight away", async () => {
  const root = initRepo("pf-rm-1-");
  const fleetDir = fleetDirOf(root);
  assert.equal((await runCli(["spawn", "hello", "--cwd", root, "--", "t"], { env: fakePiEnv({ FAKE_PI_WRITE_HELLO: "1", FAKE_PI_DELAY_MS: "100" }) })).code, 0);
  const runId = firstRunId(root);
  await waitFor(() => (TERMINAL.includes(readState(root, runId).status) ? true : undefined), { timeoutMs: 30_000 });
  const state = readState(root, runId);

  const r = await workerCommand({ runDir: path.join(fleetDir, "runs", runId), state, input: "/remove", piFleetDir: fleetDir, runId });
  assert.equal(r.error, false, r.notice);
  assert.equal(r.confirm, undefined);
  assert.match(r.notice, /^✓ removed hello/);
  assert.match(r.notice, /unmerged branch was kept/, "an unmerged branch is kept, and said so");
  assert.equal(readState(root, runId).status, "archived");
  assert.equal(fs.existsSync(state.worktree), false);
}, { timeout: 60_000 });

test("/remove asks before destroying anything: a running worker, or uncommitted work", async () => {
  const root = initRepo("pf-rm-2-");
  const fleetDir = fleetDirOf(root);
  assert.equal((await runCli(["spawn", "slow", "--cwd", root, "--", "t"], { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) })).code, 0);
  const runId = firstRunId(root);
  await waitFor(() => (readState(root, runId).status === "running" ? true : undefined), { timeoutMs: 20_000 });
  const runDir = path.join(fleetDir, "runs", runId);

  const running = await workerCommand({ runDir, state: readState(root, runId), input: "/remove", piFleetDir: fleetDir, runId });
  assert.equal(running.error, false);
  assert.equal(running.notice, "");
  assert.match(running.confirm!.message, /slow is running\. Abort it and remove/);
  assert.equal(readState(root, runId).status, "running", "nothing happened without the confirmation");

  // confirming aborts and removes it
  const removed = await removeWorker({ piFleetDir: fleetDir, runId, name: "slow", force: true });
  assert.equal(removed.error, false, removed.notice);
  assert.match(removed.notice, /^✓ removed slow/);
  assert.equal(readState(root, runId).status, "archived");
}, { timeout: 60_000 });

test("/remove on a settled worker with uncommitted changes asks first", async () => {
  const root = initRepo("pf-rm-3-");
  const fleetDir = fleetDirOf(root);
  assert.equal((await runCli(["spawn", "hello", "--cwd", root, "--", "t"], { env: fakePiEnv({ FAKE_PI_WRITE_HELLO: "1", FAKE_PI_DELAY_MS: "100" }) })).code, 0);
  const runId = firstRunId(root);
  await waitFor(() => (TERMINAL.includes(readState(root, runId).status) ? true : undefined), { timeoutMs: 30_000 });
  const state = readState(root, runId);
  fs.writeFileSync(path.join(state.worktree, "scratch.txt"), "unsaved\n");

  const r = await workerCommand({ runDir: path.join(fleetDir, "runs", runId), state, input: "/remove", piFleetDir: fleetDir, runId });
  assert.equal(r.notice, "");
  assert.match(r.confirm!.message, /1 uncommitted change\(s\) that would be discarded/);
  assert.equal(fs.existsSync(path.join(state.worktree, "scratch.txt")), true);
}, { timeout: 60_000 });

test("short aliases do the same as the long forms", async () => {
  const { runDir, state } = mk({ pendingQuestion: { id: "q_1", question: "which?", options: null, context: null, askedAt: "t" } });
  assert.match((await workerCommand({ runDir, state, input: "/a use argon2" })).notice, /answered db \(q_1\): use argon2/);
  assert.match((await workerCommand({ runDir, state, input: "/f later please" })).notice, /follow-up queued for db: later please/);
  assert.match((await workerCommand({ runDir, state, input: "/s" })).notice, /abort requested for db/);
  assert.deepEqual(control(runDir).map((c) => c.type), ["answer", "follow_up", "abort"]);
  assert.match((await workerCommand({ runDir, state, input: "/a" })).notice, /usage:/, "an alias with no argument still explains itself");
});

test("/remove without a fleet dir, and the updated unknown-command hint", async () => {
  const { runDir, state } = mk({ status: "settled" });
  assert.deepEqual(await workerCommand({ runDir, state, input: "/remove" }), { notice: "! /remove is not available here", error: true });
  const unknown = await workerCommand({ runDir, state, input: "/nope" });
  assert.match(unknown.notice, /\/remove/);
});

test("a command the worker itself offers is sent to pi; an unknown one lists what it has", async () => {
  const commands = [
    { name: "skill:fleet-worker-report", description: "How to write the report", source: "skill" },
    { name: "session-name", description: "Set the session name", source: "extension" },
  ];
  const { runDir, state } = mk({ commands });
  const sent = await workerCommand({ runDir, state, input: "/skill:fleet-worker-report" });
  assert.equal(sent.error, false, sent.notice);
  assert.equal(sent.notice, "→ sent /skill:fleet-worker-report to db");
  await workerCommand({ runDir, state, input: "/session-name my-run" });
  assert.deepEqual(control(runDir).map((c) => [c.type, c.message, c.source]), [
    ["command", "/skill:fleet-worker-report", "console"],
    ["command", "/session-name my-run", "console"],
  ]);

  const unknown = await workerCommand({ runDir, state, input: "/nope" });
  assert.equal(unknown.error, true);
  assert.match(unknown.notice, /the worker's own: \/skill:fleet-worker-report, \/session-name/);

  const finished = mk({ status: "settled", commands });
  const late = await workerCommand({ runDir: finished.runDir, state: finished.state, input: "/session-name x" });
  assert.equal(late.error, true);
  assert.match(late.notice, /is settled/);
  assert.deepEqual(control(finished.runDir), []);
});
