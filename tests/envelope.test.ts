import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnvelope, controlToEnvelope, parseEnvelope, workerParty } from "../src/fleet/envelope.js";

test("makeEnvelope fills id and ts and keeps the payload", () => {
  const env = makeEnvelope({ from: workerParty("r-1"), to: "orchestrator", type: "question", payload: { question: "a?", options: null, context: null } });
  assert.match(env.id, /^m_/);
  assert.match(env.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(env.from, "worker:r-1");
  assert.equal(env.to, "orchestrator");
  assert.equal(env.type, "question");
  assert.deepEqual(env.payload, { question: "a?", options: null, context: null });
  const fixed = makeEnvelope({ from: "fleet", to: "console", type: "x", payload: 1, id: "m_fixed", ts: "2026-01-01T00:00:00.000Z" });
  assert.equal(fixed.id, "m_fixed");
  assert.equal(fixed.ts, "2026-01-01T00:00:00.000Z");
});

test("controlToEnvelope lifts a flat control line, including legacy lines without ids", () => {
  const env = controlToEnvelope({ id: "ctl_1", type: "answer", message: "argon2", source: "console", ts: "t", questionId: "q_1" }, "run-1");
  assert.deepEqual(env, { id: "ctl_1", ts: "t", from: "console", to: "worker:run-1", type: "answer", payload: { message: "argon2", questionId: "q_1" } });
  const legacy = controlToEnvelope({ type: "steer", message: "m", source: "orchestrator", ts: "t" }, "run-2");
  assert.match(legacy.id, /^ctl_/);
  assert.equal(legacy.from, "orchestrator");
  assert.deepEqual(legacy.payload, { message: "m", questionId: null });
});

test("parseEnvelope validates the shape", () => {
  const good = { id: "m_1", ts: "t", from: "worker:r", to: "orchestrator", type: "progress", payload: { message: "hi" } };
  assert.deepEqual(parseEnvelope(good), good);
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope("x"), null);
  assert.equal(parseEnvelope({ ...good, from: "stranger" }), null);
  assert.equal(parseEnvelope({ ...good, id: 1 }), null);
  assert.equal(parseEnvelope({ ...good, to: undefined }), null);
});
