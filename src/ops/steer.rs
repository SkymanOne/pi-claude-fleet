//! Steering a running worker: send, follow-up, answer a pending question,
//! abort. Every action is an envelope appended to the run's `inbox.jsonl`,
//! with the steering log noted in `run.json`. Implemented in the ops step
//! (see the TypeScript `src/commands.ts`).

/// Steer a running worker (delivered after its current tool calls).
pub async fn send(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: send")
}

/// Queue a message for after the worker finishes its current work.
pub async fn followup(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: followup")
}

/// Answer the worker's pending `fleet_ask` question.
pub async fn answer(
    _name: &str,
    _cwd: Option<&std::path::Path>,
    _question_id: Option<&str>,
    _message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: answer")
}

/// Abort a running worker (state becomes stopped).
pub async fn stop(
    _name: &str,
    _cwd: Option<&std::path::Path>,
) -> anyhow::Result<crate::cli::ExitCode> {
    anyhow::bail!("not implemented yet: stop")
}
