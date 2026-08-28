// Real-model end-to-end for pi-fleet. Requires `pi` on PATH with a working default provider.
// Optional: PI_FLEET_E2E_MODEL=<pattern> (e.g. a cheap model) is passed to every spawn.
import fs from "node:fs";
import path from "node:path";
import { initRepo, runCli, readState, firstRunId, fleetDirOf, waitFor } from "./helpers.js";

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

await scenarioHello();
await scenarioSteering();
console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
