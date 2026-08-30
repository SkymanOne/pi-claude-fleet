//! The claude child process: spawn with stream-json over stdio, write user
//! and control messages (including `set_model`, which switches the running
//! session with no restart), read the stream. Implemented in the orch step
//! (see the TypeScript `src/orchestrator/process.ts`).

/// Spawn one claude child in the given working directory.
pub async fn spawn_claude(_cwd: &std::path::Path, _args: &[String]) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: claude child process")
}
