import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  newRunState, loadState, saveState, deriveStatus, isAlive, recordSteering,
  recordToolActivity, appendControl, listRuns, findRun, runDirFor, STARTING_GRACE_MS,
} from "../src/state.js";
import { tmpDir } from "./helpers.js";

function mkFleet(): string {
  const fleetDir = path.join(tmpDir("pf-state-"), ".pi-fleet");
  fs.mkdirSync(fleetDir, { recursive: true });
  return fleetDir;
}

const base = {
  fleetDir: "/tmp/x/.pi-fleet", runId: "auth-20260828141530", name: "auth",
  cwd: "/tmp/x", base: "HEAD", model: "m", taskBrief: "b",
};

test("newRunState has the full schema with neutral defaults", () => {
  const s = newRunState(base);
  for (const k of ["id", "name", "status", "pid", "createdAt", "settledAt", "lastTool",
    "lastActivity", "lastAssistantText", "steerCount", "steeringLog", "error", "taskBrief",
    "repoRoot", "isGit"]) {
    assert.ok(k in s, `missing ${k}`);
  }
  assert.equal(s.status, "starting");
  assert.equal(s.pid, null);
  assert.equal(s.steerCount, 0);
  assert.equal(s.worktree, null);
});

test("saveState is atomic and loadState round-trips", async () => {
  const runDir = runDirFor(mkFleet(), base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  await saveState(runDir, newRunState(base));
  const loaded = await loadState(runDir);
  assert.equal(loaded.id, base.runId);
  assert.deepEqual(fs.readdirSync(runDir).filter((f) => f.includes(".tmp")), []);
  await assert.rejects(loadState(path.join(runDir, "missing")), /No readable state.json/);
});

test("isAlive: own pid alive, absurd pid not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});

test("deriveStatus flags dead when pid is gone mid-run", () => {
  const s = newRunState(base);
  s.status = "running";
  s.pid = 1;
  assert.equal(deriveStatus(s, (pid) => pid === 1), "running");
  assert.equal(deriveStatus(s, () => false), "dead");
  s.status = "settled";
  assert.equal(deriveStatus(s, () => false), "settled");
});

test("recordToolActivity and recordSteering (cap 20) update state", () => {
  const s = newRunState(base);
  recordToolActivity(s, "bash");
  assert.equal(s.lastTool, "bash");
  assert.ok(s.lastActivity);
  for (let i = 0; i < 25; i++) recordSteering(s, { source: "console", message: `m${i}`, ts: `t${i}` });
  assert.equal(s.steerCount, 25);
  assert.equal(s.steeringLog.length, 20);
  assert.equal(s.steeringLog.at(-1)?.message, "m24");
});

test("appendControl writes one JSON line with ts", async () => {
  const runDir = runDirFor(mkFleet(), base.runId);
  fs.mkdirSync(runDir, { recursive: true });
  await appendControl(runDir, { type: "steer", message: "hi", source: "orchestrator" });
  const obj = JSON.parse(fs.readFileSync(path.join(runDir, "control.jsonl"), "utf8").trim());
  assert.equal(obj.type, "steer");
  assert.equal(obj.source, "orchestrator");
  assert.ok(obj.ts);
});

test("listRuns newest-first; findRun prefers non-archived; throws when absent", async () => {
  const fleetDir = mkFleet();
  for (const id of ["auth-20260828141530", "auth-20260828161530"]) {
    const runDir = runDirFor(fleetDir, id);
    fs.mkdirSync(runDir, { recursive: true });
    await saveState(runDir, newRunState({ ...base, runId: id }));
  }
  assert.equal(listRuns(fleetDir)[0].runId, "auth-20260828161530");
  assert.equal(findRun(fleetDir, "auth").runId, "auth-20260828161530");
  const newest = findRun(fleetDir, "auth-20260828161530");
  newest.state.status = "archived";
  await saveState(newest.runDir, newest.state);
  assert.equal(findRun(fleetDir, "auth").runId, "auth-20260828141530");
  assert.throws(() => findRun(fleetDir, "ghost"), /No run found/);
});

test("deriveStatus: starting with no pid is 'starting' within the grace period, 'dead' after", () => {
  const s = newRunState(base);
  const created = Date.parse(s.createdAt);
  assert.equal(deriveStatus(s, () => false, created + 1000), "starting");
  assert.equal(deriveStatus(s, () => false, created + STARTING_GRACE_MS + 1), "dead");
});
