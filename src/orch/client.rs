//! The console-side orchestrator client: attaches to the live monitor's
//! files, or resumes the saved claude session when the monitor is gone, and
//! replays the transcript. Implemented in the orch step (see the TypeScript
//! `src/orchestrator/client.ts`).

/// Attach to the orchestrator for the console.
pub async fn attach(_fleet_dir: &std::path::Path) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: orchestrator client")
}
