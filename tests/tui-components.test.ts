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
  { key: "orchestrator", glyph: "○", name: "orchestrator", detail: "idle", age: "", target: { kind: "orchestrator" }, attention: false },
  { key: "r1", glyph: "?", name: "db", detail: "needs an answer", age: "3m", target: { kind: "worker", runId: "r1", runDir: "/f/r1" }, attention: true },
];

test("Rail shows what each session is doing and marks the selected one", () => {
  const { lastFrame, unmount } = render(React.createElement(Rail, { items, selectedIndex: 1, width: 26 }));
  try {
    const frame = lastFrame() ?? "";
    assert.match(squash(frame), /○ orchestrator/);
    assert.match(squash(frame), /idle/);
    assert.match(squash(frame), /▸\? db/, "the selection is marked, not only inverted");
    assert.match(squash(frame), /needs an answer/, "the row says what it is doing");
    assert.match(frame, /db\s+3m/, "the age is right-aligned on the name line");
    assert.match(frame, /─{4,}/, "a rule separates the orchestrator from the workers");
  } finally {
    unmount();
  }
  // long names are clipped to the rail, never wrapped
  const long = render(React.createElement(Rail, {
    items: [{ ...items[1], name: "review-orchestrator-mcp-and-more", age: "12m" }],
    selectedIndex: 0,
    width: 20,
  }));
  try {
    for (const line of (long.lastFrame() ?? "").split("\n")) assert.ok(line.length <= 22, `"${line}" is wider than the rail`);
    assert.match(long.lastFrame() ?? "", /…/);
  } finally {
    long.unmount();
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

test("StatusLine shows the selected session: the worker's own model, or the orchestrator's spend", () => {
  const orchestrator = {
    session: { kind: "orchestrator" as const, name: "orchestrator", state: "working", model: "claude-opus-5" },
    sessionId: "6a65a8dd-1111", costUsd: 0.921, numTurns: 5, pendingApprovals: 0,
  };
  assert.match(statusText(orchestrator), /^claude-opus-5 · 6a65a8dd · \$0\.921 · 5 turns · working · /);
  assert.match(statusText({ ...orchestrator, session: { ...orchestrator.session, state: "idle" }, numTurns: 1 }), /1 turn · tab switch/);
  assert.match(statusText({ ...orchestrator, session: { ...orchestrator.session, model: null }, sessionId: null }), /^starting… · no session/);
  assert.match(statusText({ ...orchestrator, pendingApprovals: 2 }), /2 approvals pending/);

  // a worker is selected: its model is the one that matters, not the orchestrator's
  const worker = {
    session: { kind: "worker" as const, name: "review-tui", state: "running", model: "glm-5.3-flash", branch: "pi-fleet/review-tui-1234567" },
    sessionId: "6a65a8dd-1111", costUsd: 0.921, numTurns: 5, pendingApprovals: 0,
  };
  const text = statusText(worker);
  assert.match(text, /^review-tui · running · glm-5\.3-flash · pi-fleet\/review-tui-1234567 · /);
  assert.equal(text.includes("claude-opus-5"), false);
  assert.equal(text.includes("$0.921"), false, "the orchestrator's spend is not this session's business");
  assert.match(statusText({ ...worker, session: { ...worker.session, model: null, branch: null } }), /^review-tui · running · default model · tab switch/);

  const { lastFrame, unmount } = render(React.createElement(StatusLine, worker));
  try {
    assert.match(squash(lastFrame() ?? ""), /review-tui · running · glm-5.3-flash/);
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
