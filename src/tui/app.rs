//! App state and the update loop for the fleet console: one watcher feeding
//! the view model, one composer, one overlay at a time. Implemented in the
//! tui-model step (see the TypeScript `src/tui/App.tsx`).

/// Everything the console launch flags carry; constructed verbatim by
/// `main.rs`, so the field set is a frozen contract.
#[derive(Debug, Clone)]
pub struct TuiOptions {
    pub cwd: Option<std::path::PathBuf>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub remote_control: Option<String>,
    pub fresh: bool,
    pub budget: Option<String>,
    pub progress_events: bool,
}

/// Run the console until the user quits; workers keep running after.
pub async fn run_app(_options: TuiOptions) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: tui app")
}
