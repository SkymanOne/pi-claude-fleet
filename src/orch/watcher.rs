//! Run state -> fleet events: the watcher tails every run's state and outbox
//! and turns changes into `<fleet-event>` batches for the orchestrator,
//! keeping its cursors in `fleet.json`. Implemented in the orch step (see
//! the TypeScript `src/fleet/watcher.ts`).

/// Poll the fleet for new fleet events.
pub async fn poll_events(
    _fleet_dir: &std::path::Path,
) -> anyhow::Result<Vec<crate::fleet::event::FleetEvent>> {
    anyhow::bail!("not implemented yet: fleet watcher")
}
