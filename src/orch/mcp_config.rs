//! The `.mcp.json` handed to claude: one stdio MCP server named `fleet`,
//! running this binary — the tools stay `mcp__fleet__*`. Implemented in the
//! orch step (see the TypeScript `src/orchestrator/mcpConfig.ts`).

/// The MCP server config claude should spawn for the fleet tools.
pub fn fleet_mcp_config(
    _binary: &std::path::Path,
    _fleet_dir: &std::path::Path,
) -> anyhow::Result<serde_json::Value> {
    anyhow::bail!("not implemented yet: orchestrator mcp config")
}
