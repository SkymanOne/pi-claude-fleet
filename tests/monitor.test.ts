import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isAlive } from "../src/state.js";
import {
  initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, TERMINAL, FAIL_PI,
} from "./helpers.js";

const settledState = (root: string) =>
  waitFor(() => {
    const s = readState(root);
    return TERMINAL.includes(s.status) ? s : undefined;
  }, { timeoutMs: 30_000 });

test("the monitor records the commands the worker offers, and forwards one as a prompt", async () => {
  const root = initRepo("pf-cmds-");
  const r = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"], { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  assert.equal(r.code, 0, r.stderr);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  const state = await waitFor(() => (readState(root, runId).commands?.length ? readState(root, runId) : undefined), { timeoutMs: 20_000 });
  assert.deepEqual(state.commands.map((c: any) => c.name), ["skill:fleet-worker-report", "compact-notes", "session-name"]);
  assert.equal(state.commands[0].source, "skill");

  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({ id: "c1", type: "command", message: "/session-name mine", source: "console", ts: new Date().toISOString() }) + "\n");
  await waitFor(() => {
    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    return events.includes("command_delivered") ? true : undefined;
  }, { timeoutMs: 15_000 });
  const after = readState(root, runId);
  assert.equal(after.steerCount, 1);
  assert.equal(after.steeringLog[0].message, "command: /session-name mine");
  await runCli(["stop", "w", "--cwd", root]);
  await runCli(["wait", "w", "--cwd", root, "--timeout", "15"]);
}, { timeout: 60_000 });

test("the monitor records what the worker is doing, including thinking", async () => {
  const root = initRepo("pf-activity-");
  assert.equal(
    (await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"], { env: fakePiEnv({ FAKE_PI_THINK_MS: "1500", FAKE_PI_DELAY_MS: "1500" }) })).code,
    0,
  );
  const runId = firstRunId(root);
  // sample what the console would show while the worker works
  const seen = new Set<string>();
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const state = readState(root, runId);
    seen.add(`${state.status}:${state.activity}`);
    if (TERMINAL.includes(state.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen.has("running:thinking"), `expected a thinking phase, saw ${[...seen].join(", ")}`);
  assert.ok([...seen].some((s) => s === "running:tool" || s === "running:text"), "and then work");
  assert.equal(readState(root, runId).activity, null, "a finished worker is doing nothing");
}, { timeout: 60_000 });

test("the monitor reports and changes the worker's thinking level", async () => {
  const root = initRepo("pf-think-");
  assert.equal((await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"], { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000", FAKE_PI_THINKING: "low" }) })).code, 0);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  await waitFor(() => (readState(root, runId).thinkingLevel ? true : undefined), { timeoutMs: 20_000 });
  assert.equal(readState(root, runId).thinkingLevel, "low");

  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({ id: "t1", type: "thinking", message: "xhigh", source: "console", ts: new Date().toISOString() }) + "\n");
  await waitFor(() => (readState(root, runId).thinkingLevel === "xhigh" ? true : undefined), { timeoutMs: 20_000 });
  assert.match(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8"), /thinking_requested/);

  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({ id: "t2", type: "thinking", message: "ludicrous", source: "console", ts: new Date().toISOString() }) + "\n");
  await waitFor(() => (fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").includes("thinking_rejected") ? true : undefined), { timeoutMs: 20_000 });
  assert.equal(readState(root, runId).thinkingLevel, "xhigh", "a rejected level does not stick");
  await runCli(["stop", "w", "--cwd", root]);
  await runCli(["wait", "w", "--cwd", root, "--timeout", "15"]);
}, { timeout: 60_000 });

test("the monitor records the model pi resolved", async () => {
  const root = initRepo("pf-model-");
  const r = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_MODEL_ID: "vendor/model-9", FAKE_PI_PROVIDER: "vendorco" }) });
  assert.equal(r.code, 0, r.stderr);
  const state = await waitFor(() => (readState(root).activeModel ? readState(root) : undefined), { timeoutMs: 20_000 });
  assert.equal(state.activeModel, "vendor/model-9");
  assert.equal(state.activeProvider, "vendorco");
  const status = await runCli(["status", "w", "--cwd", root]);
  assert.equal(JSON.parse(status.stdout).activeModel, "vendor/model-9");
}, { timeout: 60_000 });

test("full run: spawn → settled → lastAssistantText + report + events captured; monitor exits", async () => {
  const root = initRepo("pf-mon-");
  const r = await runCli(["spawn", "auth", "--cwd", root, "--no-worktree", "--", "create hello.txt"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "300" }) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Spawned auth-\d{14}/);

  const state = await settledState(root);
  assert.equal(state.status, "settled");
  assert.equal(state.lastAssistantText, "Working: wrote hello.txt");
  assert.equal(state.lastTool, "bash");
  assert.ok(state.lastActivity);
  assert.ok(state.settledAt);
  assert.equal(state.error, null);
  assert.ok(Number.isInteger(state.pid));

  const fleetDir = fleetDirOf(root);
  const runId = firstRunId(root);
  assert.equal(fs.existsSync(path.join(fleetDir, "reports", `${runId}.md`)), true);
  const events = fs.readFileSync(path.join(fleetDir, "runs", runId, "events.jsonl"), "utf8");
  assert.match(events, /"task_prompt"/);
  assert.match(events, /"tool_execution_end"/);
  assert.match(events, /"text_end"/);
  assert.doesNotMatch(events, /"turn_start"/, "unselected events are not captured");
  const rpcLog = fs.readFileSync(path.join(fleetDir, "runs", runId, "rpc.log"), "utf8");
  assert.match(rpcLog, /"agent_settled"/);
  assert.match(rpcLog, /"turn_start"/, "rpc.log keeps every raw line");

  // the monitor shuts pi down and exits after settling
  await waitFor(() => (isAlive(state.pid) ? undefined : true), { timeoutMs: 15_000 });
}, { timeout: 60_000 });

test("pi child exits without settling → error state with exit code", async () => {
  const root = initRepo("pf-err-");
  const r = await runCli(["spawn", "boom", "--cwd", root, "--no-worktree", "--", "x"],
    { env: fakePiEnv({ PI_FLEET_PI_BIN: `${process.execPath} ${FAIL_PI}` }) });
  assert.equal(r.code, 0, r.stderr);
  const state = await settledState(root);
  assert.equal(state.status, "error");
  assert.match(state.error, /exited with code 1/);
  assert.match(state.error, /model provider unreachable/, "stderr tail captured");
  assert.ok(state.settledAt);
}, { timeout: 60_000 });

test("missing pi binary → error state naming the spawn failure", async () => {
  const root = initRepo("pf-nopi-");
  const r = await runCli(["spawn", "ghost", "--cwd", root, "--no-worktree", "--", "x"],
    { env: fakePiEnv({ PI_FLEET_PI_BIN: "/nonexistent/pi-binary" }) });
  assert.equal(r.code, 0, r.stderr);
  const state = await settledState(root);
  assert.equal(state.status, "error");
  assert.match(state.error, /failed to start pi/);
}, { timeout: 60_000 });
