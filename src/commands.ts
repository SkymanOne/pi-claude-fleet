import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRun, sanitizeName, resolveFleetDir, type SpawnOpts } from "./spawn.js";
import { runDirFor } from "./state.js";

export type { SpawnOpts } from "./spawn.js";

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.dirname(SRC_DIR);

/**
 * How to re-invoke this CLI as a detached background process.
 * - Production: compiled `dist/cli.js` (this file sits next to cli.js in dist/).
 * - Tests (PI_FLEET_DEV=1): run src/cli.ts through tsx so tests need no build.
 *   The tsx loader is resolved to an absolute path because a bare `--import
 *   tsx` cannot be resolved when the child's cwd is outside this package —
 *   the detached monitor inherits the orchestrator's cwd.
 */
export function cliSpawnArgs(): string[] {
  if (process.env.PI_FLEET_DEV === "1") {
    const loader = fileURLToPath(import.meta.resolve("tsx"));
    return ["--import", loader, path.join(SRC_DIR, "cli.ts")];
  }
  return [path.join(SRC_DIR, "cli.js")];
}

export async function launchMonitor(args: { piFleetDir: string; runId: string }): Promise<void> {
  const logFd = fs.openSync(path.join(runDirFor(args.piFleetDir, args.runId), "monitor.log"), "a");
  const child = spawn(
    process.execPath,
    [...cliSpawnArgs(), "__monitor", args.piFleetDir, args.runId],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  fs.closeSync(logFd);
}

export async function cmdSpawn(args: { name: string; brief: string; opts: SpawnOpts }): Promise<number> {
  if (!args.brief.trim()) throw new Error('spawn: task brief required after "--"');
  const created = await createRun({ name: sanitizeName(args.name), opts: args.opts, brief: args.brief });
  if (!created.state.isGit && args.opts.worktree !== false) {
    console.error("warning: target is not a git repo — running in place without a worktree");
  }
  await launchMonitor({ piFleetDir: created.piFleetDir, runId: created.runId });
  console.log(`Spawned ${created.runId}`);
  console.log(`  state:    ${created.runDir}/state.json`);
  console.log(`  fleet dir: ${created.piFleetDir}`);
  if (created.worktreePath) console.log(`  worktree: ${created.worktreePath}`);
  if (created.state.branch) console.log(`  branch:   ${created.state.branch}`);
  return 0;
}
