import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { Rail } from "../src/tui/Rail.js";
import { Transcript, colorFor } from "../src/tui/Transcript.js";
import { WorkerTranscript } from "../src/tui/WorkerTranscript.js";
import { StatusLine, statusText } from "../src/tui/StatusLine.js";
import type { RailItem } from "../src/tui/model.js";
import { tmpDir, waitFor } from "./helpers.js";

const squash = (s: string): string => s.replace(/\s+/g, " ");
const frameMatching = (lastFrame: () => string | undefined, re: RegExp): Promise<string> =>
  waitFor(() => (re.test(lastFrame() ?? "") ? (lastFrame() as string) : undefined), { timeoutMs: 5000, intervalMs: 15 });

const items: RailItem[] = [
  { key: "orchestrator", glyph: "○", name: "orchestrator", detail: "idle", target: { kind: "orchestrator" }, attention: false },
  { key: "r1", glyph: "?", name: "db", detail: "blocked 3m", target: { kind: "worker", runId: "r1", runDir: "/f/r1" }, attention: true },
];

test("Rail lists sessions with glyphs and shows the selected row's detail", () => {
  const { lastFrame, unmount } = render(React.createElement(Rail, { items, selectedIndex: 1 }));
  try {
    const frame = squash(lastFrame() ?? "");
    assert.match(frame, /○ orchestrator/);
    assert.match(frame, /\? db/);
    assert.match(frame, /blocked 3m/);
  } finally {
    unmount();
  }
});

test("Transcript keeps the tail that fits the pane and says what it hid", () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({ kind: "text" as const, text: `line${i}` }));
  // 4 rows: one for the streaming partial, three for lines
  const { lastFrame, unmount } = render(React.createElement(Transcript, { lines, partial: "typing", maxRows: 4, width: 40 }));
  try {
    const frame = lastFrame() ?? "";
    assert.equal(frame.includes("line1"), false, "older lines are dropped");
    assert.match(frame, /line2[\s\S]*line4/);
    assert.match(frame, /typing/);
    assert.match(frame, /… 2 earlier lines/);
  } finally {
    unmount();
  }
  // a long line wraps, so fewer of them fit
  const wide = [{ kind: "text" as const, text: "x".repeat(90) }, { kind: "text" as const, text: "short" }];
  const narrow = render(React.createElement(Transcript, { lines: wide, maxRows: 2, width: 30 }));
  try {
    const frame = narrow.lastFrame() ?? "";
    assert.match(frame, /short/);
    assert.equal(frame.includes("xxx"), false, "the wrapped line would not fit");
    assert.match(frame, /… 1 earlier line$/m);
  } finally {
    narrow.unmount();
  }
  assert.deepEqual(colorFor("user"), { color: "cyan", bold: true });
  assert.deepEqual(colorFor("error"), { color: "red" });
  assert.deepEqual(colorFor("text"), {});
});

test("StatusLine shows model, session, cost, turns and pending approvals", () => {
  const props = { model: "fake-model", sessionId: "sess-12345678", costUsd: 0.125, numTurns: 1, pendingApprovals: 2, turnActive: true };
  assert.match(statusText(props), /^fake-model · sess-123 · \$0\.125 · 1 turn · working · 2 approvals pending · /);
  assert.match(statusText({ ...props, numTurns: 2, pendingApprovals: 0, turnActive: false }), /2 turns · tab switch/);
  assert.match(statusText({ ...props, model: null, sessionId: null }), /^starting… · no session/);
  const { lastFrame, unmount } = render(React.createElement(StatusLine, props));
  try {
    assert.match(squash(lastFrame() ?? ""), /fake-model · sess-123/);
  } finally {
    unmount();
  }
});

test("WorkerTranscript replays a run's events and follows new ones", async () => {
  const runDir = tmpDir("pf-wt-");
  const eventsPath = path.join(runDir, "events.jsonl");
  fs.writeFileSync(eventsPath, JSON.stringify({ type: "task_prompt", brief: "write hello.txt" }) + "\n");
  const { lastFrame, unmount } = render(React.createElement(WorkerTranscript, { runDir, pollMs: 20 }));
  try {
    await frameMatching(lastFrame, /task: write hello\.txt/);
    fs.appendFileSync(eventsPath, JSON.stringify({ type: "worker_question", questionId: "q1", question: "bcrypt or argon2?", options: ["bcrypt", "argon2"] }) + "\n");
    const frame = await frameMatching(lastFrame, /bcrypt or argon2/);
    assert.match(squash(frame), /\? bcrypt or argon2\? \[bcrypt \| argon2\]/);
  } finally {
    unmount();
  }
});

test("WorkerTranscript on an empty run says so", async () => {
  const runDir = tmpDir("pf-wt-empty-");
  const { lastFrame, unmount } = render(React.createElement(WorkerTranscript, { runDir, pollMs: 20 }));
  try {
    await frameMatching(lastFrame, /no events captured yet/);
  } finally {
    unmount();
  }
});
