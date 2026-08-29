/**
 * The orchestrator: a `claude -p` child driven over stream-json. This class owns
 * the process and the wire protocol; it knows nothing about the TUI. It emits
 * typed events for every message and keeps a small amount of derived state
 * (session id, cost, whether a turn is running, pending permission requests).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { splitJsonLines, nowIso } from "../util.js";
import { buildClaudeArgs, claudeCommand, type ClaudeArgsOptions } from "./args.js";
import {
  parseClaudeLine,
  isSystemInit,
  isCanUseTool,
  isAssistant,
  isUser,
  isResult,
  isStreamEvent,
  textDeltaOf,
  toolUsesOf,
  userMessage,
  allowResponse,
  denyResponse,
  askUserQuestionResponse,
  interruptRequest,
  setPermissionModeRequest,
  applyFlagSettingsRequest,
  initializeRequest,
  serialize,
  newRequestId,
  type ClaudeStreamMessage,
  type SystemInitMessage,
  type AssistantMessage,
  type UserMessage,
  type StreamEventMessage,
  type ResultMessage,
  type CanUseToolRequest,
  type ControlResponseMessage,
  type PermissionUpdate,
  type PermissionMode,
  type AskUserQuestionAnswers,
  type AgentCommand,
} from "./protocol.js";

export interface OrchestratorProcessOptions extends ClaudeArgsOptions {
  /** The repository the orchestrator works in (claude's cwd). */
  cwd: string;
  /** Raw protocol log (both directions), e.g. `.pi-fleet/orchestrator.log`. */
  logPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Escalation delays for stop(). */
  stopGraceMs?: number;
}

export interface PermissionRequest {
  requestId: string;
  request: CanUseToolRequest;
  receivedAt: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OrchestratorProcessEvents {
  init: [SystemInitMessage];
  assistant: [AssistantMessage];
  user: [UserMessage];
  text_delta: [string, StreamEventMessage];
  stream_event: [StreamEventMessage];
  result: [ResultMessage];
  permission_request: [PermissionRequest];
  control_response: [ControlResponseMessage];
  commands: [AgentCommand[]];
  /** Every parsed message, in order. */
  message: [ClaudeStreamMessage];
  /** A line we wrote to the child's stdin. */
  sent: [unknown];
  stderr: [string];
  spawned: [number];
  exit: [ExitInfo];
  error: [Error];
}

const CONTROL_TIMEOUT_MS = 5_000;

/** A stream event carrying the model's reasoning rather than its answer. */
function isThinkingEvent(msg: { event?: { type?: string; delta?: { type?: string }; content_block?: { type?: string } } }): boolean {
  const ev = msg.event;
  if (!ev) return false;
  if (ev.type === "content_block_delta") return ev.delta?.type === "thinking_delta";
  return ev.type === "content_block_start" && ev.content_block?.type === "thinking";
}

export class OrchestratorProcess extends EventEmitter<OrchestratorProcessEvents> {
  readonly options: OrchestratorProcessOptions;
  readonly pendingRequests = new Map<string, PermissionRequest>();
  sessionId: string | null;
  model: string | null = null;
  claudeVersion: string | null = null;
  capabilities: string[] = [];
  /** Slash commands and skills claude offers, learned from the initialize response. */
  slashCommands: AgentCommand[] = [];
  costUsd = 0;
  numTurns = 0;
  /** True from the moment we send a user message until the next `result`. */
  turnActive = false;
  /** What the model is doing right now: reasoning, writing, or in a tool. */
  activity: { kind: "thinking" | "responding" | "tool"; label?: string; since: number } | null = null;
  initReceived = false;
  exited: ExitInfo | null = null;
  private child: ChildProcess | null = null;
  private rest = "";
  private log: fs.WriteStream | null = null;
  private stderrTail: string[] = [];
  private controlWaiters = new Map<string, { resolve: (v: Record<string, unknown> | null) => void; timer: NodeJS.Timeout }>();

  constructor(options: OrchestratorProcessOptions) {
    super();
    this.options = options;
    this.sessionId = options.resumeSessionId ?? null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.child !== null && this.exited === null;
  }

  /** The argv the child is started with (without the executable). */
  args(): string[] {
    return buildClaudeArgs(this.options);
  }

  start(): void {
    if (this.child) throw new Error("orchestrator already started");
    if (this.options.logPath) this.log = fs.createWriteStream(this.options.logPath, { flags: "a" });
    const { bin, prefix } = claudeCommand(this.options.env ?? process.env);
    const child = spawn(bin, [...prefix, ...this.args()], {
      cwd: this.options.cwd,
      env: { ...(this.options.env ?? process.env) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.log?.write(`[${nowIso()}] spawn pid=${child.pid ?? "?"} ${bin} ${this.args().join(" ")}\n`);
    // A write that races the child's death fails asynchronously (EPIPE). Without a
    // listener that is an uncaught exception, which would take the whole app down;
    // the `close` handler below is what actually reports the child going away.
    child.stdin?.on("error", (err: Error) => {
      this.log?.write(`[stdin error] ${err.message}\n`);
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      this.log?.write(`[stderr] ${text}`);
      this.emit("stderr", text);
    });
    child.on("error", (err) => {
      this.log?.write(`[error] ${err.message}\n`);
      this.emit("error", err);
    });
    child.on("close", (code, signal) => {
      this.exited = { code, signal };
      this.turnActive = false;
      for (const w of this.controlWaiters.values()) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      this.controlWaiters.clear();
      this.log?.write(`[${nowIso()}] exit code=${code} signal=${signal}\n`);
      this.log?.end();
      this.emit("exit", { code, signal });
    });
    if (child.pid) this.emit("spawned", child.pid);
    // The handshake is also how we learn which commands and skills this claude
    // offers, so it is always sent; the spike showed permission prompts do not
    // depend on it.
    void this.initialize().then((response) => {
      const commands = response?.commands;
      if (Array.isArray(commands)) {
        this.slashCommands = commands.filter((c): c is AgentCommand => Boolean(c && typeof (c as AgentCommand).name === "string"));
        this.emit("commands", this.slashCommands);
      }
    });
  }

  /** Last stderr output, for error reporting. */
  stderrText(): string {
    return this.stderrTail.join("");
  }

  private write(msg: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || this.exited) return false;
    const line = serialize(msg);
    this.log?.write(`> ${line}`);
    try {
      stdin.write(line);
    } catch {
      return false;
    }
    this.emit("sent", msg);
    return true;
  }

  /** A user turn, or an async message injected mid-turn (claude folds it into the running turn). */
  send(text: string): boolean {
    const okWrite = this.write(userMessage(text));
    if (okWrite) {
      this.turnActive = true;
      this.activity = { kind: "thinking", since: Date.now() };
    }
    return okWrite;
  }

  allow(requestId: string, updatedPermissions?: PermissionUpdate[]): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    return this.write(allowResponse(requestId, pending.request.input, updatedPermissions));
  }

  deny(requestId: string, message: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    return this.write(denyResponse(requestId, message));
  }

  /** Answer an AskUserQuestion request (answers keyed by question text). */
  answerQuestion(requestId: string, answers: AskUserQuestionAnswers): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    return this.write(askUserQuestionResponse(requestId, pending.request.input, answers));
  }

  private control(requestId: string, msg: unknown): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      if (!this.write(msg)) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId);
        resolve(null);
      }, CONTROL_TIMEOUT_MS);
      this.controlWaiters.set(requestId, { resolve, timer });
    });
  }

  /** Stop the running turn; resolves with the CLI's receipt (or null on timeout). */
  interrupt(cancelQueued = false): Promise<Record<string, unknown> | null> {
    const id = newRequestId();
    return this.control(id, interruptRequest(id, cancelQueued));
  }

  setPermissionMode(mode: PermissionMode): Promise<Record<string, unknown> | null> {
    const id = newRequestId();
    return this.control(id, setPermissionModeRequest(id, mode));
  }

  /** Change session settings (effort, thinking) without saying anything to the model. */
  applyFlagSettings(settings: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = newRequestId();
    return this.control(id, applyFlagSettingsRequest(id, settings));
  }

  initialize(extra: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    const id = newRequestId();
    return this.control(id, initializeRequest(id, extra));
  }

  /**
   * End the running turn, then stdin, then escalate to SIGTERM and SIGKILL.
   *
   * The interrupt matters: a `claude -p` killed mid-turn leaves that turn
   * unfinished, and resuming the session *continues* it — which looks like the
   * session restarting itself the next time the console opens.
   */
  async stop(): Promise<ExitInfo> {
    if (this.child && !this.exited && this.turnActive) {
      await Promise.race([this.interrupt(true), new Promise((r) => setTimeout(r, 2_000))]);
      if (this.turnActive) await Promise.race([once(this, "result"), new Promise((r) => setTimeout(r, 1_500))]);
    }
    return this.stopNow();
  }

  /** Close the child down without ending the turn first. */
  stopNow(): Promise<ExitInfo> {
    const child = this.child;
    if (!child) return Promise.resolve({ code: null, signal: null });
    if (this.exited) return Promise.resolve(this.exited);
    const grace = this.options.stopGraceMs ?? 3_000;
    return new Promise((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const done = (info: ExitInfo): void => {
        for (const t of timers) clearTimeout(t);
        resolve(info);
      };
      this.once("exit", done);
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      timers.push(setTimeout(() => child.kill("SIGTERM"), grace));
      timers.push(setTimeout(() => child.kill("SIGKILL"), grace * 2));
    });
  }

  private onStdout(chunk: Buffer): void {
    const framed = splitJsonLines(chunk.toString(), this.rest);
    this.rest = framed.rest;
    for (const line of framed.lines) {
      this.log?.write(`< ${line}\n`);
      const msg = parseClaudeLine(line);
      if (msg) this.handleMessage(msg);
    }
  }

  private handleMessage(msg: ClaudeStreamMessage): void {
    this.emit("message", msg);
    if (isSystemInit(msg)) {
      this.initReceived = true;
      this.sessionId = msg.session_id;
      this.model = msg.model ?? this.model;
      this.claudeVersion = msg.claude_code_version ?? this.claudeVersion;
      this.capabilities = msg.capabilities ?? [];
      this.emit("init", msg);
      return;
    }
    if (isCanUseTool(msg)) {
      const pending: PermissionRequest = { requestId: msg.request_id, request: msg.request, receivedAt: nowIso() };
      this.pendingRequests.set(msg.request_id, pending);
      this.emit("permission_request", pending);
      return;
    }
    if (msg.type === "control_cancel_request") {
      const id = (msg as { request_id?: string }).request_id;
      if (id) this.pendingRequests.delete(id);
      return;
    }
    if (msg.type === "control_response") {
      const response = (msg as ControlResponseMessage).response;
      const waiter = this.controlWaiters.get(response.request_id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.controlWaiters.delete(response.request_id);
        waiter.resolve(response.subtype === "success" ? (response.response ?? {}) : null);
      }
      this.emit("control_response", msg as ControlResponseMessage);
      return;
    }
    if (isStreamEvent(msg)) {
      this.turnActive = true;
      const delta = textDeltaOf(msg);
      if (delta !== null) {
        if (this.activity?.kind !== "responding") this.activity = { kind: "responding", since: Date.now() };
        this.emit("text_delta", delta, msg);
      } else if (isThinkingEvent(msg) && this.activity?.kind !== "thinking") {
        this.activity = { kind: "thinking", since: Date.now() };
      }
      this.emit("stream_event", msg);
      return;
    }
    if (isAssistant(msg)) {
      this.turnActive = true;
      const tools = toolUsesOf(msg);
      if (tools.length > 0) this.activity = { kind: "tool", label: tools[tools.length - 1].name, since: Date.now() };
      this.emit("assistant", msg);
      return;
    }
    if (isUser(msg)) {
      this.emit("user", msg);
      return;
    }
    if (isResult(msg)) {
      this.turnActive = false;
      this.activity = null;
      if (typeof msg.total_cost_usd === "number") this.costUsd = msg.total_cost_usd;
      if (typeof msg.num_turns === "number") this.numTurns = msg.num_turns;
      if (msg.session_id) this.sessionId = msg.session_id;
      this.emit("result", msg);
      return;
    }
  }
}
