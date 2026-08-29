import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { splitJsonLines, parseLineSafe, nowIso, readNewLines } from "./util.js";
import { parseEnvelope } from "./fleet/envelope.js";
import { FLEET_EXTENSION_PATH, FLEET_SKILL_PATH } from "./paths.js";
import {
  loadState,
  saveState,
  recordToolActivity,
  recordSteering,
  type RunState,
  type ControlMessage,
} from "./state.js";

/** A pi RPC event or response, as parsed from one stdout line. */
export type RpcEvent = { type: string; [key: string]: any };

/** Events copied from the RPC stream into events.jsonl. */
const SELECTED = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "extension_error",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
]);
const TEXT_TYPES = new Set(["text_start", "text_delta", "text_end"]);

const FLUSH_INTERVAL_MS = 300;
const PROMPT_DELAY_MS = 150;
const CONTROL_POLL_MS = 300;
/** After settling: wait this long for get_last_assistant_text, then end stdin. */
const LAST_TEXT_TIMEOUT_MS = 2000;
/** After ending stdin: escalate to SIGTERM, then SIGKILL. */
const SHUTDOWN_GRACE_MS = 5000;

/** Tools the fleet-worker extension registers; appended to any `--tools` allowlist. */
export const FLEET_WORKER_TOOLS = ["fleet_ask", "fleet_progress"] as const;

/** `PI_FLEET_PI_BIN` is an executable spec split on spaces ("node /path/fake-pi.mjs"). */
export function piCommand(): { bin: string; prefix: string[] } {
  const [bin, ...prefix] = (process.env.PI_FLEET_PI_BIN || "pi").split(" ");
  return { bin, prefix };
}

export function buildPiArgs(state: RunState, runDir: string): string[] {
  const args = [
    "--mode", "rpc",
    "--session-dir", path.join(runDir, "session"),
    // the worker protocol travels with the CLI, so `pi install` is optional
    "--extension", FLEET_EXTENSION_PATH,
    "--skill", FLEET_SKILL_PATH,
  ];
  if (state.provider) args.push("--provider", state.provider);
  if (state.model) args.push("--model", state.model);
  if (state.thinking) args.push("--thinking", state.thinking);
  if (state.skill) args.push("--skill", state.skill);
  if (state.appendSystemPrompt) args.push("--append-system-prompt", state.appendSystemPrompt);
  // a user allowlist must not hide the worker protocol tools
  if (state.tools) args.push("--tools", `${state.tools},${FLEET_WORKER_TOOLS.join(",")}`);
  if (state.excludeTools) args.push("--exclude-tools", state.excludeTools);
  if (state.sessionArg) args.push("--session", state.sessionArg);
  return args;
}

export function reportReminder(piFleetDir: string, runId: string): string {
  return (
    `When you finish this task, write your fleet report to ${piFleetDir}/reports/${runId}.md ` +
    "using the fleet-worker-report template before ending your final turn. " +
    'Include a "Steering received" section ("none" if you received no steering).'
  );
}

export async function runMonitor(args: { piFleetDir: string; runId: string }): Promise<number> {
  const { piFleetDir, runId } = args;
  const runDir = path.join(piFleetDir, "runs", runId);
  const state = await loadState(runDir);
  const eventsPath = path.join(runDir, "events.jsonl");
  const rpcLogPath = path.join(runDir, "rpc.log");

  let dirty = false;
  let settledHandled = false;
  let pendingAbort = false;
  let finished = false;
  let promptSent = false;
  let abortRequests = 0;
  let lastTextTimer: NodeJS.Timeout | null = null;
  let shutdownTimers: NodeJS.Timeout[] = [];
  // Assigned once the mailbox paths are known; drained on settle and finish too.
  let pollMailboxes: () => void = () => {};

  const writeEvent = (obj: Record<string, unknown>): void => {
    try {
      fs.appendFileSync(eventsPath, JSON.stringify({ ...obj, ts: nowIso() }) + "\n");
    } catch {
      // events are best-effort; state.json is the source of truth
    }
  };
  // Flushes are serialized, and never overwrite an `archived` state written by
  // `cleanup` (which can land between our settle flush and the child's close).
  let flushChain: Promise<void> = Promise.resolve();
  let archivedOnDisk = false;
  const flushNow = (): Promise<void> => {
    dirty = false;
    flushChain = flushChain.then(async () => {
      if (archivedOnDisk) return;
      try {
        if ((await loadState(runDir)).status === "archived") {
          archivedOnDisk = true;
          return;
        }
      } catch {
        // missing or mid-rename: write ours
      }
      try {
        await saveState(runDir, state);
      } catch {
        dirty = true; // retried by the periodic flusher
      }
    });
    return flushChain;
  };
  const flusher = setInterval(() => {
    if (dirty) void flushNow();
  }, FLUSH_INTERVAL_MS);

  state.pid = process.pid;
  state.status = "running";
  await flushNow();

  const { bin, prefix } = piCommand();
  const child: ChildProcess = spawn(bin, [...prefix, ...buildPiArgs(state, runDir)], {
    cwd: state.worktree ?? state.cwd,
    env: { ...process.env, PI_FLEET_RUN: runId, PI_FLEET_DIR: piFleetDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // As in the orchestrator: an EPIPE from a write racing pi's death must not
  // become an uncaught exception and kill the monitor before it records why.
  child.stdin?.on("error", () => {
    // the close handler sets state.error with the stderr tail
  });

  const send = (msg: Record<string, unknown>): boolean => {
    try {
      return child.stdin?.write(JSON.stringify(msg) + "\n") ?? false;
    } catch {
      return false;
    }
  };

  const stderrTail: string[] = [];
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail.push(d.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  /** Ask pi to exit: close stdin, then escalate if it lingers. */
  const beginShutdown = (): void => {
    if (shutdownTimers.length > 0) return;
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    shutdownTimers.push(
      setTimeout(() => {
        if (!finished) child.kill("SIGTERM");
      }, SHUTDOWN_GRACE_MS),
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, SHUTDOWN_GRACE_MS * 2),
    );
  };

  const handleEvent = (ev: RpcEvent): void => {
    if (ev.type === "response") {
      if (ev.command === "get_last_assistant_text" && ev.success) {
        state.lastAssistantText = ev.data?.text ?? state.lastAssistantText;
        void flushNow();
        if (lastTextTimer) clearTimeout(lastTextTimer);
        beginShutdown();
      } else if (ev.success === false) {
        writeEvent(ev);
        if (ev.id === "fleet-init") {
          state.error = `prompt rejected: ${ev.error ?? "unknown error"}`;
          void flushNow();
          beginShutdown();
        }
      }
      return;
    }
    if (ev.type === "message_update") {
      const a = ev.assistantMessageEvent;
      if (!a || !TEXT_TYPES.has(a.type)) return;
      writeEvent({
        type: "message_update",
        ev: { type: a.type, contentIndex: a.contentIndex, delta: a.delta, content: a.content },
      });
      if (a.type === "text_delta") {
        state.lastActivity = nowIso();
        dirty = true;
      }
      return;
    }
    if (!SELECTED.has(ev.type)) return;
    writeEvent(ev);
    if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") {
      recordToolActivity(state, ev.toolName ?? state.lastTool);
      dirty = true;
    }
    if (ev.type === "agent_settled" && !settledHandled) {
      // Everything the worker wrote before settling must be mirrored before
      // observers can see the terminal status.
      if (promptSent) pollMailboxes();
      settledHandled = true;
      state.status = pendingAbort ? "stopped" : "settled";
      state.settledAt = nowIso();
      state.pendingQuestion = null;
      void flushNow();
      send({ id: "fleet-last", type: "get_last_assistant_text" });
      lastTextTimer = setTimeout(beginShutdown, LAST_TEXT_TIMEOUT_MS);
    }
  };

  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const framed = splitJsonLines(chunk.toString(), rest);
    rest = framed.rest;
    for (const line of framed.lines) {
      try {
        fs.appendFileSync(rpcLogPath, line + "\n");
      } catch {
        // best effort
      }
      const parsed = parseLineSafe<RpcEvent>(line);
      if (parsed.ok && parsed.value && typeof parsed.value.type === "string") {
        handleEvent(parsed.value);
      }
    }
  });

  const promptTimer = setTimeout(() => {
    if (finished) return;
    writeEvent({ type: "task_prompt", brief: state.taskBrief });
    send({
      id: "fleet-init",
      type: "prompt",
      message: `${state.taskBrief}\n\n${reportReminder(piFleetDir, runId)}`,
    });
    promptSent = true;
  }, PROMPT_DELAY_MS);

  /** First request: RPC abort. Second: SIGTERM pi. Third: SIGKILL pi. */
  const requestAbort = (): void => {
    pendingAbort = true;
    abortRequests += 1;
    if (abortRequests === 1) send({ type: "abort" });
    else if (abortRequests === 2) child.kill("SIGTERM");
    else child.kill("SIGKILL");
  };
  process.on("SIGTERM", requestAbort);

  // Control channel: orchestrator/console append lines to control.jsonl; we
  // forward them to pi and record provenance. We read from byte 0 so lines
  // written before this monitor booted are still delivered (once pi has its prompt).
  const controlPath = path.join(runDir, "control.jsonl");
  let controlOffset = 0;
  const handleControl = (msg: ControlMessage): void => {
    if (msg.type === "answer") {
      // The worker's fleet_ask reads the answer from control.jsonl itself; we only
      // record it. Never drop it: the worker may consume the answer and settle
      // before this poll runs, and the record must still say who answered.
      if (typeof msg.message !== "string") return;
      const source = msg.source ?? "unknown";
      const questionId = msg.questionId ?? null;
      writeEvent({ type: "answer_delivered", questionId, source, message: msg.message });
      recordSteering(state, { source, message: `answer(${questionId ?? "?"}): ${msg.message}`, ts: nowIso() });
      if (state.pendingQuestion && (questionId === null || state.pendingQuestion.id === questionId)) {
        state.pendingQuestion = null;
      }
      void flushNow();
      return;
    }
    if (msg.type === "steer" || msg.type === "follow_up") {
      if (typeof msg.message !== "string") return;
      if (settledHandled) {
        writeEvent({ type: "control_dropped", control: msg.type, source: msg.source ?? "unknown", reason: "run already settled" });
        return;
      }
      if (!send({ type: msg.type, message: msg.message })) return;
      const source = msg.source ?? "unknown";
      writeEvent({ type: "steering_delivered", source, message: msg.message });
      recordSteering(state, { source, message: msg.message, ts: nowIso() });
      void flushNow();
    } else if (msg.type === "abort") {
      writeEvent({ type: "abort_requested", source: msg.source ?? "unknown" });
      requestAbort();
    }
  };
  // Outbox: the worker's fleet_ask / fleet_progress write envelopes here; we
  // mirror them into events.jsonl and state so observers never read the outbox.
  const outboxPath = path.join(runDir, "outbox.jsonl");
  let outboxOffset = 0;
  const handleOutbox = (env: { id: string; ts: string; type: string; payload: unknown }): void => {
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    if (env.type === "question") {
      const question = typeof payload.question === "string" ? payload.question : "";
      const options = Array.isArray(payload.options) ? payload.options.map(String) : null;
      const context = typeof payload.context === "string" ? payload.context : null;
      writeEvent({ type: "worker_question", questionId: env.id, question, options, context });
      state.pendingQuestion = { id: env.id, question, options, context, askedAt: env.ts };
      state.lastActivity = nowIso();
      void flushNow();
    } else if (env.type === "progress") {
      const message = typeof payload.message === "string" ? payload.message : "";
      writeEvent({ type: "worker_progress", message });
      state.lastProgress = message;
      state.lastActivity = nowIso();
      dirty = true;
    } else if (env.type === "question_resolved") {
      const questionId = typeof payload.questionId === "string" ? payload.questionId : null;
      const how = typeof payload.how === "string" ? payload.how : "unknown";
      writeEvent({ type: "worker_question_resolved", questionId, how });
      if (state.pendingQuestion && state.pendingQuestion.id === questionId) state.pendingQuestion = null;
      void flushNow();
    }
  };
  pollMailboxes = (): void => {
    const { lines, offset } = readNewLines(controlPath, controlOffset);
    controlOffset = offset;
    for (const line of lines) {
      const parsed = parseLineSafe<ControlMessage>(line);
      if (parsed.ok && parsed.value && typeof parsed.value.type === "string") {
        handleControl(parsed.value);
      }
    }
    const out = readNewLines(outboxPath, outboxOffset);
    outboxOffset = out.offset;
    for (const line of out.lines) {
      const parsed = parseLineSafe<unknown>(line);
      const env = parsed.ok ? parseEnvelope(parsed.value) : null;
      if (env) handleOutbox(env);
    }
  };
  const controlTimer = setInterval(() => {
    if (finished || !promptSent) return;
    pollMailboxes();
  }, CONTROL_POLL_MS);

  return await new Promise<number>((resolve) => {
    let spawnError: Error | null = null;
    const finish = async (code: number | null): Promise<void> => {
      if (finished) return;
      finished = true;
      clearInterval(flusher);
      clearInterval(controlTimer);
      // Lines written in the last poll interval (e.g. question_resolved right before
      // settling) must still land in events.jsonl.
      if (promptSent) pollMailboxes();
      clearTimeout(promptTimer);
      if (lastTextTimer) clearTimeout(lastTextTimer);
      for (const t of shutdownTimers) clearTimeout(t);
      process.off("SIGTERM", requestAbort);
      if (state.status !== "settled" && state.status !== "stopped") {
        state.status = "error";
        const tail = stderrTail.join("").split("\n").filter((l) => l.length > 0).slice(-8).join("\n");
        const reason = spawnError
          ? `failed to start pi: ${spawnError.message}`
          : `pi exited with code ${code ?? "unknown"} before settling`;
        state.error = state.error ?? (tail ? `${reason}\n${tail}` : reason);
      }
      if (!state.settledAt) state.settledAt = nowIso();
      state.pendingQuestion = null;
      await flushNow();
      resolve(0);
    };
    child.on("error", (err) => {
      spawnError = err;
      void finish(null);
    });
    child.on("close", (code) => void finish(code));
  });
}
