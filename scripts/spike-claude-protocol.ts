/**
 * Protocol spike: drive the real `claude` binary the way the fleet TUI will and
 * record what the stream-json / control protocol actually does. Costs tokens.
 *
 *   node --import tsx scripts/spike-claude-protocol.ts [--model <m>] [--keep]
 *
 * Findings (fill in after running; keep this block current):
 *   F1 can_use_tool arrives without an `initialize` control request: (pending)
 *   F2 ... after a bare {subtype:"initialize"}:                           (pending)
 *   F3 --allowedTools "mcp__fleet__*" suppresses prompts for fleet tools: (pending)
 *   F4 updatedPermissions from permission_suggestions is honored:         (pending)
 *   F5 --append-system-prompt-file is accepted and applied:               (pending)
 *   F6 a user message injected mid-turn is consumed in that turn:         (pending)
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitJsonLines } from "../src/util.js";
import { cliSpawnArgs } from "../src/commands.js";
import {
  parseClaudeLine,
  isSystemInit,
  isCanUseTool,
  isAssistant,
  isResult,
  isUser,
  isReplayedUserMessage,
  textOfAssistant,
  userMessage,
  allowResponse,
  initializeRequest,
  serialize,
  newRequestId,
  type ClaudeStreamMessage,
  type CanUseToolRequest,
} from "../src/orchestrator/protocol.js";

const argv = process.argv.slice(2);
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : (process.env.PI_FLEET_SPIKE_MODEL ?? "haiku");
const keep = argv.includes("--keep");
const claudeBin = process.env.PI_FLEET_CLAUDE_BIN ?? "claude";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-spike-")));
execFileSync("git", ["init", "-q"], { cwd: tmp });
fs.writeFileSync(path.join(tmp, "README.md"), "spike\n");
execFileSync("git", ["-c", "user.email=s@x", "-c", "user.name=s", "add", "."], { cwd: tmp });
execFileSync("git", ["-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "init"], { cwd: tmp });
const piFleetDir = path.join(tmp, ".pi-fleet");
fs.mkdirSync(piFleetDir, { recursive: true });
const promptFile = path.join(piFleetDir, "spike.prompt.md");
fs.writeFileSync(
  promptFile,
  "You are a protocol test harness. Do exactly what each user message asks, briefly. The secret word is PELICAN.\n",
);
const mcpConfig = {
  mcpServers: {
    fleet: {
      type: "stdio",
      command: process.execPath,
      args: [...cliSpawnArgs(), "mcp", "--cwd", tmp],
      env: { PI_FLEET_DIR: piFleetDir, PI_FLEET_DEV: process.env.PI_FLEET_DEV ?? "", PI_FLEET_PI_BIN: process.env.PI_FLEET_PI_BIN ?? "" },
    },
  },
};
const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-prompt-tool", "stdio",
  "--append-system-prompt-file", promptFile,
  "--mcp-config", JSON.stringify(mcpConfig),
  "--strict-mcp-config",
  "--allowedTools", "mcp__fleet__*",
  "--model", model,
  "--max-budget-usd", "0.5",
];

const logPath = path.join(tmp, "spike.log");
const log = fs.createWriteStream(logPath);
const findings: Record<string, string> = {};
console.error(`spike: cwd=${tmp}\nspike: ${claudeBin} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

const child = spawn(claudeBin, args, { cwd: tmp, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_FLEET_DEV: process.env.PI_FLEET_DEV ?? "1" } });
child.stderr.on("data", (d: Buffer) => log.write(`[stderr] ${d.toString()}`));
const write = (msg: unknown): void => {
  const line = serialize(msg);
  log.write(`> ${line}`);
  child.stdin.write(line);
};

type Waiter = { pred: (m: ClaudeStreamMessage) => boolean; resolve: (m: ClaudeStreamMessage | null) => void; timer: NodeJS.Timeout };
const waiters: Waiter[] = [];
const seen: ClaudeStreamMessage[] = [];
let rest = "";
child.stdout.on("data", (chunk: Buffer) => {
  const framed = splitJsonLines(chunk.toString(), rest);
  rest = framed.rest;
  for (const line of framed.lines) {
    log.write(`< ${line}\n`);
    const msg = parseClaudeLine(line);
    if (!msg) continue;
    seen.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  }
});
child.on("exit", (code, signal) => {
  log.write(`[exit] code=${code} signal=${signal}\n`);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve(null);
  }
});

function waitFor(pred: (m: ClaudeStreamMessage) => boolean, timeoutMs: number, includePast = false): Promise<ClaudeStreamMessage | null> {
  if (includePast) {
    const past = seen.find(pred);
    if (past) return Promise.resolve(past);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.splice(waiters.findIndex((w) => w.resolve === resolve), 1);
      resolve(null);
    }, timeoutMs);
    waiters.push({ pred, resolve, timer });
  });
}

const isResultMsg = (m: ClaudeStreamMessage): boolean => isResult(m);
const canUse = (tool?: string) => (m: ClaudeStreamMessage): boolean =>
  isCanUseTool(m) && (tool === undefined || m.request.tool_name === tool);

/** Ask for a Bash command; resolve with the permission request or the turn result, whichever comes first. */
async function askBash(cmd: string, allowAlways: boolean): Promise<{ prompted: boolean; assistant: string }> {
  write(userMessage(`Run the shell command \`${cmd}\` with the Bash tool, then reply with its output only.`));
  const first = await waitFor((m) => canUse("Bash")(m) || isResultMsg(m), 90_000);
  if (first && isCanUseTool(first)) {
    const req = first.request as CanUseToolRequest;
    write(allowResponse(first.request_id, req.input, allowAlways ? req.permission_suggestions : undefined));
    const result = await waitFor(isResultMsg, 90_000);
    const text = seen.filter(isAssistant).map(textOfAssistant).join("\n");
    return { prompted: true, assistant: result ? text : "(no result)" };
  }
  return { prompted: false, assistant: seen.filter(isAssistant).map(textOfAssistant).join("\n") };
}

async function main(): Promise<void> {
  const init = await waitFor(isSystemInit, 60_000);
  if (!init || !isSystemInit(init)) {
    findings.F5 = "FAIL: no system/init within 60s (see spike.log)";
    return;
  }
  const fleetServer = init.mcp_servers?.find((s) => s.name === "fleet");
  findings.F5 = `init ok: version=${init.claude_code_version} model=${init.model} mcp fleet=${fleetServer?.status ?? "absent"} caps=${(init.capabilities ?? []).join(",")}`;

  // F1: does a Bash permission prompt arrive with no initialize handshake?
  const a = await askBash("echo spike-1", true);
  findings.F1 = a.prompted ? "YES: can_use_tool arrived without initialize" : `NO prompt before result; assistant said: ${a.assistant.slice(0, 200)}`;

  if (!a.prompted) {
    // F2: try again after a bare initialize
    const reqId = newRequestId();
    write(initializeRequest(reqId));
    const resp = await waitFor((m) => m.type === "control_response" && (m as any).response?.request_id === reqId, 10_000);
    const b = await askBash("echo spike-2", true);
    findings.F2 = `${resp ? "initialize acknowledged" : "initialize unanswered"}; ${b.prompted ? "prompt arrived after initialize" : "still no prompt"}`;
    findings.F4 = b.prompted ? "(see F4 second call)" : "n/a";
  } else {
    findings.F2 = "n/a (not needed)";
  }

  // F4: after allow-always with the suggested rules, does the same command prompt again?
  const c = await askBash("echo spike-3", false);
  findings.F4 = c.prompted ? "NOT honored: prompted again after updatedPermissions" : "honored: no second prompt";

  // F3: fleet tool with --allowedTools mcp__fleet__*
  write(userMessage("Call the fleet_status tool with no arguments and reply with its exact text."));
  const f3 = await waitFor((m) => canUse()(m) || isResultMsg(m), 90_000);
  if (f3 && isCanUseTool(f3)) {
    findings.F3 = `NOT suppressed: prompted for ${f3.request.tool_name}`;
    write(allowResponse(f3.request_id, f3.request.input));
    await waitFor(isResultMsg, 60_000);
  } else {
    findings.F3 = f3 ? "suppressed: fleet_status ran without a prompt" : "no result (timeout)";
  }

  // F5b: system prompt file applied?
  write(userMessage("What is the secret word in your system prompt? Reply with the word only."));
  const r5 = await waitFor(isResultMsg, 60_000);
  findings.F5 += r5 && isResult(r5) && /PELICAN/i.test(r5.result ?? "") ? "; prompt file applied (PELICAN)" : "; prompt file NOT visible";

  // F6: inject a user message while a turn is running
  write(userMessage("Run `sleep 4` with the Bash tool, then reply DONE-SLEEP."));
  const p6 = await waitFor(canUse("Bash"), 30_000);
  if (p6 && isCanUseTool(p6)) write(allowResponse(p6.request_id, p6.request.input, p6.request.permission_suggestions));
  await new Promise((r) => setTimeout(r, 500));
  write(userMessage("INJECTED: when you are done, also reply with the word INJECTED-ACK."));
  const r6 = await waitFor(isResultMsg, 90_000);
  const replays = seen.filter(isUser).filter(isReplayedUserMessage).length;
  const r6text = r6 && isResult(r6) ? (r6.result ?? "") : "";
  const r6b = /INJECTED-ACK/.test(r6text) ? null : await waitFor(isResultMsg, 60_000);
  const r6btext = r6b && isResult(r6b) ? (r6b.result ?? "") : "";
  findings.F6 =
    /INJECTED-ACK/.test(r6text)
      ? "consumed in the same turn"
      : /INJECTED-ACK/.test(r6btext)
        ? "consumed as a separate following turn"
        : `not consumed (results: ${JSON.stringify(r6text.slice(0, 80))}, ${JSON.stringify(r6btext.slice(0, 80))}); replays=${replays}`;
}

main()
  .catch((err) => {
    findings.ERROR = String(err);
  })
  .finally(() => {
    child.stdin.end();
    setTimeout(() => child.kill("SIGTERM"), 3000).unref();
    console.log("\n=== spike findings ===");
    for (const [k, v] of Object.entries(findings)) console.log(`${k}: ${v}`);
    console.log(`log: ${logPath}${keep ? "" : " (temp dir kept for inspection)"}`);
    log.end();
  });
