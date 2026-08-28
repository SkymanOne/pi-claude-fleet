import path from "node:path";
import { render } from "ink";
import { resolveFleetDir } from "../spawn.js";
import {
  appendControl,
  deriveStatus,
  findRun,
  listRuns,
  loadStateSync,
  type ControlType,
  type RunRef,
} from "../state.js";
import { AttachView } from "./AttachView.js";
import { OpenMenu, type RunRow } from "./OpenMenu.js";
import { readActiveLock, startLockHeartbeat } from "./lock.js";
import { replay } from "./transcript.js";

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function nonArchivedRows(piFleetDir: string): RunRow[] {
  return listRuns(piFleetDir).flatMap(({ runId, runDir }) => {
    try {
      const state = loadStateSync(runDir);
      return state.status === "archived" ? [] : [{ runId, runDir, state }];
    } catch {
      return [];
    }
  });
}

/** Non-interactive fallback: the last `n` transcript lines on stdout. */
export function printStaticTail(runDir: string, n = 40): void {
  const { transcript } = replay(path.join(runDir, "events.jsonl"), n);
  if (transcript.lines.length === 0) console.log("(no events captured yet)");
  for (const line of transcript.lines) console.log(line.text);
}

export async function attachRun(run: RunRef, opts: { interactive: boolean }): Promise<void> {
  const status = deriveStatus(run.state);
  if (!opts.interactive || status === "dead") {
    if (status === "dead") console.error(`${run.state.name}: monitor is dead — showing the captured tail`);
    printStaticTail(run.runDir);
    return;
  }
  const other = readActiveLock(run.runDir);
  if (other) console.error(`warning: another console (pid ${other.pid}) is attached to ${run.state.name}`);
  const stopHeartbeat = startLockHeartbeat(run.runDir);
  try {
    const app = render(
      <AttachView
        runDir={run.runDir}
        writeControl={(type: ControlType, message: string | null) => {
          void appendControl(run.runDir, { type, message, source: "console" });
        }}
        onQuit={() => app.unmount()}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } finally {
    stopHeartbeat();
  }
}

export async function cmdAttach(args: { name: string; cwd?: string }): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  const run = findRun(piFleetDir, args.name);
  await attachRun(run, { interactive: isInteractiveTerminal() });
  return 0;
}

export async function cmdOpen(args: { cwd?: string }): Promise<number> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  if (!isInteractiveTerminal()) {
    console.error("open: needs an interactive terminal — use `pi-fleet status` or `pi-fleet attach <name>` instead");
    return 1;
  }
  for (;;) {
    const rows = nonArchivedRows(piFleetDir);
    const choice = await new Promise<RunRow | "quit" | "refresh">((resolve) => {
      const app = render(
        <OpenMenu
          runs={rows}
          onSelect={(row) => {
            app.unmount();
            resolve(row);
          }}
          onQuit={() => {
            app.unmount();
            resolve("quit");
          }}
          onRefresh={() => {
            app.unmount();
            resolve("refresh");
          }}
        />,
      );
    });
    if (choice === "quit") return 0;
    if (choice === "refresh") continue;
    await attachRun({ runId: choice.runId, runDir: choice.runDir, state: choice.state }, { interactive: true });
  }
}
