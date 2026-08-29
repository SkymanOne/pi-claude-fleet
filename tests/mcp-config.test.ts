import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetMcpConfig, FLEET_MCP_TIMEOUT_MS, FLEET_TOOLS_ALLOW_PATTERN } from "../src/orchestrator/mcpConfig.js";

test("fleetMcpConfig points claude at `pi-fleet mcp` with the fleet dir and dev knobs", () => {
  const cfg = fleetMcpConfig("/repo/.pi-fleet", { PI_FLEET_DEV: "1", PI_FLEET_PI_BIN: "node fake.mjs", HOME: "/h" });
  const fleet = cfg.mcpServers.fleet;
  assert.equal(fleet.type, "stdio");
  assert.equal(fleet.command, process.execPath);
  assert.equal(fleet.args.at(-1), "mcp");
  assert.ok(fleet.args.some((a) => /cli\.(ts|js)$/.test(a)), "runs the CLI entry");
  assert.deepEqual(fleet.env, { PI_FLEET_DIR: "/repo/.pi-fleet", PI_FLEET_DEV: "1", PI_FLEET_PI_BIN: "node fake.mjs" });
  assert.equal(fleet.timeout, FLEET_MCP_TIMEOUT_MS);
  assert.equal(FLEET_TOOLS_ALLOW_PATTERN, "mcp__fleet__*");
  const bare = fleetMcpConfig("/repo/.pi-fleet", {});
  assert.deepEqual(bare.mcpServers.fleet.env, { PI_FLEET_DIR: "/repo/.pi-fleet" });
  JSON.parse(JSON.stringify(cfg));
});
