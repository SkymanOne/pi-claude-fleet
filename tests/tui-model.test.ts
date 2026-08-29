import { test } from "node:test";
import assert from "node:assert/strict";
import { initialViewState, reduceOrchestrator, buildRail, summarizeFleetEvents, WORKER_GLYPHS } from "../src/tui/model.js";
import { makeFleetEvent } from "../src/fleet/events.js";
import { newRunState, type RunState } from "../src/state.js";
import { helpText, GLOBAL_KEYS, COMPOSER_KEYS } from "../src/tui/keys.js";

const feed = (msgs: any[]) => msgs.reduce((s, m) => reduceOrchestrator(s, m), initialViewState());
const texts = (s: ReturnType<typeof initialViewState>) => s.lines.map((l) => `${l.kind}|${l.text}`);
/** Blank separator lines are layout, not content; most assertions read better without them. */
const content = (s: ReturnType<typeof initialViewState>) => texts(s).filter((l) => l !== "gap|");

const init = (over: Record<string, unknown> = {}) => ({
  type: "system", subtype: "init", session_id: "sess-12345678", model: "fake-model",
  mcp_servers: [{ name: "fleet", status: "connected" }], ...over,
});

test("a turn: init, our echo, deltas, assistant text and tools, tool results, result", () => {
  const s = initialViewState();
  reduceOrchestrator(s, init());
  assert.equal(s.sessionId, "sess-12345678");
  assert.equal(s.model, "fake-model");
  assert.deepEqual(s.mcpStatus, [{ name: "fleet", status: "connected" }]);
  assert.deepEqual(content(s), ["system|· session sess-123 · fake-model · mcp fleet:connected"]);

  reduceOrchestrator(s, { type: "sent", text: "spawn a worker" });
  assert.equal(s.turnActive, true);
  reduceOrchestrator(s, { type: "user", message: { role: "user", content: "spawn a worker" }, parent_tool_use_id: null });
  assert.equal(content(s).filter((t) => t.startsWith("user|")).length, 1, "the replay of our own message is suppressed");
  assert.deepEqual(s.pendingEchoes, []);

  reduceOrchestrator(s, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Spawn" } }, parent_tool_use_id: null });
  reduceOrchestrator(s, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ing…" } }, parent_tool_use_id: null });
  assert.equal(s.partial, "Spawning…");

  reduceOrchestrator(s, {
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "Spawning add-auth.\nTwo steps." },
      { type: "tool_use", id: "t1", name: "mcp__fleet__fleet_spawn", input: { name: "add-auth", brief: "long brief here" } },
    ] },
    parent_tool_use_id: null,
  });
  assert.equal(s.partial, null, "the finished message replaces the partial");
  reduceOrchestrator(s, {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Spawned add-auth-2026\nmore", is_error: false }] },
    parent_tool_use_id: null,
  });
  reduceOrchestrator(s, { type: "result", subtype: "success", session_id: "s", total_cost_usd: 0.25, num_turns: 3 });

  assert.deepEqual(content(s).slice(1), [
    "user|> spawn a worker",
    "text|Spawning add-auth.",
    "text|Two steps.",
    "tool|⚙ mcp__fleet__fleet_spawn add-auth",
    "tool_result|  ↳ mcp__fleet__fleet_spawn: Spawned add-auth-2026 more",
  ]);
  assert.equal(s.turnActive, false);
  assert.equal(s.costUsd, 0.25);
  assert.equal(s.numTurns, 3);
});

test("assistant markdown is rendered into styled spans, and huge tool output is bounded", () => {
  const s = feed([
    init(),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "## Findings\n\n1. **medium** — `commands.ts:346` is risky\n\nDone." }] }, parent_tool_use_id: null },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "mcp__fleet__fleet_status", input: {} }] }, parent_tool_use_id: null },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: JSON.stringify({ lastAssistantText: "y".repeat(4000) }) }] },
      parent_tool_use_id: null,
    },
  ]);
  const md = s.lines.filter((l) => l.kind === "text");
  assert.deepEqual(md.map((l) => l.md), ["heading", "text", "bullet", "text", "text"]);
  assert.equal(md[0].text, "Findings");
  assert.ok(md[0].spans?.every((sp) => sp.bold));
  assert.ok(md[2].spans?.some((sp) => sp.bold && sp.text === "medium"));
  assert.ok(md[2].spans?.some((sp) => sp.code && sp.text === "commands.ts:346"));
  assert.equal(md[2].text, "1. medium — commands.ts:346 is risky", "the plain text has no markdown syntax left");

  const result = s.lines.find((l) => l.kind === "tool_result")!;
  assert.ok(result.text.length < 260, `tool result stays bounded (was ${result.text.length})`);
  assert.ok(result.text.endsWith("…"));
  assert.equal(result.text.includes("\n"), false);
});

test("a user message we did not send is rendered; a second init is quiet", () => {
  const s = feed([init(), { type: "user", message: { role: "user", content: "typed elsewhere" }, parent_tool_use_id: null }, init()]);
  assert.deepEqual(content(s).filter((t) => t.startsWith("user|")), ["user|> typed elsewhere"]);
  assert.equal(content(s).filter((t) => t.startsWith("system|· session")).length, 1);
});

test("fleet batches render as one line and their replay is suppressed", () => {
  const events = [
    makeFleetEvent({ kind: "settled", runId: "r1", name: "add-auth" }),
    makeFleetEvent({ kind: "question", runId: "r2", name: "db" }),
  ];
  assert.equal(summarizeFleetEvents(events), "settled add-auth · question db");
  const s = initialViewState();
  reduceOrchestrator(s, { type: "fleet", events, text: "<fleet-event …>" });
  reduceOrchestrator(s, { type: "user", message: { role: "user", content: "<fleet-event …>" }, parent_tool_use_id: null });
  assert.deepEqual(content(s), ["fleet|⚑ settled add-auth · question db"]);
});

test("failures, retries, mcp trouble and exit are visible", () => {
  const s = feed([
    init({ mcp_servers: [{ name: "fleet", status: "failed" }] }),
    { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], session_id: "s" },
    { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, error: "overloaded" },
    { type: "exit", code: 143, signal: "SIGTERM" },
  ]);
  const t = content(s);
  assert.ok(t.some((l) => l === "error|! mcp server(s) not connected: fleet:failed"));
  assert.ok(t.some((l) => l.startsWith("error|! turn failed (error_during_execution): boom")));
  assert.ok(t.some((l) => l === "system|↻ api retry 2/5 (overloaded)"));
  assert.ok(t.some((l) => l.startsWith("error|orchestrator exited (code 143, SIGTERM)")));
  assert.equal(s.exited, true);
  assert.equal(s.turnActive, false);
});

test("notices and local errors are lines; unknown messages are ignored", () => {
  const s = feed([{ type: "notice", text: "· steer queued for db" }, { type: "error", text: "! could not write control" }, { type: "mystery" }]);
  assert.deepEqual(content(s), ["system|· steer queued for db", "error|! could not write control"]);
});

test("the rail glyphs the orchestrator and every worker, and flags what needs the human", () => {
  const now = Date.parse("2026-08-29T12:10:00.000Z");
  const mk = (name: string, over: Partial<RunState>): { runId: string; runDir: string; state: RunState } => ({
    runId: `${name}-1`,
    runDir: `/f/runs/${name}-1`,
    state: { ...newRunState({ fleetDir: "/f", runId: `${name}-1`, name, cwd: "/r" }), createdAt: "2026-08-29T12:00:00.000Z", pid: process.pid, ...over },
  });
  const runs = [
    mk("add-auth", { status: "running" }),
    mk("db", { status: "running", pendingQuestion: { id: "q", question: "which?", options: null, context: null, askedAt: "t" } }),
    mk("docs", { status: "settled" }),
    mk("gone", { status: "running", pid: 999_999_999 }),
  ];
  const idle = buildRail({ orchestrator: { turnActive: false, exited: false, pendingApprovals: 0 }, runs, now });
  assert.deepEqual(idle.map((i) => `${i.glyph}${i.name}`), ["○orchestrator", "●add-auth", "?db", "✓docs", "!gone"]);
  assert.deepEqual(idle.map((i) => i.detail), ["idle", "working…", "needs an answer", "done", "monitor gone"]);
  assert.deepEqual(idle.map((i) => i.age), ["", "10m", "10m", "10m", "10m"]);
  // a running worker shows the tool it is in, which is the point of the rail
  assert.equal(
    buildRail({ orchestrator: { turnActive: false, exited: false, pendingApprovals: 0 }, runs: [mk("busy", { status: "running", lastTool: "bash" })], now })[1].detail,
    "⚙ bash",
  );
  assert.equal(
    buildRail({ orchestrator: { turnActive: false, exited: false, pendingApprovals: 0 }, runs: [mk("broke", { status: "error", error: "pi exited with code 1\nmore" })], now })[1].detail,
    "pi exited with code 1",
  );
  assert.deepEqual(
    buildRail({ orchestrator: { turnActive: true, exited: false, pendingApprovals: 0 }, runs: [], now })[0].detail,
    "working…",
    "the orchestrator's row says what it is doing; its model is in the status line",
  );
  assert.deepEqual(idle.map((i) => i.attention), [false, false, true, false, false]);
  assert.deepEqual(idle[1].target, { kind: "worker", runId: "add-auth-1", runDir: "/f/runs/add-auth-1" });
  assert.deepEqual(idle[0].target, { kind: "orchestrator" });

  const busy = buildRail({ orchestrator: { turnActive: true, exited: false, pendingApprovals: 0 }, runs: [], now });
  assert.equal(busy[0].glyph, "●");
  const asking = buildRail({ orchestrator: { turnActive: true, exited: false, pendingApprovals: 2 }, runs: [], now });
  assert.deepEqual([asking[0].glyph, asking[0].detail, asking[0].attention], ["?", "2 to approve", true]);
  const dead = buildRail({ orchestrator: { turnActive: false, exited: true, pendingApprovals: 0 }, runs: [], now });
  assert.deepEqual([dead[0].glyph, dead[0].detail], ["!", "exited"]);
  assert.equal(WORKER_GLYPHS.blocked, "?");
});

test("help text lists every binding once", () => {
  const text = helpText();
  for (const row of [...GLOBAL_KEYS, ...COMPOSER_KEYS]) assert.ok(text.includes(row.keys), row.keys);
  assert.match(text, /^Keys/);
});

test("blocks are separated by blank lines, and thinking is kept short and marked", () => {
  const s = feed([
    init(),
    { type: "sent", text: "do the thing" },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n") },
          { type: "text", text: "Done." },
        ],
      },
      parent_tool_use_id: null,
    },
  ]);
  const kinds = s.lines.map((l) => l.kind);
  assert.ok(kinds.includes("thinking"));
  const thinking = s.lines.filter((l) => l.kind === "thinking");
  assert.equal(thinking.length, 9, "eight lines plus the count of what was left out");
  assert.equal(thinking[0].text, "✻ step 0");
  assert.match(thinking.at(-1)!.text, /… 4 more lines of thinking/);

  // every block starts after a blank line, and blanks never double up
  const gapIndexes = kinds.flatMap((k, i) => (k === "gap" ? [i] : []));
  assert.ok(gapIndexes.length >= 3, `expected separators, got ${kinds.join(",")}`);
  assert.equal(gapIndexes.some((i) => kinds[i + 1] === "gap"), false, "no double blank lines");
  assert.equal(kinds[0] !== "gap" || kinds.length > 1, true);
  const userAt = kinds.indexOf("user");
  assert.equal(kinds[userAt - 1], "gap", "a prompt starts a new block");
  assert.equal(kinds[kinds.indexOf("thinking") - 1], "gap");
  assert.equal(kinds[kinds.lastIndexOf("text") - 1], "gap");
});
