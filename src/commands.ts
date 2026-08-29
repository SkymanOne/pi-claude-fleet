import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";
import { SRC_DIR } from "./paths.js";
import { createRun, sanitizeName, resolveFleetDir, type SpawnOpts } from "./spawn.js";
import {
  runDirFor,
  listRuns,
  findRun,
  findSessionFile,
  loadState,
  loadStateSync,
  saveState,
  deriveStatus,
  deriveView,
  isAlive,
  appendControl,
  resumeHint,
  TERMINAL_STATES,
  type ControlType,
  type DerivedView,
  type RunRef,
  type RunState,
} from "./state.js";
import { readJsonlTail, tailText, firstLine, formatAge, resultTextOf } from "./util.js";
import { readReport, buildSteeringAppendix } from "./report.js";
import { checkModel } from "./models.js";
import { gitRaw, isGitRepo, removeWorktree } from "./worktree.js";

export type { SpawnOpts } from "./spawn.js";

/**
 * What a command core produces: the exit code, the lines the CLI prints on
 * stdout (`out`) and stderr (`err`), and structured data for programmatic
 * callers such as the MCP server. Cores never print; `printResult` does.
 */
export interface CommandResult<T = unknown> {
  code: number;
  out: string[];
  err: string[];
  data: T;
}

export function ok<T>(data: T, out: string[] = [], err: string[] = []): CommandResult<T> {
  return { code: 0, out, err, data };
}

export function fail(code: number, ...err: string[]): CommandResult<null> {
  return { code, out: [], err, data: null };
}

/** Print a core's lines the way the CLI always has, and hand back its exit code. */
export function printResult(result: CommandResult<unknown>): number {
  for (const line of result.out) console.log(line);
  for (const line of result.err) console.error(line);
  return result.code;
}

/** Who a control message comes from: the orchestrating agent or a human at the console. */
export type ControlSource = "orchestrator" | "console";

/**
 * How to re-invoke this CLI as a detached background process.
 * - Production: compiled `dist/cli.js` (this file sits next to cli.js in dist/).
 * - Tests (PI_FLEET_DEV=1): run src/cli.ts through tsx so tests need no build.
 *   The tsx loader is resolved to an absolute path because a bare `--import
 *   tsx` cannot be resolved when the child's cwd is outside this package —
 *   the detached monitor inherits the orchestrator's cwd.
 */
export function cliSpawnArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.PI_FLEET_DEV === "1") {
    const loader = fileURLToPath(import.meta.resolve("tsx"));
    return ["--import", loader, path.join(SRC_DIR, "cli.ts")];
  }
  return [path.join(SRC_DIR, "cli.js")];
}

export async function launchMonitor(args: { piFleetDir: string; runId: string }): Promise<void> {
  const logFd = fs.openSync(path.join(runDirFor(args.piFleetDir, args.runId), "monitor.log"), "a");
  const child = spawn(
    process.execPath,
    [...cliSpawnArgs(), "__monitor", args.piFleetDir, args.runId],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  fs.closeSync(logFd);
}

export interface SpawnData {
  runId: string;
  runDir: string;
  piFleetDir: string;
  worktree: string | null;
  branch: string | null;
}

export async function spawnCore(args: { name: string; brief: string; opts: SpawnOpts }): Promise<CommandResult<SpawnData | null>> {
  if (!args.brief.trim()) throw new Error('spawn: task brief required after "--"');
  // before a worktree and a branch exist, so a wrong name costs a second
  const badModel = await checkModel(args.opts.model);
  if (badModel) return fail(2, `spawn: ${badModel}`);
  const created = await createRun({ name: sanitizeName(args.name), opts: args.opts, brief: args.brief });
  const err: string[] = [];
  if (!created.state.isGit && args.opts.worktree !== false) {
    err.push("warning: target is not a git repo — running in place without a worktree");
  }
  await launchMonitor({ piFleetDir: created.piFleetDir, runId: created.runId });
  const out = [
    `Spawned ${created.runId}`,
    `  state:    ${created.runDir}/state.json`,
    `  logs:     ${created.runDir}/{events.jsonl,rpc.log,monitor.log}`,
    `  fleet dir: ${created.piFleetDir}`,
  ];
  if (created.worktreePath) out.push(`  worktree: ${created.worktreePath}`);
  if (created.state.branch) out.push(`  branch:   ${created.state.branch}`);
  return ok(
    {
      runId: created.runId,
      runDir: created.runDir,
      piFleetDir: created.piFleetDir,
      worktree: created.worktreePath,
      branch: created.state.branch,
    },
    out,
    err,
  );
}

export const cmdSpawn = async (args: { name: string; brief: string; opts: SpawnOpts }): Promise<number> =>
  printResult(await spawnCore(args));

const WAIT_POLL_MS = 2000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isTerminal = (status: string): boolean => (TERMINAL_STATES as readonly string[]).includes(status);

/** Locate the fleet dir for `cwd` and the newest non-archived run called `name`. */
export async function resolveRun(name: string, cwd?: string): Promise<{ piFleetDir: string; run: RunRef }> {
  if (!name) throw new Error("<name> required");
  const { piFleetDir } = await resolveFleetDir(cwd);
  return { piFleetDir, run: findRun(piFleetDir, name) };
}

/** A run state as observers see it: `status` is the derived view (may be `blocked`). */
export type DerivedRunState = Omit<RunState, "status"> & { status: DerivedView; sessionFile?: string | null };

function withDerivedStatus(state: RunState): DerivedRunState {
  return { ...state, status: deriveView(state) };
}

export interface StatusArgs {
  name?: string;
  cwd?: string;
  json?: boolean;
  all?: boolean;
}

export interface StatusData {
  /** Runs with their derived status; one element when `name` was given. */
  runs: DerivedRunState[];
}

export async function statusCore(args: StatusArgs): Promise<CommandResult<StatusData>> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  if (args.name) {
    const { state, runDir } = findRun(piFleetDir, args.name);
    // the session file is what `spawn --session` / fleet_spawn(session) resumes
    const derived: DerivedRunState = { ...withDerivedStatus(state), sessionFile: findSessionFile(runDir) };
    return ok({ runs: [derived] }, [JSON.stringify(derived, null, 2)]);
  }
  const runs = listRuns(piFleetDir)
    .flatMap(({ runDir }) => {
      try {
        return [loadStateSync(runDir)];
      } catch {
        return [];
      }
    })
    .filter((s) => args.all || s.status !== "archived");
  const derived = runs.map(withDerivedStatus);
  if (args.json) return ok({ runs: derived }, [JSON.stringify(derived, null, 2)]);
  if (runs.length === 0) return ok({ runs: derived }, ["(no runs)"]);
  const table = new Table({
    head: ["NAME", "STATE", "LAST-ACTIVITY", "LAST-TOOL", "STEERED", "AGE"],
    style: { head: [], border: [] },
  });
  for (const s of derived) {
    table.push([
      s.name,
      s.status,
      s.lastActivity ?? "-",
      s.lastTool ?? "-",
      String(s.steerCount),
      formatAge(Math.max(0, Date.now() - Date.parse(s.createdAt))),
    ]);
  }
  return ok({ runs: derived }, [table.toString()]);
}

export const cmdStatus = async (args: StatusArgs): Promise<number> => printResult(await statusCore(args));

export interface WaitArgs {
  name: string;
  cwd?: string;
  timeout?: string;
}

export interface WaitData {
  name: string;
  /** Derived status at the end, or null when the wait timed out. */
  status: string | null;
}

/** Exit 0 settled/archived · 3 timeout · 4 stopped/error/dead. */
export async function waitCore(args: WaitArgs): Promise<CommandResult<WaitData>> {
  const { run } = await resolveRun(args.name, args.cwd);
  const timeoutSec = Number(args.timeout) > 0 ? Number(args.timeout) : 600;
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    let state: RunState | null = null;
    try {
      state = await loadState(run.runDir);
    } catch {
      state = null;
    }
    if (state) {
      const derived = deriveStatus(state);
      if (isTerminal(derived)) {
        const code = derived === "settled" || derived === "archived" ? 0 : 4;
        return { code, out: [`${state.name} ${derived}`], err: [], data: { name: state.name, status: derived } };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        code: 3,
        out: [],
        err: [`wait: timed out after ${timeoutSec}s waiting for ${run.state.name}`],
        data: { name: run.state.name, status: null },
      };
    }
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
}

export const cmdWait = async (args: WaitArgs): Promise<number> => printResult(await waitCore(args));

export interface OutputArgs {
  name: string;
  cwd?: string;
  tail?: string;
}

export interface TextData {
  text: string;
}

export async function outputCore(args: OutputArgs): Promise<CommandResult<TextData>> {
  const { run } = await resolveRun(args.name, args.cwd);
  if (args.tail !== undefined) {
    const n = Number(args.tail) > 0 ? Number(args.tail) : 10;
    const events = await readJsonlTail<any>(path.join(run.runDir, "events.jsonl"), 5000);
    const ends = events.filter((e) => e.type === "tool_execution_end").slice(-n);
    const out = ends.length === 0
      ? ["(no tool activity yet)"]
      : ends.map((ev) => `${ev.toolName ?? "tool"}: ${firstLine(resultTextOf(ev))}`);
    return ok({ text: out.join("\n") }, out);
  }
  const text = run.state.lastAssistantText ?? "(no output yet)";
  return ok({ text }, [text]);
}

export const cmdOutput = async (args: OutputArgs): Promise<number> => printResult(await outputCore(args));

export async function logsCore(args: OutputArgs): Promise<CommandResult<TextData>> {
  const { run } = await resolveRun(args.name, args.cwd);
  const n = Number(args.tail) > 0 ? Number(args.tail) : 50;
  const text = await tailText(path.join(run.runDir, "rpc.log"), n);
  if (!text.trim()) return ok({ text: "" }, ["(no rpc.log yet)"]);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return ok({ text: body }, [body]);
}

export const cmdLogs = async (args: OutputArgs): Promise<number> => printResult(await logsCore(args));

export interface ControlArgs {
  name: string;
  cwd?: string;
  message?: string;
  source?: ControlSource;
  /** `answer` only: the question being answered (default: the run's pending one). */
  questionId?: string | null;
}

export interface ControlData {
  name: string;
  type: ControlType;
  questionId?: string;
}

async function controlCore(type: ControlType, args: ControlArgs): Promise<CommandResult<ControlData | null>> {
  const { run } = await resolveRun(args.name, args.cwd);
  const derived = deriveStatus(run.state);
  if (isTerminal(derived)) {
    const what = type === "abort" ? "nothing to stop" : type === "answer" ? "nothing is waiting for an answer" : "steering refused";
    return fail(
      1,
      `${type}: run ${run.state.name} is ${derived} — ${what}.\n` +
        `Answer its open questions in a new brief and resume with:\n  ${resumeHint(run.state, run.runDir)}`,
    );
  }
  const source = args.source ?? "orchestrator";
  if (type === "answer") {
    const questionId = args.questionId ?? run.state.pendingQuestion?.id ?? null;
    if (!questionId) {
      return fail(1, `answer: ${run.state.name} has no pending question — use send to steer it instead.`);
    }
    await appendControl(run.runDir, { type, message: args.message ?? null, source, questionId });
    return ok({ name: run.state.name, type, questionId }, [`answer queued for ${run.state.name} (question ${questionId})`]);
  }
  await appendControl(run.runDir, { type, message: args.message ?? null, source });
  const line = type === "abort" ? `abort requested for ${run.state.name}` : `${type} queued for ${run.state.name}`;
  return ok({ name: run.state.name, type }, [line]);
}

export async function sendCore(args: ControlArgs): Promise<CommandResult<ControlData | null>> {
  if (!args.message?.trim()) throw new Error('send: message required after "--"');
  return controlCore("steer", args);
}

export async function followupCore(args: ControlArgs): Promise<CommandResult<ControlData | null>> {
  if (!args.message?.trim()) throw new Error('followup: message required after "--"');
  return controlCore("follow_up", args);
}

export async function answerCore(args: ControlArgs): Promise<CommandResult<ControlData | null>> {
  if (!args.message?.trim()) throw new Error('answer: message required after "--"');
  return controlCore("answer", args);
}

export async function stopCore(args: { name: string; cwd?: string; source?: ControlSource }): Promise<CommandResult<ControlData | null>> {
  return controlCore("abort", { name: args.name, cwd: args.cwd, source: args.source });
}

export const cmdSend = async (args: ControlArgs): Promise<number> => printResult(await sendCore(args));
export const cmdFollowup = async (args: ControlArgs): Promise<number> => printResult(await followupCore(args));
export const cmdAnswer = async (args: ControlArgs): Promise<number> => printResult(await answerCore(args));
export const cmdStop = async (args: { name: string; cwd?: string }): Promise<number> => printResult(await stopCore(args));

export interface ReportData {
  kind: "report" | "fallback";
  text: string;
  appendix: string;
}

/** Exit 0 with the report (or fallback text) + steering appendix; exit 2 when there is nothing. */
export async function reportCore(args: { name: string; cwd?: string }): Promise<CommandResult<ReportData | null>> {
  const { piFleetDir, run } = await resolveRun(args.name, args.cwd);
  const result = readReport(piFleetDir, run.state);
  if (result.kind === "missing") {
    return fail(2, `report: no report file and no captured output for ${run.state.name}`);
  }
  const appendix = buildSteeringAppendix(run.state);
  const out = [result.text];
  if (appendix) out.push(appendix);
  return ok({ kind: result.kind, text: result.text, appendix }, out);
}

export const cmdReport = async (args: { name: string; cwd?: string }): Promise<number> => printResult(await reportCore(args));

export interface DiffData {
  applicable: boolean;
  text: string;
  /** Uncommitted paths in the worktree (invisible to diff/merge). */
  dirty: string[];
}

export async function diffCore(args: { name: string; cwd?: string; nameOnly?: boolean }): Promise<CommandResult<DiffData | null>> {
  const { run } = await resolveRun(args.name, args.cwd);
  if (!run.state.worktree || !fs.existsSync(run.state.worktree)) {
    const text = "not applicable (run has no isolated worktree)";
    return ok({ applicable: false, text, dirty: [] }, [text]);
  }
  const base = run.state.baseCommit ?? run.state.base ?? "HEAD";
  const r = await gitRaw(["diff", args.nameOnly ? "--name-only" : "--stat", `${base}...HEAD`], run.state.worktree);
  if (r.code !== 0) return fail(1, `diff: ${r.stderr.trim()}`);
  const text = r.stdout.trim() ? r.stdout.replace(/\n$/, "") : "(no changes)";
  const dirty = await dirtyFiles(run.state.worktree);
  const err = dirty.length > 0 ? [dirtyWarning(dirty, "diff", "merge will not include them")] : [];
  return ok({ applicable: true, text, dirty }, [text], err);
}

export const cmdDiff = async (args: { name: string; cwd?: string; nameOnly?: boolean }): Promise<number> =>
  printResult(await diffCore(args));

/** Uncommitted worker output is invisible to diff/merge and lost by `cleanup --force`. */
async function dirtyFiles(worktree: string): Promise<string[]> {
  const status = await gitRaw(["status", "--porcelain"], worktree);
  if (status.code !== 0) return [];
  return status.stdout.split("\n").filter((l) => l.trim().length > 0);
}

function dirtyWarning(files: string[], command: string, consequence: string): string {
  return (
    `${command}: warning — worktree has ${files.length} uncommitted change(s) (worker did not commit); ${consequence}:\n` +
    files.map((f) => `  ${f}`).join("\n")
  );
}

export const MERGE_CONFLICT_EXIT = 5;

export interface MergeData {
  branch: string;
  into: string;
  committed: boolean;
  conflicts: string[];
}

/**
 * Merge the worker branch into the checkout we're running from. Exit 5 on conflicts;
 * with `abortOnConflict` the merge is rolled back (`git merge --abort`) so the
 * checkout stays clean and the worker can rebase instead (the orchestrator never edits).
 */
export async function mergeCore(args: { name: string; cwd?: string; noCommit?: boolean; abortOnConflict?: boolean }): Promise<CommandResult<MergeData | null>> {
  const { run } = await resolveRun(args.name, args.cwd);
  const derived = deriveStatus(run.state);
  if (derived !== "settled") {
    return fail(1, `merge: run ${run.state.name} is ${derived} — only settled runs can be merged.`);
  }
  if (!run.state.branch) {
    return fail(1, `merge: run ${run.state.name} has no branch (spawned without a worktree) — nothing to merge.`);
  }
  // The orchestrating checkout is the repo the run was spawned from, wherever we're invoked.
  const cwd = run.state.repoRoot;
  if (!cwd || !(await isGitRepo(cwd))) {
    return fail(1, `merge: run ${run.state.name} has no git checkout to merge into (repoRoot: ${cwd ?? "none"}).`);
  }
  const err: string[] = [];
  if (run.state.worktree) {
    const dirty = await dirtyFiles(run.state.worktree);
    if (dirty.length > 0) err.push(dirtyWarning(dirty, "merge", "they are not part of the branch"));
  }
  const mergeArgs = ["merge", ...(args.noCommit ? ["--no-commit", "--no-ff"] : []), run.state.branch];
  const r = await gitRaw(mergeArgs, cwd);
  if (r.code !== 0) {
    const conflicts = await gitRaw(["diff", "--name-only", "--diff-filter=U"], cwd);
    const files = conflicts.stdout.trim();
    if (files) {
      if (args.abortOnConflict) {
        await gitRaw(["merge", "--abort"], cwd);
        const base = run.state.baseCommit ? run.state.baseCommit.slice(0, 7) : "the base commit";
        err.push(
          `merge: conflicts in:\n${files}\nThe merge was aborted; the checkout is clean. ` +
            `Have the worker rebase its branch ${run.state.branch} onto the current HEAD of ${cwd} (it was cut from ${base}) ` +
            "in its own worktree, resolve the conflicts there, commit, and then merge again.",
        );
      } else {
        err.push(`merge: conflicts in:\n${files}\nResolve them, then \`git add\` and \`git commit\` (or \`git merge --abort\`).`);
      }
      return {
        code: MERGE_CONFLICT_EXIT,
        out: [],
        err,
        data: { branch: run.state.branch, into: cwd, committed: false, conflicts: files.split("\n") },
      };
    }
    err.push(`merge: git merge failed:\n${r.stderr.trim()}`);
    return { code: 1, out: [], err, data: null };
  }
  return ok(
    { branch: run.state.branch, into: cwd, committed: !args.noCommit, conflicts: [] },
    [
      `merged ${run.state.branch} into ${cwd}${args.noCommit ? " (staged, not committed)" : ""}`,
      "Run your integration checks before cleanup.",
    ],
    err,
  );
}

export const cmdMerge = async (args: { name: string; cwd?: string; noCommit?: boolean }): Promise<number> =>
  printResult(await mergeCore(args));

const CLEANUP_ABORT_WAIT_MS = 10_000;

export interface CleanupData {
  archived: string[];
  refused: string[];
}

/** Remove worktree + branch and mark the run archived; reports/events are kept. */
export async function cleanupCore(args: { target: string; cwd?: string; force?: boolean }): Promise<CommandResult<CleanupData>> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  return cleanupRuns({ piFleetDir, target: args.target, force: args.force });
}

/** The same cleanup, for callers that already know the fleet dir (the console, the reaper). */
export async function cleanupRuns(args: { piFleetDir: string; target: string; force?: boolean }): Promise<CommandResult<CleanupData>> {
  const { piFleetDir } = args;
  if (!args.target) throw new Error("cleanup: <name|all> required");
  const all = args.target === "all";
  const targets: RunRef[] = all
    ? listRuns(piFleetDir).flatMap(({ runId, runDir }) => {
        try {
          return [{ runId, runDir, state: loadStateSync(runDir) }];
        } catch {
          return [];
        }
      })
    : [findRun(piFleetDir, args.target)];

  const out: string[] = [];
  const err: string[] = [];
  const data: CleanupData = { archived: [], refused: [] };
  let refused = false;
  for (const t of targets) {
    if (t.state.status === "archived") {
      if (!all) out.push(`${t.runId} is already archived`);
      continue;
    }
    let derived = deriveStatus(t.state);
    if (!isTerminal(derived)) {
      if (!args.force) {
        err.push(`cleanup: ${all ? "skipping" : "refusing"} ${t.state.name} (${derived}) — use --force to abort and clean.`);
        data.refused.push(t.runId);
        if (!all) refused = true;
        continue;
      }
      await appendControl(t.runDir, { type: "abort", message: null, source: "orchestrator" });
      const deadline = Date.now() + CLEANUP_ABORT_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(200);
        try {
          t.state = await loadState(t.runDir);
        } catch {
          // keep last known state
        }
        derived = deriveStatus(t.state);
        // terminal AND monitor gone: its final flush can no longer race our archive write
        if (isTerminal(derived) && !isAlive(t.state.pid)) break;
      }
      if (!isTerminal(derived)) err.push(`cleanup: ${t.state.name} did not stop within ${CLEANUP_ABORT_WAIT_MS / 1000}s — archiving anyway`);
    }
    if (t.state.worktree && t.state.repoRoot) {
      const r = await removeWorktree({
        repoRoot: t.state.repoRoot,
        worktreePath: t.state.worktree,
        branch: t.state.branch,
        force: Boolean(args.force),
      });
      if (!r.worktreeRemoved && fs.existsSync(t.state.worktree)) {
        err.push(
          `cleanup: ${all ? "skipping" : "refusing"} ${t.state.name} — worktree ${t.state.worktree} could not be removed ` +
            "(uncommitted changes?) — inspect or commit them, or use --force to discard.",
        );
        data.refused.push(t.runId);
        if (!all) refused = true;
        continue;
      }
      if (t.state.branch && !r.branchDeleted) {
        err.push(`cleanup: kept unmerged branch ${t.state.branch} (use --force to delete it)`);
      }
    }
    t.state.status = "archived";
    await saveState(t.runDir, t.state);
    out.push(`archived ${t.runId}`);
    data.archived.push(t.runId);
  }
  return { code: refused ? 1 : 0, out, err, data };
}

export const cmdCleanup = async (args: { target: string; cwd?: string; force?: boolean }): Promise<number> =>
  printResult(await cleanupCore(args));
