import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetMcpConfig, FLEET_MCP_TIMEOUT_MS, FLEET_TOOLS_ALLOW_PATTERN } from "../src/orchestrator/mcpConfig.js";

test("fleetMcpConfig points claude at `pi-fleet mcp` with the fleet dir, git's basics, and dev knobs", () => {
  const cfg = fleetMcpConfig("/repo/.pi-fleet", { PI_FLEET_DEV: "1", PI_FLEET_PI_BIN: "node fake.mjs", HOME: "/h", PATH: "/bin", ANTHROPIC_API_KEY: "secret" });
  const fleet = cfg.mcpServers.fleet;
  assert.equal(fleet.type, "stdio");
  assert.equal(fleet.command, process.execPath);
  assert.equal(fleet.args.at(-1), "mcp");
  assert.ok(fleet.args.some((a) => /cli\.ts$/.test(a)), "dev env selects the tsx entry");
  assert.deepEqual(fleet.env, {
    PI_FLEET_DIR: "/repo/.pi-fleet",
    PATH: "/bin",
    HOME: "/h",
    PI_FLEET_DEV: "1",
    PI_FLEET_PI_BIN: "node fake.mjs",
  });
  assert.equal("ANTHROPIC_API_KEY" in fleet.env, false, "no secrets on claude's command line");
  assert.equal(fleet.timeout, FLEET_MCP_TIMEOUT_MS);
  assert.equal(FLEET_TOOLS_ALLOW_PATTERN, "mcp__fleet__*");

  const prod = fleetMcpConfig("/repo/.pi-fleet", { PATH: "/bin" });
  assert.deepEqual(prod.mcpServers.fleet.env, { PI_FLEET_DIR: "/repo/.pi-fleet", PATH: "/bin" });
  assert.ok(prod.mcpServers.fleet.args.some((a) => /cli\.js$/.test(a)), "without the dev env it runs the built entry");
  JSON.parse(JSON.stringify(cfg));
});
