import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reapMergedRuns, isBranchMerged, isReapCandidate } from "../src/fleet/reap.js";
import { readState, firstRunId, fleetDirOf, initRepo, runCli, fakePiEnv, waitFor, TERMINAL } from "./helpers.js";
import { newRunState, loadStateSync, runDirFor } from "../src/state.js";

/** A real worker that commits, so its branch can actually be merged. */
async function spawnCommittingWorker(root: string, name: string): Promise<{ runId: string; runDir: string }> {
  const r = await runCli(["spawn", name, "--cwd", root, "--", "write hello"], { env: fakePiEnv({ FAKE_PI_WRITE_HELLO: "1", FAKE_PI_DELAY_MS: "100" }) });
  assert.equal(r.code, 0, r.stderr);
  const runId = firstRunId(root);
  await waitFor(() => (TERMINAL.includes(readState(root, runId).status) ? true : undefined), { timeoutMs: 30_000 });
  return { runId, runDir: path.join(fleetDirOf(root), "runs", runId) };
}

test("a settled worker is reaped once its branch is merged, and not before", async () => {
  const root = initRepo("pf-reap-1-");
  const fleetDir = fleetDirOf(root);
  const { runId } = await spawnCommittingWorker(root, "hello");
  const state = readState(root, runId);
  assert.equal(state.status, "settled");
  assert.ok(state.branch);

  // unmerged: left alone
  assert.equal(await isBranchMerged(root, state.branch), false);
  const before = await reapMergedRuns(fleetDir);
  assert.deepEqual(before, { reaped: [], refused: [] });
  assert.equal(readState(root, runId).status, "settled");

  const merge = await runCli(["merge", "hello", "--cwd", root], { cwd: root });
  assert.equal(merge.code, 0, merge.stderr);
  assert.equal(await isBranchMerged(root, state.branch), true);

  const after = await reapMergedRuns(fleetDir);
  assert.deepEqual(after.reaped.map((r) => r.name), ["hello"]);
  assert.deepEqual(after.refused, []);
  assert.equal(readState(root, runId).status, "archived");
  assert.equal(fs.existsSync(state.worktree), false, "worktree removed");
  const branches = execFileSync("git", ["branch", "--list", state.branch], { cwd: root, encoding: "utf8" });
  assert.equal(branches.trim(), "", "branch removed");
  // reaping again is a no-op
  assert.deepEqual((await reapMergedRuns(fleetDir)).reaped, []);
}, { timeout: 90_000 });

test("running, unmerged and worktree-less runs are never reaped", async () => {
  const fleetDir = path.join(fleetDirOf(initRepo("pf-reap-2-")), "");
  const mk = (name: string, over: Record<string, unknown>) => {
    const runId = `${name}-20260829120000`;
    const runDir = runDirFor(fleetDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const state = { ...newRunState({ fleetDir, runId, name, cwd: "/repo" }), ...over };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state));
    return loadStateSync(runDir);
  };
  assert.equal(isReapCandidate(mk("running", { status: "running", pid: process.pid, branch: "b", repoRoot: "/r" })), false);
  assert.equal(isReapCandidate(mk("noworktree", { status: "settled", branch: null, repoRoot: "/r" })), false, "a --no-worktree run has nothing to remove");
  assert.equal(isReapCandidate(mk("archived", { status: "archived", branch: "b", repoRoot: "/r" })), false);
  assert.equal(isReapCandidate(mk("errored", { status: "error", branch: "b", repoRoot: "/r" })), false);
  assert.equal(isReapCandidate(mk("ok", { status: "settled", branch: "b", repoRoot: "/r" })), true);
}, { timeout: 30_000 });

test("a merged worker with uncommitted leftovers is refused, not silently discarded", async () => {
  const root = initRepo("pf-reap-3-");
  const fleetDir = fleetDirOf(root);
  const { runId } = await spawnCommittingWorker(root, "hello");
  const state = readState(root, runId);
  assert.equal((await runCli(["merge", "hello", "--cwd", root], { cwd: root })).code, 0);
  fs.writeFileSync(path.join(state.worktree, "scratch.txt"), "unsaved work\n");

  const result = await reapMergedRuns(fleetDir);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.refused, ["hello"]);
  assert.equal(readState(root, runId).status, "settled", "still there for the human to look at");
  assert.equal(fs.existsSync(path.join(state.worktree, "scratch.txt")), true);
}, { timeout: 90_000 });
