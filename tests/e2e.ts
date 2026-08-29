/**
 * Real end-to-end for pi-fleet. Scenarios 1-2 need `pi` on PATH with a working
 * default provider; scenario 3 also drives the real `claude` binary and costs a
 * few cents (skip it with PI_FLEET_E2E_NO_CLAUDE=1).
 *
 * Optional: PI_FLEET_E2E_MODEL=<pattern> for pi workers,
 *           PI_FLEET_E2E_CLAUDE_MODEL=<alias> for the orchestrator (default haiku).
 */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { initRepo, runCli, readState, firstRunId, fleetDirOf, waitFor, FAKE_PI } from "./helpers.js";
import { OrchestratorProcess, type PermissionRequest } from "../src/orchestrator/process.js";
import { fleetMcpConfig } from "../src/orchestrator/mcpConfig.js";
import { writeRenderedPrompt } from "../src/orchestrator/prompt.js";
import { FleetWatcher } from "../src/fleet/watcher.js";
import { formatFleetBatch, type FleetEvent } from "../src/fleet/events.js";
import { textOfAssistant, isResult, type ResultMessage } from "../src/orchestrator/protocol.js";

const env: NodeJS.ProcessEnv = { ...process.env, PI_FLEET_DEV: "1" };
delete env.PI_FLEET_PI_BIN;
const modelArgs = process.env.PI_FLEET_E2E_MODEL ? ["--model", process.env.PI_FLEET_E2E_MODEL] : [];

let failures = 0;
function check(condition: unknown, label: string): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}
const cli = (args: string[], cwd?: string) => runCli(args, { env, cwd });

async function scenarioHello(): Promise<void> {
  console.log("scenario 1: spawn → wait → report → diff → merge → cleanup");
  const root = initRepo("pf-e2e-1-");
  console.log(`  repo ${root}`);
  const spawn = await cli([
    "spawn", "hello", "--cwd", root, ...modelArgs, "--",
    "Create a file named hello.txt in the current directory containing exactly the text 'hi' (one line).",
    "Commit it with git (git add hello.txt && git commit -m 'add hello'). Verify with cat hello.txt.",
    "Then write your fleet report.",
  ]);
  check(spawn.code === 0, `spawn exit 0 ${spawn.stderr.trim()}`);
  const runId = firstRunId(root);
  const initial = readState(root, runId);
  check(initial.worktree && fs.existsSync(initial.worktree), "worktree created");
  const wait = await cli(["wait", "hello", "--cwd", root, "--timeout", "600"]);
  check(wait.code === 0, `wait settled (exit ${wait.code}) ${wait.stdout.trim()} ${wait.stderr.trim()}`);
  const report = await cli(["report", "hello", "--cwd", root]);
  check(report.code === 0 && /## Status/.test(report.stdout), "report exists with ## Status");
  const diff = await cli(["diff", "hello", "--cwd", root]);
  check(/hello\.txt/.test(diff.stdout), `diff shows hello.txt (${diff.stdout.trim().split("\n")[0]})`);
  const merge = await cli(["merge", "hello", "--cwd", root], root);
  check(merge.code === 0, `merge exit 0 ${merge.stderr.trim()}`);
  check(fs.existsSync(path.join(root, "hello.txt")), "hello.txt present in parent after merge");
  const cleanup = await cli(["cleanup", "hello", "--cwd", root], root);
  check(cleanup.code === 0, `cleanup exit 0 ${cleanup.stderr.trim()}`);
  check(!fs.existsSync(initial.worktree), "worktree removed");
  check(readState(root, runId).status === "archived", "run archived");
}

async function scenarioSteering(): Promise<void> {
  console.log("scenario 2: console steering mid-run reaches the worker and its report");
  const root = initRepo("pf-e2e-2-");
  console.log(`  repo ${root}`);
  const spawn = await cli([
    "spawn", "steer", "--cwd", root, ...modelArgs, "--",
    "Step 1: run the bash command `sleep 25`. Step 2: create note.txt containing the single word 'done'.",
    "Step 3: write your fleet report.",
  ]);
  check(spawn.code === 0, `spawn exit 0 ${spawn.stderr.trim()}`);
  const runId = firstRunId(root);
  const runDir = path.join(fleetDirOf(root), "runs", runId);
  await waitFor(() => {
    try {
      return /tool_execution_start/.test(fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8")) ? true : undefined;
    } catch {
      return undefined;
    }
  }, { timeoutMs: 300_000, intervalMs: 500 });
  fs.appendFileSync(path.join(runDir, "control.jsonl"), JSON.stringify({
    type: "steer",
    message: "Change of plan from the user's console: note.txt must contain the word STEERED instead of done.",
    source: "console",
    ts: new Date().toISOString(),
  }) + "\n");
  const wait = await cli(["wait", "steer", "--cwd", root, "--timeout", "600"]);
  check(wait.code === 0, `wait settled (exit ${wait.code}) ${wait.stdout.trim()} ${wait.stderr.trim()}`);
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  check(/steering_delivered/.test(events), "steering_delivered event recorded");
  const state = readState(root, runId);
  check(state.steerCount === 1 && state.steeringLog[0]?.source === "console", "steerCount=1 with console provenance");
  const report = await cli(["report", "steer", "--cwd", root]);
  const section = report.stdout.split("## Steering received")[1]?.split("\n## ")[0] ?? "";
  check(section.trim().length > 0 && !/^\s*none\s*$/i.test(section.trim()), "report's 'Steering received' is not 'none'");
  check(/Steering log/.test(report.stdout), "steering-log appendix present");
  const note = state.worktree ? path.join(state.worktree, "note.txt") : null;
  console.log(`  info note.txt: ${note && fs.existsSync(note) ? fs.readFileSync(note, "utf8").trim() : "(missing)"}`);
  const cleanup = await cli(["cleanup", "steer", "--force", "--cwd", root], root);
  check(cleanup.code === 0, `cleanup exit 0 ${cleanup.stderr.trim()}`);
}

/**
 * The real orchestrator, headless: claude drives fake pi workers through the
 * fleet MCP server, and the watcher pushes the settled event back to it.
 */
async function scenarioOrchestrator(): Promise<void> {
  console.log("scenario 3: claude orchestrates a worker through the fleet MCP tools");
  const root = initRepo("pf-e2e-3-");
  const piFleetDir = path.join(fs.realpathSync(root), ".pi-fleet");
  fs.mkdirSync(path.join(piFleetDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(piFleetDir, "reports"), { recursive: true });
  console.log(`  repo ${root}`);
  // fake pi keeps this scenario about the orchestrator, not about a model writing code
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PI_FLEET_DEV: "1", PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`, FAKE_PI_DELAY_MS: "300" };
  const promptFile = writeRenderedPrompt(piFleetDir, { fleetDir: piFleetDir, repoRoot: fs.realpathSync(root) });
  const proc = new OrchestratorProcess({
    cwd: fs.realpathSync(root),
    promptFile,
    mcpConfigJson: JSON.stringify(fleetMcpConfig(piFleetDir, childEnv)),
    model: process.env.PI_FLEET_E2E_CLAUDE_MODEL ?? "haiku",
    maxBudgetUsd: 0.5,
    logPath: path.join(piFleetDir, "orchestrator.log"),
    env: childEnv,
  });
  const watcher = new FleetWatcher({ piFleetDir, pollMs: 300, batchMs: 300 });
  const injected: string[] = [];
  const seen: FleetEvent[] = [];
  watcher.on("batch", (events) => {
    seen.push(...events);
    const text = formatFleetBatch(events, watcher.batchLimit);
    injected.push(text);
    proc.send(text);
  });
  // the orchestrator only gets fleet tools and read-only git, so nothing here should prompt
  const prompts: PermissionRequest[] = [];
  proc.on("permission_request", (req) => {
    prompts.push(req);
    proc.allow(req.requestId, req.request.permission_suggestions);
  });
  const assistant: string[] = [];
  proc.on("assistant", (msg) => assistant.push(textOfAssistant(msg)));

  proc.start();
  watcher.start();
  try {
    const first = once(proc, "result");
    proc.send(
      'Spawn a fleet worker named "hello" with worktree true and this brief: ' +
        '"Create hello.txt containing hi, commit it, and write your fleet report." ' +
        "Then stop and wait: do not call fleet_wait, and do not do anything else. Reply with the run id only.",
    );
    const [spawnResult] = (await first) as [ResultMessage];
    check(isResult(spawnResult) && !spawnResult.is_error, `first turn finished (${spawnResult.subtype})`);
    const runId = await waitFor(() => {
      try {
        return fs.readdirSync(path.join(piFleetDir, "runs"))[0];
      } catch {
        return undefined;
      }
    }, { timeoutMs: 180_000, intervalMs: 500 });
    check(Boolean(runId), `worker spawned by the orchestrator (${runId})`);
    check(prompts.length === 0, `no permission prompts for fleet tools (got ${prompts.length})`);

    // the watcher must push the settled event, and the orchestrator must act on it
    const settledTurn = once(proc, "result");
    await waitFor(() => (seen.some((e) => e.kind === "settled") ? true : undefined), { timeoutMs: 180_000, intervalMs: 300 });
    check(injected.some((t) => /<fleet-event kind="settled"/.test(t)), "a settled fleet event was injected");
    const [reactResult] = (await settledTurn) as [ResultMessage];
    check(!reactResult.is_error, `the orchestrator reacted to the event (${reactResult.subtype})`);
    const text = `${assistant.join("\n")}\n${reactResult.result ?? ""}`;
    check(/done/i.test(text), "the orchestrator read the report (mentions the worker's Status: done)");
    console.log(`  info cost so far: $${proc.costUsd.toFixed(4)} over ${proc.numTurns} turns`);
  } finally {
    watcher.stop();
    await proc.stop();
    await runCli(["cleanup", "all", "--force", "--cwd", root], { env: childEnv, cwd: root });
  }
}

// PI_FLEET_E2E_ONLY=pi|claude narrows the run; PI_FLEET_E2E_NO_CLAUDE=1 skips scenario 3.
const only = process.env.PI_FLEET_E2E_ONLY;
if (!only || only === "pi") {
  await scenarioHello();
  await scenarioSteering();
}
if (only === "pi" || process.env.PI_FLEET_E2E_NO_CLAUDE === "1") console.log("scenario 3: skipped");
else await scenarioOrchestrator();
console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
