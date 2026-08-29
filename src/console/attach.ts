import path from "node:path";
import { resolveFleetDir } from "../spawn.js";
import { findRun } from "../state.js";
import { BIN_NAME } from "../paths.js";
import { ok, type CommandResult } from "../commands.js";
import { replay } from "./transcript.js";

/** The last `n` transcript lines of a run, as the CLI prints them. */
export function tailLines(runDir: string, n: number): string[] {
  const { transcript } = replay(path.join(runDir, "events.jsonl"), n);
  return transcript.lines.map((line) => line.text);
}

export interface AttachArgs {
  name: string;
  cwd?: string;
  tail?: string;
}

/**
 * A static tail of one worker's transcript. Live viewing and steering moved to
 * the `pi-fleet` console, which shows every worker and the orchestrator at once.
 */
export async function attachCore(args: AttachArgs): Promise<CommandResult<{ lines: string[] }>> {
  const { piFleetDir } = await resolveFleetDir(args.cwd);
  const run = findRun(piFleetDir, args.name);
  const n = Number(args.tail) > 0 ? Number(args.tail) : 40;
  const lines = tailLines(run.runDir, n);
  if (lines.length === 0) return ok({ lines }, ["(no events captured yet)"]);
  return ok({ lines }, lines, [`(static tail — run \`${BIN_NAME}\` for the live console)`]);
}
