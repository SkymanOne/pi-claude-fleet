//! Integrating a worker's work: diff against its base, merge its branch
//! (exit 5 on conflicts), and cleanup (worktree + branch removal, archive).
//! Implemented in the ops step (see the TypeScript `src/commands.ts`).

/// What the worker changed against its base commit.
pub async fn diff(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _name_only: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: diff")
}

/// Merge the settled worker's branch into the current checkout.
/// Exit 5 on conflicts.
pub async fn merge(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _no_commit: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: merge")
}

/// Remove a run's worktree + branch and archive it (`<name>` or `all`).
pub async fn cleanup(
    _target: &str,
    _cwd: Option<&std::path::Path>,
    _force: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: cleanup")
}
