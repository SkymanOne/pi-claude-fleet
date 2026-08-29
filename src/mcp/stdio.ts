import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFleetServer } from "./server.js";

/**
 * `pi-fleet mcp`: serve the fleet tools over stdio. stdout carries JSON-RPC only;
 * diagnostics go to stderr. The target directory comes from --cwd, else from
 * PI_FLEET_DIR (its parent), else the process cwd.
 */
export async function runFleetMcp(opts: { cwd?: string } = {}): Promise<number> {
  const fromEnv = process.env.PI_FLEET_DIR ? path.dirname(process.env.PI_FLEET_DIR) : undefined;
  const cwd = path.resolve(opts.cwd ?? fromEnv ?? process.cwd());
  const server = createFleetServer({ cwd });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
  return 0;
}
