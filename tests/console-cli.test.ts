import { test } from "node:test";
import assert from "node:assert/strict";
import { initRepo, runCli } from "./helpers.js";

test("attach prints a worker's transcript tail; `open` is gone (the console is `pi-fleet`)", async () => {
  const root = initRepo("pf-ccli-");
  const spawned = await runCli(["spawn", "worker", "--cwd", root, "--no-worktree", "--", "task"]);
  assert.equal(spawned.code, 0, spawned.stderr);
  assert.equal((await runCli(["wait", "worker", "--cwd", root, "--timeout", "30"])).code, 0);

  const tail = await runCli(["attach", "worker", "--cwd", root]);
  assert.equal(tail.code, 0, tail.stderr);
  assert.match(tail.stdout, /▶ task: task/);
  assert.match(tail.stdout, /⚙ bash echo hi/);
  assert.match(tail.stdout, /● settled/);
  assert.match(tail.stderr, /static tail — run `pi-fleet` for the live console/);

  const short = await runCli(["attach", "worker", "--cwd", root, "--tail", "1"]);
  assert.equal(short.code, 0);
  assert.equal(short.stdout.trim().split("\n").length, 1);

  const open = await runCli(["open", "--cwd", root]);
  assert.equal(open.code, 1);
  assert.match(open.stderr, /unknown command/i);
}, { timeout: 60_000 });

test("attach on a run with no events says so, and an unknown run exits 1", async () => {
  const root = initRepo("pf-ccli-2-");
  const missing = await runCli(["attach", "nope", "--cwd", root]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No run found matching "nope"/);
});
