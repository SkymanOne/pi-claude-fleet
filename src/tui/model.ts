/**
 * Pure view state for the TUI: the orchestrator transcript, and the rail rows.
 * Everything here is a function of messages already received, so the components
 * stay presentational and the reducer is testable without a process.
 */
import { deriveView, modelLabel, type DerivedView, type RunState } from "../state.js";
import { summarizeArgs } from "../console/transcript.js";
import { formatAge } from "../util.js";
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
  userText,
  type ClaudeStreamMessage,
} from "../orchestrator/protocol.js";

export type OrchestratorLineKind = "user" | "fleet" | "text" | "tool" | "tool_result" | "system" | "error";

export interface OrchestratorLine {
  kind: OrchestratorLineKind;
  text: string;
  /** Styled segments for markdown-rendered lines; plain `text` is used when absent. */
  spans?: Span[];
  /** The markdown block element this line came from, so the view can style it. */
  md?: MdLine["kind"];
}

export interface OrchestratorViewState {
  lines: OrchestratorLine[];
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
  | { type: "fleet"; events: FleetEvent[]; text: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
  | { type: "exit"; code: number | null; signal: string | null };

const MAX_LINES = 500;

function trim(state: OrchestratorViewState): void {
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
}

function push(state: OrchestratorViewState, kind: OrchestratorLineKind, text: string): void {
  for (const line of text.split("\n")) state.lines.push({ kind, text: line });
  trim(state);
}

/** Assistant prose is markdown; render it into styled lines rather than dumping the source. */
function pushMarkdown(state: OrchestratorViewState, text: string): void {
  for (const line of parseMarkdownBlock(text)) {
    state.lines.push({ kind: "text", text: line.spans.map((s) => s.text).join(""), spans: line.spans, md: line.kind });
  }
  trim(state);
}

/** `settled add-auth · question db` — a fleet batch as one rail-friendly line. */
export function summarizeFleetEvents(events: FleetEvent[]): string {
  return events.map((e) => `${e.kind} ${e.name}`).join(" · ");
}

const isLocal = (msg: ClaudeStreamMessage | LocalEvent): msg is LocalEvent =>
  ["sent", "fleet", "notice", "error", "exit"].includes((msg as LocalEvent).type);

/** Fold one message (wire or local) into the view state; mutates and returns it. */
export function reduceOrchestrator(state: OrchestratorViewState, msg: ClaudeStreamMessage | LocalEvent): OrchestratorViewState {
  if (isLocal(msg)) {
    switch (msg.type) {
      case "sent":
        state.pendingEchoes.push(msg.text);
        push(state, msg.kind ?? "user", `> ${msg.display ?? msg.text}`);
        state.turnActive = true;
        return state;
      case "fleet":
        state.pendingEchoes.push(msg.text);
        push(state, "fleet", `⚑ ${summarizeFleetEvents(msg.events)}`);
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
    }
    return state;
  }

  if (isAssistant(msg)) {
    state.turnActive = true;
    state.partial = null;
    const text = textOfAssistant(msg).trim();
    if (text) pushMarkdown(state, text);
    for (const tool of toolUsesOf(msg)) {
      state.toolNames[tool.id] = tool.name;
      push(state, "tool", `⚙ ${tool.name} ${summarizeArgs(tool.input)}`.trimEnd());
    }
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
      const head = oneLine(result.text) || (result.isError ? "(error)" : "(no output)");
      push(state, "tool_result", `  ↳ ${name}: ${head}`);
    }
    return state;
  }

  if (isResult(msg)) {
    state.turnActive = false;
    state.partial = null;
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
  detail: string;
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

export function buildRail(args: {
  orchestrator: { turnActive: boolean; exited: boolean; pendingApprovals: number; model?: string | null };
  runs: RailRun[];
  now?: number;
}): RailItem[] {
  const now = args.now ?? Date.now();
  const o = args.orchestrator;
  const orchestratorState = o.exited ? "exited" : o.pendingApprovals > 0 ? `${o.pendingApprovals} to approve` : o.turnActive ? "working" : "idle";
  const items: RailItem[] = [
    {
      key: "orchestrator",
      glyph: o.exited ? "!" : o.pendingApprovals > 0 ? "?" : o.turnActive ? "●" : "○",
      name: "orchestrator",
      detail: o.model ? `${orchestratorState} · ${o.model}` : orchestratorState,
      target: { kind: "orchestrator" },
      attention: o.pendingApprovals > 0 || o.exited,
    },
  ];
  for (const run of args.runs) {
    const view = deriveView(run.state, undefined, now);
    const model = modelLabel(run.state);
    const age = formatAge(Math.max(0, now - Date.parse(run.state.createdAt)));
    items.push({
      key: run.runId,
      glyph: WORKER_GLYPHS[view] ?? "·",
      name: run.state.name,
      detail: model ? `${view} ${age} · ${model}` : `${view} ${age}`,
      target: { kind: "worker", runId: run.runId, runDir: run.runDir },
      attention: view === "blocked",
    });
  }
  return items;
}
