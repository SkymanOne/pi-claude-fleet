//! The fleet as an MCP server: one tool per operation core, served over
//! stdio for the orchestrator. The server name stays `fleet`, so the tools
//! stay `mcp__fleet__*`. stdout is the protocol; the cores' lines are
//! rendered as tool results, never printed.

pub mod server;
