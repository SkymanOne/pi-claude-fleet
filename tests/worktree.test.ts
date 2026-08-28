import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isGitRepo, repoRoot, ensureWorktree, removeWorktree, ensureGitignoreEntry } from "../src/worktree.js";
import { initRepo, tmpDir } from "./helpers.js";

test("isGitRepo/repoRoot detect repos", async () => {
  const root = initRepo("pf-wt-");
  assert.equal(await isGitRepo(root), true);
  assert.equal(await repoRoot(root), fs.realpathSync(root));
  const plain = tmpDir("pf-plain-");
  assert.equal(await isGitRepo(plain), false);
  assert.equal(await repoRoot(plain), null);
});

test("ensureWorktree creates worktree + branch; removeWorktree cleans up when merged", async () => {
  const root = initRepo("pf-wt-");
  const worktreesDir = path.join(root, ".pi-fleet", "worktrees");
  const { worktreePath, branch } = await ensureWorktree({
    repoRoot: root, worktreesDir, runId: "auth-20260828141530", name: "auth", base: null,
  });
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  assert.equal(branch, "pi-fleet/auth-8141530");
  assert.match(execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString(), /auth-8141530/);

  fs.writeFileSync(path.join(worktreePath, "hello.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: worktreePath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "hello"], { cwd: worktreePath });
  execFileSync("git", ["merge", branch, "-q", "--no-edit"], { cwd: root });

  const r = await removeWorktree({ repoRoot: root, worktreePath, branch, force: false });
  assert.deepEqual(r, { worktreeRemoved: true, branchDeleted: true });
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(execFileSync("git", ["branch", "--list", branch], { cwd: root }).toString().trim(), "");
});

test("removeWorktree keeps an unmerged branch unless force", async () => {
  const root = initRepo("pf-wt-");
  const worktreesDir = path.join(root, ".pi-fleet", "worktrees");
  const { worktreePath, branch } = await ensureWorktree({
    repoRoot: root, worktreesDir, runId: "x-20260828141530", name: "x", base: null,
  });
  fs.writeFileSync(path.join(worktreePath, "unmerged.txt"), "u\n");
  execFileSync("git", ["add", "."], { cwd: worktreePath });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "u"], { cwd: worktreePath });
  const soft = await removeWorktree({ repoRoot: root, worktreePath, branch, force: false });
  assert.equal(soft.worktreeRemoved, true);
  assert.equal(soft.branchDeleted, false);
  const hard = await removeWorktree({ repoRoot: root, worktreePath, branch, force: true });
  assert.equal(hard.branchDeleted, true);
});

test("ensureGitignoreEntry appends once with marker", async () => {
  const root = initRepo("pf-wt-");
  assert.equal(await ensureGitignoreEntry(root, ".pi-fleet/"), true);
  assert.equal(await ensureGitignoreEntry(root, ".pi-fleet/"), false);
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /# pi-fleet\n\.pi-fleet\//);
});
