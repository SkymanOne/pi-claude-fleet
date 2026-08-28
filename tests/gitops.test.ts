import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isAlive } from "../src/state.js";
import { initRepo, runCli, fakePiEnv, readState, firstRunId, fleetDirOf, waitFor, tmpDir } from "./helpers.js";

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

  // invoked from an unrelated directory: --cwd locates the fleet, the merge lands in the run's repo
  const merged = await runCli(["merge", "worker", "--cwd", root], { cwd: tmpDir("pf-elsewhere-") });
  assert.equal(merged.code, 0, merged.stderr);
  assert.match(merged.stdout, /merged pi-fleet\/worker-.* into /);
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
  assert.equal(isAlive(readState(root).pid), false, "cleanup --force waits for the monitor to exit");
}, { timeout: 60_000 });

test("stop → wait → cleanup: the monitor's late final flush never overwrites `archived`", async () => {
  const root = initRepo("pf-git-5-");
  await runCli(["spawn", "slow", "--cwd", root, "--no-worktree", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000", FAKE_PI_EXIT_DELAY_MS: "1500" }) });
  await waitFor(() => (readState(root).status === "running" ? true : undefined), { timeoutMs: 15_000 });
  assert.equal((await runCli(["stop", "slow", "--cwd", root])).code, 0);
  assert.equal((await runCli(["wait", "slow", "--cwd", root, "--timeout", "15"])).code, 4);
  const pid = readState(root).pid;
  assert.equal(isAlive(pid), true, "fake pi lingers, so the monitor is still alive here");
  assert.equal((await runCli(["cleanup", "slow"], { cwd: root })).code, 0);
  assert.equal(readState(root).status, "archived");
  await waitFor(() => (isAlive(pid) ? undefined : true), { timeoutMs: 15_000 });
  assert.equal(readState(root).status, "archived", "monitor's close-time flush must not clobber archived");
}, { timeout: 60_000 });

test("diff warns about uncommitted worker changes; non-force cleanup refuses a dirty worktree", async () => {
  const root = await settledWorktreeRun("pf-git-6-");
  const worktree = readState(root).worktree;
  fs.writeFileSync(path.join(worktree, "forgot.txt"), "uncommitted\n");
  const diff = await runCli(["diff", "worker"], { cwd: root });
  assert.equal(diff.code, 0);
  assert.match(diff.stdout, /hello\.txt/);
  assert.match(diff.stderr, /warning — worktree has 1 uncommitted change\(s\)[\s\S]*forgot\.txt/);
  const refused = await runCli(["cleanup", "worker"], { cwd: root });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /could not be removed/);
  assert.notEqual(readState(root).status, "archived");
  assert.equal(fs.existsSync(worktree), true);
  const forced = await runCli(["cleanup", "worker", "--force"], { cwd: root });
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(readState(root).status, "archived");
}, { timeout: 60_000 });

test("cleanup all: archives finished runs, skips running ones with a warning, exit 0", async () => {
  const root = initRepo("pf-git-7-");
  await runCli(["spawn", "done", "--cwd", root, "--no-worktree", "--", "t"]);
  assert.equal((await runCli(["wait", "done", "--cwd", root, "--timeout", "30"])).code, 0);
  await runCli(["spawn", "busy", "--cwd", root, "--no-worktree", "--", "t"], { env: fakePiEnv({ FAKE_PI_DELAY_MS: "20000" }) });
  await waitFor(() => (readState(root, firstRunIdOf(root, "busy")).status === "running" ? true : undefined), { timeoutMs: 15_000 });
  const all = await runCli(["cleanup", "all"], { cwd: root });
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /archived done-/);
  assert.match(all.stderr, /skipping busy \(running\)/);
  assert.equal(readState(root, firstRunIdOf(root, "done")).status, "archived");
  assert.equal(readState(root, firstRunIdOf(root, "busy")).status, "running");
  assert.equal((await runCli(["cleanup", "all", "--force"], { cwd: root })).code, 0);
  assert.equal(readState(root, firstRunIdOf(root, "busy")).status, "archived");
}, { timeout: 60_000 });

function firstRunIdOf(root: string, name: string): string {
  const id = fs.readdirSync(path.join(fleetDirOf(root), "runs")).find((r) => r.startsWith(`${name}-`));
  if (!id) throw new Error(`no run named ${name}`);
  return id;
}
