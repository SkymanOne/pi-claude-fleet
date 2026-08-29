import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/App.js";
import { OrchestratorProcess } from "../src/orchestrator/process.js";
import { FleetWatcher } from "../src/fleet/watcher.js";
import { fleetMcpConfig } from "../src/orchestrator/mcpConfig.js";
import { newRunState, saveState, runDirFor, type RunState } from "../src/state.js";
import { fakeClaudeEnv, tmpDir, waitFor } from "./helpers.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const squash = (s: string): string => s.replace(/\s+/g, " ");

interface Harness {
  proc: OrchestratorProcess;
  watcher: FleetWatcher;
  piFleetDir: string;
  stdinLog: () => string;
  quit: { called: number };
}

function setup(over: Record<string, string> = {}): Harness {
  const root = tmpDir("pf-app-");
  const piFleetDir = path.join(root, ".pi-fleet");
  fs.mkdirSync(path.join(piFleetDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(piFleetDir, "reports"), { recursive: true });
  const promptFile = path.join(piFleetDir, "prompt.md");
  fs.writeFileSync(promptFile, "# prompt\n");
  const stdinLogPath = path.join(root, "stdin.log");
  const proc = new OrchestratorProcess({
    cwd: root,
    promptFile,
    mcpConfigJson: JSON.stringify(fleetMcpConfig(piFleetDir)),
    env: fakeClaudeEnv({ FAKE_CLAUDE_STDIN_LOG: stdinLogPath, FAKE_CLAUDE_SESSION_ID: "sess-abcdef12", ...over }),
    stopGraceMs: 300,
  });
  proc.start();
  const watcher = new FleetWatcher({ piFleetDir, pollMs: 30, batchMs: 20 });
  watcher.start();
  return {
    proc,
    watcher,
    piFleetDir,
    stdinLog: () => {
      try {
        return fs.readFileSync(stdinLogPath, "utf8");
      } catch {
        return "";
      }
    },
    quit: { called: 0 },
  };
}

async function addRun(piFleetDir: string, name: string, over: Partial<RunState> = {}): Promise<{ runId: string; runDir: string }> {
  const runId = `${name}-20260829120000`;
  const runDir = runDirFor(piFleetDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  await saveState(runDir, { ...newRunState({ fleetDir: piFleetDir, runId, name, cwd: "/repo" }), status: "running", pid: process.pid, ...over });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  return { runId, runDir };
}

function renderApp(h: Harness) {
  return render(React.createElement(App, { proc: h.proc, watcher: h.watcher, onQuit: () => { h.quit.called += 1; }, railPollMs: 30, reapMs: 0 }));
}

const frameMatching = (lastFrame: () => string | undefined, re: RegExp, timeoutMs = 8000): Promise<string> =>
  waitFor(() => (re.test(squash(lastFrame() ?? "")) ? squash(lastFrame() as string) : undefined), { timeoutMs, intervalMs: 20 });

type Rendered = ReturnType<typeof renderApp>;

/**
 * Type into the composer and submit. The two writes must not land in the same
 * tick: TextInput would still hold the old (empty) value when Enter arrives.
 */
async function type(app: Rendered, text: string): Promise<void> {
  app.stdin.write(text);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await frameMatching(app.lastFrame, new RegExp(`> ${escaped}`));
  app.stdin.write("\r");
}

async function teardown(h: Harness, app: { unmount: () => void }): Promise<void> {
  app.unmount();
  h.watcher.stop();
  await h.proc.stop();
}

test("typing a message shows it, streams the reply, and fills the status line", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "hello there");
    await frameMatching(app.lastFrame, /> hello there/);
    await frameMatching(app.lastFrame, /echo: hello there/);
    const frame = await frameMatching(app.lastFrame, /sess-abc/);
    assert.match(frame, /fake-model . sess-abc . \$0\.001 . 1 turn/);
    assert.match(frame, /. orchestrator/, "the rail lists the orchestrator");
    assert.equal((frame.match(/> hello there/g) ?? []).length, 1, "the replay of our own message is suppressed");
  } finally {
    await teardown(h, app);
  }
}, { timeout: 30_000 });

test("a permission request opens the overlay; y allows it", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "perm:touch a.txt");
    const overlay = await frameMatching(app.lastFrame, /Run touch a\.txt/);
    assert.match(overlay, /y allow once . a allow for this session . n deny/);
    assert.match(overlay, /1 approval pending/);
    assert.match(overlay, /\? orchestrator/, "the rail flags the approval");
    app.stdin.write("y");
    await frameMatching(app.lastFrame, /allowed:touch a\.txt/);
    assert.match(squash(app.lastFrame() ?? ""), /orchestrator > /, "the composer is back");
  } finally {
    await teardown(h, app);
  }
}, { timeout: 30_000 });

test("an AskUserQuestion is answered with the picker", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "ask:Which hash?|bcrypt|argon2");
    const overlay = await frameMatching(app.lastFrame, /question 1\/1/);
    assert.match(overlay, /Which hash\?/);
    assert.match(overlay, /bcrypt/);
    app.stdin.write(DOWN);
    await frameMatching(app.lastFrame, /argon2/);
    app.stdin.write("\r");
    await frameMatching(app.lastFrame, /answers:\{"Which hash\?":"argon2"\}/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 30_000 });

test("a worker question reaches the rail and the orchestrator; the human can answer it", async () => {
  const h = setup();
  const { runDir } = await addRun(h.piFleetDir, "db");
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /. db/);
    // what the monitor does when it sees the question in the worker's outbox
    fs.appendFileSync(
      path.join(runDir, "events.jsonl"),
      JSON.stringify({ type: "worker_question", questionId: "q_1", question: "bcrypt or argon2?", options: ["bcrypt", "argon2"] }) + "\n",
    );
    const statePath = path.join(runDir, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.pendingQuestion = { id: "q_1", question: "bcrypt or argon2?", options: ["bcrypt", "argon2"], context: null, askedAt: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(state));
    await frameMatching(app.lastFrame, /\? db/);
    await frameMatching(app.lastFrame, /question db/);
    const sent = await waitFor(() => (h.stdinLog().includes("fleet-event") ? h.stdinLog() : undefined), { timeoutMs: 8000 });
    const line = JSON.parse(sent.split("\n").find((l) => l.includes("fleet-event"))!);
    assert.match(line.message.content, /<fleet-event kind="question" run="db-20260829120000" name="db"/);
    assert.match(line.message.content, /question: bcrypt or argon2\?/);
    assert.match(line.message.content, /next: fleet_answer name="db"/);

    app.stdin.write("\t");
    await frameMatching(app.lastFrame, /db \(running\) > /);
    await frameMatching(app.lastFrame, /bcrypt or argon2/);
    await type(app, "/answer use argon2");
    const control = await waitFor(
      () => {
        try {
          return fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim() || undefined;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 8000 },
    );
    const answer = JSON.parse(control.split("\n")[0]);
    assert.deepEqual([answer.type, answer.message, answer.source, answer.questionId], ["answer", "use argon2", "console", "q_1"]);
    app.stdin.write("\t");
    await frameMatching(app.lastFrame, /answered db \(q_1\): use argon2/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 40_000 });

test("/help shows the bindings, esc closes it, /quit asks the app to exit", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "/help");
    await frameMatching(app.lastFrame, /tab \/ shift-tab next \/ previous session/);
    assert.match(squash(app.lastFrame() ?? ""), /y allow once/, "the approval keys are documented too");
    app.stdin.write(ESC);
    await waitFor(() => (squash(app.lastFrame() ?? "").includes("Composer type + enter") ? undefined : true), { timeoutMs: 5000, intervalMs: 20 });
    assert.equal(h.quit.called, 0);
    await type(app, "/quit");
    await waitFor(() => (h.quit.called > 0 ? true : undefined), { timeoutMs: 5000 });
  } finally {
    await teardown(h, app);
  }
}, { timeout: 30_000 });

test("esc interrupts a running turn", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "slow:");
    await frameMatching(app.lastFrame, /tick0/);
    app.stdin.write(ESC);
    await frameMatching(app.lastFrame, /interrupted/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 30_000 });

test("/remove on a running worker asks first, and the confirmation removes it", async () => {
  const h = setup();
  const { runId, runDir } = await addRun(h.piFleetDir, "db");
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /. db/);
    app.stdin.write("\t");
    await frameMatching(app.lastFrame, /db \(running\) > /);
    await type(app, "/remove");
    const asked = await frameMatching(app.lastFrame, /Abort it and remove/);
    assert.match(asked, /y remove . n or esc cancel/);
    assert.equal(fs.existsSync(path.join(runDir, "state.json")), true);

    app.stdin.write("n");
    await frameMatching(app.lastFrame, /removal cancelled/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).status, "running");

    await type(app, "/remove");
    await frameMatching(app.lastFrame, /Abort it and remove/);
    app.stdin.write("y");
    await waitFor(
      () => (JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).status === "archived" ? true : undefined),
      { timeoutMs: 15_000 },
    );
    await frameMatching(app.lastFrame, /removed db/);
    // the rail drops it and the selection falls back to the orchestrator
    await frameMatching(app.lastFrame, /orchestrator > /);
    assert.equal(squash(app.lastFrame() ?? "").includes("? db"), false);
    assert.ok(runId.startsWith("db-"));
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });
