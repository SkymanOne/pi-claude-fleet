import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { AttachView, resumeHint } from "../src/console/AttachView.js";
import { OpenMenu, formatRow, type RunRow } from "../src/console/OpenMenu.js";
import { newRunState, saveState, runDirFor, type RunState } from "../src/state.js";
import { tmpDir, waitFor } from "./helpers.js";

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
/** Poll the last frame until it matches — rendering is asynchronous. */
const frameMatching = (lastFrame: () => string | undefined, re: RegExp) =>
  waitFor(() => (re.test(lastFrame() ?? "") ? (lastFrame() ?? "") : undefined), { timeoutMs: 5000, intervalMs: 15 });
const until = (fn: () => boolean) => waitFor(() => (fn() ? true : undefined), { timeoutMs: 5000, intervalMs: 15 });

async function fixtureRun(status: RunState["status"]): Promise<{ runDir: string; state: RunState }> {
  const fleetDir = path.join(tmpDir("pf-view-"), ".pi-fleet");
  const runDir = runDirFor(fleetDir, "auth-20260828141530");
  fs.mkdirSync(runDir, { recursive: true });
  const state = newRunState({ fleetDir, runId: "auth-20260828141530", name: "auth", cwd: "/x", model: "glm" });
  state.status = status;
  state.pid = process.pid; // alive → deriveStatus keeps "running"
  await saveState(runDir, state);
  fs.writeFileSync(
    path.join(runDir, "events.jsonl"),
    [
      JSON.stringify({ type: "task_prompt", brief: "create hello.txt" }),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" } }),
      JSON.stringify({ type: "message_update", ev: { type: "text_end", contentIndex: 0, content: "Working: wrote hello.txt" } }),
    ].join("\n") + "\n",
  );
  return { runDir, state };
}

test("AttachView (running): replays, follows new events, sends steer/followup/stop, quits", async () => {
  const { runDir } = await fixtureRun("running");
  const controls: Array<{ type: string; message: string | null }> = [];
  let quit = false;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(AttachView, {
      runDir,
      pollMs: 40,
      writeControl: (type, message) => { controls.push({ type, message }); },
      onQuit: () => { quit = true; },
    }),
  );
  try {
    const frame = await frameMatching(lastFrame, /\/followup <msg> · \/stop · \/quit/);
    assert.match(frame, /auth · running · glm · no branch/);
    assert.match(frame, /▶ task: create hello.txt/);
    assert.match(frame, /⚙ bash echo hi/);
    assert.match(frame, /Working: wrote hello.txt/);

    fs.appendFileSync(path.join(runDir, "events.jsonl"),
      JSON.stringify({ type: "steering_delivered", source: "orchestrator", message: "use tabs" }) + "\n");
    await frameMatching(lastFrame, /▶ orchestrator: use tabs/);

    stdin.write("use spaces");
    await frameMatching(lastFrame, /> use spaces/);
    stdin.write("\r");
    await until(() => controls.at(-1)?.message === "use spaces");
    assert.deepEqual(controls.at(-1), { type: "steer", message: "use spaces" });
    await frameMatching(lastFrame, /→ steer queued: use spaces/);

    stdin.write("/followup then summarize");
    await frameMatching(lastFrame, /> \/followup then summarize/);
    stdin.write("\r");
    await until(() => controls.at(-1)?.type === "follow_up");
    assert.deepEqual(controls.at(-1), { type: "follow_up", message: "then summarize" });

    stdin.write("/stop");
    await frameMatching(lastFrame, /> \/stop/);
    stdin.write("\r");
    await until(() => controls.at(-1)?.type === "abort");
    assert.deepEqual(controls.at(-1), { type: "abort", message: null });

    stdin.write("/quit");
    await frameMatching(lastFrame, /> \/quit/);
    stdin.write("\r");
    await until(() => quit);
  } finally {
    unmount();
  }
});

test("AttachView (settled): read-only with resume hint; q quits; typing sends nothing", async () => {
  const { runDir, state } = await fixtureRun("settled");
  const controls: unknown[] = [];
  let quit = false;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(AttachView, {
      runDir, pollMs: 40,
      writeControl: (type, message) => { controls.push({ type, message }); },
      onQuit: () => { quit = true; },
    }),
  );
  try {
    const frame = await frameMatching(lastFrame, /read-only: run is settled/);
    // ink wraps long lines at the terminal width; compare with whitespace removed
    const squash = (s: string) => s.replace(/\s+/g, "");
    assert.ok(squash(frame).includes(squash(resumeHint(state, runDir))), `frame lacks resume hint:\n${frame}`);
    assert.doesNotMatch(frame, /\/stop · \/quit/);
    stdin.write("hello\r");
    await settle(); // negative check: nothing should be written
    assert.equal(controls.length, 0);
    stdin.write("q");
    await until(() => quit);
  } finally {
    unmount();
  }
});

test("OpenMenu: renders numbered rows; Enter selects highlighted; r refreshes; q quits", async () => {
  const { runDir, state } = await fixtureRun("running");
  const rows: RunRow[] = [{ runId: state.id, runDir, state }];
  const now = Date.parse(state.createdAt) + 90_000;
  let selected: RunRow | null = null;
  let quit = 0;
  let refreshed = 0;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(OpenMenu, {
      runs: rows, now,
      onSelect: (r) => { selected = r; }, onQuit: () => { quit++; }, onRefresh: () => { refreshed++; },
    }),
  );
  try {
    const frame = await frameMatching(lastFrame, /NAME\s+STATE\s+LAST-ACTIVITY\s+LAST-TOOL\s+STEERED\s+AGE/);
    assert.ok(frame.includes(`1 ${formatRow(rows[0], now)}`), `frame lacks numbered row:\n${frame}`);
    assert.match(frame, /auth\s+running\s+-\s+-\s+0\s+1m/);
    stdin.write("\r");
    await until(() => selected?.runId === state.id);
    stdin.write("r");
    await until(() => refreshed === 1);
    stdin.write("q");
    await until(() => quit === 1);
  } finally {
    unmount();
  }
});
