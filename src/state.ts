import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, nowIso, sanitizeName, escapeRegExp, newId } from "./util.js";

export const RUN_STATES = [
  "starting",
  "running",
  "settled",
  "stopped",
  "error",
  "dead",
  "archived",
] as const;
export type RunStateName = (typeof RUN_STATES)[number];

export const TERMINAL_STATES = [
  "settled",
  "stopped",
  "error",
  "dead",
  "archived",
] as const;

export interface SteeringEntry {
  source: string;
  ts: string;
  message: string;
}

/** A `fleet_ask` the worker is blocked on until an `answer` control line lands. */
export interface PendingQuestion {
  id: string;
  question: string;
  options: string[] | null;
  context: string | null;
  askedAt: string;
}

export interface RunState {
  id: string;
  name: string;
  status: RunStateName;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  /** Commit the worker branch was cut from (resolved at spawn); null without a worktree. */
  baseCommit: string | null;
  model: string | null;
  provider: string | null;
  thinking: string | null;
  sessionArg: string | null;
  skill: string | null;
  appendSystemPrompt: string | null;
  tools: string | null;
  excludeTools: string | null;
  taskBrief: string;
  fleetDir: string;
  repoRoot: string | null;
  isGit: boolean;
  pid: number | null;
  createdAt: string;
  settledAt: string | null;
  lastTool: string | null;
  lastActivity: string | null;
  lastAssistantText: string | null;
  steerCount: number;
  steeringLog: SteeringEntry[];
  error: string | null;
  /** Set while the worker waits in `fleet_ask`; absent in state files written before this field existed. */
  pendingQuestion?: PendingQuestion | null;
  /** Last `fleet_progress` message. */
  lastProgress?: string | null;
}

export interface RunRef {
  runId: string;
  runDir: string;
  state: RunState;
}

export function runDirFor(fleetDir: string, runId: string): string {
  return path.join(fleetDir, "runs", runId);
}

export function newRunState(input: {
  fleetDir: string;
  runId: string;
  name: string;
  cwd: string;
  worktree?: string | null;
  branch?: string | null;
  base?: string | null;
  model?: string | null;
  provider?: string | null;
  thinking?: string | null;
  sessionArg?: string | null;
  skill?: string | null;
  appendSystemPrompt?: string | null;
  tools?: string | null;
  excludeTools?: string | null;
  taskBrief?: string;
}): RunState {
  return {
    id: input.runId,
    name: input.name,
    status: "starting",
    cwd: input.cwd,
    worktree: input.worktree ?? null,
    branch: input.branch ?? null,
    base: input.base ?? null,
    baseCommit: null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    thinking: input.thinking ?? null,
    sessionArg: input.sessionArg ?? null,
    skill: input.skill ?? null,
    appendSystemPrompt: input.appendSystemPrompt ?? null,
    tools: input.tools ?? null,
    excludeTools: input.excludeTools ?? null,
    taskBrief: input.taskBrief ?? "",
    fleetDir: input.fleetDir,
    repoRoot: null,
    isGit: false,
    pid: null,
    createdAt: nowIso(),
    settledAt: null,
    lastTool: null,
    lastActivity: null,
    lastAssistantText: null,
    steerCount: 0,
    steeringLog: [],
    error: null,
    pendingQuestion: null,
    lastProgress: null,
  };
}

export async function loadState(runDir: string): Promise<RunState> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(runDir, "state.json"), "utf8");
  } catch {
    throw new Error(`No readable state.json in ${runDir}`);
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    throw new Error(`Corrupted state.json in ${runDir}`);
  }
}

export function loadStateSync(runDir: string): RunState {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir, "state.json"), "utf8");
  } catch {
    throw new Error(`No readable state.json in ${runDir}`);
  }
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    throw new Error(`Corrupted state.json in ${runDir}`);
  }
}

export async function saveState(
  runDir: string,
  state: RunState,
): Promise<void> {
  await atomicWriteJson(path.join(runDir, "state.json"), state);
}

export function isAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** A freshly spawned run has no pid until its monitor boots; don't call it dead yet. */
export const STARTING_GRACE_MS = 30_000;

export function deriveStatus(
  state: RunState,
  liveness: (pid: number | null | undefined) => boolean = isAlive,
  now: number = Date.now(),
): RunStateName {
  if (state.status === "starting" && state.pid === null) {
    return now - Date.parse(state.createdAt) > STARTING_GRACE_MS ? "dead" : "starting";
  }
  if (
    (state.status === "starting" || state.status === "running") &&
    !liveness(state.pid)
  ) {
    return "dead";
  }
  return state.status;
}

/**
 * What observers show: the durable status, except that a running worker
 * waiting on a `fleet_ask` answer is `blocked`. Never stored.
 */
export type DerivedView = RunStateName | "blocked";

export function deriveView(
  state: RunState,
  liveness: (pid: number | null | undefined) => boolean = isAlive,
  now: number = Date.now(),
): DerivedView {
  const status = deriveStatus(state, liveness, now);
  return status === "running" && state.pendingQuestion ? "blocked" : status;
}

export function recordToolActivity(
  state: RunState,
  toolName: string | null | undefined,
): void {
  state.lastTool = toolName ?? state.lastTool;
  state.lastActivity = nowIso();
}

export function recordSteering(
  state: RunState,
  entry: { source: string; message: string; ts: string },
): void {
  state.steerCount += 1;
  state.steeringLog.push({
    source: entry.source,
    ts: entry.ts,
    message: entry.message,
  });
  if (state.steeringLog.length > 20) {
    state.steeringLog.splice(0, state.steeringLog.length - 20);
  }
}

export type ControlType = "steer" | "follow_up" | "abort" | "answer";

/** One line of `control.jsonl` (orchestrator/console → monitor and the worker's `fleet_ask`). */
export interface ControlMessage {
  /** Absent in lines written before ids existed. */
  id?: string;
  type: ControlType;
  message: string | null;
  source: string;
  ts: string;
  /** For `answer`: the `fleet_ask` question being answered. */
  questionId?: string | null;
}

export async function appendControl(
  runDir: string,
  msg: { type: ControlType; message: string | null; source: string; questionId?: string | null },
): Promise<void> {
  const line: ControlMessage = {
    id: newId("ctl"),
    type: msg.type,
    message: msg.message,
    source: msg.source,
    ts: nowIso(),
  };
  if (msg.type === "answer") line.questionId = msg.questionId ?? null;
  await fsp.appendFile(
    path.join(runDir, "control.jsonl"),
    JSON.stringify(line) + "\n",
  );
}

export function listRuns(
  fleetDir: string,
): { runId: string; runDir: string }[] {
  const runsDir = path.join(fleetDir, "runs");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return entries
    .map((runId) => ({ runId, runDir: path.join(runsDir, runId) }))
    .filter((r) => fs.existsSync(path.join(r.runDir, "state.json")))
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

/**
 * Resolve `<name>` (newest non-archived run of exactly that name) or a full run id.
 * A name matches only `<name>-<14-digit stamp>`, so `api` never resolves to `api-tests-…`.
 */
export function findRun(fleetDir: string, nameOrId: string): RunRef {
  const key = sanitizeName(nameOrId.trim());
  const ofName = new RegExp(`^${escapeRegExp(key)}-\\d{14}$`);
  const candidates: RunRef[] = [];
  for (const r of listRuns(fleetDir)) {
    if (r.runId !== key && !ofName.test(r.runId)) continue;
    try {
      candidates.push({ runId: r.runId, runDir: r.runDir, state: loadStateSync(r.runDir) });
    } catch {
      // unreadable state.json: not a usable run
    }
  }
  const chosen = candidates.find((c) => c.state.status !== "archived") ?? candidates[0];
  if (!chosen) {
    throw new Error(`No run found matching "${nameOrId}" in ${fleetDir}/runs`);
  }
  return chosen;
}

/** Newest pi session file under `<runDir>/session`, for `--session` resume hints. */
export function findSessionFile(runDir: string): string | null {
  const dir = path.join(runDir, "session");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const newest = names
    .map((n) => ({ n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? path.join(dir, newest.n) : null;
}

/** Copy-pasteable command to continue a finished run's session in a new run. */
export function resumeHint(state: RunState, runDir: string): string {
  const session = findSessionFile(runDir) ?? path.join(runDir, "session", "<session-file>");
  return `pi-fleet spawn ${state.name}-2 --session ${session} -- "<new brief>"`;
}
