/**
 * What the human's composer can do to the selected worker. Kept out of the
 * components so the rules (no steering a finished run, no answer without a
 * question) are testable and identical to the CLI's.
 */
import { appendControl, deriveStatus, resumeHint, TERMINAL_STATES, type RunState } from "../state.js";

export interface WorkerActionResult {
  notice: string;
  error: boolean;
}

export interface WorkerActionArgs {
  runDir: string;
  state: RunState;
  input: string;
}

const isTerminal = (status: string): boolean => (TERMINAL_STATES as readonly string[]).includes(status);

/** Parse `/answer [<questionId>] <text>` — the id is optional and never contains spaces. */
export function parseAnswer(rest: string, pendingId: string | null): { questionId: string | null; message: string } {
  const trimmed = rest.trim();
  const [first, ...others] = trimmed.split(/\s+/);
  if (first && /^q_[A-Za-z0-9_]+$/.test(first) && others.length > 0) {
    return { questionId: first, message: others.join(" ") };
  }
  return { questionId: pendingId, message: trimmed };
}

/** Route one composer line to the selected worker. */
export async function workerCommand(args: WorkerActionArgs): Promise<WorkerActionResult> {
  const { runDir, state } = args;
  const input = args.input.trim();
  if (!input) return { notice: "", error: false };
  const status = deriveStatus(state);
  const finished = isTerminal(status);

  if (input === "/stop") {
    if (finished) return { notice: `! ${state.name} is ${status} — nothing to stop`, error: true };
    await appendControl(runDir, { type: "abort", message: null, source: "console" });
    return { notice: `■ abort requested for ${state.name}`, error: false };
  }
  if (input.startsWith("/followup")) {
    const message = input.slice("/followup".length).trim();
    if (!message) return { notice: "! usage: /followup <message>", error: true };
    if (finished) return { notice: `! ${state.name} is ${status} — ${resumeHint(state, runDir)}`, error: true };
    await appendControl(runDir, { type: "follow_up", message, source: "console" });
    return { notice: `→ follow-up queued for ${state.name}: ${message}`, error: false };
  }
  if (input.startsWith("/answer")) {
    const { questionId, message } = parseAnswer(input.slice("/answer".length), state.pendingQuestion?.id ?? null);
    if (!message) return { notice: "! usage: /answer [<questionId>] <text>", error: true };
    if (finished) return { notice: `! ${state.name} is ${status} — nothing is waiting for an answer`, error: true };
    if (!questionId) return { notice: `! ${state.name} has no pending question — type a message to steer it instead`, error: true };
    await appendControl(runDir, { type: "answer", message, source: "console", questionId });
    return { notice: `→ answered ${state.name} (${questionId}): ${message}`, error: false };
  }
  if (input.startsWith("/")) {
    return { notice: `! unknown command ${input.split(/\s+/)[0]} — /answer, /followup, /stop, /help, /quit`, error: true };
  }
  if (finished) return { notice: `! ${state.name} is ${status} — ${resumeHint(state, runDir)}`, error: true };
  await appendControl(runDir, { type: "steer", message: input, source: "console" });
  return { notice: `→ steer queued for ${state.name}: ${input}`, error: false };
}
