import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FLEET_TOOL_NAMES } from "../src/mcp/server.js";
import { CLI_TS, TSX_LOADER, fakePiEnv, tmpDir } from "./helpers.js";

test("`pi-fleet mcp` speaks MCP over stdio with a clean stdout", async () => {
  const root = tmpDir("pf-mcp-stdio-");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(fakePiEnv())) if (typeof v === "string") env[k] = v;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", TSX_LOADER, CLI_TS, "mcp", "--cwd", root],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...FLEET_TOOL_NAMES].sort());
    const status: any = await client.callTool({ name: "fleet_status", arguments: {} });
    assert.equal(status.isError, false);
    assert.equal(status.content[0].text, "(no runs)\nexit: 0");
  } finally {
    await client.close();
  }
}, { timeout: 30_000 });

test("`pi-fleet mcp` derives the target from PI_FLEET_DIR when --cwd is absent", async () => {
  const root = tmpDir("pf-mcp-stdio-env-");
  const env: Record<string, string> = { PI_FLEET_DIR: `${root}/.pi-fleet` };
  for (const [k, v] of Object.entries(fakePiEnv())) if (typeof v === "string") env[k] = v;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", TSX_LOADER, CLI_TS, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const status: any = await client.callTool({ name: "fleet_status", arguments: {} });
    assert.equal(status.content[0].text, "(no runs)\nexit: 0");
  } finally {
    await client.close();
  }
}, { timeout: 30_000 });
