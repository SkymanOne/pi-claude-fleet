/**
 * What the human's composer can do to the selected worker. Kept out of the
 * components so the rules (no steering a finished run, no answer without a
 * question) are testable and identical to the CLI's.
 */
import {
  appendControl,
  deriveStatus,
  resumeHint,
  listRuns,
  loadStateSync,
  THINKING_LEVELS,
  TERMINAL_STATES,
  type RunState,
} from "../state.js";
import { cleanupRuns } from "../commands.js";
import { gitRaw } from "../worktree.js";
import { resolveCommand } from "./completions.js";

export interface WorkerActionResult {
  notice: string;
  error: boolean;
  /** Set when the action needs the human to confirm before anything is destroyed. */
  confirm?: { message: string; action: "remove" };
}

export interface WorkerActionArgs {
  runDir: string;
  state: RunState;
  input: string;
  /** Needed by /remove; without it the command reports that it is unavailable. */
  piFleetDir?: string;
  runId?: string;
}

const isTerminal = (status: string): boolean =>
  (TERMINAL_STATES as readonly string[]).includes(status);

/** Parse `/answer [<questionId>] <text>` — the id is optional and never contains spaces. */
export function parseAnswer(
  rest: string,
  pendingId: string | null,
): { questionId: string | null; message: string } {
  const trimmed = rest.trim();
  const [first, ...others] = trimmed.split(/\s+/);
  if (first && /^q_[A-Za-z0-9_]+$/.test(first) && others.length > 0) {
    return { questionId: first, message: others.join(" ") };
  }
  return { questionId: pendingId, message: trimmed };
}

/** Route one composer line to the selected worker. */
export async function workerCommand(
  args: WorkerActionArgs,
): Promise<WorkerActionResult> {
  const { runDir, state } = args;
  const input = args.input.trim();
  if (!input) return { notice: "", error: false };
  const status = deriveStatus(state);
  const finished = isTerminal(status);

  const [head, ...restWords] = input.split(/\s+/);
  const spec = input.startsWith("/") ? resolveCommand(head) : null;
  const command = spec?.name ?? (input.startsWith("/") ? head : null);
  const argument = restWords.join(" ");

  if (command === "/stop") {
    if (finished)
      return {
        notice: `! ${state.name} is ${status} — nothing to stop`,
        error: true,
      };
    await appendControl(runDir, {
      type: "abort",
      message: null,
      source: "console",
    });
    return { notice: `■ abort requested for ${state.name}`, error: false };
  }
  if (command === "/followup") {
    const message = argument.trim();
    if (!message)
      return { notice: "! usage: /followup <message>", error: true };
    if (finished)
      return {
        notice: `! ${state.name} is ${status} — ${resumeHint(state, runDir)}`,
        error: true,
      };
    await appendControl(runDir, {
      type: "follow_up",
      message,
      source: "console",
    });
    return {
      notice: `→ follow-up queued for ${state.name}: ${message}`,
      error: false,
    };
  }
  if (command === "/answer") {
    const { questionId, message } = parseAnswer(
      argument,
      state.pendingQuestion?.id ?? null,
    );
    if (!message)
      return { notice: "! usage: /answer [<questionId>] <text>", error: true };
    if (finished)
      return {
        notice: `! ${state.name} is ${status} — nothing is waiting for an answer`,
        error: true,
      };
    if (!questionId)
      return {
        notice: `! ${state.name} has no pending question — type a message to steer it instead`,
        error: true,
      };
    await appendControl(runDir, {
      type: "answer",
      message,
      source: "console",
      questionId,
    });
    return {
      notice: `→ answered ${state.name} (${questionId}): ${message}`,
      error: false,
    };
  }
  if (command === "/thinking") {
    const level = argument.trim().toLowerCase();
    if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
      return {
        notice: `! usage: /thinking <${THINKING_LEVELS.join("|")}>`,
        error: true,
      };
    }
    if (finished)
      return {
        notice: `! ${state.name} is ${status} — its thinking level no longer matters`,
        error: true,
      };
    await appendControl(runDir, {
      type: "thinking",
      message: level,
      source: "console",
    });
    return {
      notice: `→ ${state.name} thinking level → ${level}`,
      error: false,
    };
  }
  if (command === "/remove") {
    if (!args.piFleetDir || !args.runId)
      return { notice: "! /remove is not available here", error: true };
    if (!finished) {
      return {
        notice: "",
        error: false,
        confirm: {
          message: `${state.name} is ${status}. Abort it and remove its worktree and branch?`,
          action: "remove",
        },
      };
    }
    const dirty = await dirtyPaths(state);
    if (dirty.length > 0) {
      return {
        notice: "",
        error: false,
        confirm: {
          message: `${state.name} has ${dirty.length} uncommitted change(s) that would be discarded. Remove it anyway?`,
          action: "remove",
        },
      };
    }
    return removeWorker({
      piFleetDir: args.piFleetDir,
      runId: args.runId,
      name: state.name,
      force: false,
    });
  }
  if (input.startsWith("/")) {
    // not one of ours: if the worker offers it, let pi expand it (skill, prompt
    // template or extension command)
    const known = (state.commands ?? []).some((c) => `/${c.name}` === head);
    if (known) {
      if (finished)
        return {
          notice: `! ${state.name} is ${status} — ${resumeHint(state, runDir)}`,
          error: true,
        };
      await appendControl(runDir, {
        type: "command",
        message: input,
        source: "console",
      });
      return { notice: `→ sent ${head} to ${state.name}`, error: false };
    }
    const offered = (state.commands ?? [])
      .slice(0, 6)
      .map((c) => `/${c.name}`)
      .join(", ");
    return {
      notice: `! unknown command ${head} — /answer, /followup, /stop, /remove, /help, /quit${offered ? `, or the worker's own: ${offered}` : ""}`,
      error: true,
    };
  }
  if (finished)
    return {
      notice: `! ${state.name} is ${status} — ${resumeHint(state, runDir)}`,
      error: true,
    };
  await appendControl(runDir, {
    type: "steer",
    message: input,
    source: "console",
  });
  return { notice: `→ steer queued for ${state.name}: ${input}`, error: false };
}

/** Uncommitted paths in a run's worktree; empty when it has none or it is gone. */
export async function dirtyPaths(state: RunState): Promise<string[]> {
  if (!state.worktree) return [];
  const r = await gitRaw(["status", "--porcelain"], state.worktree);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/** Archive a run and delete its worktree and branch. `force` also aborts a running worker. */
export async function removeWorker(args: {
  piFleetDir: string;
  runId: string;
  name: string;
  force: boolean;
}): Promise<WorkerActionResult> {
  const result = await cleanupRuns({
    piFleetDir: args.piFleetDir,
    target: args.runId,
    force: args.force,
  });
  if (result.code === 0 && result.data.archived.includes(args.runId)) {
    const kept = result.err.find((line) =>
      line.includes("kept unmerged branch"),
    );
    return {
      notice: `✓ removed ${args.name}${kept ? " (its unmerged branch was kept)" : ""}`,
      error: false,
    };
  }
  const why = result.err[0] ?? "cleanup refused";
  return { notice: `! could not remove ${args.name}: ${why}`, error: true };
}

/** Abort every worker that is still going; used by /shutdown. */
export async function stopAllWorkers(piFleetDir: string): Promise<string[]> {
  const stopped: string[] = [];
  for (const { runDir } of listRuns(piFleetDir)) {
    let state: RunState;
    try {
      state = loadStateSync(runDir);
    } catch {
      continue;
    }
    if (state.status === "archived" || isTerminal(deriveStatus(state)))
      continue;
    await appendControl(runDir, {
      type: "abort",
      message: null,
      source: "console",
    });
    stopped.push(state.name);
  }
  return stopped;
}
