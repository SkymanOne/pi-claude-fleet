import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lockPath, readActiveLock, writeLock, startLockHeartbeat, LOCK_STALE_MS } from "../src/console/lock.js";
import { tmpDir } from "./helpers.js";

test("lock: missing/invalid/stale/own-pid → null; foreign fresh lock → returned", () => {
  const runDir = tmpDir("pf-lock-");
  assert.equal(readActiveLock(runDir), null);
  fs.writeFileSync(lockPath(runDir), "{nope");
  assert.equal(readActiveLock(runDir), null);
  writeLock(runDir);
  assert.equal(readActiveLock(runDir), null, "own pid is not a conflict");
  fs.writeFileSync(lockPath(runDir), JSON.stringify({ pid: 424242, ts: new Date().toISOString() }));
  assert.equal(readActiveLock(runDir)?.pid, 424242);
  assert.equal(readActiveLock(runDir, Date.now() + LOCK_STALE_MS + 1), null, "stale");
});

test("heartbeat writes, refreshes, and removes its own lock on stop", async () => {
  const runDir = tmpDir("pf-lock-");
  const stop = startLockHeartbeat(runDir, 20);
  const first = JSON.parse(fs.readFileSync(lockPath(runDir), "utf8"));
  assert.equal(first.pid, process.pid);
  await new Promise((r) => setTimeout(r, 60));
  const later = JSON.parse(fs.readFileSync(lockPath(runDir), "utf8"));
  assert.ok(Date.parse(later.ts) >= Date.parse(first.ts));
  stop();
  assert.equal(fs.existsSync(lockPath(runDir)), false);
});
