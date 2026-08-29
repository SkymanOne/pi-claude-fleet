import { firstLine, parseLineSafe, readNewLines, resultTextOf } from "../util.js";

export type LineKind = "steer" | "text" | "tool" | "tool_result" | "system" | "question" | "error";

export interface TranscriptLine {
  kind: LineKind;
  text: string;
}

export interface Transcript {
  lines: TranscriptLine[];
  /** In-flight streamed assistant text, keyed by contentIndex. */
  open: Map<number, string>;
}

export function createTranscript(): Transcript {
  return { lines: [], open: new Map() };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line summary of a tool call's arguments for the `⚙ tool …` line. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  // fleet tools take `name`/`target`; pi tools take the others
  const primary = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.name ?? a.target;
  const raw = typeof primary === "string" ? primary : JSON.stringify(a);
  return clip(firstLine(raw), 80);
}

function push(t: Transcript, kind: LineKind, text: string): void {
  t.lines.push({ kind, text });
}

/** Matches the orchestrator pane: a command in full, output as a counted preview. */
const TOOL_ARGS = { maxLines: 10, maxChars: 1200 };
const TOOL_RESULT = { maxLines: 4, maxChars: 600 };

/** The arguments as written, not a one-line digest of them. */
function toolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const primary = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.name ?? a.target;
  return typeof primary === "string" ? primary.trim() : JSON.stringify(a);
}

/** Text over as many lines as it takes, up to a bound; the rest is counted. */
function pushBlock(
  t: Transcript,
  kind: LineKind,
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
  shown.forEach((line, i) => push(t, kind, i === 0 ? `${prefix}${line}`.trimEnd() : `${indent}${line}`.trimEnd()));
  if (shown.length === 0) push(t, kind, prefix.trimEnd());
  const restLines = lines.length - shown.length;
  const restChars = text.length - shown.reduce((n, l) => n + l.length + 1, -1);
  if (restLines > 0) push(t, kind, `${indent}… ${restLines} more ${restLines === 1 ? "line" : "lines"}`);
  else if (cutMidLine && restChars > 0) push(t, kind, `${indent}… ${restChars} more characters`);
}

/** Fold one events.jsonl entry (fleet or RPC event) into the transcript. */
export function applyEvent(t: Transcript, ev: any): void {
  switch (ev?.type) {
    case "task_prompt":
      push(t, "steer", `▶ task: ${clip(firstLine(ev.brief ?? ""), 200)}`);
      return;
    case "steering_delivered":
      push(t, "steer", `▶ ${ev.source ?? "unknown"}: ${ev.message ?? ""}`);
      return;
    case "abort_requested":
      push(t, "system", "■ abort requested");
      return;
    case "worker_question": {
      const options = Array.isArray(ev.options) && ev.options.length > 0 ? ` [${ev.options.join(" | ")}]` : "";
      push(t, "question", `? ${clip(String(ev.question ?? ""), 300)}${options}`);
      return;
    }
    case "worker_progress":
      push(t, "system", `· ${clip(String(ev.message ?? ""), 200)}`);
      return;
    case "thinking_requested":
      push(t, "system", `· thinking level → ${ev.level ?? "?"} (${ev.source ?? "unknown"})`);
      return;
    case "thinking_rejected":
      push(t, "system", `! thinking level rejected: ${ev.error ?? ""}`);
      return;
    case "command_delivered":
      push(t, "steer", `▶ command (${ev.source ?? "unknown"}): ${ev.message ?? ""}`);
      return;
    case "answer_delivered":
      push(t, "steer", `▶ answer (${ev.source ?? "unknown"}): ${ev.message ?? ""}`);
      return;
    case "worker_question_resolved":
      if (ev.how === "timeout") push(t, "system", "! no answer in time; worker proceeds on its own judgment");
      else if (ev.how === "aborted") push(t, "system", "! question aborted");
      return;
    case "control_dropped":
      push(t, "system", `! ${ev.control ?? "control"} from ${ev.source ?? "unknown"} dropped: ${ev.reason ?? ""}`);
      return;
    case "message_update": {
      // the monitor stores the delta under `ev`; raw RPC uses `assistantMessageEvent`
      const a = ev.ev ?? ev.assistantMessageEvent;
      if (!a) return;
      const idx = Number(a.contentIndex ?? 0);
      if (a.type === "text_start") {
        t.open.set(idx, "");
      } else if (a.type === "text_delta") {
        t.open.set(idx, (t.open.get(idx) ?? "") + (a.delta ?? ""));
      } else if (a.type === "text_end") {
        const full = typeof a.content === "string" ? a.content : (t.open.get(idx) ?? "");
        t.open.delete(idx);
        for (const line of full.split("\n")) if (line.trim()) push(t, "text", line);
      }
      return;
    }
    case "tool_execution_start":
      // the command is the thing worth reading, so it is not cut
      pushBlock(t, "tool", `⚙ ${ev.toolName ?? "tool"} `, toolArgs(ev.args), TOOL_ARGS);
      return;
    case "tool_execution_end": {
      const body = resultTextOf(ev).trim() || (ev.isError ? "(error)" : "(no output)");
      pushBlock(t, "tool_result", "  ↳ ", body, TOOL_RESULT);
      return;
    }
    case "agent_settled":
      push(t, "system", "● settled");
      return;
    case "run_failed": {
      const lines = String(ev.error ?? "the worker stopped").split("\n").filter((l) => l.length > 0);
      for (const [i, line] of lines.entries()) push(t, "error", i === 0 ? `✖ ${line}` : `  ${line}`);
      return;
    }
    case "extension_error":
      push(t, "system", `! extension error: ${clip(String(ev.error ?? ""), 120)}`);
      return;
    case "auto_retry_start":
      push(t, "system", `↻ retry ${ev.attempt}/${ev.maxAttempts}`);
      return;
    case "compaction_start":
      push(t, "system", "⌁ compacting context");
      return;
    default:
      return;
  }
}

/** Text the assistant is still streaming (not yet a committed line). */
export function partialText(t: Transcript): string | null {
  if (t.open.size === 0) return null;
  const joined = [...t.open.values()].join("");
  return joined.length > 0 ? joined : null;
}

/** Parse the complete events appended after byte `offset`. */
export function readNewEvents(filePath: string, offset: number): { events: any[]; offset: number } {
  const { lines, offset: next } = readNewLines(filePath, offset);
  const events: any[] = [];
  for (const line of lines) {
    const parsed = parseLineSafe(line);
    if (parsed.ok) events.push(parsed.value);
  }
  return { events, offset: next };
}

/** Rebuild the transcript from the whole file, keeping only the last `keepLines`. */
export function replay(filePath: string, keepLines: number): { transcript: Transcript; offset: number } {
  const transcript = createTranscript();
  const { events, offset } = readNewEvents(filePath, 0);
  for (const ev of events) applyEvent(transcript, ev);
  if (transcript.lines.length > keepLines) {
    transcript.lines.splice(0, transcript.lines.length - keepLines);
  }
  return { transcript, offset };
}
