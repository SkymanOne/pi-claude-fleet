import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  parseClaudeVersion,
  versionSupported,
  checkClaudeVersion,
  commandLineOf,
  reapOrphanOrchestrator,
  TESTED_CLAUDE_RANGE,
} from "../src/orchestrator/health.js";
import { isAlive } from "../src/state.js";
import { fakeClaudeEnv, waitFor } from "./helpers.js";

test("version parsing and the tested range", () => {
  assert.equal(parseClaudeVersion("2.1.251 (Claude Code)"), "2.1.251");
  assert.equal(parseClaudeVersion("no version here"), null);
  assert.deepEqual(TESTED_CLAUDE_RANGE.min, [2, 1]);
  assert.equal(versionSupported("2.1.0"), true);
  assert.equal(versionSupported("2.1.251"), true);
  assert.equal(versionSupported("2.0.9"), false);
  assert.equal(versionSupported("2.2.0"), false);
  assert.equal(versionSupported("3.0.0"), false);
  assert.equal(versionSupported(null), false);
});

test("checkClaudeVersion reports the version, warns outside the range, and survives a missing binary", async () => {
  const ok = await checkClaudeVersion(fakeClaudeEnv());
  assert.deepEqual(ok, { version: "2.1.251", supported: true, warning: null });

  const old = await checkClaudeVersion(fakeClaudeEnv({ FAKE_CLAUDE_VERSION: "2.0.9" }));
  assert.equal(old.version, "2.0.9");
  assert.equal(old.supported, false);
  assert.match(old.warning!, /outside the tested range/);

  const missing = await checkClaudeVersion({ ...process.env, PI_FLEET_CLAUDE_BIN: "/nonexistent/claude-binary" });
  assert.equal(missing.version, null);
  assert.match(missing.warning!, /could not run .*--version/);
}, { timeout: 30_000 });

test("reapOrphanOrchestrator kills only a live process that looks like the child", async () => {
  assert.deepEqual(reapOrphanOrchestrator(null), { reaped: false, reason: null });
  assert.deepEqual(reapOrphanOrchestrator(999_999_999), { reaped: false, reason: null });

  // our own process is alive but is not a "claude"
  const notClaude = reapOrphanOrchestrator(process.pid);
  assert.equal(notClaude.reaped, false);
  assert.match(notClaude.reason!, /is not a claude process — leaving it alone/);
  assert.ok(commandLineOf(process.pid)?.includes("node"));
  assert.equal(commandLineOf(999_999_999), null);

  // a stand-in for an orphaned child: matched by its command line, then killed
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await waitFor(() => (child.pid && isAlive(child.pid) ? true : undefined), { timeoutMs: 5000 });
  const result = reapOrphanOrchestrator(child.pid, "-e");
  assert.equal(result.reaped, true);
  assert.match(result.reason!, /stopped an orphaned orchestrator/);
  await once(child, "exit");
  assert.equal(isAlive(child.pid), false);
}, { timeout: 30_000 });
