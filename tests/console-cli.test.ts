import { test } from "node:test";
import assert from "node:assert/strict";
import { initRepo, runCli } from "./helpers.js";

test("attach on a non-TTY prints the static tail and exits 0; open on a non-TTY exits 1", async () => {
  const root = initRepo("pf-ccli-");
  const spawned = await runCli(["spawn", "worker", "--cwd", root, "--no-worktree", "--", "task"]);
  assert.equal(spawned.code, 0, spawned.stderr);
  assert.equal((await runCli(["wait", "worker", "--cwd", root, "--timeout", "30"])).code, 0);
  const tail = await runCli(["attach", "worker", "--cwd", root]);
  assert.equal(tail.code, 0, tail.stderr);
  assert.match(tail.stdout, /▶ task: task/);
  assert.match(tail.stdout, /⚙ bash echo hi/);
  assert.match(tail.stdout, /● settled/);
  const open = await runCli(["open", "--cwd", root]);
  assert.equal(open.code, 1);
  assert.match(open.stderr, /interactive terminal/);
}, { timeout: 60_000 });
