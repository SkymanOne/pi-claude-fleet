import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pExecFile = promisify(execFile);

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_TS = path.join(ROOT, "src", "cli.ts");
export const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
export const FAKE_PI = path.join(ROOT, "tests", "fixtures", "fake-pi.mjs");
export const FAIL_PI = path.join(ROOT, "tests", "fixtures", "fail-pi.mjs");
export const TERMINAL = ["settled", "stopped", "error", "dead", "archived"];

export function fakePiEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PI_FLEET_DEV: "1",
    PI_FLEET_PI_BIN: `${process.execPath} ${FAKE_PI}`,
    FAKE_PI_DELAY_MS: "200",
    ...over,
  };
}

export interface CliResult { code: number; stdout: string; stderr: string }

export async function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await pExecFile(
      process.execPath,
      ["--import", TSX_LOADER, CLI_TS, ...args],
      { env: opts.env ?? fakePiEnv(), cwd: opts.cwd },
    );
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return {
      code: typeof err?.code === "number" ? err.code : 1,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? String(err),
    };
  }
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function initRepo(prefix: string, files: Record<string, string> = { "seed.txt": "seed\n" }): string {
  const root = tmpDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

export function fleetDirOf(root: string): string {
  return path.join(fs.realpathSync(root), ".pi-fleet");
}

export function firstRunId(root: string): string {
  const runs = fs.readdirSync(path.join(fleetDirOf(root), "runs"));
  if (!runs[0]) throw new Error(`no runs under ${root}`);
  return runs[0];
}

export function readState(root: string, runId: string = firstRunId(root)): any {
  return JSON.parse(fs.readFileSync(path.join(fleetDirOf(root), "runs", runId, "state.json"), "utf8"));
}

export async function waitFor<T>(
  fn: () => T | undefined,
  { timeoutMs = 10_000, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try { value = fn(); } catch { value = undefined; }
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
