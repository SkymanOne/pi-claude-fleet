//! The stdio MCP server: text-first results (the CLI's stdout/stderr lines
//! plus a trailing `exit: N`), `isError` when the exit code is non-zero, and
//! structured content where a caller benefits. Built on `rmcp` (verified to
//! compile against its server API during the scaffold step). Implemented in
//! the mcp step (see the TypeScript `src/mcp/server.ts`).

/// Serve the fleet tools over stdio until the client disconnects.
pub async fn serve_stdio(_cwd: Option<&std::path::Path>) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: mcp stdio server")
}
