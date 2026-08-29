import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { resolveFleetDir } from "../spawn.js";
import { BIN_NAME } from "../paths.js";
import { OrchestratorClient } from "../orchestrator/client.js";
import { orchestratorPaths } from "../orchestrator/records.js";
import { renderOrchestratorPrompt, DEFAULT_MAX_WORKERS } from "../orchestrator/prompt.js";
import { loadSession, newSession, saveSession, type OrchestratorSession } from "../orchestrator/session.js";
import { checkClaudeVersion } from "../orchestrator/health.js";
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
  const saved = args.fresh ? null : previous;
  const session: OrchestratorSession = saved ?? newSession(targetDir);
  session.claudeVersion = version.version;

  // The prompt is read by the monitor's claude child, so it lives beside it.
  const paths = orchestratorPaths(piFleetDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(
    paths.prompt,
    renderOrchestratorPrompt({
      fleetDir: piFleetDir,
      repoRoot: repoRoot ?? targetDir,
      maxWorkers: args.maxWorkers ?? DEFAULT_MAX_WORKERS,
    }),
  );

  const client = new OrchestratorClient({
    piFleetDir,
    cwd: targetDir,
    model: args.model,
    budget: args.budget,
    fresh: args.fresh,
  });
  const watcher = new FleetWatcher({
    piFleetDir,
    cursors: (session.watcher.cursors as Cursors) ?? {},
    progressEvents: args.progressEvents,
  });

  let cursors: Cursors = watcher.getCursors();
  watcher.on("cursors", (c) => {
    cursors = c;
  });
  client.on("state", (state) => {
    if (!state.sessionId || state.sessionId === session.sessionId) return;
    session.sessionId = state.sessionId;
    session.model = state.model;
    session.claudeVersion = state.claudeVersion;
    void saveSession(piFleetDir, { ...session, watcher: { cursors } });
  });

  // Attaching to a live orchestrator means the fleet is mid-flight; tell it what is running.
  const { attached } = client.start();
  watcher.start({ snapshot: attached });
  if (attached) console.error("note: attaching to the orchestrator that is already running here");

  const app = render(<App client={client} watcher={watcher} cwd={repoRoot ?? targetDir} onQuit={() => app.unmount()} />, {
    exitOnCtrlC: true,
  });

  try {
    await app.waitUntilExit();
  } finally {
    watcher.stop();
    client.stop();
    await saveSession(piFleetDir, { ...session, watcher: { cursors } });
    releaseLock();
  }
  console.log(
    `The orchestrator and its workers keep running. \`${BIN_NAME}\` reopens this console where you left it; ` +
      `\`${BIN_NAME} status\` lists the workers. \`/shutdown\` inside the console stops everything.`,
  );
  return 0;
}
