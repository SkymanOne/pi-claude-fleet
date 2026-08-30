//! Spawning a worker: validate the brief and model, create the worktree,
//! write `run.json`, boot the detached monitor. Implemented in the ops step
//! (see the TypeScript `src/spawn.ts` and `src/commands.ts`).

/// Everything `spawn` needs to know; constructed verbatim by `main.rs` from
/// the parsed CLI, so the field set is a frozen contract.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub name: String,
    pub brief: String,
    pub cwd: Option<std::path::PathBuf>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub thinking: Option<String>,
    /// `false` for `--no-worktree`: run in place, read-only tasks.
    pub worktree: bool,
    pub base: Option<String>,
    pub skill: Option<String>,
    pub append_system_prompt: Option<String>,
    pub session: Option<String>,
    pub tools: Option<String>,
    pub exclude_tools: Option<String>,
}

/// Spawn one worker.
pub async fn spawn_run(_request: SpawnRequest) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: spawn")
}
