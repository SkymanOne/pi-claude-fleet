/**
 * Pure view state for the TUI: the orchestrator transcript, and the rail rows.
 * Everything here is a function of messages already received, so the components
 * stay presentational and the reducer is testable without a process.
 */
import { deriveView, modelLabel, type DerivedView, type RunState } from "../state.js";
import { summarizeArgs } from "../console/transcript.js";
import { firstLine, formatAge } from "../util.js";
import { parseMarkdownBlock, oneLine, type MdLine, type Span } from "./markdown.js";
import type { FleetEvent } from "../fleet/events.js";
import {
  isSystemInit,
  isAssistant,
  isUser,
  isResult,
  isStreamEvent,
  textDeltaOf,
  textOfAssistant,
  toolUsesOf,
  toolResultsOf,
  isReplayedUserMessage,
  thinkingOfAssistant,
  userText,
  type ClaudeStreamMessage,
} from "../orchestrator/protocol.js";

export type OrchestratorLineKind = "user" | "fleet" | "text" | "thinking" | "tool" | "tool_result" | "system" | "error" | "gap";

export interface OrchestratorLine {
  kind: OrchestratorLineKind;
  text: string;
  /** Styled segments for markdown-rendered lines; plain `text` is used when absent. */
  spans?: Span[];
  /** The markdown block element this line came from, so the view can style it. */
  md?: MdLine["kind"];
}

export interface Activity {
  kind: "thinking" | "responding" | "tool";
  /** The tool being run, when that is what it is doing. */
  label?: string;
  /** Epoch millis this activity started, for the elapsed counter. */
  since: number;
}

export interface OrchestratorViewState {
  lines: OrchestratorLine[];
  /** What the orchestrator is doing right now, or null between turns. */
  activity: Activity | null;
  /** Text the model is still streaming, not yet a committed line. */
  partial: string | null;
  turnActive: boolean;
  sessionId: string | null;
  model: string | null;
  costUsd: number;
  numTurns: number;
  exited: boolean;
  /** tool_use_id → tool name, so results can name their tool. */
  toolNames: Record<string, string>;
  mcpStatus: { name: string; status: string }[];
  /** Texts we sent and already rendered ourselves; their replay is suppressed. */
  pendingEchoes: string[];
}

export function initialViewState(): OrchestratorViewState {
  return {
    lines: [],
    activity: null,
    partial: null,
    turnActive: false,
    sessionId: null,
    model: null,
    costUsd: 0,
    numTurns: 0,
    exited: false,
    toolNames: {},
    mcpStatus: [],
    pendingEchoes: [],
  };
}

/** Things that happen in the app rather than on the wire. */
export type LocalEvent =
  | { type: "sent"; text: string; display?: string; kind?: OrchestratorLineKind }
  | { type: "stream_text"; text: string }
  | { type: "activity"; activity: Activity | null }
  | { type: "fleet"; events: FleetEvent[]; text: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
  | { type: "exit"; code: number | null; signal: string | null };

const MAX_LINES = 500;

function trim(state: OrchestratorViewState): void {
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
}

/**
 * How much of a tool call and of its output the transcript shows. A command is
 * written by the model and is the thing worth reading, so it gets room; output
 * can be megabytes, so it gets a preview.
 */
const TOOL_ARGS = { maxLines: 10, maxChars: 1200 };
const TOOL_RESULT = { maxLines: 4, maxChars: 600 };

/** The arguments as written, not a one-line digest of them. */
function toolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const a = input as Record<string, unknown>;
  const primary = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.name ?? a.target;
  return typeof primary === "string" ? primary.trim() : JSON.stringify(a);
}

/**
 * Push text over as many lines as it takes, up to a bound. What is left out is
 * counted rather than hidden behind a bare ellipsis, so it is clear that there
 * is more and roughly how much.
 */
function pushBlock(
  state: OrchestratorViewState,
  kind: OrchestratorLineKind,
  prefix: string,
  text: string,
  { maxLines, maxChars }: { maxLines: number; maxChars: number },
): void {
  const lines = text.split("\n");
  const shown: string[] = [];
  let budget = maxChars;
  let cutMidLine = false;
  for (const line of lines) {
    if (shown.length >= maxLines || budget <= 0) break;
    if (line.length > budget) {
      shown.push(line.slice(0, budget));
      cutMidLine = true;
      budget = 0;
      break;
    }
    shown.push(line);
    budget -= line.length;
  }
  const indent = " ".repeat(Math.min(prefix.length, 6));
  shown.forEach((line, i) => {
    push(state, kind, i === 0 ? `${prefix}${line}`.trimEnd() : `${indent}${line}`.trimEnd());
  });
  if (shown.length === 0) push(state, kind, prefix.trimEnd());
  const restLines = lines.length - shown.length;
  const restChars = text.length - shown.reduce((n, l) => n + l.length + 1, -1);
  if (restLines > 0) {
    push(state, kind, `${indent}… ${restLines} more ${restLines === 1 ? "line" : "lines"}`);
  } else if (cutMidLine && restChars > 0) {
    push(state, kind, `${indent}… ${restChars} more characters`);
  }
}

function push(state: OrchestratorViewState, kind: OrchestratorLineKind, text: string): void {
  for (const line of text.split("\n")) state.lines.push({ kind, text: line });
  trim(state);
}

/** A blank line between blocks, so a turn does not read as one wall of text. */
function gap(state: OrchestratorViewState): void {
  const last = state.lines[state.lines.length - 1];
  if (state.lines.length === 0 || last.kind === "gap") return;
  state.lines.push({ kind: "gap", text: "" });
}

/** Reasoning is long and secondary: show the head of it, dimmed, and say what was left out. */
const THINKING_LINES = 8;

function pushThinking(state: OrchestratorViewState, text: string): void {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  gap(state);
  const shown = lines.slice(0, THINKING_LINES);
  shown.forEach((line, i) => state.lines.push({ kind: "thinking", text: `${i === 0 ? "✻ " : "  "}${line}` }));
  if (lines.length > shown.length) {
    state.lines.push({ kind: "thinking", text: `  … ${lines.length - shown.length} more line${lines.length - shown.length === 1 ? "" : "s"} of thinking` });
  }
  trim(state);
}

/** Assistant prose is markdown; render it into styled lines rather than dumping the source. */
function pushMarkdown(state: OrchestratorViewState, text: string): void {
  gap(state);
  for (const line of parseMarkdownBlock(text)) {
    state.lines.push({ kind: "text", text: line.spans.map((s) => s.text).join(""), spans: line.spans, md: line.kind });
  }
  trim(state);
}

/** What the model is doing when it emits a thinking block. */
function thinkingKindOf(msg: { event?: { type?: string; delta?: { type?: string }; content_block?: { type?: string } } }): boolean {
  const ev = msg.event;
  if (!ev) return false;
  if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") return true;
  return ev.type === "content_block_start" && ev.content_block?.type === "thinking";
}

/** `settled add-auth · question db` — a fleet batch as one rail-friendly line. */
export function summarizeFleetEvents(events: FleetEvent[]): string {
  return events.map((e) => `${e.kind} ${e.name}`).join(" · ");
}

const isLocal = (msg: ClaudeStreamMessage | LocalEvent): msg is LocalEvent =>
  ["sent", "fleet", "notice", "error", "exit", "stream_text", "activity"].includes((msg as LocalEvent).type);

/** Fold one message (wire or local) into the view state; mutates and returns it. */
export function reduceOrchestrator(state: OrchestratorViewState, msg: ClaudeStreamMessage | LocalEvent): OrchestratorViewState {
  if (isLocal(msg)) {
    switch (msg.type) {
      case "sent":
        state.pendingEchoes.push(msg.text);
        state.activity = { kind: "thinking", since: Date.now() };
        gap(state);
        push(state, msg.kind ?? "user", `> ${msg.display ?? msg.text}`);
        state.turnActive = true;
        return state;
      case "fleet":
        state.pendingEchoes.push(msg.text);
        gap(state);
        push(state, "fleet", `⚑ ${summarizeFleetEvents(msg.events)}`);
        return state;
      case "stream_text":
        // coalesced token deltas from the monitor
        state.partial = (state.partial ?? "") + msg.text;
        state.turnActive = true;
        return state;
      case "activity":
        state.activity = msg.activity;
        if (msg.activity) state.turnActive = true;
        return state;
      case "notice":
        push(state, "system", msg.text);
        return state;
      case "error":
        push(state, "error", msg.text);
        return state;
      case "exit":
        state.exited = true;
        state.turnActive = false;
        state.activity = null;
        push(state, "error", `orchestrator exited (code ${msg.code ?? "?"}${msg.signal ? `, ${msg.signal}` : ""})`);
        return state;
    }
  }

  if (isSystemInit(msg)) {
    const fresh = state.sessionId === null;
    state.sessionId = msg.session_id;
    state.model = msg.model ?? state.model;
    state.mcpStatus = msg.mcp_servers ?? state.mcpStatus;
    const failed = state.mcpStatus.filter((s) => s.status !== "connected" && s.status !== "pending");
    if (fresh) {
      push(state, "system", `· session ${msg.session_id.slice(0, 8)} · ${msg.model ?? "default model"} · mcp ${state.mcpStatus.map((s) => `${s.name}:${s.status}`).join(", ") || "none"}`);
    }
    if (failed.length > 0) push(state, "error", `! mcp server(s) not connected: ${failed.map((s) => `${s.name}:${s.status}`).join(", ")}`);
    return state;
  }

  if (isStreamEvent(msg)) {
    const delta = textDeltaOf(msg);
    if (delta !== null) {
      state.partial = (state.partial ?? "") + delta;
      state.turnActive = true;
      state.activity = state.activity?.kind === "responding" ? state.activity : { kind: "responding", since: Date.now() };
      return state;
    }
    const kind = thinkingKindOf(msg);
    if (kind) {
      state.turnActive = true;
      if (state.activity?.kind !== "thinking") state.activity = { kind: "thinking", since: Date.now() };
    }
    return state;
  }

  if (isAssistant(msg)) {
    state.turnActive = true;
    state.partial = null;
    pushThinking(state, thinkingOfAssistant(msg));
    const text = textOfAssistant(msg).trim();
    if (text) pushMarkdown(state, text);
    const tools = toolUsesOf(msg);
    for (const tool of tools) {
      state.toolNames[tool.id] = tool.name;
      // the command itself is the thing worth reading, so it is not cut: ink
      // wraps it and the row budget counts the rows it takes
      pushBlock(state, "tool", `⚙ ${tool.name} `, toolArgs(tool.input), TOOL_ARGS);
    }
    if (tools.length > 0) state.activity = { kind: "tool", label: tools[tools.length - 1].name, since: Date.now() };
    return state;
  }

  if (isUser(msg)) {
    if (isReplayedUserMessage(msg)) {
      const text = userText(msg) ?? "";
      const at = state.pendingEchoes.indexOf(text);
      // our own message coming back; we already rendered it
      if (at !== -1) {
        state.pendingEchoes.splice(at, 1);
        return state;
      }
      push(state, "user", `> ${text}`);
      return state;
    }
    for (const result of toolResultsOf(msg)) {
      const name = state.toolNames[result.toolUseId] ?? "tool";
      // tool output can be one enormous line (a whole state.json, a report);
      // the transcript shows a bounded preview, the tools show the rest
      const body = result.text.trim() || (result.isError ? "(error)" : "(no output)");
      pushBlock(state, "tool_result", `  ↳ ${name}: `, body, TOOL_RESULT);
    }
    return state;
  }

  if (isResult(msg)) {
    state.turnActive = false;
    state.partial = null;
    state.activity = null;
    if (typeof msg.total_cost_usd === "number") state.costUsd = msg.total_cost_usd;
    if (typeof msg.num_turns === "number") state.numTurns = msg.num_turns;
    if (msg.is_error) push(state, "error", `! turn failed (${msg.subtype})${msg.errors?.length ? `: ${msg.errors.join("; ")}` : ""}`);
    return state;
  }

  if (msg.type === "system" && (msg as { subtype?: string }).subtype === "api_retry") {
    const m = msg as { attempt?: number; max_retries?: number; error?: string };
    push(state, "system", `↻ api retry ${m.attempt ?? "?"}/${m.max_retries ?? "?"}${m.error ? ` (${m.error})` : ""}`);
    return state;
  }

  return state;
}

// ---------------------------------------------------------------------------
// Rail

export type SessionTarget = { kind: "orchestrator" } | { kind: "worker"; runId: string; runDir: string };

export interface RailItem {
  key: string;
  glyph: string;
  name: string;
  /** What it is doing right now, shown under the name; the glyph carries the state. */
  detail: string;
  /** How long it has been alive, right-aligned on the name line. */
  age: string;
  target: SessionTarget;
  /** Needs the human: an approval to answer, or a worker blocked on a question. */
  attention: boolean;
}

export const WORKER_GLYPHS: Record<DerivedView, string> = {
  starting: "…",
  running: "●",
  blocked: "?",
  settled: "✓",
  stopped: "■",
  error: "!",
  dead: "!",
  archived: "·",
};

export interface RailRun {
  runId: string;
  runDir: string;
  state: RunState;
}

/**
 * What a worker is doing, for the line under its name. The glyph already says
 * running/blocked/settled, so this is the operation, not the state.
 */
export function workerActivity(state: RunState, view: DerivedView): string {
  switch (view) {
    case "blocked":
      return "needs an answer";
    case "running":
      if (state.activity === "thinking") return "✻ thinking…";
      if (state.activity === "text") return "✎ replying…";
      return state.lastTool ? `⚙ ${state.lastTool}` : "working…";
    case "starting":
      return "starting…";
    case "settled":
      return "done";
    case "error":
      return state.error ? firstLine(state.error) : "failed";
    case "dead":
      return "monitor gone";
    default:
      return view;
  }
}

export function buildRail(args: {
  orchestrator: { turnActive: boolean; exited: boolean; pendingApprovals: number; model?: string | null };
  runs: RailRun[];
  now?: number;
}): RailItem[] {
  const now = args.now ?? Date.now();
  const o = args.orchestrator;
  const orchestratorState = o.exited ? "exited" : o.pendingApprovals > 0 ? `${o.pendingApprovals} to approve` : o.turnActive ? "working…" : "idle";
  const items: RailItem[] = [
    {
      key: "orchestrator",
      glyph: o.exited ? "!" : o.pendingApprovals > 0 ? "?" : o.turnActive ? "●" : "○",
      name: "orchestrator",
      detail: orchestratorState,
      age: "",
      target: { kind: "orchestrator" },
      attention: o.pendingApprovals > 0 || o.exited,
    },
  ];
  for (const run of args.runs) {
    const view = deriveView(run.state, undefined, now);
    const age = formatAge(Math.max(0, now - Date.parse(run.state.createdAt)));
    items.push({
      key: run.runId,
      glyph: WORKER_GLYPHS[view] ?? "·",
      name: run.state.name,
      detail: workerActivity(run.state, view),
      age,
      target: { kind: "worker", runId: run.runId, runDir: run.runDir },
      attention: view === "blocked",
    });
  }
  return items;
}

/** The current activity of a live process, for the monitor to record. */
export function activityOf(proc: { turnActive: boolean; activity?: Activity | null }): Activity | null {
  return proc.turnActive ? (proc.activity ?? null) : null;
}

/** `✻ thinking… 8s` — what the orchestrator is doing, and for how long. */
export function activityLine(activity: Activity | null, now: number): string | null {
  if (!activity) return null;
  const seconds = Math.max(0, Math.round((now - activity.since) / 1000));
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
  switch (activity.kind) {
    case "thinking":
      return `✻ thinking… ${elapsed}`;
    case "responding":
      return `✎ replying… ${elapsed}`;
    case "tool":
      return `⚙ ${activity.label ?? "tool"}… ${elapsed}`;
  }
}
