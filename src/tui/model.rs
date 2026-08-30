//! The view model: everything the console shows, kept separate from how it
//! is drawn. Implemented in the tui-model step (see the TypeScript
//! `src/tui/model.ts`).

/// One session row on the rail (the orchestrator or a worker).
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub name: String,
    /// What the session is doing — derived, never stored.
    pub status: String,
    pub age_ms: i64,
}

/// Build the rail rows from the fleet's current state.
pub fn rail_rows(_fleet_dir: &std::path::Path) -> anyhow::Result<Vec<SessionRow>> {
    anyhow::bail!("not implemented yet: tui view model")
}
