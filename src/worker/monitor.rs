//! The detached worker monitor: owns the `pi --mode rpc` child, keeps
//! `runs/<id>/run.json` current, tails the RPC stream into `events.jsonl`,
//! acts on `inbox.jsonl` envelopes, and writes the worker's outbox. A pi
//! extension dialog (`extension_ui_request`) is treated like a `fleet_ask`
//! pending question: the console can answer it, and a `cancelled: true` is
//! sent shortly before pi's own timeout so the worker never hangs.
//! Implemented in the worker step (see the TypeScript `src/monitor.ts`).

/// Run the monitor for one run until the worker process exits.
pub async fn run_monitor(
    _fleet_dir: &std::path::Path,
    _run_id: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: worker monitor")
}
