import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { OrchestratorClient } from "../src/orchestrator/client.js";
import { loadOrchestratorState } from "../src/orchestrator/monitor.js";
import { orchestratorPaths } from "../src/orchestrator/records.js";
import { isAlive } from "../src/state.js";
import { fakeClaudeEnv, tmpDir, waitFor } from "./helpers.js";

/** The monitor is a detached child, so its fake-claude knobs travel through this process's env. */
function useFakeClaude(over: Record<string, string> = {}): () => void {
  const keys = ["PI_FLEET_DEV", "PI_FLEET_CLAUDE_BIN", "PI_FLEET_PI_BIN", "FAKE_CLAUDE_STDIN_LOG", "FAKE_CLAUDE_SESSION_ID", "FAKE_CLAUDE_ARGV_FILE"];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  const env = fakeClaudeEnv(over);
  for (const key of keys) {
    if (typeof env[key] === "string") process.env[key] = env[key] as string;
    else delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

interface Fixture {
  piFleetDir: string;
  cwd: string;
  restore: () => void;
}

function fixture(over: Record<string, string> = {}): Fixture {
  const cwd = tmpDir("pf-orch-");
  over = { FAKE_CLAUDE_ARGV_FILE: path.join(cwd, "argv.json"), ...over };
  const piFleetDir = path.join(cwd, ".pi-fleet");
  const paths = orchestratorPaths(piFleetDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.prompt, "# test orchestrator\n");
  return { piFleetDir, cwd, restore: useFakeClaude(over) };
}

const client = (f: Fixture, fresh = true) => new OrchestratorClient({ piFleetDir: f.piFleetDir, cwd: f.cwd, fresh, pollMs: 30 });

async function stopMonitor(f: Fixture): Promise<void> {
  const state = loadOrchestratorState(f.piFleetDir);
  if (!state?.pid || !isAlive(state.pid)) return;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // already gone
  }
  await waitFor(() => (!isAlive(state.pid) ? true : undefined), { timeoutMs: 10_000 }).catch(() => undefined);
}

test("the monitor owns the claude session; the console attaches, detaches and reattaches", async () => {
  const f = fixture({ FAKE_CLAUDE_SESSION_ID: "sess-detach01" });
  const first = client(f);
  try {
    const started = first.start();
    assert.equal(started.attached, false, "there was nothing to attach to yet");

    const records: Record<string, unknown>[] = [];
    first.on("record", (r) => records.push(r));
    // claude only announces its session on the first turn, so wait for the monitor itself
    await waitFor(() => (first.running() ? true : undefined), { timeoutMs: 20_000 });
    await first.send("hello there");
    await waitFor(() => (records.some((r) => r.type === "result") ? true : undefined), { timeoutMs: 20_000 });
    const state = loadOrchestratorState(f.piFleetDir)!;
    assert.equal(state.sessionId, "sess-detach01");
    assert.equal(state.model, "fake-model");
    assert.ok(state.pid && isAlive(state.pid), "a monitor is running");
    assert.deepEqual(state.commands.map((c) => c.name), ["model", "usage", "research"]);
    assert.ok(records.some((r) => r.type === "stream_text"), "token deltas are coalesced into the transcript");

    // this is what /quit does: the console goes away, the orchestrator does not
    first.stop();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(isAlive(state.pid!), "the orchestrator survived the console");

    // reopening picks the same session back up, and replays what was said
    const second = client(f, false);
    const replayed: Record<string, unknown>[] = [];
    second.on("record", (r) => replayed.push(r));
    const reattached = second.start();
    assert.equal(reattached.attached, true, "it attached rather than starting another one");
    await waitFor(() => (replayed.some((r) => r.type === "result") ? true : undefined), { timeoutMs: 10_000 });
    assert.equal(loadOrchestratorState(f.piFleetDir)!.pid, state.pid, "the same monitor, not a new one");

    // and it still works
    await second.send("again");
    await waitFor(() => (replayed.filter((r) => r.type === "result").length >= 2 ? true : undefined), { timeoutMs: 20_000 });
    second.stop();
  } finally {
    await stopMonitor(f);
    f.restore();
  }
}, { timeout: 90_000 });

test("a permission request waits in the state until some console answers it", async () => {
  const f = fixture();
  const c = client(f);
  try {
    c.start();
    await waitFor(() => (c.running() ? true : undefined), { timeoutMs: 20_000 });
    const asked = once(c, "permission_request");
    await c.send("perm:touch a.txt");
    const [pending] = (await asked) as [{ requestId: string; request: { tool_name: string } }];
    assert.equal(pending.request.tool_name, "Bash");
    assert.equal(loadOrchestratorState(f.piFleetDir)!.pendingRequests.length, 1, "it is held in the state, not just announced");

    // a console that dies mid-question leaves the request for the next one
    c.stop();
    const next = client(f, false);
    const announced = once(next, "permission_request");
    next.start();
    const [again] = (await announced) as [{ requestId: string }];
    assert.equal(again.requestId, pending.requestId, "the new console is shown the same question");

    const records: Record<string, unknown>[] = [];
    next.on("record", (r) => records.push(r));
    await next.allow(pending.requestId);
    await waitFor(() => (records.some((r) => r.type === "result") ? true : undefined), { timeoutMs: 20_000 });
    assert.deepEqual(loadOrchestratorState(f.piFleetDir)!.pendingRequests, [], "answered questions are cleared");
    next.stop();
  } finally {
    await stopMonitor(f);
    f.restore();
  }
}, { timeout: 90_000 });

test("the permission mode is set at launch, changed from a console, and kept across a restart", async () => {
  const f = fixture();
  const c = new OrchestratorClient({ piFleetDir: f.piFleetDir, cwd: f.cwd, fresh: true, permissionMode: "auto", pollMs: 30 });
  try {
    c.start();
    await waitFor(() => (c.running() ? true : undefined), { timeoutMs: 20_000 });
    await waitFor(() => (loadOrchestratorState(f.piFleetDir)?.permissionMode === "auto" ? true : undefined), { timeoutMs: 10_000 });
    const argv: string[] = JSON.parse(fs.readFileSync(path.join(f.cwd, "argv.json"), "utf8"));
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "auto", "claude was started in that mode");

    const records: Record<string, unknown>[] = [];
    c.on("record", (r) => records.push(r));
    await c.setPermissionMode("acceptEdits");
    await waitFor(() => (loadOrchestratorState(f.piFleetDir)?.permissionMode === "acceptEdits" ? true : undefined), { timeoutMs: 10_000 });
    assert.ok(
      records.some((r) => r.type === "notice" && String(r.text).includes("acceptEdits")),
      "the change is reported in the transcript",
    );
    c.stop();

    // a console that has to start a fresh monitor keeps the mode the last one was in
    const pid = loadOrchestratorState(f.piFleetDir)!.pid!;
    process.kill(pid, "SIGTERM");
    await waitFor(() => (!isAlive(pid) ? true : undefined), { timeoutMs: 10_000 });
    const next = new OrchestratorClient({ piFleetDir: f.piFleetDir, cwd: f.cwd, pollMs: 30 });
    next.start();
    await waitFor(() => (next.running() ? true : undefined), { timeoutMs: 20_000 });
    const restarted: string[] = JSON.parse(fs.readFileSync(path.join(f.cwd, "argv.json"), "utf8"));
    assert.equal(restarted[restarted.indexOf("--permission-mode") + 1], "acceptEdits");
    next.stop();
  } finally {
    await stopMonitor(f);
    f.restore();
  }
}, { timeout: 90_000 });

test("shutdown ends the orchestrator for good", async () => {
  const f = fixture();
  const c = client(f);
  try {
    c.start();
    await waitFor(() => (c.running() ? true : undefined), { timeoutMs: 20_000 });
    const pid = loadOrchestratorState(f.piFleetDir)!.pid!;
    assert.ok(isAlive(pid));

    await c.shutdown();
    await waitFor(() => (!isAlive(pid) ? true : undefined), { timeoutMs: 20_000 });
    const state = loadOrchestratorState(f.piFleetDir)!;
    assert.ok(state.exited, "the state records that it is gone");
    assert.equal(state.pid, null);
    assert.equal(c.running(), false);
    c.stop();

    // and the next console starts a new one rather than attaching to a corpse
    const after = client(f, false);
    try {
      assert.equal(after.start().attached, false);
      await waitFor(() => (after.running() ? true : undefined), { timeoutMs: 20_000 });
      after.stop();
    } finally {
      await stopMonitor(f);
    }
  } finally {
    await stopMonitor(f);
    f.restore();
  }
}, { timeout: 90_000 });
