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

export interface OrchestratorClientOptions {
  piFleetDir: string;
  cwd: string;
  model?: string;
  budget?: string;
  fresh?: boolean;
  /** Starting permission mode for a monitor this client has to start. */
  permissionMode?: string;
  pollMs?: number;
}

export class OrchestratorClient extends EventEmitter<OrchestratorClientEvents> {
  readonly piFleetDir: string;
  state: OrchestratorState | null = null;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly announced = new Set<string>();
  private lastStateJson = "";

  constructor(private readonly options: OrchestratorClientOptions) {
    super();
    this.piFleetDir = options.piFleetDir;
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
      if (this.options.fresh || !this.running()) {
        try {
          fs.rmSync(paths.events, { force: true });
          fs.rmSync(paths.control, { force: true });
        } catch {
          // a fresh start is best effort
        }
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

  private spawnMonitor(): void {
    const paths = orchestratorPaths(this.piFleetDir);
    // a restarted monitor keeps the mode the last one was running in
    const mode = this.options.permissionMode ?? loadOrchestratorState(this.piFleetDir)?.permissionMode ?? null;
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
      ...(this.options.fresh ? ["--fresh"] : []),
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
      this.emit("record", event as Record<string, unknown>);
      if (event?.type === "exit") this.emit("exit", { code: event.code ?? null, signal: event.signal ?? null });
    }
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
      this.announced.add(pending.requestId);
      this.emit("permission_request", pending);
    }
    for (const id of [...this.announced]) {
      if (!state.pendingRequests.some((p) => p.requestId === id)) this.announced.delete(id);
    }
  }
}
