import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { resolveFleetDir } from "../spawn.js";
import { BIN_NAME } from "../paths.js";
import { OrchestratorProcess } from "../orchestrator/process.js";
import { fleetMcpConfig } from "../orchestrator/mcpConfig.js";
import { writeRenderedPrompt, DEFAULT_MAX_WORKERS } from "../orchestrator/prompt.js";
import { loadSession, newSession, saveSession, type OrchestratorSession } from "../orchestrator/session.js";
import { checkClaudeVersion, reapOrphanOrchestrator } from "../orchestrator/health.js";
import { FleetWatcher, type Cursors } from "../fleet/watcher.js";
import { readActiveLock, startLockHeartbeat } from "../console/lock.js";
import { App } from "./App.js";

export const TUI_LOCK = "tui.lock";

export interface TuiArgs {
  cwd?: string;
  model?: string;
  /** Ignore the saved claude session and start a new one. */
  fresh?: boolean;
  budget?: string;
  progressEvents?: boolean;
  maxWorkers?: number;
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function cmdTui(args: TuiArgs): Promise<number> {
  if (!isInteractiveTerminal()) {
    console.error(
      `${BIN_NAME}: the fleet console needs an interactive terminal.\n` +
        `Run it in one, or drive the fleet headlessly: \`${BIN_NAME} spawn <name> -- "<brief>"\`, \`${BIN_NAME} status\`, \`${BIN_NAME} report <name>\`.`,
    );
    return 1;
  }
  const { piFleetDir, repoRoot, targetDir, isGit } = await resolveFleetDir(args.cwd);
  fs.mkdirSync(path.join(piFleetDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(piFleetDir, "reports"), { recursive: true });
  if (!isGit) console.error(`warning: ${targetDir} is not a git repo — workers will run in place without worktrees`);

  const other = readActiveLock(piFleetDir, Date.now(), TUI_LOCK);
  if (other) {
    console.error(`${BIN_NAME}: another console (pid ${other.pid}) is already open on ${piFleetDir}`);
    return 1;
  }
  const releaseLock = startLockHeartbeat(piFleetDir, 5000, TUI_LOCK);

  const version = await checkClaudeVersion();
  if (version.warning) console.error(`warning: ${version.warning}`);

  const previous = loadSession(piFleetDir);
  // A console that crashed leaves its claude child running; the lock above proves
  // no live console owns it, so it is an orphan.
  const reaped = reapOrphanOrchestrator(previous?.pid);
  if (reaped.reason) console.error(`${reaped.reaped ? "note" : "warning"}: ${reaped.reason}`);

  const saved = args.fresh ? null : previous;
  const session: OrchestratorSession = saved ?? newSession(targetDir);
  session.claudeVersion = version.version;
  const promptFile = writeRenderedPrompt(piFleetDir, {
    fleetDir: piFleetDir,
    repoRoot: repoRoot ?? targetDir,
    maxWorkers: args.maxWorkers ?? DEFAULT_MAX_WORKERS,
  });
  const proc = new OrchestratorProcess({
    cwd: targetDir,
    promptFile,
    mcpConfigJson: JSON.stringify(fleetMcpConfig(piFleetDir)),
    model: args.model,
    resumeSessionId: saved?.sessionId ?? null,
    maxBudgetUsd: args.budget ? Number(args.budget) : null,
    logPath: path.join(piFleetDir, "orchestrator.log"),
  });
  const watcher = new FleetWatcher({ piFleetDir, cursors: (session.watcher.cursors as Cursors) ?? {}, progressEvents: args.progressEvents });

  let cursors: Cursors = watcher.getCursors();
  watcher.on("cursors", (c) => {
    cursors = c;
  });
  proc.on("init", (init) => {
    session.sessionId = init.session_id;
    session.pid = proc.pid;
    session.model = init.model ?? session.model;
    session.claudeVersion = init.claude_code_version ?? session.claudeVersion;
    void saveSession(piFleetDir, { ...session, watcher: { cursors } });
  });

  proc.start();
  watcher.start({ snapshot: Boolean(saved?.sessionId) });

  const app = render(<App proc={proc} watcher={watcher} onQuit={() => app.unmount()} />, { exitOnCtrlC: true });

  // The orchestrator must not outlive us, however we go down.
  const killChild = (): void => {
    const pid = proc.pid;
    if (pid && proc.running) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  const onSignal = (signal: NodeJS.Signals) => (): void => {
    killChild();
    releaseLock();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const handlers: [NodeJS.Signals, () => void][] = [
    ["SIGTERM", onSignal("SIGTERM")],
    ["SIGHUP", onSignal("SIGHUP")],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  process.on("exit", killChild);

  try {
    await app.waitUntilExit();
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off("exit", killChild);
    watcher.stop();
    await proc.stop();
    session.pid = null;
    await saveSession(piFleetDir, { ...session, watcher: { cursors } });
    releaseLock();
  }
  console.log(`Workers keep running in the background. \`${BIN_NAME} status\` shows them; \`${BIN_NAME}\` reopens this console.`);
  return 0;
}
