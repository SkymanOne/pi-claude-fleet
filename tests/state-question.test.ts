import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newRunState, deriveView, appendControl } from "../src/state.js";
import { tmpDir } from "./helpers.js";

const base = {
  fleetDir: "/tmp/x/.pi-fleet", runId: "auth-20260828141530", name: "auth",
  cwd: "/tmp/x", base: "HEAD", model: "m", taskBrief: "b",
};

test("new run state has no pending question or progress", () => {
  const s = newRunState(base);
  assert.equal(s.pendingQuestion, null);
  assert.equal(s.lastProgress, null);
});

test("deriveView is blocked only while running with a pending question", () => {
  const alive = () => true;
  const s = newRunState(base);
  s.status = "running";
  s.pid = 4242;
  assert.equal(deriveView(s, alive), "running");
  s.pendingQuestion = { id: "q_1", question: "which?", options: null, context: null, askedAt: "2026-08-29T00:00:00.000Z" };
  assert.equal(deriveView(s, alive), "blocked");
  // a dead monitor wins over the question
  assert.equal(deriveView(s, () => false), "dead");
  // settled runs are never blocked, even with a stale pendingQuestion
  s.status = "settled";
  assert.equal(deriveView(s, alive), "settled");
  // old state files without the field
  const legacy = { ...newRunState(base), status: "running" as const, pid: 1 };
  delete (legacy as { pendingQuestion?: unknown }).pendingQuestion;
  assert.equal(deriveView(legacy, alive), "running");
});

test("appendControl writes ids, and questionId only for answers", async () => {
  const runDir = tmpDir("pf-ctl-");
  await appendControl(runDir, { type: "steer", message: "use tabs", source: "orchestrator" });
  await appendControl(runDir, { type: "answer", message: "argon2", source: "console", questionId: "q_7" });
  await appendControl(runDir, { type: "answer", message: "x", source: "console" });
  const lines = fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.match(l.id, /^ctl_/);
    assert.match(l.ts, /^\d{4}-/);
  }
  assert.equal("questionId" in lines[0], false);
  assert.deepEqual([lines[1].type, lines[1].message, lines[1].source, lines[1].questionId], ["answer", "argon2", "console", "q_7"]);
  assert.equal(lines[2].questionId, null);
  assert.notEqual(lines[0].id, lines[1].id);
});
