//! Orchestrator health: whether a monitor is alive, when to reap it, and
//! what an exit code means. Implemented in the orch step (see the TypeScript
//! `src/orchestrator/health.ts`).

/// Classify an orchestrator monitor exit.
pub fn classify_exit(_code: Option<i32>) -> anyhow::Result<&'static str> {
    anyhow::bail!("not implemented yet: orchestrator health")
}
