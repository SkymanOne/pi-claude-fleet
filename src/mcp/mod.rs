//! The fleet as an MCP server: one tool per command core, served over stdio
//! for the orchestrator. The server name stays `fleet`, so the tools stay
//! `mcp__fleet__*`. Implemented in the mcp step.

pub mod server;
