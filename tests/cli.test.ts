import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli, tmpDir } from "./helpers.js";

test("--help prints usage, lists spawn, hides __monitor, exits 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /pi-fleet/);
  assert.match(r.stdout, /spawn/);
  assert.doesNotMatch(r.stdout, /__monitor/);
});

test("unknown command exits 1", async () => {
  const r = await runCli(["nope"]);
  assert.equal(r.code, 1);
});

test("spawn without a brief exits 1 with guidance", async () => {
  const r = await runCli(["spawn", "x", "--cwd", tmpDir("pf-cli-")]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /brief required/);
});

test("the Claude Code skill installer is gone; mcp and answer are advertised", async () => {
  const gone = await runCli(["install-claude-skill"]);
  assert.equal(gone.code, 1);
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /\bmcp\b/);
  assert.match(help.stdout, /\banswer\b/);
});

test("the root command opens the TUI and refuses a non-TTY with guidance", async () => {
  const r = await runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs an interactive terminal/);
  assert.match(r.stderr, /pi-fleet spawn <name>/);
  const viaName = await runCli(["tui"]);
  assert.equal(viaName.code, 1);
  assert.match(viaName.stderr, /needs an interactive terminal/);
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /tui \[options\]/);
});
