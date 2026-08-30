//! Orchestrator transcript records: claude's messages, coalesced token
//! deltas, activity and permission records in `orchestrator/events.jsonl`.
//! Implemented in the orch step (see the TypeScript
//! `src/orchestrator/records.ts`).

/// Append one transcript record, coalescing token deltas.
pub fn append_record(
    _events_path: &std::path::Path,
    _record: &serde_json::Value,
) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: orchestrator records")
}
