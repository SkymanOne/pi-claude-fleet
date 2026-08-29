import { cliSpawnArgs } from "../commands.js";

/** Per-server tool-call timeout: above fleet_wait's 600 s cap so long waits are not cut off. */
export const FLEET_MCP_TIMEOUT_MS = 660_000;

export interface FleetMcpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
}

export interface McpConfig {
  mcpServers: { fleet: FleetMcpServerConfig };
}

/**
 * An MCP stdio server is spawned with exactly the environment given here (the
 * client does not merge the parent's), so the server needs the basics: PATH and
 * HOME for `git`, TMPDIR and the locale for everything else. Deliberately
 * narrow — the config travels on claude's command line, so no secrets go in it.
 */
const BASE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL", "SystemRoot", "APPDATA"];
/** Dev/test knobs, so workers spawned through MCP behave like ones spawned from the CLI under test. */
const FLEET_ENV_KEYS = ["PI_FLEET_DEV", "PI_FLEET_PI_BIN", "PI_FLEET_ASK_POLL_MS", "PI_FLEET_ASK_TIMEOUT_MS"];

/**
 * The `--mcp-config` document that makes claude spawn `pi-fleet mcp` over stdio.
 * No shell is involved (argv arrays), so paths with spaces need no quoting.
 */
export function fleetMcpConfig(piFleetDir: string, env: NodeJS.ProcessEnv = process.env): McpConfig {
  const passthrough: Record<string, string> = { PI_FLEET_DIR: piFleetDir };
  for (const key of [...BASE_ENV_KEYS, ...FLEET_ENV_KEYS]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) passthrough[key] = value;
  }
  return {
    mcpServers: {
      fleet: {
        type: "stdio",
        command: process.execPath,
        // the dev/tsx decision must follow the env we hand the child, not ours
        args: [...cliSpawnArgs(env), "mcp"],
        env: passthrough,
        timeout: FLEET_MCP_TIMEOUT_MS,
      },
    },
  };
}

/** The `mcp__<server>__<tool>` names claude gives the fleet tools; used for allowlists. */
export const FLEET_MCP_SERVER_NAME = "fleet";
export const FLEET_TOOLS_ALLOW_PATTERN = `mcp__${FLEET_MCP_SERVER_NAME}__*`;
