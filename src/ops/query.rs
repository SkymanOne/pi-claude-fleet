//! Read-only fleet queries: the status table, one run's full state, output
//! and log tails, the final report, waiting for a terminal state, and
//! attaching to a transcript. Implemented in the ops step (see the
//! TypeScript `src/commands.ts` and `src/console/attach.ts`).

/// The fleet table, or one run's full state as JSON.
pub async fn status(
    _name: Option<&str>,
    _cwd: Option<&std::path::Path>,
    _json: bool,
    _all: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: status")
}

/// The worker's last assistant text, or the last `n` tool results.
pub async fn output(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _tail: Option<usize>,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: output")
}

/// Tail the captured raw RPC stream (`pi.log`).
pub async fn logs(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _tail: Option<usize>,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: logs")
}

/// The worker's final report plus the steering log; exit 2 when there is none.
pub async fn report(
    _name: &str,
    _cwd: Option<&std::path::Path>,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: report")
}

/// Block until the run reaches a terminal state.
/// Exit 3 on timeout, 4 when it ends stopped/error/dead.
pub async fn wait(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _timeout_secs: u64,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: wait")
}

/// Print the tail of one worker's transcript (the live console is `parl`).
pub async fn attach(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _tail: Option<usize>,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: attach")
}
