/**
 * The common envelope for every fleet mailbox line. `control.jsonl` keeps its
 * flat legacy shape on disk; `controlToEnvelope` lifts it into this form so
 * observers (watcher, TUI) deal with one shape.
 */
import { newId, nowIso } from "../util.js";
import type { ControlMessage } from "../state.js";

export type Party = "orchestrator" | "console" | "fleet" | `worker:${string}`;

export interface Envelope<T extends string = string, P = unknown> {
  id: string;
  ts: string;
  from: Party;
  to: Party;
  type: T;
  payload: P;
}

export interface QuestionPayload {
  question: string;
  options: string[] | null;
  context: string | null;
}

export interface ProgressPayload {
  message: string;
}

export type QuestionResolution = "answered" | "timeout" | "aborted";

export interface QuestionResolvedPayload {
  questionId: string;
  how: QuestionResolution;
}

/** What a worker writes to `runs/<id>/outbox.jsonl`. */
export type OutboxEnvelope =
  | Envelope<"question", QuestionPayload>
  | Envelope<"progress", ProgressPayload>
  | Envelope<"question_resolved", QuestionResolvedPayload>;

export interface ControlPayload {
  message: string | null;
  questionId: string | null;
}

export function workerParty(runId: string): Party {
  return `worker:${runId}`;
}

export function makeEnvelope<T extends string, P>(args: {
  from: Party;
  to: Party;
  type: T;
  payload: P;
  id?: string;
  ts?: string;
}): Envelope<T, P> {
  return {
    id: args.id ?? newId("m"),
    ts: args.ts ?? nowIso(),
    from: args.from,
    to: args.to,
    type: args.type,
    payload: args.payload,
  };
}

/** A `control.jsonl` line as an envelope addressed to the run's worker. */
export function controlToEnvelope(line: ControlMessage, runId: string): Envelope<ControlMessage["type"], ControlPayload> {
  const from: Party = line.source === "console" ? "console" : "orchestrator";
  return {
    id: line.id ?? newId("ctl"),
    ts: line.ts,
    from,
    to: workerParty(runId),
    type: line.type,
    payload: { message: line.message ?? null, questionId: line.questionId ?? null },
  };
}

const PARTY_RE = /^(orchestrator|console|fleet|worker:.+)$/;

/** Validate a parsed JSON value as an envelope; null when the shape is off. */
export function parseEnvelope(value: unknown): Envelope | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.ts !== "string" || typeof v.type !== "string") return null;
  if (typeof v.from !== "string" || !PARTY_RE.test(v.from)) return null;
  if (typeof v.to !== "string" || !PARTY_RE.test(v.to)) return null;
  return { id: v.id, ts: v.ts, from: v.from as Party, to: v.to as Party, type: v.type, payload: v.payload };
}
