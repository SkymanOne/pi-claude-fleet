import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, TERMINAL } from "./helpers.js";

async function settledRun(prefix: string): Promise<string> {
  const root = initRepo(prefix);
  const spawned = await runCli(["spawn", "worker", "--cwd", root, "--no-worktree", "--", "task"]);
  assert.equal(spawned.code, 0, spawned.stderr);
  const waited = await runCli(["wait", "worker", "--cwd", root, "--timeout", "30"]);
  assert.equal(waited.code, 0, waited.stderr);
  assert.equal(waited.stdout.trim(), "worker settled");
  return root;
}

test("status: table, --json, single-run JSON, hides archived unless --all", async () => {
  const root = await settledRun("pf-cmd-1-");
  const table = await runCli(["status", "--cwd", root]);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /NAME.*STATE.*LAST-ACTIVITY.*LAST-TOOL.*STEERED.*AGE/);
  assert.match(table.stdout, /worker.*settled.*bash/);

  const json = JSON.parse((await runCli(["status", "--cwd", root, "--json"])).stdout);
  assert.equal(json.length, 1);
  assert.equal(json[0].name, "worker");
  assert.equal(json[0].status, "settled");

  const one = JSON.parse((await runCli(["status", "worker", "--cwd", root])).stdout);
  assert.equal(one.id, firstRunId(root));
  assert.equal(one.lastAssistantText, "Working: wrote hello.txt");

  const statePath = path.join(fleetDirOf(root), "runs", firstRunId(root), "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ ...readState(root), status: "archived" }));
  assert.equal((await runCli(["status", "--cwd", root])).stdout.trim(), "(no runs)");
  assert.match((await runCli(["status", "--cwd", root, "--all"])).stdout, /archived/);
}, { timeout: 60_000 });

test("output prints last assistant text; --tail prints the tool trail; logs tails rpc.log", async () => {
  const root = await settledRun("pf-cmd-2-");
  const out = await runCli(["output", "worker", "--cwd", root]);
  assert.equal(out.stdout.trim(), "Working: wrote hello.txt");
  const trail = await runCli(["output", "worker", "--cwd", root, "--tail", "5"]);
  assert.equal(trail.stdout.trim(), "bash: hi");
  const logs = await runCli(["logs", "worker", "--cwd", root, "--tail", "3"]);
  assert.equal(logs.code, 0);
  assert.equal(logs.stdout.trim().split("\n").length, 3);
  assert.match(logs.stdout, /"agent_settled"|"response"/);
}, { timeout: 60_000 });

test("wait: exit 3 on timeout, exit 4 when the run ends stopped", async () => {
  const root = initRepo("pf-cmd-3-");
  const spawned = await runCli(["spawn", "slow", "--cwd", root, "--no-worktree", "--", "task"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  assert.equal(spawned.code, 0, spawned.stderr);
  const timedOut = await runCli(["wait", "slow", "--cwd", root, "--timeout", "1"]);
  assert.equal(timedOut.code, 3);
  assert.match(timedOut.stderr, /timed out after 1s/);
  // force the run to end via the control channel (what `stop` writes)
  const runDir = path.join(fleetDirOf(root), "runs", firstRunId(root));
  await waitFor(() => (readState(root).status === "running" ? true : undefined), { timeoutMs: 15_000 });
  fs.appendFileSync(path.join(runDir, "control.jsonl"),
    JSON.stringify({ type: "abort", message: null, source: "orchestrator", ts: new Date().toISOString() }) + "\n");
  const stopped = await runCli(["wait", "slow", "--cwd", root, "--timeout", "15"]);
  assert.equal(stopped.code, 4);
  assert.equal(stopped.stdout.trim(), "slow stopped");
}, { timeout: 60_000 });

test("wait: exit 4 on error; unknown run exits 1", async () => {
  const root = initRepo("pf-cmd-4-");
  await runCli(["spawn", "boom", "--cwd", root, "--no-worktree", "--", "x"],
    { env: fakePiEnv({ PI_FLEET_PI_BIN: "/nonexistent/pi" }) });
  const r = await runCli(["wait", "boom", "--cwd", root, "--timeout", "20"]);
  assert.equal(r.code, 4);
  assert.equal(r.stdout.trim(), "boom error");
  const missing = await runCli(["wait", "ghost", "--cwd", root]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No run found/);
  assert.ok(TERMINAL.includes(readState(root).status));
}, { timeout: 60_000 });
