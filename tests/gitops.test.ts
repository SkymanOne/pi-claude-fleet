import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor } from "./helpers.js";

const HELLO_ENV = fakePiEnv({ FAKE_PI_WRITE_HELLO: "1" });

async function settledWorktreeRun(prefix: string, files?: Record<string, string>): Promise<string> {
  const root = initRepo(prefix, files);
  const spawned = await runCli(["spawn", "worker", "--cwd", root, "--", "task"], { env: HELLO_ENV });
  assert.equal(spawned.code, 0, spawned.stderr);
  const waited = await runCli(["wait", "worker", "--cwd", root, "--timeout", "30"], { env: HELLO_ENV });
  assert.equal(waited.code, 0, waited.stderr);
  return root;
}

test("diff shows worker changes; merge brings them into the parent; cleanup archives and keeps the report", async () => {
  const root = await settledWorktreeRun("pf-git-1-");
  const stat = await runCli(["diff", "worker"], { cwd: root });
  assert.equal(stat.code, 0, stat.stderr);
  assert.match(stat.stdout, /hello\.txt \| 1 \+/);
  const names = await runCli(["diff", "worker", "--name-only"], { cwd: root });
  assert.equal(names.stdout.trim(), "hello.txt");

  const merged = await runCli(["merge", "worker"], { cwd: root });
  assert.equal(merged.code, 0, merged.stderr);
  assert.match(merged.stdout, /merged pi-fleet\/worker-/);
  assert.equal(fs.readFileSync(path.join(root, "hello.txt"), "utf8"), "hi\n");

  const state = readState(root);
  const cleaned = await runCli(["cleanup", "worker"], { cwd: root });
  assert.equal(cleaned.code, 0, cleaned.stderr);
  assert.match(cleaned.stdout, /archived worker-/);
  assert.equal(readState(root).status, "archived");
  assert.equal(fs.existsSync(state.worktree), false);
  assert.equal(execFileSync("git", ["branch", "--list", state.branch], { cwd: root }).toString().trim(), "");
  assert.equal(fs.existsSync(path.join(fleetDirOf(root), "reports", `${firstRunId(root)}.md`)), true);
  assert.match((await runCli(["cleanup", "worker"], { cwd: root })).stdout, /already archived/);
  assert.equal((await runCli(["diff", "worker"], { cwd: root })).stdout.trim(), "not applicable (run has no isolated worktree)");
}, { timeout: 60_000 });

test("merge refuses runs that are not settled and runs without a branch", async () => {
  const root = initRepo("pf-git-2-");
  await runCli(["spawn", "boom", "--cwd", root, "--", "x"], { env: fakePiEnv({ PI_FLEET_PI_BIN: "/nonexistent/pi" }) });
  await runCli(["wait", "boom", "--cwd", root, "--timeout", "20"]);
  const notSettled = await runCli(["merge", "boom"], { cwd: root });
  assert.equal(notSettled.code, 1);
  assert.match(notSettled.stderr, /is error — only settled runs can be merged/);

  await runCli(["spawn", "flat", "--cwd", root, "--no-worktree", "--", "x"]);
  await runCli(["wait", "flat", "--cwd", root, "--timeout", "30"]);
  const noBranch = await runCli(["merge", "flat"], { cwd: root });
  assert.equal(noBranch.code, 1);
  assert.match(noBranch.stderr, /has no branch/);
}, { timeout: 60_000 });

test("merge conflict exits 5 with the file list; --force cleanup deletes the unmerged branch", async () => {
  const root = await settledWorktreeRun("pf-git-3-", { "hello.txt": "parent version\n" });
  // the parent moves on after the branch was cut → real conflict on hello.txt
  fs.writeFileSync(path.join(root, "hello.txt"), "parent edit\n");
  execFileSync("git", ["commit", "-qam", "parent edit"], { cwd: root });
  const conflict = await runCli(["merge", "worker"], { cwd: root });
  assert.equal(conflict.code, 5);
  assert.match(conflict.stderr, /conflicts in:\nhello\.txt/);
  execFileSync("git", ["merge", "--abort"], { cwd: root });

  const state = readState(root);
  const soft = await runCli(["cleanup", "worker"], { cwd: root });
  assert.equal(soft.code, 0, soft.stderr);
  assert.match(soft.stderr, /kept unmerged branch/);
  assert.notEqual(execFileSync("git", ["branch", "--list", state.branch], { cwd: root }).toString().trim(), "");
  execFileSync("git", ["branch", "-D", state.branch], { cwd: root });
}, { timeout: 60_000 });

test("cleanup refuses a running run without --force; with --force it aborts, then archives", async () => {
  const root = initRepo("pf-git-4-");
  await runCli(["spawn", "slow", "--cwd", root, "--no-worktree", "--", "t"], { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  await waitFor(() => (readState(root).status === "running" ? true : undefined), { timeoutMs: 15_000 });
  const refused = await runCli(["cleanup", "slow"], { cwd: root });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing slow \(running\)/);
  const forced = await runCli(["cleanup", "slow", "--force"], { cwd: root });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(readState(root).status, "archived");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(readState(root).status, "archived", "monitor must not overwrite the archived state afterwards");
}, { timeout: 60_000 });
