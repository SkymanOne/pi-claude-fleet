//! The detached orchestrator monitor: keeps the `claude` child alive while
//! consoles come and go, appending everything to `orchestrator/events.jsonl`
//! and `state.json`, acting on `orchestrator/inbox.jsonl`. Quitting a console
//! leaves this process running; a `stop` control line is what ends it.
//! Implemented in the orch step (see the TypeScript
//! `src/orchestrator/monitor.ts`).

/// Run the orchestrator monitor for the fleet rooted at `fleet_dir`.
pub async fn run_orchestrator_monitor(
    _fleet_dir: &std::path::Path,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: orchestrator monitor")
}
