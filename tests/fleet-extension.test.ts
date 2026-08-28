import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import fleetReport, { buildFleetProtocol, FLEET_PROTOCOL_MARKER, REPORT_TEMPLATE } from "../pi/extensions/fleet-report.js";
import { FLEET_EXTENSION_PATH, FLEET_SKILL_PATH } from "../src/paths.js";
import { initRepo, runCli, fakePiEnv, readState, waitFor, tmpDir, TERMINAL } from "./helpers.js";

test("buildFleetProtocol: null without env; otherwise paths, rules, and template", () => {
  assert.equal(buildFleetProtocol({}, "/wt"), null);
  assert.equal(buildFleetProtocol({ PI_FLEET_RUN: "auth-1" }, "/wt"), null);
  const block = buildFleetProtocol({ PI_FLEET_RUN: "auth-1", PI_FLEET_DIR: "/f/.pi-fleet" }, "/wt")!;
  assert.ok(block.startsWith(FLEET_PROTOCOL_MARKER));
  assert.match(block, /\/f\/\.pi-fleet\/reports\/auth-1\.md/);
  assert.match(block, /\/f\/\.pi-fleet\/runs\/auth-1\/progress\.md/);
  assert.match(block, /Steering received/);
  assert.match(block, /never run `git merge`/i);
  assert.ok(block.includes(REPORT_TEMPLATE));
  for (const h of ["## Status", "## Summary", "## What I did", "## Files changed", "## Verification",
    "## Decisions & assumptions", "## Steering received", "## Open questions for orchestrator", "## Suggested next step"]) {
    assert.ok(REPORT_TEMPLATE.includes(h), `template missing ${h}`);
  }
});

test("extension appends the protocol once via before_agent_start (idempotent, env-gated)", async () => {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const pi = { on: (name: string, fn: any) => { handlers[name] = fn; } } as any;
  const saved = { run: process.env.PI_FLEET_RUN, dir: process.env.PI_FLEET_DIR };
  try {
    process.env.PI_FLEET_RUN = "auth-1";
    process.env.PI_FLEET_DIR = "/f/.pi-fleet";
    fleetReport(pi);
    assert.ok(handlers.before_agent_start, "registers before_agent_start");
    const first = await handlers.before_agent_start({ systemPrompt: "base" }, { cwd: "/wt" });
    assert.match(first.systemPrompt, /^base\n\n## Fleet worker protocol/);
    const second = await handlers.before_agent_start({ systemPrompt: first.systemPrompt }, { cwd: "/wt" });
    assert.equal(second, undefined, "does not append twice");
    delete process.env.PI_FLEET_RUN;
    delete process.env.PI_FLEET_DIR;
    assert.equal(await handlers.before_agent_start({ systemPrompt: "base" }, { cwd: "/wt" }), undefined);
  } finally {
    if (saved.run !== undefined) process.env.PI_FLEET_RUN = saved.run;
    if (saved.dir !== undefined) process.env.PI_FLEET_DIR = saved.dir;
  }
});

test("worker skill has valid frontmatter and the same template headings", () => {
  const skill = fs.readFileSync(path.join(FLEET_SKILL_PATH, "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: fleet-worker-report\ndescription: .+\n---/);
  assert.match(skill, /## Steering received/);
  assert.equal(fs.existsSync(FLEET_EXTENSION_PATH), true);
});

test("monitor passes --extension and --skill for the fleet protocol", async () => {
  const root = initRepo("pf-ext-");
  const argvFile = path.join(tmpDir("pf-argv-"), "argv.json");
  const r = await runCli(["spawn", "w", "--cwd", root, "--no-worktree", "--skill", "/extra/skill",
    "--session", "abc123", "--model", "glm", "--thinking", "high", "--", "t"],
    { env: fakePiEnv({ FAKE_PI_ARGV_FILE: argvFile }) });
  assert.equal(r.code, 0, r.stderr);
  await waitFor(() => (TERMINAL.includes(readState(root).status) ? true : undefined), { timeoutMs: 30_000 });
  const argv: string[] = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(argv[argv.indexOf("--extension") + 1], FLEET_EXTENSION_PATH);
  assert.equal(argv[argv.indexOf("--skill") + 1], FLEET_SKILL_PATH);
  assert.ok(argv.includes("/extra/skill"), "user --skill still passed");
  const pair = (flag: string) => argv[argv.lastIndexOf(flag) + 1];
  assert.equal(pair("--session"), "abc123");
  assert.equal(pair("--model"), "glm");
  assert.equal(pair("--thinking"), "high");
}, { timeout: 60_000 });
