/**
 * The console's handle on the orchestrator. It never owns the `claude` child —
 * a detached monitor does — so quitting the console leaves the session running
 * and reopening it picks the conversation back up.
 */
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { isAlive } from "../state.js";
import { cliSpawnArgs } from "../commands.js";
import { readNewEvents } from "../console/transcript.js";
import { appendOrchestratorControl, loadOrchestratorState } from "./monitor.js";
import { orchestratorPaths, type OrchestratorState, type PendingRequestRecord, type PermissionDecisionRecord } from "./records.js";
import type { AskUserQuestionAnswers, PermissionUpdate } from "./protocol.js";

export interface OrchestratorClientEvents {
  /** Anything the monitor recorded: claude's messages and the monitor's own records. */
  record: [Record<string, unknown>];
  state: [OrchestratorState];
  permission_request: [PendingRequestRecord];
  exit: [{ code: number | null; signal: string | null }];
}

/** How much of an old transcript is carried into a restarted session. */
export const MAX_RESTORED_LINES = 2000;

/** Cap on what is held for a console that has not attached yet. */
const MAX_BUFFERED_RECORDS = 5000;

export interface OrchestratorClientOptions {
  piFleetDir: string;
  cwd: string;
  model?: string;
  budget?: string;
  fresh?: boolean;
  /** Starting permission mode for a monitor this client has to start. */
  permissionMode?: string;
  /** Remote Control name for a monitor this client has to start. */
  remoteControl?: string | null;
  pollMs?: number;
}

export class OrchestratorClient extends EventEmitter<OrchestratorClientEvents> {
  readonly piFleetDir: string;
  state: OrchestratorState | null = null;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly announced = new Set<string>();
  private lastStateJson = "";
  /** Records read before anything listened; a console attaches after start(). */
  private buffered: Record<string, unknown>[] = [];
  /** The catch-up read of an existing transcript is history, not news. */
  private caughtUp = false;
  /** Set by enableRemoteControl, for the monitor this client starts next. */
  private remoteControl: string | null = null;

  constructor(private readonly options: OrchestratorClientOptions) {
    super();
    this.piFleetDir = options.piFleetDir;
    // The console renders after start(), so the restored transcript would be
    // emitted to nobody. Hold it until something is listening.
    this.on("newListener", (name) => {
      if (name !== "record" || this.listenerCount("record") > 0) return;
      const pending = this.buffered;
      this.buffered = [];
      // the listener being added is not registered until this returns
      queueMicrotask(() => {
        for (const event of pending) this.emit("record", event);
      });
    });
  }

  /** True when a monitor is alive and owns a claude child. */
  running(): boolean {
    const state = loadOrchestratorState(this.piFleetDir);
    return Boolean(state && state.pid && isAlive(state.pid) && !state.exited);
  }

  /**
   * Attach to the running orchestrator, starting one if there is none. A fresh
   * start clears the transcript; otherwise the existing one is replayed.
   */
  start(): { attached: boolean } {
    const paths = orchestratorPaths(this.piFleetDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    const attached = this.running() && !this.options.fresh;
    if (!attached) {
      if (this.options.fresh) {
        // only --fresh throws the conversation away; otherwise the transcript is
        // the history, and the monitor resumes the same claude session under it
        try {
          fs.rmSync(paths.events, { force: true });
          fs.rmSync(paths.control, { force: true });
        } catch {
          // best effort
        }
      } else {
        // a control file from a dead monitor would be replayed by the new one
        try {
          fs.rmSync(paths.control, { force: true });
        } catch {
          // best effort
        }
        this.trimTranscript(paths.events);
      }
      this.spawnMonitor();
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.pollMs ?? 200);
    this.timer.unref?.();
    return { attached };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the monitor to shut the orchestrator down for good. */
  async shutdown(): Promise<void> {
    await appendOrchestratorControl(this.piFleetDir, { type: "stop" });
  }

  async send(text: string): Promise<void> {
    await appendOrchestratorControl(this.piFleetDir, { type: "user", text });
  }

  async interrupt(): Promise<void> {
    await appendOrchestratorControl(this.piFleetDir, { type: "interrupt" });
  }

  async setEffort(level: string): Promise<void> {
    await appendOrchestratorControl(this.piFleetDir, { type: "effort", level });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await appendOrchestratorControl(this.piFleetDir, { type: "permission_mode", mode });
  }

  /**
   * Remote Control is a launch flag, so turning it on means giving the session a
   * new claude process: the monitor stops, and a new one resumes the same
   * session with the flag set. The transcript is kept.
   */
  async enableRemoteControl(name: string): Promise<void> {
    this.remoteControl = name;
    await this.shutdown();
    const state = loadOrchestratorState(this.piFleetDir);
    const pid = state?.pid ?? null;
    const deadline = Date.now() + 10_000;
    while (pid && isAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.announced.clear();
    this.spawnMonitor(false);
  }

  async allow(requestId: string, updatedPermissions?: PermissionUpdate[]): Promise<void> {
    await this.respond(requestId, { behavior: "allow", updatedPermissions });
  }

  async deny(requestId: string, message: string): Promise<void> {
    await this.respond(requestId, { behavior: "deny", message });
  }

  async answerQuestion(requestId: string, answers: AskUserQuestionAnswers): Promise<void> {
    await this.respond(requestId, { behavior: "answer", answers });
  }

  private async respond(requestId: string, decision: PermissionDecisionRecord): Promise<void> {
    this.announced.add(requestId);
    await appendOrchestratorControl(this.piFleetDir, { type: "permission", requestId, decision });
  }

  /** Keep the transcript restorable without letting it grow forever. */
  private trimTranscript(eventsPath: string): void {
    try {
      const raw = fs.readFileSync(eventsPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      if (lines.length <= MAX_RESTORED_LINES) return;
      fs.writeFileSync(eventsPath, `${lines.slice(-MAX_RESTORED_LINES).join("\n")}\n`);
    } catch {
      // no transcript yet, or unreadable: nothing to trim
    }
  }

  /** `fresh` only ever comes from the launch flag; a restart must resume. */
  private spawnMonitor(fresh: boolean = Boolean(this.options.fresh)): void {
    const paths = orchestratorPaths(this.piFleetDir);
    // a restarted monitor keeps the mode the last one was running in
    const previous = loadOrchestratorState(this.piFleetDir);
    const mode = this.options.permissionMode ?? previous?.permissionMode ?? null;
    // undefined means "leave it off"; "" means on with an automatic name
    const remote = this.remoteControl ?? this.options.remoteControl ?? previous?.remoteControl ?? null;
    const logFd = fs.openSync(paths.monitorLog, "a");
    const args = [
      ...cliSpawnArgs(),
      "__orchestrator",
      this.piFleetDir,
      "--cwd",
      this.options.cwd,
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.budget ? ["--budget", this.options.budget] : []),
      ...(mode ? ["--permission-mode", mode] : []),
      ...(remote !== null ? ["--remote-control", ...(remote ? [remote] : [])] : []),
      ...(fresh ? ["--fresh"] : []),
    ];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    fs.closeSync(logFd);
  }

  private tick(): void {
    const paths = orchestratorPaths(this.piFleetDir);
    const { events, offset } = readNewEvents(paths.events, this.offset);
    this.offset = offset;
    for (const event of events) {
      const record = event as Record<string, unknown>;
      if (this.listenerCount("record") === 0) {
        this.buffered.push(record);
        if (this.buffered.length > MAX_BUFFERED_RECORDS) this.buffered.shift();
      } else {
        this.emit("record", record);
      }
      // an exit in a restored transcript belongs to the session that ended, and
      // announcing it would close a console over a conversation that is running
      if (event?.type === "exit" && this.caughtUp) {
        this.emit("exit", { code: event.code ?? null, signal: event.signal ?? null });
      }
    }
    this.caughtUp = true;
    const state = loadOrchestratorState(this.piFleetDir);
    if (!state) return;
    const json = JSON.stringify(state);
    if (json !== this.lastStateJson) {
      this.lastStateJson = json;
      this.state = state;
      this.emit("state", state);
    }
    // a request the monitor is still holding, that this console has not shown yet
    for (const pending of state.pendingRequests) {
      if (this.announced.has(pending.requestId)) continue;
      // with no console attached it stays unannounced, so the one that attaches
      // next is still asked
      if (this.listenerCount("permission_request") === 0) continue;
      this.announced.add(pending.requestId);
      this.emit("permission_request", pending);
    }
    for (const id of [...this.announced]) {
      if (!state.pendingRequests.some((p) => p.requestId === id)) this.announced.delete(id);
    }
  }
}
