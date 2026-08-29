/**
 * The orchestrator's own mailbox, mirroring the workers': a detached monitor
 * owns the `claude` child and writes what happens to `events.jsonl` and
 * `state.json`, while consoles come and go, reading those files and appending
 * to `control.jsonl`. Nothing here talks to a process directly.
 */
import path from "node:path";
import type { CanUseToolRequest, PermissionUpdate, AskUserQuestionAnswers, AgentCommand } from "./protocol.js";
import type { Activity } from "../tui/model.js";

export const ORCHESTRATOR_DIR = "orchestrator";

export function orchestratorDir(piFleetDir: string): string {
  return path.join(piFleetDir, ORCHESTRATOR_DIR);
}

export const orchestratorPaths = (piFleetDir: string) => ({
  dir: orchestratorDir(piFleetDir),
  state: path.join(orchestratorDir(piFleetDir), "state.json"),
  events: path.join(orchestratorDir(piFleetDir), "events.jsonl"),
  control: path.join(orchestratorDir(piFleetDir), "control.jsonl"),
  log: path.join(orchestratorDir(piFleetDir), "claude.log"),
  monitorLog: path.join(orchestratorDir(piFleetDir), "monitor.log"),
  prompt: path.join(orchestratorDir(piFleetDir), "prompt.md"),
});

/** A permission prompt (or AskUserQuestion) waiting for a human. */
export interface PendingRequestRecord {
  requestId: string;
  request: CanUseToolRequest;
  receivedAt: string;
}

/** What a console needs to know without replaying the whole transcript. */
export interface OrchestratorState {
  version: 1;
  /** The monitor's pid; the claude child lives and dies with it. */
  pid: number | null;
  sessionId: string | null;
  model: string | null;
  claudeVersion: string | null;
  capabilities: string[];
  commands: AgentCommand[];
  mcpServers: { name: string; status: string }[];
  costUsd: number;
  numTurns: number;
  turnActive: boolean;
  activity: Activity | null;
  /** Reasoning level last asked for, since claude does not report one. */
  effort: string | null;
  /** How permission prompts are handled: default, auto, acceptEdits, dontAsk, plan. */
  permissionMode: string;
  startedAt: string;
  lastActivity: string | null;
  pendingRequests: PendingRequestRecord[];
  /** Set once the child is gone; the console then offers to start a new one. */
  exited: { code: number | null; signal: string | null; at: string } | null;
  cwd: string;
}

export function newOrchestratorState(cwd: string): OrchestratorState {
  return {
    version: 1,
    pid: null,
    sessionId: null,
    model: null,
    claudeVersion: null,
    capabilities: [],
    commands: [],
    mcpServers: [],
    costUsd: 0,
    numTurns: 0,
    turnActive: false,
    activity: null,
    effort: null,
    permissionMode: "default",
    startedAt: new Date().toISOString(),
    lastActivity: null,
    pendingRequests: [],
    exited: null,
    cwd,
  };
}

/** Console → monitor, before the id and timestamp are stamped on. */
export type OrchestratorCommand =
  | { type: "user"; text: string }
  | { type: "permission"; requestId: string; decision: PermissionDecisionRecord }
  | { type: "interrupt" }
  | { type: "effort"; level: string }
  | { type: "permission_mode"; mode: string }
  | { type: "stop" };

/** Console → monitor. */
export type OrchestratorControl =
  | { id: string; ts: string; type: "user"; text: string }
  | { id: string; ts: string; type: "permission"; requestId: string; decision: PermissionDecisionRecord }
  | { id: string; ts: string; type: "interrupt" }
  | { id: string; ts: string; type: "effort"; level: string }
  | { id: string; ts: string; type: "permission_mode"; mode: string }
  | { id: string; ts: string; type: "stop" };

export type PermissionDecisionRecord =
  | { behavior: "allow"; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string }
  | { behavior: "answer"; answers: AskUserQuestionAnswers };

/**
 * Monitor → console. Claude's own messages ride through as they are, except
 * token deltas, which are coalesced into `stream_text` so the file stays small
 * and a reattaching console can still replay what was said.
 */
export type OrchestratorEvent =
  | { type: "stream_text"; text: string }
  | { type: "activity"; activity: Activity | null }
  | { type: "permission_request"; requestId: string; request: CanUseToolRequest }
  | { type: "permission_resolved"; requestId: string; how: string }
  | { type: "notice"; text: string; error?: boolean }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: string; [key: string]: unknown };
