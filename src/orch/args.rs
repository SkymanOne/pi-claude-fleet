//! Building claude's argv: model, permission mode, budget, remote control,
//! the fleet MCP config, stream-json in/out. Implemented in the orch step
//! (see the TypeScript `src/orchestrator/args.ts`).

/// The argv for one orchestrator child process.
pub fn build_claude_args(
    _model: Option<&str>,
    _permission_mode: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    anyhow::bail!("not implemented yet: claude argv builder")
}
