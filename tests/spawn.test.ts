import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveFleetDir, createRun, sanitizeName } from "../src/spawn.js";
import { initRepo, tmpDir } from "./helpers.js";

test("sanitizeName kebab-cases", () => {
  assert.equal(sanitizeName("Auth Worker 2!"), "auth-worker-2");
  assert.equal(sanitizeName("--x--"), "x");
});

test("resolveFleetDir: git repo anchors to root; plain dir anchors to itself; missing dir throws", async () => {
  const root = initRepo("pf-spawn-");
  const sub = path.join(root, "sub");
  fs.mkdirSync(sub);
  const inRepo = await resolveFleetDir(sub);
  assert.equal(inRepo.isGit, true);
  assert.equal(inRepo.repoRoot, fs.realpathSync(root));
  assert.equal(inRepo.piFleetDir, path.join(fs.realpathSync(root), ".pi-fleet"));
  const plain = tmpDir("pf-plain-");
  const standalone = await resolveFleetDir(plain);
  assert.equal(standalone.isGit, false);
  assert.equal(standalone.repoRoot, null);
  assert.equal(standalone.piFleetDir, path.join(fs.realpathSync(plain), ".pi-fleet"));
  await assert.rejects(resolveFleetDir(path.join(plain, "nope")), /does not exist/);
});

test("createRun builds state dir, gitignore, worktree and initial state", async () => {
  const root = initRepo("pf-spawn-");
  const { runId, piFleetDir, state, worktreePath } = await createRun({
    name: "auth-worker", opts: { cwd: root, worktree: true, model: "glm" }, brief: "create hello",
  });
  assert.match(runId, /^auth-worker-\d{14}$/);
  assert.equal(fs.existsSync(path.join(piFleetDir, "runs", runId, "state.json")), true);
  assert.equal(fs.existsSync(path.join(piFleetDir, "reports")), true);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".pi-fleet/"), true);
  assert.ok(worktreePath);
  assert.equal(fs.existsSync(path.join(worktreePath, "seed.txt")), true);
  assert.match(state.branch ?? "", /^pi-fleet\/auth-worker-.{7}$/);
  assert.equal(state.repoRoot, fs.realpathSync(root));
  assert.equal(state.isGit, true);
  assert.equal(state.taskBrief, "create hello");
  assert.equal(state.status, "starting");
  assert.equal(state.model, "glm");
});

test("createRun in a plain directory runs in place (no worktree, no branch)", async () => {
  const dir = tmpDir("pf-plain-");
  const { state, worktreePath } = await createRun({ name: "r", opts: { cwd: dir }, brief: "b" });
  assert.equal(worktreePath, null);
  assert.equal(state.branch, null);
  assert.equal(state.isGit, false);
  assert.equal(state.cwd, fs.realpathSync(dir));
});
