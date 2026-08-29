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
 * The `--mcp-config` document that makes claude spawn `pi-fleet mcp` over stdio.
 * No shell is involved (argv arrays), so paths with spaces need no quoting.
 * Dev/test knobs (tsx loader, fake pi) are passed through so workers spawned
 * from the MCP server behave like ones spawned from the CLI under test.
 */
export function fleetMcpConfig(piFleetDir: string, env: NodeJS.ProcessEnv = process.env): McpConfig {
  const passthrough: Record<string, string> = { PI_FLEET_DIR: piFleetDir };
  for (const key of ["PI_FLEET_DEV", "PI_FLEET_PI_BIN", "PI_FLEET_ASK_POLL_MS", "PI_FLEET_ASK_TIMEOUT_MS"]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) passthrough[key] = value;
  }
  return {
    mcpServers: {
      fleet: {
        type: "stdio",
        command: process.execPath,
        args: [...cliSpawnArgs(), "mcp"],
        env: passthrough,
        timeout: FLEET_MCP_TIMEOUT_MS,
      },
    },
  };
}

/** The `mcp__<server>__<tool>` names claude gives the fleet tools; used for allowlists. */
export const FLEET_MCP_SERVER_NAME = "fleet";
export const FLEET_TOOLS_ALLOW_PATTERN = `mcp__${FLEET_MCP_SERVER_NAME}__*`;
