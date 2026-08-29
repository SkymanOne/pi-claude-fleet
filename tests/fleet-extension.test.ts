import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import fleetWorker, {
  buildFleetProtocol, FLEET_PROTOCOL_MARKER, REPORT_TEMPLATE, askOrchestrator, noteProgress, findAnswer,
} from "../pi/extensions/fleet-worker.js";
import { buildPiArgs, FLEET_WORKER_TOOLS } from "../src/monitor.js";
import { newRunState } from "../src/state.js";
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
  assert.match(block, /`fleet_ask`/);
  assert.match(block, /`fleet_progress`/);
  assert.ok(block.includes(REPORT_TEMPLATE));
  for (const h of ["## Status", "## Summary", "## What I did", "## Files changed", "## Verification",
    "## Decisions & assumptions", "## Steering received", "## Open questions for orchestrator", "## Suggested next step"]) {
    assert.ok(REPORT_TEMPLATE.includes(h), `template missing ${h}`);
  }
});

test("extension appends the protocol once via before_agent_start (idempotent, env-gated)", async () => {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const pi = { on: (name: string, fn: any) => { handlers[name] = fn; }, registerTool: () => {} } as any;
  const saved = { run: process.env.PI_FLEET_RUN, dir: process.env.PI_FLEET_DIR };
  try {
    process.env.PI_FLEET_RUN = "auth-1";
    process.env.PI_FLEET_DIR = "/f/.pi-fleet";
    fleetWorker(pi);
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

function workerEnv(): { env: Record<string, string>; fleetDir: string; runId: string; runDir: string } {
  const fleetDir = path.join(tmpDir("pf-ask-"), ".pi-fleet");
  const runId = "w-20260829000000";
  const runDir = path.join(fleetDir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { env: { PI_FLEET_DIR: fleetDir, PI_FLEET_RUN: runId, PI_FLEET_ASK_POLL_MS: "20", PI_FLEET_ASK_TIMEOUT_MS: "300" }, fleetDir, runId, runDir };
}

const outbox = (runDir: string) => fs.readFileSync(path.join(runDir, "outbox.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("extension registers fleet_ask and fleet_progress only when running as a worker", () => {
  const tools: Record<string, any> = {};
  const pi = { on: () => {}, registerTool: (def: any) => { tools[def.name] = def; } } as any;
  const saved = { run: process.env.PI_FLEET_RUN, dir: process.env.PI_FLEET_DIR };
  try {
    delete process.env.PI_FLEET_RUN;
    delete process.env.PI_FLEET_DIR;
    fleetWorker(pi);
    assert.deepEqual(Object.keys(tools), []);
    process.env.PI_FLEET_RUN = "r";
    process.env.PI_FLEET_DIR = "/f";
    fleetWorker(pi);
    assert.deepEqual(Object.keys(tools).sort(), ["fleet_ask", "fleet_progress"]);
    assert.equal(tools.fleet_ask.label, "Ask orchestrator");
    assert.equal(tools.fleet_ask.parameters.type, "object");
    assert.deepEqual(tools.fleet_ask.parameters.required, ["question"]);
    assert.deepEqual(tools.fleet_progress.parameters.required, ["message"]);
  } finally {
    if (saved.run !== undefined) process.env.PI_FLEET_RUN = saved.run; else delete process.env.PI_FLEET_RUN;
    if (saved.dir !== undefined) process.env.PI_FLEET_DIR = saved.dir; else delete process.env.PI_FLEET_DIR;
  }
});

test("fleet_ask posts a question and returns the matching answer from the inbox", async () => {
  const { env, runDir } = workerEnv();
  // an unrelated older line must not be mistaken for the answer
  fs.writeFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({ type: "answer", questionId: "q_old", message: "stale", source: "console", ts: "t" }) + "\n");
  let waitingId: string | null = null;
  const pending = askOrchestrator(env, { question: "bcrypt or argon2?", options: ["bcrypt", "argon2"] }, { onWaiting: (id) => { waitingId = id; } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(waitingId);
  const posted = outbox(runDir);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "question");
  assert.equal(posted[0].id, waitingId);
  assert.equal(posted[0].from, `worker:${env.PI_FLEET_RUN}`);
  assert.equal(posted[0].to, "orchestrator");
  assert.deepEqual(posted[0].payload, { question: "bcrypt or argon2?", options: ["bcrypt", "argon2"], context: null });
  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({ id: "ctl_1", type: "answer", questionId: waitingId, message: "argon2", source: "console", ts: "t" }) + "\n");
  const result = await pending;
  assert.equal(result.how, "answered");
  assert.equal(result.text, "Answer from console: argon2");
  assert.deepEqual(result.answer, { message: "argon2", source: "console" });
  const after = outbox(runDir);
  assert.equal(after.length, 2);
  assert.deepEqual(after[1].payload, { questionId: waitingId, how: "answered" });
});

test("fleet_ask times out with guidance, and honors abort", async () => {
  const { env, runDir } = workerEnv();
  const timedOut = await askOrchestrator(env, { question: "anyone?" });
  assert.equal(timedOut.how, "timeout");
  assert.match(timedOut.text, /No answer arrived within \d+ minute/);
  assert.match(timedOut.text, /Decisions & assumptions/);
  assert.equal(outbox(runDir).at(-1).payload.how, "timeout");

  const ac = new AbortController();
  const pending = askOrchestrator({ ...env, PI_FLEET_ASK_TIMEOUT_MS: "5000" }, { question: "again?" }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 40);
  const aborted = await pending;
  assert.equal(aborted.how, "aborted");
  assert.equal(outbox(runDir).at(-1).payload.how, "aborted");
});

test("fleet_progress writes the outbox line and progress.md", () => {
  const { env, runDir } = workerEnv();
  const line = noteProgress(env, "tests passing");
  assert.equal(line.type, "progress");
  assert.deepEqual(outbox(runDir)[0].payload, { message: "tests passing" });
  assert.match(fs.readFileSync(path.join(runDir, "progress.md"), "utf8"), /^- \d{4}-.* tests passing\n$/);
});

test("findAnswer ignores malformed and unrelated lines", () => {
  assert.equal(findAnswer(["{bad", JSON.stringify({ type: "steer", message: "x" })], "q1"), null);
  assert.deepEqual(findAnswer([JSON.stringify({ type: "answer", questionId: "q1", message: "yes" })], "q1"), { message: "yes", source: "unknown" });
});

test("buildPiArgs appends the worker tools to a --tools allowlist", () => {
  const state = newRunState({ fleetDir: "/f/.pi-fleet", runId: "r-1", name: "r", cwd: "/w", tools: "read,bash" });
  const args = buildPiArgs(state, "/f/.pi-fleet/runs/r-1");
  assert.equal(args[args.indexOf("--tools") + 1], `read,bash,${FLEET_WORKER_TOOLS.join(",")}`);
  const none = buildPiArgs(newRunState({ fleetDir: "/f/.pi-fleet", runId: "r-2", name: "r", cwd: "/w" }), "/f/.pi-fleet/runs/r-2");
  assert.equal(none.includes("--tools"), false);
});
