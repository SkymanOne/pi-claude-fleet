import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { runIdFor } from "./util.js";
import { newRunState, saveState, runDirFor, type RunState } from "./state.js";
import {
  isGitRepo,
  repoRoot,
  ensureWorktree,
  ensureGitignoreEntry,
} from "./worktree.js";

export interface SpawnOpts {
  cwd?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  base?: string;
  skill?: string;
  appendSystemPrompt?: string;
  session?: string;
  tools?: string;
  excludeTools?: string;
  worktree?: boolean;
}

export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ResolvedFleet {
  targetDir: string;
  repoRoot: string | null;
  isGit: boolean;
  piFleetDir: string;
}

export async function resolveFleetDir(cwd?: string): Promise<ResolvedFleet> {
  const requestedDir = path.resolve(cwd ?? process.cwd());
  if (!fs.existsSync(requestedDir)) {
    throw new Error(`--cwd does not exist: ${requestedDir}`);
  }
  // Resolve symlinks so non-git targets compare equal to git's real paths
  // (e.g. macOS `/var` -> `/private/var`).
  const targetDir = fs.realpathSync(requestedDir);
  const isGit = await isGitRepo(targetDir);
  const root = isGit ? await repoRoot(targetDir) : targetDir;
  const resolvedRoot = root ?? targetDir;
  return {
    targetDir,
    repoRoot: isGit ? resolvedRoot : null,
    isGit,
    piFleetDir: path.join(resolvedRoot, ".pi-fleet"),
  };
}

export interface CreatedRun {
  runId: string;
  runDir: string;
  piFleetDir: string;
  state: RunState;
  worktreePath: string | null;
}

export async function createRun(args: {
  name: string;
  opts: SpawnOpts;
  brief: string;
}): Promise<CreatedRun> {
  const name = sanitizeName(args.name);
  if (!name) throw new Error("spawn: <name> required");
  if (!args.brief.trim()) {
    throw new Error('spawn: task brief required after "--"');
  }

  const {
    targetDir,
    repoRoot: root,
    isGit,
    piFleetDir,
  } = await resolveFleetDir(args.opts.cwd);
  await fsp.mkdir(path.join(piFleetDir, "runs"), { recursive: true });
  await fsp.mkdir(path.join(piFleetDir, "reports"), { recursive: true });
  await fsp.mkdir(path.join(piFleetDir, "worktrees"), { recursive: true });
  if (isGit && root) await ensureGitignoreEntry(root, ".pi-fleet/");

  const runId = runIdFor(name);
  let worktreePath: string | null = null;
  let branch: string | null = null;
  let baseCommit: string | null = null;
  if (isGit && root && args.opts.worktree !== false) {
    const created = await ensureWorktree({
      repoRoot: root,
      worktreesDir: path.join(piFleetDir, "worktrees"),
      runId,
      name,
      base: args.opts.base ?? null,
    });
    worktreePath = created.worktreePath;
    branch = created.branch;
    baseCommit = created.baseCommit;
  }

  const runDir = runDirFor(piFleetDir, runId);
  await fsp.mkdir(runDir, { recursive: true });
  const state = newRunState({
    fleetDir: piFleetDir,
    runId,
    name,
    cwd: targetDir,
    worktree: worktreePath,
    branch,
    base: args.opts.base ?? null,
    model: args.opts.model ?? null,
    provider: args.opts.provider ?? null,
    thinking: args.opts.thinking ?? null,
    sessionArg: args.opts.session ?? null,
    skill: args.opts.skill ?? null,
    appendSystemPrompt: args.opts.appendSystemPrompt ?? null,
    tools: args.opts.tools ?? null,
    excludeTools: args.opts.excludeTools ?? null,
    taskBrief: args.brief,
  });
  state.repoRoot = root;
  state.isGit = isGit;
  state.baseCommit = baseCommit;
  await saveState(runDir, state);
  return { runId, runDir, piFleetDir, state, worktreePath };
}
