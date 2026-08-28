import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import { simpleGit } from "simple-git";
import { branchFor } from "./util.js";

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return await simpleGit({ baseDir: dir }).checkIsRepo();
  } catch {
    return false;
  }
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const root = await simpleGit({ baseDir: dir }).revparse([
      "--show-toplevel",
    ]);
    return root.trim() || null;
  } catch {
    return null;
  }
}

export async function ensureWorktree(args: {
  repoRoot: string;
  worktreesDir: string;
  runId: string;
  name: string;
  base: string | null;
}): Promise<{ worktreePath: string; branch: string; baseRef: string }> {
  const branch = branchFor(args.name, args.runId);
  const worktreePath = path.join(args.worktreesDir, args.runId);
  const baseRef = args.base || "HEAD";
  await simpleGit({ baseDir: args.repoRoot }).raw([
    "worktree",
    "add",
    worktreePath,
    "-b",
    branch,
    baseRef,
  ]);
  return { worktreePath, branch, baseRef };
}

export interface RemoveWorktreeResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
}

export async function removeWorktree(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string | null;
  force?: boolean;
}): Promise<RemoveWorktreeResult> {
  const g = simpleGit({ baseDir: args.repoRoot });
  let worktreeRemoved = false;
  let branchDeleted = false;
  if (!fs.existsSync(args.worktreePath)) {
    // Already gone (e.g. removed by a prior call) — just tidy git's
    // administrative files and fall through to branch deletion.
    try {
      await g.raw(["worktree", "prune"]);
    } catch {
      // best effort
    }
  } else {
    try {
      await g.raw([
        "worktree",
        "remove",
        ...(args.force ? ["--force"] : []),
        args.worktreePath,
      ]);
      worktreeRemoved = true;
    } catch (err) {
      if (args.force) {
        throw new Error(
          `Failed to remove worktree ${args.worktreePath}: ${String(err)}`,
        );
      }
      // non-force: other failures are reported via the result, not thrown —
      // cleanup is best-effort.
    }
  }
  if (args.branch) {
    try {
      await g.raw(["branch", args.force ? "-D" : "-d", args.branch]);
      branchDeleted = true;
    } catch {
      // branch kept (e.g. unmerged); surface via result — callers log it
    }
  }
  return { worktreeRemoved, branchDeleted };
}

export async function ensureGitignoreEntry(
  root: string,
  entry: string,
): Promise<boolean> {
  const gitignorePath = path.join(root, ".gitignore");
  let content = "";
  try {
    content = await fsp.readFile(gitignorePath, "utf8");
  } catch {
    // new file
  }
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return false;
  const needsMarker = !lines.includes("# pi-fleet");
  const addition = `${needsMarker ? "# pi-fleet\n" : ""}${entry}\n`;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await fsp.appendFile(gitignorePath, `${prefix}${addition}`);
  return true;
}
