/**
 * Startup checks for the orchestrator child: is the `claude` we are about to
 * drive a version this app was tested against, and is there an orphaned one
 * left over from a console that crashed?
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { isAlive } from "../state.js";
import { claudeCommand } from "./args.js";

const pExecFile = promisify(execFile);

/** Claude Code versions whose stream-json protocol this app was verified against. */
export const TESTED_CLAUDE_RANGE = { min: [2, 1], max: [2, 2] } as const;

export interface VersionCheck {
  version: string | null;
  supported: boolean;
  warning: string | null;
}

export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? m[0] : null;
}

export function versionSupported(version: string | null): boolean {
  if (!version) return false;
  const [major, minor] = version.split(".").map(Number);
  const [minMajor, minMinor] = TESTED_CLAUDE_RANGE.min;
  const [maxMajor, maxMinor] = TESTED_CLAUDE_RANGE.max;
  if (major < minMajor || (major === minMajor && minor < minMinor)) return false;
  return major < maxMajor || (major === maxMajor && minor < maxMinor);
}

/** Never fatal: an unknown version still runs, it just says so. */
export async function checkClaudeVersion(env: NodeJS.ProcessEnv = process.env): Promise<VersionCheck> {
  const { bin, prefix } = claudeCommand(env);
  let output: string;
  try {
    const r = await pExecFile(bin, [...prefix, "--version"], { env, timeout: 15_000 });
    output = `${r.stdout}${r.stderr}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { version: null, supported: false, warning: `could not run \`${bin} --version\` (${message}) — is Claude Code installed and on your PATH?` };
  }
  const version = parseClaudeVersion(output);
  if (!version) return { version: null, supported: false, warning: `could not read a version from \`${bin} --version\` — continuing anyway` };
  if (versionSupported(version)) return { version, supported: true, warning: null };
  const { min, max } = TESTED_CLAUDE_RANGE;
  return {
    version,
    supported: false,
    warning: `Claude Code ${version} is outside the tested range (${min.join(".")}.x up to but not including ${max.join(".")}) — the stream-json protocol may have changed`,
  };
}

/** The process's command line, or null when it cannot be read (missing, or not POSIX). */
export function commandLineOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

export interface ReapResult {
  reaped: boolean;
  reason: string | null;
}

/**
 * Kill an orchestrator left behind by a console that died. Only a live pid whose
 * command line still looks like the claude child is touched: pids get reused, and
 * killing the wrong process would be far worse than leaving one behind.
 */
export function reapOrphanOrchestrator(pid: number | null | undefined, matcher = "claude"): ReapResult {
  if (!isAlive(pid)) return { reaped: false, reason: null };
  const command = commandLineOf(pid as number);
  if (!command) return { reaped: false, reason: `pid ${pid} is alive but its command line could not be read — leaving it alone` };
  if (!command.includes(matcher)) return { reaped: false, reason: `pid ${pid} is alive but is not a ${matcher} process — leaving it alone` };
  try {
    process.kill(pid as number, "SIGTERM");
  } catch {
    return { reaped: false, reason: `pid ${pid} could not be signalled` };
  }
  return { reaped: true, reason: `stopped an orphaned orchestrator (pid ${pid}) left by an earlier console` };
}
