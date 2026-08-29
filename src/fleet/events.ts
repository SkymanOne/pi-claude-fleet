/**
 * Fleet events: what the watcher observes about workers, and how it is rendered
 * for the orchestrator. Events reach the orchestrator as ordinary user messages
 * carrying `<fleet-event>` blocks, so the format must be unambiguous and
 * impossible to spoof from worker-controlled text.
 */
import { newId, nowIso, firstLine } from "../util.js";

export const FLEET_EVENT_KINDS = [
  "settled",
  "stopped",
  "error",
  "dead",
  "question",
  "question_resolved",
  "answered_by_console",
  "console_steer",
  "progress",
  "snapshot",
] as const;

export type FleetEventKind = (typeof FLEET_EVENT_KINDS)[number];

export interface FleetEvent {
  id: string;
  ts: string;
  kind: FleetEventKind;
  /** Run id, or "-" for fleet-wide events such as `snapshot`. */
  runId: string;
  name: string;
  /** Rendered as `key: value` lines inside the block, in insertion order. */
  fields: Record<string, string | null | undefined>;
}

export function makeFleetEvent(args: {
  kind: FleetEventKind;
  runId: string;
  name: string;
  fields?: Record<string, string | null | undefined>;
  id?: string;
  ts?: string;
}): FleetEvent {
  return {
    id: args.id ?? newId("ev"),
    ts: args.ts ?? nowIso(),
    kind: args.kind,
    runId: args.runId,
    name: args.name,
    fields: args.fields ?? {},
  };
}

/** What the orchestrator should do next for each kind; ends up in the block. */
export function describeNextStep(kind: FleetEventKind, name: string): string {
  switch (kind) {
    case "settled":
      return `fleet_report name="${name}"; then fleet_diff and fleet_merge, then the integration checks`;
    case "stopped":
      return `fleet_output name="${name}"; decide whether to respawn with session or drop the step`;
    case "error":
    case "dead":
      return `fleet_output name="${name}" and fleet_logs name="${name}"; then rebrief or respawn with session`;
    case "question":
      return `fleet_answer name="${name}" (ask the human first if the brief does not settle it) — the worker is blocked`;
    case "answered_by_console":
      return "the human already answered; reconcile your plan, do not answer again";
    case "console_steer":
      return "the human steered this worker; reconcile your plan and re-read the report when it settles";
    case "question_resolved":
      return "no action needed";
    case "progress":
      return "no action needed";
    case "snapshot":
      return "reconcile your plan with these runs before doing anything else";
  }
}

const MAX_FIELD_CHARS = 2000;

/** Attribute-safe: quotes and control characters cannot break out of the tag. */
function attr(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

/**
 * Body-safe: worker-controlled text must not be able to close the block or
 * forge another one, and long text is clipped.
 */
export function sanitizeField(value: string): string {
  const clipped = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS - 1)}…` : value;
  return clipped.replace(/<\/?fleet-event/gi, "<​fleet-event").replace(/\r/g, "");
}

export function formatFleetEvent(ev: FleetEvent): string {
  const lines = [`<fleet-event kind="${attr(ev.kind)}" run="${attr(ev.runId)}" name="${attr(ev.name)}" id="${attr(ev.id)}" ts="${attr(ev.ts)}">`];
  for (const [key, value] of Object.entries(ev.fields)) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${key}: ${sanitizeField(String(value))}`);
  }
  lines.push("next: " + sanitizeField(describeNextStep(ev.kind, ev.name)));
  lines.push("</fleet-event>");
  return lines.join("\n");
}

/** One user message per batch; the cap keeps a burst from flooding the turn. */
export function formatFleetBatch(events: FleetEvent[], maxPerBatch = 10): string {
  const shown = events.slice(0, maxPerBatch);
  const blocks = shown.map(formatFleetEvent);
  if (events.length > shown.length) {
    blocks.push(`(+${events.length - shown.length} more fleet events; call fleet_status for the whole fleet)`);
  }
  return blocks.join("\n");
}

/** First line of a worker's last assistant text, for the `last:` field. */
export function lastLine(text: string | null | undefined): string | null {
  const line = firstLine(text ?? "").trim();
  return line.length > 0 ? line : null;
}
