import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { AttachView, resumeHint } from "../src/console/AttachView.js";
import { OpenMenu, formatRow, type RunRow } from "../src/console/OpenMenu.js";
import { newRunState, saveState, runDirFor, type RunState } from "../src/state.js";
import { tmpDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(120);
  const frame = lastFrame() ?? "";
  assert.match(frame, /auth · running · glm · no branch/);
  assert.match(frame, /▶ task: create hello.txt/);
  assert.match(frame, /⚙ bash echo hi/);
  assert.match(frame, /Working: wrote hello.txt/);
  assert.match(frame, /\/followup <msg> · \/stop · \/quit/);

  fs.appendFileSync(path.join(runDir, "events.jsonl"),
    JSON.stringify({ type: "steering_delivered", source: "orchestrator", message: "use tabs" }) + "\n");
  await sleep(150);
  assert.match(lastFrame() ?? "", /▶ orchestrator: use tabs/);

  stdin.write("use spaces"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "steer", message: "use spaces" });
  assert.match(lastFrame() ?? "", /→ steer queued: use spaces/);
  stdin.write("/followup then summarize"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "follow_up", message: "then summarize" });
  stdin.write("/stop"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.deepEqual(controls.at(-1), { type: "abort", message: null });
  stdin.write("/quit"); await sleep(40); stdin.write("\r"); await sleep(60);
  assert.equal(quit, true);
  unmount();
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
  await sleep(120);
  const frame = lastFrame() ?? "";
  assert.match(frame, /read-only: run is settled/);
  // ink wraps long lines at the terminal width; compare with whitespace removed
  const squash = (s: string) => s.replace(/\s+/g, "");
  assert.ok(squash(frame).includes(squash(resumeHint(state, runDir))), `frame lacks resume hint:\n${frame}`);
  assert.doesNotMatch(frame, /\/stop · \/quit/);
  stdin.write("hello\r"); await sleep(60);
  assert.equal(controls.length, 0);
  stdin.write("q"); await sleep(60);
  assert.equal(quit, true);
  unmount();
});

test("OpenMenu: renders rows; Enter selects highlighted; r refreshes; q quits", async () => {
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
  await sleep(60);
  const frame = lastFrame() ?? "";
  assert.match(frame, /NAME\s+STATE\s+LAST-ACTIVITY\s+LAST-TOOL\s+STEERED\s+AGE/);
  assert.ok(frame.includes(formatRow(rows[0], now)), `frame lacks row:\n${frame}`);
  assert.match(frame, /auth\s+running\s+-\s+-\s+0\s+1m/);
  stdin.write("\r"); await sleep(60);
  assert.equal(selected?.runId, state.id);
  stdin.write("r"); await sleep(40);
  assert.equal(refreshed, 1);
  stdin.write("q"); await sleep(40);
  assert.equal(quit, 1);
  unmount();
});
