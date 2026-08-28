import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Table from "cli-table3";
import { createRun, sanitizeName, resolveFleetDir, type SpawnOpts } from "./spawn.js";
import {
  runDirFor,
  listRuns,
  findRun,
  loadState,
  loadStateSync,
  saveState,
  deriveStatus,
  appendControl,
  resumeHint,
  TERMINAL_STATES,
  type ControlType,
  type RunRef,
  type RunState,
} from "./state.js";
import { readJsonlTail, tailText, firstLine, formatAge, resultTextOf } from "./util.js";
import { readReport, buildSteeringAppendix } from "./report.js";
import { gitRaw, isGitRepo, repoRoot, removeWorktree } from "./worktree.js";

export type { SpawnOpts } from "./spawn.js";

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(SRC_DIR);

/**
 * How to re-invoke this CLI as a detached background process.
 * - Production: compiled `dist/cli.js` (this file sits next to cli.js in dist/).
 * - Tests (PI_FLEET_DEV=1): run src/cli.ts through tsx so tests need no build.
 *   The tsx loader is resolved to an absolute path because a bare `--import
 *   tsx` cannot be resolved when the child's cwd is outside this package —
 *   the detached monitor inherits the orchestrator's cwd.
 */
export function cliSpawnArgs(): string[] {
  if (process.env.PI_FLEET_DEV === "1") {
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

export async function cmdSpawn(args: { name: string; brief: string; opts: SpawnOpts }): Promise<number> {
  if (!args.brief.trim()) throw new Error('spawn: task brief required after "--"');
  const created = await createRun({ name: sanitizeName(args.name), opts: args.opts, brief: args.brief });
  if (!created.state.isGit && args.opts.worktree !== false) {
    console.error("warning: target is not a git repo — running in place without a worktree");
  }
  await launchMonitor({ piFleetDir: created.piFleetDir, runId: created.runId });
  console.log(`Spawned ${created.runId}`);
  console.log(`  state:    ${created.runDir}/state.json`);
  console.log(`  fleet dir: ${created.piFleetDir}`);
  if (created.worktreePath) console.log(`  worktree: ${created.worktreePath}`);
  if (created.state.branch) console.log(`  branch:   ${created.state.branch}`);
  return 0;
}

const WAIT_POLL_MS = 2000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isTerminal = (status: string): boolean => (TERMINAL_STATES as readonly string[]).includes(status);

/** Locate the fleet dir for `cwd` and the newest non-archived run called `name`. */
export async function resolveRun(name: string, cwd?: string): Promise<{ piFleetDir: string; run: RunRef }> {
  if (!name) throw new Error("<name> required");
  const { piFleetDir } = await resolveFleetDir(cwd);
  return { piFleetDir, run: findRun(piFleetDir, name) };
}

function withDerivedStatus(state: RunState): RunState {
  return { ...state, status: deriveStatus(state) };
}

export interface StatusArgs {
  name?: string;
  cwd?: string;
  json?: boolean;
  all?: boolean;
}

export async function cmdStatus(args: StatusArgs): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  if (args.name) {
    const { state } = findRun(piFleetDir, args.name);
    console.log(JSON.stringify(withDerivedStatus(state), null, 2));
    return 0;
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
  if (args.json) {
    console.log(JSON.stringify(runs.map(withDerivedStatus), null, 2));
    return 0;
  }
  if (runs.length === 0) {
    console.log("(no runs)");
    return 0;
  }
  const table = new Table({
    head: ["NAME", "STATE", "LAST-ACTIVITY", "LAST-TOOL", "STEERED", "AGE"],
    style: { head: [], border: [] },
  });
  for (const s of runs) {
    table.push([
      s.name,
      deriveStatus(s),
      s.lastActivity ?? "-",
      s.lastTool ?? "-",
      String(s.steerCount),
      formatAge(Math.max(0, Date.now() - Date.parse(s.createdAt))),
    ]);
  }
  console.log(table.toString());
  return 0;
}

export interface WaitArgs {
  name: string;
  cwd?: string;
  timeout?: string;
}

/** Exit 0 settled/archived · 3 timeout · 4 stopped/error/dead. */
export async function cmdWait(args: WaitArgs): Promise<number> {
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
        console.log(`${state.name} ${derived}`);
        return derived === "settled" || derived === "archived" ? 0 : 4;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error(`wait: timed out after ${timeoutSec}s waiting for ${run.state.name}`);
      return 3;
    }
    await sleep(Math.min(WAIT_POLL_MS, remaining));
  }
}

export interface OutputArgs {
  name: string;
  cwd?: string;
  tail?: string;
}

export async function cmdOutput(args: OutputArgs): Promise<number> {
  const { run } = await resolveRun(args.name, args.cwd);
  if (args.tail !== undefined) {
    const n = Number(args.tail) > 0 ? Number(args.tail) : 10;
    const events = await readJsonlTail<any>(path.join(run.runDir, "events.jsonl"), 5000);
    const ends = events.filter((e) => e.type === "tool_execution_end").slice(-n);
    if (ends.length === 0) console.log("(no tool activity yet)");
    for (const ev of ends) console.log(`${ev.toolName ?? "tool"}: ${firstLine(resultTextOf(ev))}`);
    return 0;
  }
  console.log(run.state.lastAssistantText ?? "(no output yet)");
  return 0;
}

export async function cmdLogs(args: OutputArgs): Promise<number> {
  const { run } = await resolveRun(args.name, args.cwd);
  const n = Number(args.tail) > 0 ? Number(args.tail) : 50;
  const text = await tailText(path.join(run.runDir, "rpc.log"), n);
  if (text.trim()) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  else console.log("(no rpc.log yet)");
  return 0;
}

export interface ControlArgs {
  name: string;
  cwd?: string;
  message?: string;
}

async function controlCommand(type: ControlType, args: ControlArgs): Promise<number> {
  const { run } = await resolveRun(args.name, args.cwd);
  const derived = deriveStatus(run.state);
  if (isTerminal(derived)) {
    const what = type === "abort" ? "nothing to stop" : "steering refused";
    console.error(
      `${type}: run ${run.state.name} is ${derived} — ${what}.\n` +
        `Answer its open questions in a new brief and resume with:\n  ${resumeHint(run.state, run.runDir)}`,
    );
    return 1;
  }
  await appendControl(run.runDir, { type, message: args.message ?? null, source: "orchestrator" });
  console.log(type === "abort" ? `abort requested for ${run.state.name}` : `${type} queued for ${run.state.name}`);
  return 0;
}

export async function cmdSend(args: ControlArgs): Promise<number> {
  if (!args.message?.trim()) throw new Error('send: message required after "--"');
  return controlCommand("steer", args);
}

export async function cmdFollowup(args: ControlArgs): Promise<number> {
  if (!args.message?.trim()) throw new Error('followup: message required after "--"');
  return controlCommand("follow_up", args);
}

export async function cmdStop(args: { name: string; cwd?: string }): Promise<number> {
  return controlCommand("abort", { name: args.name, cwd: args.cwd });
}

/** Exit 0 with the report (or fallback text) + steering appendix; exit 2 when there is nothing. */
export async function cmdReport(args: { name: string; cwd?: string }): Promise<number> {
  const { piFleetDir, run } = await resolveRun(args.name, args.cwd);
  const result = readReport(piFleetDir, run.state);
  if (result.kind === "missing") {
    console.error(`report: no report file and no captured output for ${run.state.name}`);
    return 2;
  }
  console.log(result.text);
  const appendix = buildSteeringAppendix(run.state);
  if (appendix) console.log(appendix);
  return 0;
}

export async function cmdDiff(args: { name: string; cwd?: string; nameOnly?: boolean }): Promise<number> {
  const { run } = await resolveRun(args.name, args.cwd);
  if (!run.state.worktree || !fs.existsSync(run.state.worktree)) {
    console.log("not applicable (run has no isolated worktree)");
    return 0;
  }
  const base = run.state.baseCommit ?? run.state.base ?? "HEAD";
  const r = await gitRaw(["diff", args.nameOnly ? "--name-only" : "--stat", `${base}...HEAD`], run.state.worktree);
  if (r.code !== 0) {
    console.error(`diff: ${r.stderr.trim()}`);
    return 1;
  }
  process.stdout.write(r.stdout.trim() ? (r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`) : "(no changes)\n");
  return 0;
}

const MERGE_CONFLICT_EXIT = 5;

/** Merge the worker branch into the checkout we're running from. Exit 5 on conflicts. */
export async function cmdMerge(args: { name: string; cwd?: string; noCommit?: boolean }): Promise<number> {
  const { run } = await resolveRun(args.name, args.cwd);
  const derived = deriveStatus(run.state);
  if (derived !== "settled") {
    console.error(`merge: run ${run.state.name} is ${derived} — only settled runs can be merged.`);
    return 1;
  }
  if (!run.state.branch) {
    console.error(`merge: run ${run.state.name} has no branch (spawned without a worktree) — nothing to merge.`);
    return 1;
  }
  const cwd = process.cwd();
  if (!(await isGitRepo(cwd))) {
    console.error(`merge: ${cwd} is not a git repo — run this from the orchestrating checkout.`);
    return 1;
  }
  const cwdRoot = (await repoRoot(cwd)) ?? cwd;
  if (run.state.worktree && (cwdRoot === run.state.worktree || cwdRoot.startsWith(run.state.worktree + path.sep))) {
    console.error("merge: refusing to merge into the worker's own worktree — run from the parent checkout.");
    return 1;
  }
  const mergeArgs = ["merge", ...(args.noCommit ? ["--no-commit", "--no-ff"] : []), run.state.branch];
  const r = await gitRaw(mergeArgs, cwd);
  if (r.code !== 0) {
    const conflicts = await gitRaw(["diff", "--name-only", "--diff-filter=U"], cwd);
    const files = conflicts.stdout.trim();
    if (files) {
      console.error(`merge: conflicts in:\n${files}\nResolve them, then \`git add\` and \`git commit\` (or \`git merge --abort\`).`);
      return MERGE_CONFLICT_EXIT;
    }
    console.error(`merge: git merge failed:\n${r.stderr.trim()}`);
    return 1;
  }
  console.log(`merged ${run.state.branch}${args.noCommit ? " (staged, not committed)" : ""}`);
  console.log("Run your integration checks before cleanup.");
  return 0;
}

const CLEANUP_ABORT_WAIT_MS = 10_000;

/** Remove worktree + branch and mark the run archived; reports/events are kept. */
export async function cmdCleanup(args: { target: string; cwd?: string; force?: boolean }): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
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

  let refused = false;
  for (const t of targets) {
    if (t.state.status === "archived") {
      if (!all) console.log(`${t.runId} is already archived`);
      continue;
    }
    let derived = deriveStatus(t.state);
    if (!isTerminal(derived)) {
      if (!args.force) {
        console.error(`cleanup: ${all ? "skipping" : "refusing"} ${t.state.name} (${derived}) — use --force to abort and clean.`);
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
        if (isTerminal(derived)) break;
      }
      if (!isTerminal(derived)) console.error(`cleanup: ${t.state.name} did not stop within ${CLEANUP_ABORT_WAIT_MS / 1000}s — archiving anyway`);
    }
    if (t.state.worktree && t.state.repoRoot) {
      const r = await removeWorktree({
        repoRoot: t.state.repoRoot,
        worktreePath: t.state.worktree,
        branch: t.state.branch,
        force: Boolean(args.force),
      });
      if (t.state.branch && !r.branchDeleted) {
        console.error(`cleanup: kept unmerged branch ${t.state.branch} (use --force to delete it)`);
      }
    }
    t.state.status = "archived";
    await saveState(t.runDir, t.state);
    console.log(`archived ${t.runId}`);
  }
  return refused ? 1 : 0;
}
