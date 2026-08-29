import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createTranscript, applyEvent, partialText, summarizeArgs, readNewEvents, replay,
} from "../src/console/transcript.js";
import { tmpDir } from "./helpers.js";

const text = (t: ReturnType<typeof createTranscript>) => t.lines.map((l) => l.text);

test("applyEvent renders steering, tools, streamed text, and status markers", () => {
  const t = createTranscript();
  applyEvent(t, { type: "task_prompt", brief: "create hello.txt\nmore detail" });
  applyEvent(t, { type: "agent_start" });
  applyEvent(t, { type: "message_update", ev: { type: "text_start", contentIndex: 0 } });
  applyEvent(t, { type: "message_update", ev: { type: "text_delta", contentIndex: 0, delta: "Work" } });
  assert.equal(partialText(t), "Work");
  applyEvent(t, { type: "message_update", ev: { type: "text_delta", contentIndex: 0, delta: "ing\nline2" } });
  applyEvent(t, { type: "message_update", ev: { type: "text_end", contentIndex: 0, content: "Working\nline2" } });
  assert.equal(partialText(t), null);
  applyEvent(t, { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi\necho there" } });
  applyEvent(t, { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "hi\nthere" }] } });
  applyEvent(t, { type: "tool_execution_end", toolName: "read", isError: true, result: { content: [] } });
  applyEvent(t, { type: "steering_delivered", source: "console", message: "use tabs" });
  applyEvent(t, { type: "abort_requested" });
  applyEvent(t, { type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  applyEvent(t, { type: "compaction_start", reason: "threshold" });
  applyEvent(t, { type: "extension_error", error: "boom" });
  applyEvent(t, { type: "agent_settled" });
  assert.deepEqual(text(t), [
    "▶ task: create hello.txt",
    "Working",
    "line2",
    "⚙ bash echo hi",
    "  ↳ hi",
    "  ↳ (error)",
    "▶ console: use tabs",
    "■ abort requested",
    "↻ retry 1/3",
    "⌁ compacting context",
    "! extension error: boom",
    "● settled",
  ]);
  assert.equal(t.lines[0].kind, "steer");
  assert.equal(t.lines[3].kind, "tool");
  assert.equal(t.lines[4].kind, "tool_result");
  assert.equal(t.lines.at(-1)?.kind, "system");
});

test("applyEvent accepts the raw RPC message_update shape; text_end without content uses the deltas", () => {
  const t = createTranscript();
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 2 } });
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "hey" } });
  applyEvent(t, { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 2 } });
  assert.deepEqual(text(t), ["hey"]);
});

test("summarizeArgs prefers command/path and clips long values", () => {
  assert.equal(summarizeArgs({ command: "ls -la" }), "ls -la");
  assert.equal(summarizeArgs({ path: "/a/b.ts", other: 1 }), "/a/b.ts");
  assert.equal(summarizeArgs({ x: 1 }), '{"x":1}');
  assert.equal(summarizeArgs(null), "");
  assert.equal(summarizeArgs({ command: "x".repeat(100) }).length, 80);
});

test("readNewEvents advances only past complete lines; replay keeps the tail", () => {
  const p = path.join(tmpDir("pf-tr-"), "events.jsonl");
  const first = JSON.stringify({ type: "agent_settled" }) + "\n";
  fs.writeFileSync(p, first + '{"type":"tool_execution_start","toolName":"ba');
  const r1 = readNewEvents(p, 0);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.offset, Buffer.byteLength(first));
  fs.appendFileSync(p, 'sh","args":{"command":"é"}}\n');
  const r2 = readNewEvents(p, r1.offset);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].toolName, "bash");
  assert.equal(r2.offset, fs.statSync(p).size);
  assert.deepEqual(readNewEvents(p, r2.offset), { events: [], offset: r2.offset });
  assert.deepEqual(readNewEvents(path.join(p, "missing"), 0), { events: [], offset: 0 });

  for (let i = 0; i < 50; i++) {
    fs.appendFileSync(p, JSON.stringify({ type: "steering_delivered", source: "s", message: `m${i}` }) + "\n");
  }
  const { transcript, offset } = replay(p, 10);
  assert.equal(transcript.lines.length, 10);
  assert.equal(transcript.lines.at(-1)?.text, "▶ s: m49");
  assert.equal(offset, fs.statSync(p).size);
});

test("applyEvent renders worker questions, progress, answers, and dropped controls", () => {
  const t = createTranscript();
  applyEvent(t, { type: "worker_question", questionId: "q_1", question: "bcrypt or argon2?", options: ["bcrypt", "argon2"] });
  applyEvent(t, { type: "worker_question", questionId: "q_2", question: "free form?" });
  applyEvent(t, { type: "worker_progress", message: "tests passing" });
  applyEvent(t, { type: "answer_delivered", source: "console", questionId: "q_1", message: "argon2" });
  applyEvent(t, { type: "worker_question_resolved", questionId: "q_1", how: "answered" });
  applyEvent(t, { type: "worker_question_resolved", questionId: "q_2", how: "timeout" });
  applyEvent(t, { type: "control_dropped", control: "steer", source: "console", reason: "run already settled" });
  assert.deepEqual(text(t), [
    "? bcrypt or argon2? [bcrypt | argon2]",
    "? free form?",
    "· tests passing",
    "▶ answer (console): argon2",
    "! no answer in time; worker proceeds on its own judgment",
    "! steer from console dropped: run already settled",
  ]);
  assert.equal(t.lines[0].kind, "question");
  assert.equal(t.lines[3].kind, "steer");
});
