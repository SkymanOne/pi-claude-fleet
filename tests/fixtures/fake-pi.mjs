#!/usr/bin/env node
// Scripted `pi --mode rpc` replacement for hermetic tests.
// Env: FAKE_PI_DELAY_MS   settle delay after the work turn (default 300)
//      FAKE_PI_WRITE_HELLO=1  write + git-commit hello.txt in cwd
//      FAKE_PI_ARGV_FILE  if set, dump process.argv.slice(2) there as JSON
//      FAKE_PI_ASK=1      call fleet_ask mid-turn: post a question to outbox.jsonl and
//                         wait for an `answer` in control.jsonl (FAKE_PI_ASK_TIMEOUT_MS, default 15000)
//      FAKE_PI_PROGRESS=1 post a progress line to outbox.jsonl before the tool call
//      FAKE_PI_EXIT_DELAY_MS: linger after stdin closes, like real pi's shutdown() teardown.
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.env.FAKE_PI_ARGV_FILE) {
  fsSync.writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const steers = [];
let taskStarted = false;
let answerText = null;
const delay = Number(process.env.FAKE_PI_DELAY_MS || 300);
const fleetDir = process.env.PI_FLEET_DIR;
const runId = process.env.PI_FLEET_RUN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mailbox (same line format as pi/extensions/fleet-worker.ts) ---
const runDir = () => path.join(fleetDir, "runs", runId);
function appendOutbox(line) {
  const full = {
    id: line.id ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    from: `worker:${runId}`,
    to: "orchestrator",
    type: line.type,
    payload: line.payload,
  };
  fsSync.mkdirSync(runDir(), { recursive: true });
  fsSync.appendFileSync(path.join(runDir(), "outbox.jsonl"), JSON.stringify(full) + "\n");
  return full;
}
function readAnswer(questionId, offset) {
  const p = path.join(runDir(), "control.jsonl");
  let size = 0;
  try { size = fsSync.statSync(p).size; } catch { return { answer: null, offset }; }
  if (size <= offset) return { answer: null, offset };
  const buf = Buffer.alloc(size - offset);
  const fd = fsSync.openSync(p, "r");
  fsSync.readSync(fd, buf, 0, buf.length, offset);
  fsSync.closeSync(fd);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { answer: null, offset };
  for (const line of buf.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "answer" && msg.questionId === questionId) return { answer: msg, offset: offset + lastNl + 1 };
    } catch { /* skip */ }
  }
  return { answer: null, offset: offset + lastNl + 1 };
}

function writeReport() {
  if (!fleetDir || !runId) return;
  fsSync.mkdirSync(path.join(fleetDir, "reports"), { recursive: true });
  const steeringSection = steers.length > 0 ? steers.map((s) => `- ${s.message}`).join("\n") : "none";
  const decisions = answerText ? `Answer received: ${answerText}` : 'Greeting text chosen as "hi".';
  fsSync.writeFileSync(
    path.join(fleetDir, "reports", `${runId}.md`),
    `# Fleet Report: ${runId}\n\n## Status\ndone\n\n## Summary\nCreated hello.txt with greeting content as briefed.\n\n## What I did\n1. Created hello.txt\n2. Verified content\n\n## Files changed\nhello.txt: new file with greeting\n\n## Verification\ncat hello.txt -> hi\n\n## Decisions & assumptions\n${decisions}\n\n## Steering received\n${steeringSection}\n\n## Open questions for orchestrator\n(none)\n\n## Suggested next step\nMerge pi-fleet branch.\n`,
  );
}

function doWork() {
  if (process.env.FAKE_PI_WRITE_HELLO === "1") {
    fsSync.writeFileSync(path.join(process.cwd(), "hello.txt"), "hi\n");
    const git = (args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: process.cwd() });
    git(["add", "hello.txt"]);
    git(["commit", "-qm", "add hello"]);
  }
}

async function askQuestion() {
  const questionId = `q_fake_${Date.now().toString(36)}`;
  const args = { question: "bcrypt or argon2?", options: ["bcrypt", "argon2"] };
  send({ type: "tool_execution_start", toolCallId: "c2", toolName: "fleet_ask", args });
  let offset = 0;
  try { offset = fsSync.statSync(path.join(runDir(), "control.jsonl")).size; } catch { offset = 0; }
  appendOutbox({ id: questionId, type: "question", payload: { question: args.question, options: args.options, context: null } });
  const deadline = Date.now() + Number(process.env.FAKE_PI_ASK_TIMEOUT_MS || 15000);
  let answer = null;
  while (!aborted && Date.now() < deadline) {
    const r = readAnswer(questionId, offset);
    offset = r.offset;
    if (r.answer) { answer = r.answer; break; }
    await sleep(100);
  }
  const how = answer ? "answered" : aborted ? "aborted" : "timeout";
  appendOutbox({ type: "question_resolved", payload: { questionId, how } });
  const text = answer ? `Answer from ${answer.source}: ${answer.message}` : `No answer (${how})`;
  send({ type: "tool_execution_end", toolCallId: "c2", toolName: "fleet_ask", result: { content: [{ type: "text", text }] } });
  if (answer) answerText = answer.message;
}

async function runTask() {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working: " } });
  if (process.env.FAKE_PI_PROGRESS === "1" && fleetDir && runId) {
    appendOutbox({ type: "progress", payload: { message: "starting the work" } });
  }
  send({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } });
  doWork();
  send({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] } });
  if (process.env.FAKE_PI_ASK === "1" && fleetDir && runId) await askQuestion();
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wrote hello.txt" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Working: wrote hello.txt" } });
  send({ type: "turn_end", message: { role: "assistant" } });
  writeReport();
  setTimeout(() => {
    if (aborted) return;
    settle();
  }, delay);
}

let aborted = false;
let settled = false;
function settle() {
  if (settled) return;
  settled = true;
  writeReport();
  send({ type: "agent_end", willRetry: false });
  send({ type: "agent_settled" });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "prompt" && !taskStarted) {
      taskStarted = true;
      send({ id: msg.id, type: "response", command: "prompt", success: true });
      void runTask();
    } else if (msg.type === "steer") {
      steers.push({ message: msg.message });
      send({ type: "response", command: "steer", success: true });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `[steer ack: ${msg.message}]` } });
    } else if (msg.type === "follow_up") {
      send({ type: "response", command: "follow_up", success: true });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "[followup ack]" } });
    } else if (msg.type === "abort") {
      aborted = true;
      send({ type: "response", command: "abort", success: true });
      settle();
    } else if (msg.type === "get_state") {
      send({
        id: msg.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          model: { id: process.env.FAKE_PI_MODEL_ID || "fake/model-1", name: "Fake Model", provider: process.env.FAKE_PI_PROVIDER || "fakeprovider" },
          thinkingLevel: "medium",
          isStreaming: false,
          sessionId: "fake-session",
        },
      });
    } else if (msg.type === "get_commands") {
      send({
        id: msg.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: {
          commands: [
            { name: "skill:fleet-worker-report", description: "How to write the fleet report", source: "skill" },
            { name: "compact-notes", description: "Summarize the session", source: "prompt" },
            { name: "session-name", description: "Set the session name", source: "extension" },
          ],
        },
      });
    } else if (msg.type === "get_last_assistant_text") {
      send({ id: msg.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "Working: wrote hello.txt" } });
    }
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), Number(process.env.FAKE_PI_EXIT_DELAY_MS || 0)));
