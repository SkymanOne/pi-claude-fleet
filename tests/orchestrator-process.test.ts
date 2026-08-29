import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { OrchestratorProcess, type PermissionRequest } from "../src/orchestrator/process.js";
import { buildClaudeArgs, claudeCommand, DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS } from "../src/orchestrator/args.js";
import { fleetMcpConfig } from "../src/orchestrator/mcpConfig.js";
import { loadSession, saveSession, newSession, sessionPath } from "../src/orchestrator/session.js";
import { isReplayedUserMessage, textOfAssistant, userText } from "../src/orchestrator/protocol.js";
import { isAlive } from "../src/state.js";
import { fakeClaudeEnv, FAKE_CLAUDE, tmpDir, waitFor } from "./helpers.js";

function startProc(root: string, over: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof OrchestratorProcess>[0]> = {}): OrchestratorProcess {
  const promptFile = path.join(root, "prompt.md");
  fs.writeFileSync(promptFile, "# test prompt\n");
  const proc = new OrchestratorProcess({
    cwd: root,
    promptFile,
    mcpConfigJson: JSON.stringify(fleetMcpConfig(path.join(root, ".pi-fleet"))),
    logPath: path.join(root, "orchestrator.log"),
    env: fakeClaudeEnv(over),
    stopGraceMs: 500,
    ...extra,
  });
  proc.start();
  return proc;
}

test("buildClaudeArgs produces the exact orchestrator flag set", () => {
  const args = buildClaudeArgs({ promptFile: "/p.md", mcpConfigJson: '{"mcpServers":{}}' });
  const pair = (flag: string) => args[args.indexOf(flag) + 1];
  assert.deepEqual(args.slice(0, 5), ["-p", "--input-format", "stream-json", "--output-format", "stream-json"]);
  for (const flag of ["--verbose", "--include-partial-messages", "--replay-user-messages", "--strict-mcp-config"]) assert.ok(args.includes(flag), flag);
  assert.equal(pair("--permission-prompt-tool"), "stdio");
  assert.equal(pair("--append-system-prompt-file"), "/p.md");
  assert.deepEqual(JSON.parse(pair("--mcp-config")), { mcpServers: {} });
  assert.equal(args.includes("--resume"), false);
  assert.equal(args.includes("--model"), false);
  const d = args.indexOf("--disallowedTools");
  assert.deepEqual(args.slice(d + 1, d + 1 + DEFAULT_DISALLOWED_TOOLS.length), ["Edit", "Write", "NotebookEdit"]);
  const a = args.indexOf("--allowedTools");
  assert.ok(a > d, "allowed list is last");
  assert.deepEqual(args.slice(a + 1), DEFAULT_ALLOWED_TOOLS);
  assert.equal(DEFAULT_ALLOWED_TOOLS[0], "mcp__fleet__*");

  const full = buildClaudeArgs({ promptFile: "/p.md", mcpConfigJson: "{}", model: "sonnet", resumeSessionId: "sess-1", maxBudgetUsd: 2.5, effort: "high", allowedTools: ["X"], disallowedTools: [] });
  const p2 = (flag: string) => full[full.indexOf(flag) + 1];
  assert.equal(p2("--model"), "sonnet");
  assert.equal(p2("--resume"), "sess-1");
  assert.equal(p2("--max-budget-usd"), "2.5");
  assert.equal(p2("--effort"), "high");
  assert.equal(full.includes("--disallowedTools"), false);
  assert.deepEqual(full.slice(full.indexOf("--allowedTools") + 1), ["X"]);

  assert.deepEqual(claudeCommand({ PI_FLEET_CLAUDE_BIN: "node /x/fake.mjs" }), { bin: "node", prefix: ["/x/fake.mjs"] });
  assert.deepEqual(claudeCommand({}), { bin: "claude", prefix: [] });
});

test("session store round-trips and tolerates missing or foreign files", async () => {
  const fleetDir = path.join(tmpDir("pf-sess-"), ".pi-fleet");
  assert.equal(loadSession(fleetDir), null);
  const s = newSession("/repo");
  s.sessionId = "abc";
  s.pid = 123;
  await saveSession(fleetDir, s);
  const back = loadSession(fleetDir)!;
  assert.equal(back.sessionId, "abc");
  assert.equal(back.pid, 123);
  assert.equal(back.cwd, "/repo");
  assert.deepEqual(back.watcher, { cursors: {} });
  fs.writeFileSync(sessionPath(fleetDir), "{\"version\":2}");
  assert.equal(loadSession(fleetDir), null);
  fs.writeFileSync(sessionPath(fleetDir), "nope");
  assert.equal(loadSession(fleetDir), null);
});

test("a turn over fake-claude: init after the first message, replay, deltas, assistant, result", async () => {
  const root = tmpDir("pf-proc-1-");
  const argvFile = path.join(root, "argv.json");
  const proc = startProc(root, { FAKE_CLAUDE_ARGV_FILE: argvFile, FAKE_CLAUDE_SESSION_ID: "sess-fixed" });
  try {
    assert.ok(proc.pid && proc.running);
    const deltas: string[] = [];
    proc.on("text_delta", (d) => deltas.push(d));
    const users: string[] = [];
    proc.on("user", (u) => { if (isReplayedUserMessage(u)) users.push(userText(u)!); });
    const assistant: string[] = [];
    proc.on("assistant", (a) => assistant.push(textOfAssistant(a)));
    const initP = once(proc, "init");
    const resultP = once(proc, "result");
    assert.equal(proc.initReceived, false);
    assert.equal(proc.send("hello"), true);
    assert.equal(proc.turnActive, true);
    const [init] = await initP;
    assert.equal(init.session_id, "sess-fixed");
    assert.equal(proc.sessionId, "sess-fixed");
    assert.equal(proc.model, "fake-model");
    assert.deepEqual(proc.capabilities, ["interrupt_receipt_v1"]);
    const [result] = await resultP;
    assert.equal(result.subtype, "success");
    assert.equal(proc.turnActive, false);
    assert.equal(proc.costUsd, 0.001);
    assert.equal(proc.numTurns, 1);
    assert.deepEqual(users, ["hello"]);
    assert.deepEqual(deltas, ["echo: hello"]);
    assert.deepEqual(assistant, ["echo: hello"]);
    const argv: string[] = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.equal(argv[argv.indexOf("--permission-prompt-tool") + 1], "stdio");
    const log = fs.readFileSync(path.join(root, "orchestrator.log"), "utf8");
    assert.match(log, /^> \{"type":"user"/m);
    assert.match(log, /^< \{"type":"system","subtype":"init"/m);
    // the real CLI re-emits system/init after every user message; the wrapper must not mind
    let inits = 0;
    proc.on("init", () => { inits += 1; });
    const again = once(proc, "result");
    proc.send("second");
    await again;
    assert.equal(inits, 1);
    assert.equal(proc.numTurns, 2);
    assert.equal(proc.costUsd, 0.002);
  } finally {
    await proc.stop();
  }
  assert.equal(isAlive(proc.pid), false);
  assert.ok(proc.exited);
}, { timeout: 20_000 });

test("permission requests: allow with suggestions, deny with a reason, AskUserQuestion answers", async () => {
  const root = tmpDir("pf-proc-2-");
  const proc = startProc(root);
  try {
    const perm = once(proc, "permission_request");
    proc.send("perm:touch a.txt");
    const [req] = (await perm) as [PermissionRequest];
    assert.equal(req.request.tool_name, "Bash");
    assert.deepEqual(req.request.input, { command: "touch a.txt" });
    assert.equal(req.request.title, "Run touch a.txt");
    assert.equal(proc.pendingRequests.size, 1);
    const res1 = once(proc, "result");
    assert.equal(proc.allow(req.requestId, req.request.permission_suggestions), true);
    assert.equal(proc.pendingRequests.size, 0);
    assert.equal(proc.allow(req.requestId), false, "already answered");
    const [r1] = await res1;
    assert.equal(r1.result, "allowed:touch a.txt");

    const perm2 = once(proc, "permission_request");
    proc.send("perm:rm -rf x");
    const [req2] = (await perm2) as [PermissionRequest];
    const res2 = once(proc, "result");
    proc.deny(req2.requestId, "not that");
    const [r2] = await res2;
    assert.equal(r2.result, "denied:not that");

    const ask = once(proc, "permission_request");
    proc.send("ask:Which style?|terse|verbose");
    const [q] = (await ask) as [PermissionRequest];
    assert.equal(q.request.tool_name, "AskUserQuestion");
    const questions = (q.request.input as any).questions;
    assert.equal(questions[0].question, "Which style?");
    assert.deepEqual(questions[0].options.map((o: any) => o.label), ["terse", "verbose"]);
    const res3 = once(proc, "result");
    proc.answerQuestion(q.requestId, { "Which style?": "verbose" });
    const [r3] = await res3;
    assert.equal(r3.result, 'answers:{"Which style?":"verbose"}');
    // the log carries the answer we sent
    assert.match(fs.readFileSync(path.join(root, "orchestrator.log"), "utf8"), /"answers":\{"Which style\?":"verbose"\}/);
  } finally {
    await proc.stop();
  }
}, { timeout: 20_000 });

test("interrupt stops a streaming turn and returns the receipt; errors surface as results", async () => {
  const root = tmpDir("pf-proc-3-");
  const proc = startProc(root);
  try {
    const firstDelta = once(proc, "text_delta");
    proc.send("slow:");
    await firstDelta;
    const res = once(proc, "result");
    const receipt = await proc.interrupt();
    assert.deepEqual(receipt, { still_queued: [] });
    const [r] = await res;
    assert.equal(r.result, "interrupted");
    assert.equal(proc.turnActive, false);

    const failed = once(proc, "result");
    proc.send("fail:");
    const [f] = await failed;
    assert.equal(f.subtype, "error_during_execution");
    assert.equal(f.is_error, true);
    assert.deepEqual(await proc.setPermissionMode("acceptEdits"), {});
  } finally {
    await proc.stop();
  }
}, { timeout: 20_000 });

test("needsInitialize: the bare initialize handshake is only sent when asked for", async () => {
  const root = tmpDir("pf-proc-4-");
  const without = startProc(root, { FAKE_CLAUDE_REQUIRE_INIT: "1" });
  try {
    let prompted = false;
    without.on("permission_request", () => { prompted = true; });
    const res = once(without, "result");
    without.send("perm:touch b.txt");
    const [r] = await res;
    assert.equal(r.result, "ran-without-prompt:touch b.txt");
    assert.equal(prompted, false);
  } finally {
    await without.stop();
  }
  const root2 = tmpDir("pf-proc-5-");
  const withInit = startProc(root2, { FAKE_CLAUDE_REQUIRE_INIT: "1" }, { needsInitialize: true });
  try {
    await waitFor(() => (fs.existsSync(path.join(root2, "orchestrator.log")) && fs.readFileSync(path.join(root2, "orchestrator.log"), "utf8").includes('"subtype":"initialize"') ? true : undefined), { timeoutMs: 5000 });
    const perm = once(withInit, "permission_request");
    withInit.send("perm:touch c.txt");
    const [req] = (await perm) as [PermissionRequest];
    const res = once(withInit, "result");
    withInit.allow(req.requestId);
    const [r] = await res;
    assert.equal(r.result, "allowed:touch c.txt");
  } finally {
    await withInit.stop();
  }
}, { timeout: 20_000 });

test("stop() escalates to SIGTERM/SIGKILL for a child that ignores stdin closing", async () => {
  const root = tmpDir("pf-proc-6-");
  const promptFile = path.join(root, "p.md");
  fs.writeFileSync(promptFile, "x");
  // hang.mjs ignores stdin closing, so only the signals end it
  const hang = path.join(path.dirname(FAKE_CLAUDE), "hang.mjs");
  const proc = new OrchestratorProcess({ cwd: root, promptFile, mcpConfigJson: "{}", env: { ...process.env, PI_FLEET_CLAUDE_BIN: `${process.execPath} ${hang}` }, stopGraceMs: 200 });
  proc.start();
  const started = Date.now();
  const info = await proc.stop();
  assert.ok(Date.now() - started < 5000);
  assert.equal(info.signal, "SIGTERM");
  assert.equal(isAlive(proc.pid), false);
}, { timeout: 20_000 });
