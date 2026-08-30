//! Steering a running worker: send, follow-up, answer a pending question or
//! dialog, abort. Every action appends an envelope to the run's
//! `inbox.jsonl` (builders in `fleet::envelope`); the `from` party is the
//! provenance the fleet watcher reads — console-originated steering becomes
//! an event the orchestrator reconciles with instead of undoing. (Ported
//! from `sendCore`/`followupCore`/`answerCore`/`stopCore` in the TypeScript
//! `src/commands.ts`.)

use std::path::Path;

use serde::Serialize;

use crate::cli::ExitCode;
use crate::fleet::envelope::{Envelope, Party, append_envelope};
use crate::fleet::run::{self, RunRef};
use crate::paths::FleetPaths;
use crate::util::now_ms;

use super::{CommandResult, fail, ok, print_result, resolve_fleet_dir};

/// Locate the fleet dir for `cwd` and the newest non-archived run matching
/// `name` (a name or a full run id). Shared by the whole ops layer.
pub(crate) async fn resolve_run(
    name: &str,
    cwd: Option<&Path>,
) -> anyhow::Result<(FleetPaths, RunRef)> {
    if name.trim().is_empty() {
        anyhow::bail!("<name> required");
    }
    let fleet = resolve_fleet_dir(cwd).await?;
    let target = run::find_run(fleet.paths.root(), name)?;
    Ok((fleet.paths, target))
}

/// What a steering action did, for programmatic callers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlData {
    pub name: String,
    /// The envelope type: `steer`, `follow_up`, `answer` or `abort`.
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
}

/// Which steering action to take; picks the envelope type and the refusal copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteerKind {
    /// `steer` — delivered after the worker's current tool call.
    Send,
    /// `follow_up` — queued until the current work finishes.
    FollowUp,
    /// `answer` — resolve the question or dialog the worker is blocked on.
    Answer,
    /// `abort` — stop the worker.
    Stop,
}

impl SteerKind {
    /// The envelope `type` value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Send => "steer",
            Self::FollowUp => "follow_up",
            Self::Answer => "answer",
            Self::Stop => "abort",
        }
    }

    fn refusal(self) -> &'static str {
        match self {
            Self::Stop => "nothing to stop",
            Self::Answer => "nothing is waiting for an answer",
            Self::Send | Self::FollowUp => "steering refused",
        }
    }
}

/// Steer a running worker (delivered after its current tool calls).
pub async fn send(
    name: &str,
    cwd: Option<&Path>,
    message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(
        send_core(name, cwd, message, Party::Orchestrator).await?,
    ))
}

/// Queue a message for after the worker finishes its current work.
pub async fn followup(
    name: &str,
    cwd: Option<&Path>,
    message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(
        followup_core(name, cwd, message, Party::Orchestrator).await?,
    ))
}

/// Answer the worker's pending `fleet_ask` question or extension dialog.
pub async fn answer(
    name: &str,
    cwd: Option<&Path>,
    question_id: Option<&str>,
    message: &str,
) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(
        answer_core(name, cwd, question_id, message, Party::Orchestrator).await?,
    ))
}

/// Abort a running worker (state becomes stopped).
pub async fn stop(name: &str, cwd: Option<&Path>) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(
        stop_core(name, cwd, Party::Orchestrator).await?,
    ))
}

/// The CLI entry points attribute steering to the orchestrator — the agent
/// driving these tools. The console passes [`Party::Console`] through the
/// `_core` variants so the watcher can tell the two apart.
pub async fn send_core(
    name: &str,
    cwd: Option<&Path>,
    message: &str,
    source: Party,
) -> anyhow::Result<CommandResult<ControlData>> {
    if message.trim().is_empty() {
        anyhow::bail!("send: message required after \"--\"");
    }
    control_core(SteerKind::Send, name, cwd, Some(message), None, source).await
}

/// Queue a message for after the worker finishes its current work.
pub async fn followup_core(
    name: &str,
    cwd: Option<&Path>,
    message: &str,
    source: Party,
) -> anyhow::Result<CommandResult<ControlData>> {
    if message.trim().is_empty() {
        anyhow::bail!("followup: message required after \"--\"");
    }
    control_core(SteerKind::FollowUp, name, cwd, Some(message), None, source).await
}

/// Answer the run's pending question or dialog. An explicit `question_id`
/// wins even when it is not the pending one — the monitor routes by id.
pub async fn answer_core(
    name: &str,
    cwd: Option<&Path>,
    question_id: Option<&str>,
    message: &str,
    source: Party,
) -> anyhow::Result<CommandResult<ControlData>> {
    if message.trim().is_empty() {
        anyhow::bail!("answer: message required after \"--\"");
    }
    control_core(
        SteerKind::Answer,
        name,
        cwd,
        Some(message),
        question_id,
        source,
    )
    .await
}

/// Abort a running worker (state becomes stopped).
pub async fn stop_core(
    name: &str,
    cwd: Option<&Path>,
    source: Party,
) -> anyhow::Result<CommandResult<ControlData>> {
    control_core(SteerKind::Stop, name, cwd, None, None, source).await
}

/// The question id an `answer` targets: the explicit id, else the pending
/// question, else the pending dialog.
fn answer_target_id(state: &run::RunState, question_id: Option<&str>) -> Option<String> {
    question_id
        .map(str::to_string)
        .or_else(|| state.pending_question.as_ref().map(|q| q.id.clone()))
        .or_else(|| state.pending_dialog.as_ref().map(|d| d.id.clone()))
}

/// The shared steering path: refuse terminal runs with the resume hint,
/// target `answer` at the explicit or pending question/dialog id, append the
/// envelope, and report the queueing.
async fn control_core(
    kind: SteerKind,
    name: &str,
    cwd: Option<&Path>,
    message: Option<&str>,
    question_id: Option<&str>,
    source: Party,
) -> anyhow::Result<CommandResult<ControlData>> {
    let (paths, target) = resolve_run(name, cwd).await?;
    let state = &target.state;
    let derived = run::derive_status(state, run::is_alive, now_ms());
    if derived.is_terminal() {
        return Ok(fail(
            ExitCode::Error,
            vec![format!(
                "{}: run {} is {} — {}.\nAnswer its open questions in a new brief and resume with:\n  {}",
                kind.as_str(),
                state.name,
                derived,
                kind.refusal(),
                run::resume_hint(state, &target.run_dir),
            )],
        ));
    }
    let envelope = match kind {
        SteerKind::Answer => {
            let Some(message) = message else {
                anyhow::bail!("answer: message required after \"--\"");
            };
            let Some(id) = answer_target_id(state, question_id) else {
                return Ok(fail(
                    ExitCode::Error,
                    vec![format!(
                        "answer: {} has no pending question — use send to steer it instead.",
                        state.name
                    )],
                ));
            };
            Envelope::answer(source, Party::worker(&target.run_id), message, Some(id))
        }
        SteerKind::Stop => Envelope::abort(source, Party::worker(&target.run_id)),
        SteerKind::Send => {
            let Some(message) = message else {
                anyhow::bail!("send: message required after \"--\"");
            };
            Envelope::steer(source, Party::worker(&target.run_id), message)
        }
        SteerKind::FollowUp => {
            let Some(message) = message else {
                anyhow::bail!("followup: message required after \"--\"");
            };
            Envelope::follow_up(source, Party::worker(&target.run_id), message)
        }
    };
    append_envelope(&paths.run_inbox(&target.run_id), &envelope)?;
    let line = match kind {
        SteerKind::Answer => format!(
            "answer queued for {} (question {})",
            state.name,
            answer_target_id(state, question_id).unwrap_or_default()
        ),
        SteerKind::Stop => format!("abort requested for {}", state.name),
        other => format!("{} queued for {}", other.as_str(), state.name),
    };
    let data = ControlData {
        name: state.name.clone(),
        kind: kind.as_str().to_string(),
        question_id: match kind {
            SteerKind::Answer => Some(
                envelope
                    .payload
                    .get("questionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => None,
        },
    };
    Ok(ok(data, vec![line]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::envelope::Decoded;
    use crate::fleet::run::{PendingDialog, PendingQuestion, RunState, RunStatus};
    use crate::util::new_id;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fleet dir with one run whose state is already on disk. The fleet
    /// dir anchors at `<dir>/.parl`, exactly like a non-git target.
    fn fleet_with_run(
        name: &str,
        status: RunStatus,
        pid: Option<i32>,
    ) -> (PathBuf, FleetPaths, String) {
        let dir = tmp_dir(name);
        let paths = FleetPaths::new(dir.join(crate::paths::STATE_DIR_NAME));
        let run_id = "auth-20260828141530";
        let run_dir = paths.run_dir(run_id);
        std::fs::create_dir_all(&run_dir).unwrap();
        let mut state = RunState::new(
            paths.root().to_string_lossy().as_ref(),
            run_id,
            "auth",
            "/tmp/x",
            "b",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        state.status = status;
        state.pid = pid;
        crate::fleet::run::save_state(&run_dir, &state).unwrap();
        (dir, paths, run_id.to_string())
    }

    fn inbox_lines(paths: &FleetPaths, run_id: &str) -> Vec<Envelope> {
        let raw = std::fs::read_to_string(paths.run_inbox(run_id)).unwrap_or_default();
        raw.trim()
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(Envelope::parse_line)
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn send_appends_a_steer_envelope_and_queues() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        let result = send_core("auth", Some(&_dir), "use tabs", Party::Orchestrator)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Ok);
        assert_eq!(result.out, vec!["steer queued for auth"]);
        let envelopes = inbox_lines(&paths, &run_id);
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].from, Party::Orchestrator);
        assert_eq!(envelopes[0].to, Party::worker(&run_id));
        assert_eq!(envelopes[0].decode(), Some(Decoded::Steer("use tabs")));
        assert_eq!(
            result.data,
            ControlData {
                name: "auth".into(),
                kind: "steer".into(),
                question_id: None,
            }
        );
    }

    #[tokio::test]
    async fn followup_and_stop_append_their_envelope_types() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        followup_core("auth", Some(&_dir), "then fmt", Party::Orchestrator)
            .await
            .unwrap();
        stop_core("auth", Some(&_dir), Party::Console)
            .await
            .unwrap();
        let envelopes = inbox_lines(&paths, &run_id);
        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[0].kind, "follow_up");
        assert_eq!(envelopes[1].kind, "abort", "stop appends an abort envelope");
        // Provenance is threaded honestly.
        assert_eq!(envelopes[0].from, Party::Orchestrator);
        assert_eq!(envelopes[1].from, Party::Console);
        let payload = &envelopes[1].payload;
        assert!(
            payload.as_object().is_some_and(|m| m.is_empty()),
            "abort carries exactly {{}}: {payload}"
        );
    }

    #[tokio::test]
    async fn empty_messages_are_refused_before_touching_the_run() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        for (core, expect) in [
            (
                send_core("auth", Some(&_dir), "  ", Party::Orchestrator).await,
                "send: message",
            ),
            (
                followup_core("auth", Some(&_dir), "", Party::Orchestrator).await,
                "followup: message",
            ),
            (
                answer_core("auth", Some(&_dir), None, "", Party::Orchestrator).await,
                "answer: message",
            ),
        ] {
            let err = core.unwrap_err().to_string();
            assert!(err.contains(expect), "{expect} <- {err}");
        }
        // Nothing was appended.
        assert!(inbox_lines(&paths, &run_id).is_empty());
    }

    #[tokio::test]
    async fn steering_a_terminal_run_refuses_with_the_resume_hint() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Settled, None);
        for core in [
            send_core("auth", Some(&_dir), "m", Party::Orchestrator).await,
            followup_core("auth", Some(&_dir), "m", Party::Orchestrator).await,
        ] {
            let result = core.unwrap();
            assert_eq!(result.code, ExitCode::Error);
            let err = result.err.join("\n");
            assert!(err.contains("is settled — steering refused"), "{err}");
            assert!(
                err.contains("parl spawn auth-2 --session"),
                "carries the copy-pasteable resume command: {err}"
            );
        }
        let stop = stop_core("auth", Some(&_dir), Party::Orchestrator)
            .await
            .unwrap();
        assert_eq!(stop.code, ExitCode::Error);
        assert!(stop.err[0].contains("nothing to stop"), "{}", stop.err[0]);
        let answer = answer_core("auth", Some(&_dir), None, "x", Party::Orchestrator)
            .await
            .unwrap();
        assert!(answer.err[0].contains("nothing is waiting for an answer"));
        // Nothing was written.
        assert!(inbox_lines(&paths, &run_id).is_empty());
    }

    #[tokio::test]
    async fn answer_needs_a_question_dialog_or_explicit_id() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        let refused = answer_core("auth", Some(&_dir), None, "argon2", Party::Orchestrator)
            .await
            .unwrap();
        assert_eq!(refused.code, ExitCode::Error);
        assert!(
            refused.err[0].contains("no pending question — use send"),
            "{}",
            refused.err[0]
        );
        assert!(inbox_lines(&paths, &run_id).is_empty());
    }

    #[tokio::test]
    async fn answer_targets_the_pending_question_by_default() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        let run_dir = paths.run_dir(&run_id);
        let mut state = crate::fleet::run::load_state(&run_dir).unwrap();
        state.pending_question = Some(PendingQuestion {
            id: "m_q1".into(),
            question: "which fixture?".into(),
            options: None,
            context: None,
            asked_at: crate::util::now_iso(),
        });
        crate::fleet::run::save_state(&run_dir, &state).unwrap();

        let result = answer_core("auth", Some(&_dir), None, "argon2", Party::Console)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Ok);
        assert_eq!(result.out, vec!["answer queued for auth (question m_q1)"]);
        assert_eq!(result.data.question_id.as_deref(), Some("m_q1"));
        let envelopes = inbox_lines(&paths, &run_id);
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].from, Party::Console);
        assert_eq!(
            envelopes[0].decode(),
            Some(Decoded::Answer {
                message: Some("argon2"),
                question_id: Some("m_q1")
            })
        );
    }

    #[tokio::test]
    async fn answer_falls_back_to_the_pending_dialog_and_explicit_ids_win() {
        let (_dir, paths, run_id) = fleet_with_run("parl-steer-", RunStatus::Running, Some(1));
        let run_dir = paths.run_dir(&run_id);
        let mut state = crate::fleet::run::load_state(&run_dir).unwrap();
        state.pending_dialog = Some(PendingDialog {
            id: "ui-9".into(),
            method: "confirm".into(),
            question: "overwrite?".into(),
            options: None,
            context: None,
            asked_at: crate::util::now_iso(),
        });
        crate::fleet::run::save_state(&run_dir, &state).unwrap();

        let result = answer_core("auth", Some(&_dir), None, "yes", Party::Orchestrator)
            .await
            .unwrap();
        assert_eq!(result.data.question_id.as_deref(), Some("ui-9"));
        let envelopes = inbox_lines(&paths, &run_id);
        assert_eq!(
            envelopes[0].decode(),
            Some(Decoded::Answer {
                message: Some("yes"),
                question_id: Some("ui-9")
            })
        );

        // An explicit id wins even when it is not the pending one.
        let result = answer_core(
            "auth",
            Some(&_dir),
            Some("q_other"),
            "no",
            Party::Orchestrator,
        )
        .await
        .unwrap();
        assert_eq!(result.data.question_id.as_deref(), Some("q_other"));
        let envelopes = inbox_lines(&paths, &run_id);
        assert_eq!(envelopes.len(), 2);
        assert_eq!(
            envelopes[1].decode(),
            Some(Decoded::Answer {
                message: Some("no"),
                question_id: Some("q_other")
            })
        );
    }

    #[tokio::test]
    async fn unknown_runs_and_empty_names_are_errors() {
        let _dir = tmp_dir("parl-steer-none-");
        let err = send_core("ghost", Some(&_dir), "m", Party::Orchestrator)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("No run found"), "{err}");
        let err = send_core("  ", Some(&_dir), "m", Party::Orchestrator)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(err, "<name> required");
    }
}
