import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workerCommand, parseAnswer } from "../src/tui/workerActions.js";
import { newRunState, type RunState } from "../src/state.js";
import { tmpDir } from "./helpers.js";

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
