/**
 * The backstop for finished workers: once a settled worker's branch is fully
 * contained in the repository's HEAD, its work is safely in and the worktree
 * and branch can go. Anything unmerged, dirty, or still running is left alone —
 * removing those would destroy work, so they wait for the orchestrator's
 * `fleet_cleanup` or the human's `/remove`.
 */
import { listRuns, loadStateSync, deriveStatus, type RunState } from "../state.js";
import { cleanupRuns } from "../commands.js";
import { gitRaw } from "../worktree.js";

export interface ReapedRun {
  runId: string;
  name: string;
  branch: string;
}

/** True when every commit on `branch` is already reachable from HEAD in `repoRoot`. */
export async function isBranchMerged(repoRoot: string, branch: string): Promise<boolean> {
  const r = await gitRaw(["merge-base", "--is-ancestor", branch, "HEAD"], repoRoot);
  return r.code === 0;
}

export function isReapCandidate(state: RunState): boolean {
  return state.status !== "archived" && deriveStatus(state) === "settled" && Boolean(state.branch) && Boolean(state.repoRoot);
}

/**
 * Archive every settled run whose branch is merged. Returns what it removed;
 * refusals (a dirty worktree, say) are reported and left in place.
 */
export async function reapMergedRuns(piFleetDir: string): Promise<{ reaped: ReapedRun[]; refused: string[] }> {
  const reaped: ReapedRun[] = [];
  const refused: string[] = [];
  for (const { runId, runDir } of listRuns(piFleetDir)) {
    let state: RunState;
    try {
      state = loadStateSync(runDir);
    } catch {
      continue;
    }
    if (!isReapCandidate(state)) continue;
    if (!(await isBranchMerged(state.repoRoot as string, state.branch as string))) continue;
    const result = await cleanupRuns({ piFleetDir, target: runId, force: false });
    if (result.code === 0 && result.data.archived.includes(runId)) {
      reaped.push({ runId, name: state.name, branch: state.branch as string });
    } else {
      refused.push(state.name);
    }
  }
  return { reaped, refused };
}
