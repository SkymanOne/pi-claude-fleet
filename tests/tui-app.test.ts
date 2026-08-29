import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/App.js";
import { OrchestratorClient } from "../src/orchestrator/client.js";
import { loadOrchestratorState } from "../src/orchestrator/monitor.js";
import { orchestratorPaths } from "../src/orchestrator/records.js";
import { FleetWatcher } from "../src/fleet/watcher.js";
import {
  isAlive,
  newRunState,
  saveState,
  runDirFor,
  type RunState,
} from "../src/state.js";
import { fakeClaudeEnv, tmpDir, waitFor } from "./helpers.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const CTRL_A = String.fromCharCode(1);
const CTRL_G = String.fromCharCode(7);
const CTRL_T = String.fromCharCode(20);
const CTRL_O = String.fromCharCode(15);
const squash = (s: string): string => s.replace(/\s+/g, " ");

interface Harness {
  client: OrchestratorClient;
  restoreEnv: () => void;
  watcher: FleetWatcher;
  piFleetDir: string;
  cwd: string;
  stdinLog: () => string;
  quit: { called: number; reason?: "quit" | "shutdown" };
}

/** The monitor is a detached child, so fake-claude's knobs travel through this process's env. */
function useFakeClaude(over: Record<string, string> = {}): () => void {
  const keys = [
    "PI_FLEET_DEV",
    "PI_FLEET_CLAUDE_BIN",
    "PI_FLEET_PI_BIN",
    "FAKE_CLAUDE_STDIN_LOG",
    "FAKE_CLAUDE_SESSION_ID",
  ];
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

function setup(over: Record<string, string> = {}): Harness {
  const root = tmpDir("pf-app-");
  const piFleetDir = path.join(root, ".pi-fleet");
  fs.mkdirSync(path.join(piFleetDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(piFleetDir, "reports"), { recursive: true });
  const paths = orchestratorPaths(piFleetDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.prompt, "# prompt\n");
  const stdinLogPath = path.join(root, "stdin.log");
  const restoreEnv = useFakeClaude({
    FAKE_CLAUDE_STDIN_LOG: stdinLogPath,
    FAKE_CLAUDE_SESSION_ID: "sess-abcdef12",
    ...over,
  });
  const client = new OrchestratorClient({ piFleetDir, cwd: root, fresh: true, pollMs: 30 });
  client.start();
  const watcher = new FleetWatcher({ piFleetDir, pollMs: 30, batchMs: 20 });
  watcher.start();
  return {
    client,
    restoreEnv,
    watcher,
    piFleetDir,
    cwd: root,
    stdinLog: () => {
      try {
        return fs.readFileSync(stdinLogPath, "utf8");
      } catch {
        return "";
      }
    },
    quit: { called: 0 } as { called: number; reason?: "quit" | "shutdown" },
  };
}

async function addRun(
  piFleetDir: string,
  name: string,
  over: Partial<RunState> = {},
): Promise<{ runId: string; runDir: string }> {
  const runId = `${name}-20260829120000`;
  const runDir = runDirFor(piFleetDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  await saveState(runDir, {
    ...newRunState({ fleetDir: piFleetDir, runId, name, cwd: "/repo" }),
    status: "running",
    pid: process.pid,
    ...over,
  });
  fs.writeFileSync(path.join(runDir, "events.jsonl"), "");
  return { runId, runDir };
}

function renderApp(h: Harness) {
  return render(
    React.createElement(App, {
      client: h.client,
      watcher: h.watcher,
      onQuit: (reason?: "quit" | "shutdown") => {
        h.quit.called += 1;
        h.quit.reason = reason;
      },
      railPollMs: 30,
      reapMs: 0,
      cwd: h.cwd,
    }),
  );
}

// each test spawns a detached orchestrator monitor, its claude child, that
// child's MCP server and a git subprocess for file completion, so the whole
// file runs under load; be patient before calling a frame missing
/**
 * Keys must not land in the same stdin chunk: ink parses a chunk as one
 * keypress, so "down" + "enter" written together become a single escape
 * sequence and neither takes effect.
 */
async function press(
  app: { stdin: { write: (data: string) => void } },
  keys: string,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
  app.stdin.write(keys);
  await new Promise((r) => setTimeout(r, 40));
}

async function frameMatching(
  lastFrame: () => string | undefined,
  re: RegExp,
  timeoutMs = 40_000,
): Promise<string> {
  try {
    return await waitFor(
      () =>
        re.test(squash(lastFrame() ?? ""))
          ? squash(lastFrame() as string)
          : undefined,
      { timeoutMs, intervalMs: 20 },
    );
  } catch (err) {
    // the frame at the moment of failure is the only useful thing here
    throw new Error(
      `${String(err)} waiting for ${re}\nlast frame: ${JSON.stringify(lastFrame())}`,
    );
  }
}

type Rendered = ReturnType<typeof renderApp>;

/**
 * Type into the composer and submit. The two writes must not land in the same
 * tick: TextInput would still hold the old (empty) value when Enter arrives.
 */
async function type(app: Rendered, text: string): Promise<void> {
  await press(app, text);
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await frameMatching(app.lastFrame, new RegExp(`> ${escaped}`));
  await press(app, "\r");
}

async function teardown(
  h: Harness,
  app: { unmount: () => void } | null,
): Promise<void> {
  app?.unmount();
  h.watcher.stop();
  h.client.stop();
  // the orchestrator outlives a console now, so the test has to stop it itself
  const state = loadOrchestratorState(h.piFleetDir);
  if (state?.pid && isAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await waitFor(() => (!isAlive(state.pid) ? true : undefined), {
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }
  h.restoreEnv();
}

test(
  "typing a message shows it, streams the reply, and fills the status line",
  async () => {
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
      assert.equal(
        (frame.match(/> hello there/g) ?? []).length,
        1,
        "the replay of our own message is suppressed",
      );
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "a permission request opens the overlay; y allows it",
  async () => {
    const h = setup();
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /orchestrator > /);
      await type(app, "perm:touch a.txt");
      const overlay = await frameMatching(app.lastFrame, /Run touch a\.txt/);
      assert.match(overlay, /y allow once . a allow for this session . n deny/);
      assert.match(overlay, /1 approval pending/);
      assert.match(overlay, /\? orchestrator/, "the rail flags the approval");
      await press(app, "y");
      await frameMatching(app.lastFrame, /allowed:touch a\.txt/);
      assert.match(
        squash(app.lastFrame() ?? ""),
        /orchestrator > /,
        "the composer is back",
      );
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test("an AskUserQuestion is answered from the list, or in your own words", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "ask:Which hash?|bcrypt|argon2");
    const overlay = await frameMatching(app.lastFrame, /question 1\/1/);
    assert.match(overlay, /Which hash\?/);
    assert.match(overlay, /something else/, "there is always a way to answer in your own words");
    await press(app, DOWN);
    await frameMatching(app.lastFrame, /❯ argon2/);
    await press(app, "\r");
    await frameMatching(app.lastFrame, /answers:\{"Which hash\?":"argon2"\}/);

    // and the same question answered with something the model did not offer
    await type(app, "ask:Which hash?|bcrypt|argon2");
    await frameMatching(app.lastFrame, /question 1\/1/);
    await press(app, DOWN);
    await press(app, DOWN);
    await frameMatching(app.lastFrame, /❯ ✎ something else/);
    await press(app, "\r");
    await frameMatching(app.lastFrame, /answer > /);
    await press(app, "scrypt, actually");
    await frameMatching(app.lastFrame, /answer > scrypt, actually/);
    await press(app, "\r");
    await frameMatching(app.lastFrame, /answers:\{"Which hash\?":"scrypt, actually"\}/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });

test(
  "a worker question reaches the rail and the orchestrator; the human can answer it",
  async () => {
    const h = setup();
    const { runDir } = await addRun(h.piFleetDir, "db");
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /. db/);
      // what the monitor does when it sees the question in the worker's outbox
      fs.appendFileSync(
        path.join(runDir, "events.jsonl"),
        JSON.stringify({
          type: "worker_question",
          questionId: "q_1",
          question: "bcrypt or argon2?",
          options: ["bcrypt", "argon2"],
        }) + "\n",
      );
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state.pendingQuestion = {
        id: "q_1",
        question: "bcrypt or argon2?",
        options: ["bcrypt", "argon2"],
        context: null,
        askedAt: new Date().toISOString(),
      };
      fs.writeFileSync(statePath, JSON.stringify(state));
      await frameMatching(app.lastFrame, /\? db/);
      await frameMatching(app.lastFrame, /question db/);
      const sent = await waitFor(
        () => (h.stdinLog().includes("fleet-event") ? h.stdinLog() : undefined),
        { timeoutMs: 8000 },
      );
      const line = JSON.parse(
        sent.split("\n").find((l) => l.includes("fleet-event"))!,
      );
      assert.match(
        line.message.content,
        /<fleet-event kind="question" run="db-20260829120000" name="db"/,
      );
      assert.match(line.message.content, /question: bcrypt or argon2\?/);
      assert.match(line.message.content, /next: fleet_answer name="db"/);

      await press(app, "\t");
      await frameMatching(app.lastFrame, /db \(running\) > /);
      await frameMatching(app.lastFrame, /bcrypt or argon2/);
      await type(app, "/answer use argon2");
      const control = await waitFor(
        () => {
          try {
            return (
              fs
                .readFileSync(path.join(runDir, "control.jsonl"), "utf8")
                .trim() || undefined
            );
          } catch {
            return undefined;
          }
        },
        { timeoutMs: 8000 },
      );
      const answer = JSON.parse(control.split("\n")[0]);
      assert.deepEqual(
        [answer.type, answer.message, answer.source, answer.questionId],
        ["answer", "use argon2", "console", "q_1"],
      );
      await press(app, "\t");
      await frameMatching(app.lastFrame, /answered db \(q_1\): use argon2/);
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "/help shows the bindings, esc closes it, /quit asks the app to exit",
  async () => {
    const h = setup();
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /orchestrator > /);
      await type(app, "/help");
      await frameMatching(
        app.lastFrame,
        /tab \/ shift-tab next \/ previous session/,
      );
      assert.match(
        squash(app.lastFrame() ?? ""),
        /allow once/,
        "the approval keys are documented too",
      );
      await press(app, ESC);
      await waitFor(
        () =>
          squash(app.lastFrame() ?? "").includes("Composer type + enter")
            ? undefined
            : true,
        { timeoutMs: 5000, intervalMs: 20 },
      );
      assert.equal(h.quit.called, 0);
      await type(app, "/quit");
      await waitFor(() => (h.quit.called > 0 ? true : undefined), {
        timeoutMs: 5000,
      });
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "esc interrupts a running turn",
  async () => {
    const h = setup();
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /orchestrator > /);
      await type(app, "slow:");
      await frameMatching(app.lastFrame, /tick0/);
      await press(app, ESC);
      await frameMatching(app.lastFrame, /interrupted/);
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "/remove on a running worker asks first, and the confirmation removes it",
  async () => {
    const h = setup();
    const { runId, runDir } = await addRun(h.piFleetDir, "db");
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /. db/);
      await press(app, "\t");
      await frameMatching(app.lastFrame, /db \(running\) > /);
      await type(app, "/remove");
      const asked = await frameMatching(app.lastFrame, /Abort it and remove/);
      assert.match(asked, /y remove . n or esc cancel/);
      assert.equal(fs.existsSync(path.join(runDir, "state.json")), true);

      await press(app, "n");
      await frameMatching(app.lastFrame, /removal cancelled/);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"))
          .status,
        "running",
      );

      await type(app, "/remove");
      await frameMatching(app.lastFrame, /Abort it and remove/);
      await press(app, "y");
      await waitFor(
        () =>
          JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"))
            .status === "archived"
            ? true
            : undefined,
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
  },
  { timeout: 60_000 },
);

test(
  "typing / offers commands, tab accepts one, and up recalls what you sent",
  async () => {
    const h = setup();
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /orchestrator > /);
      await type(app, "first message");
      await frameMatching(app.lastFrame, /echo: first message/);

      // the orchestrator only gets the global commands
      await press(app, "/");
      const popup = await frameMatching(
        app.lastFrame,
        /tab or enter to accept/,
      );
      assert.match(popup, /\/help/);
      assert.equal(
        popup.includes("/answer"),
        false,
        "worker-only commands are hidden here",
      );
      assert.match(popup, /tab or enter to accept/);

      // narrowing by alias, then accepting with tab
      await press(app, "q");
      await frameMatching(app.lastFrame, /orchestrator > \/q/);
      await press(app, "\t");
      await frameMatching(app.lastFrame, /> \/quit/);
      assert.equal(h.quit.called, 0, "accepting a suggestion does not run it");
      await press(app, ESC);

      // history recall
      await press(app, UP);
      await frameMatching(app.lastFrame, /> first message/);
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "ctrl shortcuts run commands: ctrl+a prefills an answer, ctrl+g opens help",
  async () => {
    const h = setup();
    await addRun(h.piFleetDir, "db");
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /. db/);
      await press(app, CTRL_G);
      await frameMatching(
        app.lastFrame,
        /tab \/ shift-tab next \/ previous session/,
      );
      await press(app, ESC);
      // ESC immediately followed by another key would arrive as one escape
      // sequence, so wait for the help to actually close first
      await waitFor(
        () =>
          squash(app.lastFrame() ?? "").includes("Composer type + enter")
            ? undefined
            : true,
        { timeoutMs: 5000, intervalMs: 20 },
      );

      // a worker command needs a worker selected
      await press(app, CTRL_A);
      await frameMatching(app.lastFrame, /needs a worker selected/);
      await press(app, "\t");
      await frameMatching(app.lastFrame, /db \(running\) > /);
      await press(app, CTRL_A);
      const prefilled = await frameMatching(
        app.lastFrame,
        /db \(running\) > \/answer/,
      );
      assert.equal(
        /> \/answer\s*a/.test(prefilled),
        false,
        "the ctrl keypress itself is not typed into the composer",
      );
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "a long transcript never pushes the rail off the screen",
  async () => {
    const h = setup();
    const { runDir } = await addRun(h.piFleetDir, "chatty");
    // a worker with far more output than the terminal has rows
    const events = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        type: "tool_execution_start",
        toolName: "bash",
        args: { command: `step ${i} ${"x".repeat(60)}` },
      }),
    ).join("\n");
    fs.writeFileSync(path.join(runDir, "events.jsonl"), events + "\n");
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /. chatty/);
      await press(app, "\t");
      await frameMatching(app.lastFrame, /chatty \(running\) > /);
      await frameMatching(app.lastFrame, /step 199/);
      const frame = app.lastFrame() ?? "";
      const rows = frame.split("\n").length;
      assert.ok(
        rows <= (process.stdout.rows || 24) + 2,
        `frame is ${rows} rows, terminal is ${process.stdout.rows || 24}`,
      );
      // the rail and the status line survive alongside the transcript
      assert.match(squash(frame), /orchestrator/);
      assert.match(squash(frame), /chatty/);
      assert.match(squash(frame), /tab switch/);
      assert.match(squash(frame), /earlier lines/);
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test(
  "/shutdown asks, then stops every worker and leaves",
  async () => {
    const h = setup();
    const { runDir } = await addRun(h.piFleetDir, "busy");
    const app = renderApp(h);
    try {
      await frameMatching(app.lastFrame, /. busy/);
      await type(app, "/shutdown");
      const asked = await frameMatching(
        app.lastFrame,
        /Stop the orchestrator and 1 running worker/,
      );
      assert.match(asked, /Worktrees and branches are kept/);
      assert.equal(h.quit.called, 0);
      await press(app, "n");
      await frameMatching(app.lastFrame, /shutdown cancelled/);
      assert.equal(
        fs.existsSync(path.join(runDir, "control.jsonl")),
        false,
        "cancelling touches nothing",
      );

      await type(app, "/sd");
      await frameMatching(app.lastFrame, /Stop the orchestrator/);
      await press(app, "y");
      await waitFor(() => (h.quit.called > 0 ? true : undefined), {
        timeoutMs: 10_000,
      });
      const control = fs.readFileSync(
        path.join(runDir, "control.jsonl"),
        "utf8",
      );
      assert.match(control, /"type":"abort"/);
    } finally {
      await teardown(h, app);
    }
  },
  { timeout: 60_000 },
);

test("/thinking sets the orchestrator's effort without saying anything to it", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "/thinking nonsense");
    await frameMatching(app.lastFrame, /usage: \/thinking <low\|medium\|high\|xhigh\|max>/);

    await type(app, "/thinking high");
    const frame = await frameMatching(app.lastFrame, /· thinking high/);
    assert.match(frame, /thinking high · tab switch/, "the status line carries the level");
    assert.equal(frame.includes("/effort"), false, "it is a settings change, not a message");
    await waitFor(
      () => (loadOrchestratorState(h.piFleetDir)?.effort === "high" ? true : undefined),
      { timeoutMs: 15_000 },
    );
    assert.equal(h.stdinLog().includes('"/effort'), false, "nothing was said to the model");
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });

test("/permissions reports the mode, rejects nonsense, and sets auto", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    await type(app, "/permissions");
    await frameMatching(app.lastFrame, /permissions: default/);
    assert.match(squash(app.lastFrame() ?? ""), /every action outside the allowlist asks you/);

    await type(app, "/permissions bypassPermissions");
    await frameMatching(app.lastFrame, /would skip the approval overlay/);
    await type(app, "/p nonsense");
    await frameMatching(app.lastFrame, /usage: \/permissions <default\|auto\|acceptEdits\|dontAsk\|plan>/);

    await type(app, "/p auto");
    await frameMatching(app.lastFrame, /permissions → auto: a classifier approves routine actions/);
    await waitFor(
      () => (loadOrchestratorState(h.piFleetDir)?.permissionMode === "auto" ? true : undefined),
      { timeoutMs: 15_000 },
    );
    // and the status line says so, since it is no longer the default
    await frameMatching(app.lastFrame, /perms auto/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });

test("ctrl+t steps the level of the open session, as a toolbar note rather than a chat turn", async () => {
  const h = setup();
  const { runDir } = await addRun(h.piFleetDir, "db", { thinkingLevel: "medium" });
  const app = renderApp(h);
  try {
    // the orchestrator cycles claude's effort levels
    await frameMatching(app.lastFrame, /orchestrator > /);
    await press(app, CTRL_T);
    await frameMatching(app.lastFrame, /· thinking low/);
    await press(app, CTRL_T);
    const second = await frameMatching(app.lastFrame, /· thinking medium/);
    // nothing about it is said to the model, and the composer is untouched
    assert.equal(second.includes("/effort"), false, "the level change is not a message");
    assert.equal(/> \/thinking/.test(second), false, "nor a prompt in the transcript");
    assert.match(second, /orchestrator > \/help/, "the composer is still empty");
    assert.match(second, /thinking medium · tab switch/, "and the status line carries it");
    assert.equal(h.stdinLog().includes("/effort"), false, "claude was told through a settings merge");
    assert.equal(
      fs.existsSync(path.join(runDir, "control.jsonl")),
      false,
      "cycling the orchestrator does not touch a worker",
    );

    // the worker cycles pi's, from the level it reports
    await press(app, "\t");
    await frameMatching(app.lastFrame, /db \(running\) > /);
    await press(app, CTRL_T);
    await frameMatching(app.lastFrame, /db thinking level → high/);
    const control = await waitFor(
      () => {
        try {
          return fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim() || undefined;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 10_000 },
    );
    const line = JSON.parse(control.split("\n")[0]);
    assert.deepEqual([line.type, line.message, line.source], ["thinking", "high", "console"]);

    // back on the orchestrator, its own cycle carried on where it was
    await press(app, "\t");
    await frameMatching(app.lastFrame, /orchestrator > /);
    await press(app, CTRL_T);
    await frameMatching(app.lastFrame, /· thinking high/);
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });

test("ctrl+o prefills /permissions on the orchestrator, and a typo is caught rather than sent", async () => {
  const h = setup();
  const app = renderApp(h);
  try {
    await frameMatching(app.lastFrame, /orchestrator > /);
    // /permissions is not a worker command: its shortcut must work here
    await press(app, CTRL_O);
    const prefilled = await frameMatching(app.lastFrame, /orchestrator > \/permissions/);
    assert.equal(prefilled.includes("needs a worker selected"), false);
    // submit it to clear the composer; with no argument it reports the mode
    await press(app, "\r");
    await frameMatching(app.lastFrame, /permissions: default/);

    // a mistyped command is reported, not sent to the model as a question
    await type(app, "/pemissions auto");
    await frameMatching(app.lastFrame, /unknown command \/pemissions — did you mean \/permissions\?/);
    assert.equal(h.stdinLog().includes("/pemissions"), false, "nothing was sent");

    // one claude does offer still goes through
    await waitFor(() => (h.client.state?.commands?.length ? true : undefined), { timeoutMs: 15_000 });
    await type(app, "/model sonnet");
    await waitFor(() => (h.stdinLog().includes("/model sonnet") ? true : undefined), { timeoutMs: 15_000 });
  } finally {
    await teardown(h, app);
  }
}, { timeout: 60_000 });

test("reopening the console shows the conversation that is already there", async () => {
  const h = setup();
  const first = renderApp(h);
  try {
    await frameMatching(first.lastFrame, /orchestrator > /);
    await type(first, "remember this line");
    await frameMatching(first.lastFrame, /remember this line/);
    await frameMatching(first.lastFrame, /echo: remember this line/);
  } finally {
    first.unmount();
    h.client.stop();
  }

  // a second console over the same orchestrator, wired the way the real one is:
  // the client starts and replays before anything renders
  const client = new OrchestratorClient({ piFleetDir: h.piFleetDir, cwd: h.cwd, pollMs: 30 });
  const { attached } = client.start();
  assert.equal(attached, true, "it attaches rather than starting a second orchestrator");
  const second = render(
    React.createElement(App, {
      client,
      watcher: h.watcher,
      onQuit: () => {},
      railPollMs: 30,
      reapMs: 0,
      cwd: h.cwd,
    }),
  );
  try {
    const frame = await frameMatching(second.lastFrame, /echo: remember this line/);
    assert.match(frame, /remember this line/, "the prompt is there too");
    assert.equal(frame.includes("orchestrator exited"), false, "and it is not read as an exit");
  } finally {
    second.unmount();
    client.stop();
    await teardown(h, null);
  }
}, { timeout: 60_000 });
