/**
 * The detached owner of the `claude` child. It keeps the orchestrator alive
 * while consoles come and go: everything claude says lands in `events.jsonl`
 * and `state.json`, and anything a console wants done arrives through
 * `control.jsonl`. Quitting a console leaves this process running; `/shutdown`
 * (or a `stop` control line) is what ends it.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, nowIso, parseLineSafe, readNewLines } from "../util.js";
import { OrchestratorProcess } from "./process.js";
import { fleetMcpConfig } from "./mcpConfig.js";
import { loadSession, newSession, saveSession } from "./session.js";
import {
  newOrchestratorState,
  orchestratorPaths,
  type OrchestratorCommand,
  type OrchestratorControl,
  type OrchestratorEvent,
  type OrchestratorState,
} from "./records.js";
import {
  isAssistant,
  isResult,
  isSystemInit,
  isUser,
  textDeltaOf,
  type ClaudeStreamMessage,
} from "./protocol.js";
import { activityOf } from "../tui/model.js";

const FLUSH_MS = 200;
const CONTROL_POLL_MS = 200;
/** Token deltas are coalesced into one record per tick, so the file stays small. */
const STREAM_FLUSH_MS = 150;

export interface OrchestratorMonitorArgs {
  piFleetDir: string;
  cwd: string;
  model?: string | null;
  budget?: number | null;
  fresh?: boolean;
  /** Starting permission mode; the console can change it later. */
  permissionMode?: string | null;
  /** Register with Claude Code's Remote Control under this name ("" for an automatic one). */
  remoteControl?: string | null;
}

export async function runOrchestratorMonitor(args: OrchestratorMonitorArgs): Promise<number> {
  const paths = orchestratorPaths(args.piFleetDir);
  fs.mkdirSync(paths.dir, { recursive: true });

  const state: OrchestratorState = {
    ...newOrchestratorState(args.cwd),
    pid: process.pid,
    permissionMode: args.permissionMode ?? "default",
    remoteControl: args.remoteControl ?? null,
  };
  const session = (args.fresh ? null : loadSession(args.piFleetDir)) ?? newSession(args.cwd);

  let dirty = false;
  // Writes are serialized: two concurrent atomic writes can land out of order,
  // and an older one winning would drop things the console needs to see — a
  // permission request waiting for an answer, say.
  let writeChain: Promise<void> = Promise.resolve();
  const writeState = (): void => {
    dirty = false;
    const snapshot = JSON.parse(JSON.stringify(state)) as OrchestratorState;
    writeChain = writeChain.then(async () => {
      try {
        await atomicWriteJson(paths.state, snapshot);
      } catch {
        dirty = true; // the periodic flush will try again
      }
    });
  };
  const writeEvent = (event: OrchestratorEvent): void => {
    try {
      fs.appendFileSync(paths.events, JSON.stringify(event) + "\n");
    } catch {
      // the transcript is best effort; state.json is what matters
    }
  };
  writeState();

  const proc = new OrchestratorProcess({
    cwd: args.cwd,
    promptFile: paths.prompt,
    mcpConfigJson: JSON.stringify(fleetMcpConfig(args.piFleetDir)),
    model: args.model ?? undefined,
    resumeSessionId: args.fresh ? null : session.sessionId,
    maxBudgetUsd: args.budget ?? null,
    permissionMode: args.permissionMode ?? null,
    remoteControl: args.remoteControl ?? null,
    logPath: paths.log,
  });

  // Coalesce token deltas: one record per tick rather than one per token.
  let pendingText = "";
  const flushText = (): void => {
    if (!pendingText) return;
    writeEvent({ type: "stream_text", text: pendingText });
    pendingText = "";
  };

  proc.on("message", (msg: ClaudeStreamMessage) => {
    if (textDeltaOf(msg as never) !== null) return; // handled by text_delta below
    if (isSystemInit(msg) || isAssistant(msg) || isUser(msg) || isResult(msg) || (msg.type === "system" && (msg as { subtype?: string }).subtype === "api_retry")) {
      flushText();
      writeEvent(msg as OrchestratorEvent);
    }
  });
  proc.on("text_delta", (delta) => {
    pendingText += delta;
    state.lastActivity = nowIso();
    dirty = true;
  });
  proc.on("init", (init) => {
    state.sessionId = init.session_id;
    state.model = init.model ?? state.model;
    state.claudeVersion = init.claude_code_version ?? state.claudeVersion;
    state.capabilities = init.capabilities ?? [];
    state.mcpServers = init.mcp_servers ?? [];
    session.sessionId = init.session_id;
    session.pid = process.pid;
    session.model = state.model;
    session.claudeVersion = state.claudeVersion;
    void saveSession(args.piFleetDir, session);
    writeState();
  });
  proc.on("commands", (commands) => {
    state.commands = commands;
    dirty = true;
  });
  proc.on("permission_request", (request) => {
    flushText();
    state.pendingRequests.push({ requestId: request.requestId, request: request.request, receivedAt: request.receivedAt });
    writeEvent({ type: "permission_request", requestId: request.requestId, request: request.request });
    writeState();
  });
  proc.on("result", () => {
    flushText();
    state.costUsd = proc.costUsd;
    state.numTurns = proc.numTurns;
    state.turnActive = false;
    state.activity = null;
    writeState();
  });
  proc.on("stderr", (text) => {
    const trimmed = text.trim();
    if (trimmed) writeEvent({ type: "notice", text: trimmed, error: true });
  });

  let finished = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("exit", (info) => {
      finished = true;
      flushText();
      state.exited = { code: info.code, signal: info.signal, at: nowIso() };
      state.turnActive = false;
      state.activity = null;
      state.pid = null;
      writeEvent({ type: "exit", code: info.code, signal: info.signal });
      writeState();
      resolve(info);
    });
  });

  proc.start();
  state.pid = process.pid;
  writeState();
  writeEvent({
    type: "notice",
    text: args.fresh
      ? "· new orchestrator session"
      : session.sessionId
        ? `· resumed the orchestrator session ${session.sessionId.slice(0, 8)}`
        : "· orchestrator started",
  });

  // What the console shows as "thinking…" is derived here, so it survives a reattach.
  const activityTimer = setInterval(() => {
    const next = activityOf(proc);
    if ((next?.kind ?? null) !== (state.activity?.kind ?? null) || next?.label !== state.activity?.label) {
      state.activity = next;
      writeEvent({ type: "activity", activity: next });
      dirty = true;
    }
    state.turnActive = proc.turnActive;
    if (dirty) writeState();
    flushText();
  }, STREAM_FLUSH_MS);

  const flusher = setInterval(() => {
    if (dirty) writeState();
  }, FLUSH_MS);

  let controlOffset = 0;
  const handleControl = async (control: OrchestratorControl): Promise<void> => {
    switch (control.type) {
      case "user":
        state.turnActive = true;
        state.lastActivity = nowIso();
        state.activity = { kind: "thinking", since: Date.now() };
        writeEvent({ type: "activity", activity: state.activity });
        writeState();
        proc.send(control.text);
        return;
      case "permission": {
        const index = state.pendingRequests.findIndex((p) => p.requestId === control.requestId);
        if (index === -1) return;
        const [pending] = state.pendingRequests.splice(index, 1);
        if (control.decision.behavior === "allow") proc.allow(control.requestId, control.decision.updatedPermissions);
        else if (control.decision.behavior === "deny") proc.deny(control.requestId, control.decision.message);
        else proc.answerQuestion(control.requestId, control.decision.answers);
        writeEvent({ type: "permission_resolved", requestId: pending.requestId, how: control.decision.behavior });
        writeState();
        return;
      }
      case "interrupt":
        await proc.interrupt(true);
        writeEvent({ type: "notice", text: "· interrupt requested" });
        return;
      case "permission_mode": {
        const response = await proc.setPermissionMode(control.mode as never);
        if (response === null) {
          writeEvent({ type: "notice", text: `! claude refused the permission mode ${control.mode}`, error: true });
          return;
        }
        state.permissionMode = control.mode;
        writeEvent({ type: "notice", text: `· permission mode → ${control.mode}` });
        writeState();
        return;
      }
      case "effort": {
        // a settings merge, not a message: the conversation is left alone
        const response = await proc.applyFlagSettings({ effort: control.level });
        if (response === null) {
          // older CLIs may not know the setting; fall back to the slash command
          writeEvent({ type: "notice", text: `· effort set through /effort (this claude has no settings merge)` });
          proc.send(`/effort ${control.level}`);
        }
        state.effort = control.level;
        writeState();
        return;
      }
      case "stop":
        writeEvent({ type: "notice", text: "· shutting down" });
        await proc.stop();
        return;
    }
  };

  const controlTimer = setInterval(() => {
    if (finished) return;
    const { lines, offset } = readNewLines(paths.control, controlOffset);
    controlOffset = offset;
    for (const line of lines) {
      const parsed = parseLineSafe<OrchestratorControl>(line);
      if (parsed.ok && parsed.value && typeof parsed.value.type === "string") void handleControl(parsed.value);
    }
  }, CONTROL_POLL_MS);

  // A console that starts fresh must not replay an old session's transcript.
  const onSignal = (): void => {
    void proc.stopNow();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  await exited;
  await writeChain;
  clearInterval(activityTimer);
  clearInterval(flusher);
  clearInterval(controlTimer);
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  session.pid = null;
  await saveSession(args.piFleetDir, session);
  writeState();
  await writeChain;
  return 0;
}

/** Where the console writes its side of the conversation. */
export async function appendOrchestratorControl(piFleetDir: string, control: OrchestratorCommand): Promise<void> {
  const paths = orchestratorPaths(piFleetDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const line = { id: `oc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ts: nowIso(), ...control };
  await fs.promises.appendFile(paths.control, JSON.stringify(line) + "\n");
}

export function loadOrchestratorState(piFleetDir: string): OrchestratorState | null {
  try {
    return JSON.parse(fs.readFileSync(orchestratorPaths(piFleetDir).state, "utf8")) as OrchestratorState;
  } catch {
    return null;
  }
}

export { orchestratorPaths, path as nodePath };
