#!/usr/bin/env node
// Scripted `pi --mode rpc` replacement for hermetic tests.
// Env: FAKE_PI_DELAY_MS   settle delay after the work turn (default 300)
//      FAKE_PI_WRITE_HELLO=1  write + git-commit hello.txt in cwd
//      FAKE_PI_ARGV_FILE  if set, dump process.argv.slice(2) there as JSON
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

if (process.env.FAKE_PI_ARGV_FILE) {
  fsSync.writeFileSync(process.env.FAKE_PI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const steers = [];
let taskStarted = false;
const delay = Number(process.env.FAKE_PI_DELAY_MS || 300);

function writeReport() {
  const dir = process.env.PI_FLEET_DIR;
  const runId = process.env.PI_FLEET_RUN;
  if (!dir || !runId) return;
  fsSync.mkdirSync(path.join(dir, "reports"), { recursive: true });
  const steeringSection = steers.length > 0 ? steers.map((s) => `- ${s.message}`).join("\n") : "none";
  fsSync.writeFileSync(
    path.join(dir, "reports", `${runId}.md`),
    `# Fleet Report: ${runId}\n\n## Status\ndone\n\n## Summary\nCreated hello.txt with greeting content as briefed.\n\n## What I did\n1. Created hello.txt\n2. Verified content\n\n## Files changed\nhello.txt: new file with greeting\n\n## Verification\ncat hello.txt -> hi\n\n## Decisions & assumptions\nGreeting text chosen as "hi".\n\n## Steering received\n${steeringSection}\n\n## Open questions for orchestrator\n(none)\n\n## Suggested next step\nMerge pi-fleet branch.\n`,
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

function runTask() {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working: " } });
  send({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi" } });
  doWork();
  send({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] } });
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
      runTask();
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
    } else if (msg.type === "get_last_assistant_text") {
      send({ id: msg.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "Working: wrote hello.txt" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
