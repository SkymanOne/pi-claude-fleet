//! Run state: the durable facts about one worker, plus the status that is
//! *derived* from them (never stored) and name/id resolution.
//!
//! Ported from the TypeScript `src/state.ts`, renamed to live in
//! `runs/<id>/run.json`. Serde is deliberately tolerant: unknown fields are
//! ignored and missing fields fall back to defaults, so a state file written
//! by a newer version cannot crash an older reader.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::FleetPaths;
use crate::util::{atomic_write_json, now_iso, parse_ts_ms, sanitize_name};

/// The durable status stored in `run.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Spawned, its monitor has not reported a live pid yet.
    #[default]
    Starting,
    /// The worker process is alive and working.
    Running,
    /// The worker finished its brief and reported back.
    Settled,
    /// Aborted (by `stop` or a failure to start).
    Stopped,
    /// The worker ended with an error.
    Error,
    /// The monitor is gone without a terminal report.
    Dead,
    /// Cleaned up: worktree and branch removed, row kept for the record.
    Archived,
}

impl RunStatus {
    /// Terminal states: `wait` stops polling once one is reached.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Settled | Self::Stopped | Self::Error | Self::Dead | Self::Archived
        )
    }
}

impl std::fmt::Display for RunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Settled => "settled",
            Self::Stopped => "stopped",
            Self::Error => "error",
            Self::Dead => "dead",
            Self::Archived => "archived",
        };
        f.write_str(name)
    }
}

/// What observers show: the durable status, plus `blocked` for a running
/// worker waiting on a `fleet_ask` answer. Never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DerivedView {
    Starting,
    Running,
    Blocked,
    Settled,
    Stopped,
    Error,
    Dead,
    Archived,
}

impl From<RunStatus> for DerivedView {
    fn from(status: RunStatus) -> Self {
        match status {
            RunStatus::Starting => Self::Starting,
            RunStatus::Running => Self::Running,
            RunStatus::Settled => Self::Settled,
            RunStatus::Stopped => Self::Stopped,
            RunStatus::Error => Self::Error,
            RunStatus::Dead => Self::Dead,
            RunStatus::Archived => Self::Archived,
        }
    }
}

impl std::fmt::Display for DerivedView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Blocked => "blocked",
            Self::Settled => "settled",
            Self::Stopped => "stopped",
            Self::Error => "error",
            Self::Dead => "dead",
            Self::Archived => "archived",
        };
        f.write_str(name)
    }
}

/// One steering note: who sent it, when, and what it said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SteeringEntry {
    pub source: String,
    pub ts: String,
    pub message: String,
}

/// What the worker is doing right now: reasoning, writing, or in a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkerActivity {
    Thinking,
    Text,
    Tool,
}

/// One entry from pi's `get_commands`: an extension command, prompt template
/// or skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerCommand {
    pub name: String,
    pub description: String,
    pub source: String,
}

/// A `fleet_ask` the worker is blocked on until an `answer` lands in its inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingQuestion {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub context: Option<String>,
    pub asked_at: String,
}

/// A pi extension dialog (`extension_ui_request`) awaiting an answer, shaped
/// like [`PendingQuestion`] so the console renders both the same way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingDialog {
    pub id: String,
    /// The dialog method: `select`, `confirm`, `input` or `editor`.
    pub method: String,
    pub question: String,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub context: Option<String>,
    pub asked_at: String,
}

/// A model pi has configured (from `get_available_models`), slimmed to what
/// the console needs to offer and switch models.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerModel {
    pub provider: String,
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// The run's durable facts, stored as `runs/<id>/run.json`.
///
/// Field names stay camelCase on disk to match the JSON the fleet tooling and
/// docs already speak (`activeModel`, `pendingQuestion`, `commands`, …).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunState {
    pub id: String,
    pub name: String,
    pub status: RunStatus,
    pub cwd: String,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    /// Commit the worker branch was cut from (resolved at spawn); `None`
    /// without a worktree.
    #[serde(default)]
    pub base_commit: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub session_arg: Option<String>,
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub append_system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Option<String>,
    #[serde(default)]
    pub exclude_tools: Option<String>,
    #[serde(default)]
    pub task_brief: String,
    pub fleet_dir: String,
    #[serde(default)]
    pub repo_root: Option<String>,
    #[serde(default)]
    pub is_git: bool,
    #[serde(default)]
    pub pid: Option<i32>,
    pub created_at: String,
    #[serde(default)]
    pub settled_at: Option<String>,
    #[serde(default)]
    pub last_tool: Option<String>,
    #[serde(default)]
    pub last_activity: Option<String>,
    #[serde(default)]
    pub last_assistant_text: Option<String>,
    #[serde(default)]
    pub steer_count: u32,
    #[serde(default)]
    pub steering_log: Vec<SteeringEntry>,
    #[serde(default)]
    pub error: Option<String>,
    /// Set while the worker waits in `fleet_ask`; absent in state files
    /// written before this field existed.
    #[serde(default)]
    pub pending_question: Option<PendingQuestion>,
    /// Set while the worker is blocked on a pi extension dialog; rendered
    /// like [`Self::pending_question`].
    #[serde(default)]
    pub pending_dialog: Option<PendingDialog>,
    /// The models pi has configured (its `get_available_models`), for the
    /// console's model switcher.
    #[serde(default)]
    pub available_models: Vec<WorkerModel>,
    /// The model pi actually resolved (from its `get_state`), as opposed to
    /// the `--model` pattern asked for.
    #[serde(default)]
    pub active_model: Option<String>,
    #[serde(default)]
    pub active_provider: Option<String>,
    /// Commands, skills and prompt templates this worker offers
    /// (pi's `get_commands`).
    #[serde(default)]
    pub commands: Vec<WorkerCommand>,
    /// The reasoning level pi is running at, as it reports it.
    #[serde(default)]
    pub thinking_level: Option<String>,
    /// What the worker is doing right now.
    #[serde(default)]
    pub activity: Option<WorkerActivity>,
    /// Last `fleet_progress` message.
    #[serde(default)]
    pub last_progress: Option<String>,
}

impl RunState {
    /// A fresh state for a run that has not booted its monitor yet.
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        fleet_dir: &str,
        run_id: &str,
        name: &str,
        cwd: &str,
        task_brief: &str,
        worktree: Option<String>,
        branch: Option<String>,
        base: Option<String>,
        model: Option<String>,
        provider: Option<String>,
        thinking: Option<String>,
        session_arg: Option<String>,
        skill: Option<String>,
        append_system_prompt: Option<String>,
        tools: Option<String>,
        exclude_tools: Option<String>,
    ) -> Self {
        Self {
            id: run_id.to_string(),
            name: name.to_string(),
            status: RunStatus::Starting,
            cwd: cwd.to_string(),
            worktree,
            branch,
            base,
            base_commit: None,
            model,
            provider,
            thinking,
            session_arg,
            skill,
            append_system_prompt,
            tools,
            exclude_tools,
            task_brief: task_brief.to_string(),
            fleet_dir: fleet_dir.to_string(),
            repo_root: None,
            is_git: false,
            pid: None,
            created_at: now_iso(),
            settled_at: None,
            last_tool: None,
            last_activity: None,
            last_assistant_text: None,
            steer_count: 0,
            steering_log: Vec::new(),
            error: None,
            pending_question: None,
            pending_dialog: None,
            available_models: Vec::new(),
            active_model: None,
            active_provider: None,
            commands: Vec::new(),
            thinking_level: None,
            activity: None,
            last_progress: None,
        }
    }

    /// What to show as the run's model: what pi resolved, else the requested
    /// pattern.
    #[must_use]
    pub fn model_label(&self) -> Option<&str> {
        self.active_model.as_deref().or(self.model.as_deref())
    }
}

/// `runs/<id>/run.json` for one run.
pub fn run_json_path(run_dir: &Path) -> PathBuf {
    run_dir.join("run.json")
}

/// Read a run's `run.json`, tolerating nothing: a missing or corrupted file
/// is an error with a message naming the directory.
pub fn load_state(run_dir: &Path) -> anyhow::Result<RunState> {
    let raw = std::fs::read_to_string(run_json_path(run_dir))
        .map_err(|_| anyhow::anyhow!("No readable run.json in {}", run_dir.display()))?;
    serde_json::from_str(&raw)
        .map_err(|_| anyhow::anyhow!("Corrupted run.json in {}", run_dir.display()))
}

/// Write a run's `run.json` atomically.
pub fn save_state(run_dir: &Path, state: &RunState) -> std::io::Result<()> {
    atomic_write_json(&run_json_path(run_dir), state)
}

/// Is a process with this pid alive? `kill(pid, 0)` semantics: a pid we may
/// signal is alive, and `EPERM` (owned by someone else) counts as alive too.
#[must_use]
pub fn is_alive(pid: Option<i32>) -> bool {
    let Some(pid) = pid else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

/// A freshly spawned run has no pid until its monitor boots; don't call it
/// dead yet.
pub const STARTING_GRACE_MS: i64 = 30_000;

/// The stored status, corrected for reality: a run whose monitor is gone is
/// `dead`, and a run still waiting to boot stays `starting` for
/// [`STARTING_GRACE_MS`] before being called `dead`.
#[must_use]
pub fn derive_status(
    state: &RunState,
    liveness: impl Fn(Option<i32>) -> bool,
    now_ms: i64,
) -> RunStatus {
    if state.status == RunStatus::Starting && state.pid.is_none() {
        let created = parse_ts_ms(&state.created_at).unwrap_or(now_ms);
        return if now_ms - created > STARTING_GRACE_MS {
            RunStatus::Dead
        } else {
            RunStatus::Starting
        };
    }
    if matches!(state.status, RunStatus::Starting | RunStatus::Running) && !liveness(state.pid) {
        return RunStatus::Dead;
    }
    state.status
}

/// [`derive_status`] plus the `blocked` view for a running worker waiting on
/// a `fleet_ask` answer or an extension dialog.
#[must_use]
pub fn derive_view(
    state: &RunState,
    liveness: impl Fn(Option<i32>) -> bool,
    now_ms: i64,
) -> DerivedView {
    let status = derive_status(state, liveness, now_ms);
    if status == RunStatus::Running
        && (state.pending_question.is_some() || state.pending_dialog.is_some())
    {
        return DerivedView::Blocked;
    }
    DerivedView::from(status)
}

/// Note what tool the worker is in and when it last did anything.
pub fn record_tool_activity(state: &mut RunState, tool_name: Option<&str>) {
    if let Some(tool) = tool_name {
        state.last_tool = Some(tool.to_string());
    }
    state.last_activity = Some(now_iso());
}

/// Append a steering note; the log is capped so a chatty console cannot grow
/// `run.json` without bound.
pub fn record_steering(state: &mut RunState, source: &str, ts: &str, message: &str) {
    state.steer_count += 1;
    state.steering_log.push(SteeringEntry {
        source: source.to_string(),
        ts: ts.to_string(),
        message: message.to_string(),
    });
    if state.steering_log.len() > STEERING_LOG_CAP {
        let excess = state.steering_log.len() - STEERING_LOG_CAP;
        state.steering_log.drain(..excess);
    }
}

/// Steering entries kept in `run.json`; older ones are dropped, the count stays.
pub const STEERING_LOG_CAP: usize = 20;

/// pi's reasoning levels, lowest to highest; the last two need a model that
/// supports them.
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// A run located by [`find_run`].
#[derive(Debug, Clone)]
pub struct RunRef {
    pub run_id: String,
    pub run_dir: PathBuf,
    pub state: RunState,
}

/// One entry of [`list_runs`]: a directory under `runs/` with a readable
/// `run.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunSummary {
    pub run_id: String,
    pub run_dir: PathBuf,
}

/// The run directories under `<fleet>/runs`, newest id first. Unreadable or
/// missing `run.json` files are skipped.
#[must_use]
pub fn list_runs(fleet_dir: &Path) -> Vec<RunSummary> {
    let runs_dir = fleet_dir.join("runs");
    let Ok(entries) = std::fs::read_dir(&runs_dir) else {
        return Vec::new();
    };
    let mut out: Vec<RunSummary> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| run_json_path(p).is_file())
        .map(|p| RunSummary {
            run_id: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            run_dir: p,
        })
        .collect();
    out.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    out
}

/// Resolve `<name>` (newest non-archived run of exactly that name) or a full
/// run id. A name matches only `<name>-<14-digit stamp>`, so `api` never
/// resolves to `api-tests-…`.
pub fn find_run(fleet_dir: &Path, name_or_id: &str) -> anyhow::Result<RunRef> {
    let key = sanitize_name(name_or_id.trim());
    let of_name = format!("^{0}-\\d{{14}}$", regex::escape(&key));
    let of_name = regex::Regex::new(&of_name).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut candidates: Vec<RunRef> = Vec::new();
    for r in list_runs(fleet_dir) {
        if r.run_id != key && !of_name.is_match(&r.run_id) {
            continue;
        }
        if let Ok(state) = load_state(&r.run_dir) {
            candidates.push(RunRef {
                run_id: r.run_id,
                run_dir: r.run_dir,
                state,
            });
        }
        // Unreadable run.json: not a usable run.
    }
    let chosen = candidates
        .iter()
        .find(|c| c.state.status != RunStatus::Archived)
        .or_else(|| candidates.first());
    match chosen {
        Some(c) => Ok(c.clone()),
        None => Err(anyhow::anyhow!(
            "No run found matching \"{name_or_id}\" in {}",
            fleet_dir.join("runs").display()
        )),
    }
}

/// Newest pi session file under `<run_dir>/session`, for `--session` resume
/// hints.
#[must_use]
pub fn find_session_file(run_dir: &Path) -> Option<PathBuf> {
    let dir = run_dir.join("session");
    let newest = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((e.path(), modified))
        })
        .max_by_key(|(_, modified)| *modified)?;
    Some(newest.0)
}

/// Copy-pasteable command to continue a finished run's session in a new run.
#[must_use]
pub fn resume_hint(state: &RunState, run_dir: &Path) -> String {
    let session = find_session_file(run_dir)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            run_dir
                .join("session")
                .join("<session-file>")
                .to_string_lossy()
                .into_owned()
        });
    format!(
        "{} spawn {}-2 --session {session} -- \"<new brief>\"",
        crate::paths::BIN_NAME,
        state.name
    )
}

/// The fleet dir a state file points at, re-materialized as [`FleetPaths`].
#[must_use]
pub fn fleet_paths_of(state: &RunState) -> FleetPaths {
    FleetPaths::new(state.fleet_dir.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::run_id_for_at;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    fn fleet_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(ts: &str) -> OffsetDateTime {
        OffsetDateTime::parse(ts, &Rfc3339).unwrap()
    }

    fn base_state(fleet: &Path, run_id: &str) -> RunState {
        RunState::new(
            fleet.to_string_lossy().as_ref(),
            run_id,
            "auth",
            "/tmp/x",
            "b",
            None,
            None,
            Some("HEAD".into()),
            Some("m".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
    }

    fn fixed_now() -> i64 {
        parse_ts_ms("2026-08-28T14:15:30Z").unwrap()
    }

    #[test]
    fn new_state_has_neutral_defaults() {
        let fleet = fleet_dir("parl-run-");
        let s = base_state(&fleet, "auth-20260828141530");
        assert_eq!(s.status, RunStatus::Starting);
        assert_eq!(s.pid, None);
        assert_eq!(s.steer_count, 0);
        assert_eq!(s.worktree, None);
        assert!(s.steering_log.is_empty());
        assert_eq!(s.task_brief, "b");
        assert_eq!(s.model_label(), Some("m"));
        assert_eq!(s.pending_dialog, None);
        assert!(s.available_models.is_empty());
    }

    #[test]
    fn derive_view_blocks_on_pending_dialogs_too() {
        let fleet = fleet_dir("parl-run-");
        let mut s = base_state(&fleet, "auth-20260828141530");
        s.status = RunStatus::Running;
        s.pid = Some(1);
        s.pending_dialog = Some(PendingDialog {
            id: "u-1".into(),
            method: "select".into(),
            question: "Pick one".into(),
            options: Some(vec!["a".into()]),
            context: None,
            asked_at: now_iso(),
        });
        assert_eq!(derive_view(&s, |_| true, fixed_now()), DerivedView::Blocked);
        s.pending_dialog = None;
        assert_eq!(derive_view(&s, |_| true, fixed_now()), DerivedView::Running);
        // A state file written before the field existed still loads.
        let run_dir = fleet.join("runs/auth-20260828141530");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(
            run_json_path(&run_dir),
            r#"{"id":"auth-20260828141530","name":"auth","status":"running","cwd":"/tmp/x","fleetDir":"/f","createdAt":"2026-08-28T14:15:30.000Z","taskBrief":"b"}"#,
        )
        .unwrap();
        let old = load_state(&run_dir).unwrap();
        assert_eq!(old.pending_dialog, None);
        assert!(old.available_models.is_empty());
    }

    #[test]
    fn save_state_is_atomic_and_load_round_trips() {
        let fleet = fleet_dir("parl-run-");
        let run_dir = fleet.join("runs/auth-20260828141530");
        std::fs::create_dir_all(&run_dir).unwrap();
        save_state(&run_dir, &base_state(&fleet, "auth-20260828141530")).unwrap();
        let loaded = load_state(&run_dir).unwrap();
        assert_eq!(loaded.id, "auth-20260828141530");
        let no_tmp: Vec<_> = std::fs::read_dir(&run_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(no_tmp.is_empty(), "{no_tmp:?}");
        assert!(load_state(&run_dir.join("missing")).is_err());
    }

    #[test]
    fn serde_tolerates_unknown_and_missing_fields() {
        let fleet = fleet_dir("parl-run-");
        let run_dir = fleet.join("runs/auth-20260828141530");
        std::fs::create_dir_all(&run_dir).unwrap();
        let path = run_json_path(&run_dir);
        // A newer writer: extra fields, and known fields omitted.
        std::fs::write(
            &path,
            r#"{
                "id": "auth-20260828141530",
                "name": "auth",
                "status": "running",
                "cwd": "/tmp/x",
                "fleetDir": "/tmp/x/.parl",
                "createdAt": "2026-08-28T14:15:30.000Z",
                "taskBrief": "b",
                "someFutureField": {"deep": [1, 2, 3]}
            }"#,
        )
        .unwrap();
        let state = load_state(&run_dir).unwrap();
        assert_eq!(state.status, RunStatus::Running);
        assert_eq!(state.steer_count, 0);
        assert_eq!(state.pending_question, None);
        assert!(!state.is_git);
        assert_eq!(state.commands, Vec::<WorkerCommand>::new());
    }

    #[test]
    fn corrupted_run_json_is_an_error_naming_the_dir() {
        let fleet = fleet_dir("parl-run-");
        let run_dir = fleet.join("runs/auth-20260828141530");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::write(run_json_path(&run_dir), "{oops").unwrap();
        let err = load_state(&run_dir).unwrap_err().to_string();
        assert!(err.contains("Corrupted run.json"), "{err}");
    }

    #[test]
    fn is_alive_matches_kill_zero_semantics() {
        assert!(is_alive(Some(std::process::id() as i32)));
        assert!(!is_alive(None));
        assert!(!is_alive(Some(0)));
        assert!(!is_alive(Some(i32::MAX)));
        assert!(!is_alive(Some(-5)));
    }

    #[test]
    fn derive_status_flags_dead_when_pid_is_gone_mid_run() {
        let fleet = fleet_dir("parl-run-");
        let mut s = base_state(&fleet, "auth-20260828141530");
        s.status = RunStatus::Running;
        s.pid = Some(1);
        assert_eq!(
            derive_status(&s, |pid| pid == Some(1), fixed_now()),
            RunStatus::Running
        );
        assert_eq!(derive_status(&s, |_| false, fixed_now()), RunStatus::Dead);
        s.status = RunStatus::Settled;
        assert_eq!(
            derive_status(&s, |_| false, fixed_now()),
            RunStatus::Settled
        );
    }

    #[test]
    fn derive_status_respects_the_starting_grace_period() {
        let fleet = fleet_dir("parl-run-");
        let s = base_state(&fleet, "auth-20260828141530");
        let created = parse_ts_ms(&s.created_at).unwrap();
        assert_eq!(
            derive_status(&s, |_| false, created + 1000),
            RunStatus::Starting
        );
        assert_eq!(
            derive_status(&s, |_| false, created + STARTING_GRACE_MS + 1),
            RunStatus::Dead
        );
        // A live pid within grace is just starting.
        assert_eq!(
            derive_status(&s, |_| true, created + 1000),
            RunStatus::Starting
        );
    }

    #[test]
    fn derive_view_adds_blocked_for_pending_questions() {
        let fleet = fleet_dir("parl-run-");
        let mut s = base_state(&fleet, "auth-20260828141530");
        s.status = RunStatus::Running;
        s.pid = Some(1);
        assert_eq!(derive_view(&s, |_| true, fixed_now()), DerivedView::Running);
        s.pending_question = Some(PendingQuestion {
            id: "m_1".into(),
            question: "which fixture?".into(),
            options: None,
            context: None,
            asked_at: now_iso(),
        });
        assert_eq!(derive_view(&s, |_| true, fixed_now()), DerivedView::Blocked);
        assert_eq!(derive_view(&s, |_| false, fixed_now()), DerivedView::Dead);
    }

    #[test]
    fn record_steering_caps_the_log_at_twenty() {
        let fleet = fleet_dir("parl-run-");
        let mut s = base_state(&fleet, "auth-20260828141530");
        for i in 0..25 {
            record_steering(&mut s, "console", &format!("t{i}"), &format!("m{i}"));
        }
        assert_eq!(s.steer_count, 25);
        assert_eq!(s.steering_log.len(), 20);
        assert_eq!(s.steering_log.last().unwrap().message, "m24");
        assert_eq!(s.steering_log.first().unwrap().message, "m5");
    }

    #[test]
    fn record_tool_activity_updates_last_tool_and_activity() {
        let fleet = fleet_dir("parl-run-");
        let mut s = base_state(&fleet, "auth-20260828141530");
        record_tool_activity(&mut s, Some("bash"));
        assert_eq!(s.last_tool.as_deref(), Some("bash"));
        assert!(s.last_activity.is_some());
        record_tool_activity(&mut s, None);
        assert_eq!(s.last_tool.as_deref(), Some("bash"));
    }

    fn write_run(fleet: &Path, run_id: &str, name: &str, status: RunStatus) -> RunState {
        let run_dir = fleet.join("runs").join(run_id);
        std::fs::create_dir_all(&run_dir).unwrap();
        let mut s = RunState::new(
            fleet.to_string_lossy().as_ref(),
            run_id,
            name,
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
        s.status = status;
        save_state(&run_dir, &s).unwrap();
        s
    }

    #[test]
    fn list_runs_is_newest_first_and_skips_empty_dirs() {
        let fleet = fleet_dir("parl-run-");
        write_run(&fleet, "auth-20260828141530", "auth", RunStatus::Running);
        write_run(&fleet, "auth-20260828161530", "auth", RunStatus::Running);
        std::fs::create_dir_all(fleet.join("runs/auth-20260828171530")).unwrap();
        let ids: Vec<String> = list_runs(&fleet).into_iter().map(|r| r.run_id).collect();
        assert_eq!(ids, vec!["auth-20260828161530", "auth-20260828141530"]);
        // No runs directory at all reads as empty.
        assert!(list_runs(&fleet_dir("parl-run-empty-")).is_empty());
    }

    #[test]
    fn find_run_prefers_non_archived_and_never_prefix_matches() {
        let fleet = fleet_dir("parl-run-");
        write_run(&fleet, "auth-20260828141530", "auth", RunStatus::Running);
        write_run(
            &fleet,
            "auth-worker-20260828141531",
            "auth-worker",
            RunStatus::Running,
        );
        assert_eq!(
            find_run(&fleet, "auth").unwrap().run_id,
            "auth-20260828141530"
        );
        assert_eq!(
            find_run(&fleet, "auth-worker").unwrap().run_id,
            "auth-worker-20260828141531"
        );
        // Casing is sanitized away.
        assert_eq!(
            find_run(&fleet, "Auth").unwrap().run_id,
            "auth-20260828141530"
        );
        // Full ids work.
        assert_eq!(
            find_run(&fleet, "auth-worker-20260828141531")
                .unwrap()
                .run_id,
            "auth-worker-20260828141531"
        );
        // A prefix of a name resolves to nothing.
        assert!(find_run(&fleet, "auth-work").is_err());
        assert!(find_run(&fleet, "ghost").is_err());
    }

    #[test]
    fn find_run_prefers_the_newest_and_skips_archived() {
        let fleet = fleet_dir("parl-run-");
        write_run(&fleet, "auth-20260828141530", "auth", RunStatus::Running);
        write_run(&fleet, "auth-20260828161530", "auth", RunStatus::Running);
        assert_eq!(
            find_run(&fleet, "auth").unwrap().run_id,
            "auth-20260828161530"
        );
        // Archive the newest; the older one wins again.
        let newest = find_run(&fleet, "auth-20260828161530").unwrap();
        let mut state = newest.state.clone();
        state.status = RunStatus::Archived;
        save_state(&newest.run_dir, &state).unwrap();
        assert_eq!(
            find_run(&fleet, "auth").unwrap().run_id,
            "auth-20260828141530"
        );
        // All archived: still resolvable, explicitly.
        let older = find_run(&fleet, "auth-20260828141530").unwrap();
        let mut state = older.state.clone();
        state.status = RunStatus::Archived;
        save_state(&older.run_dir, &state).unwrap();
        assert_eq!(
            find_run(&fleet, "auth").unwrap().run_id,
            "auth-20260828161530"
        );
    }

    #[test]
    fn run_id_stamps_are_14_utc_digits() {
        let id = run_id_for_at("auth", at("2026-08-28T14:15:30Z"));
        assert_eq!(id, "auth-20260828141530");
        assert!(regex::Regex::new(r"^\w+-\d{14}$").unwrap().is_match(&id));
    }

    #[test]
    fn resume_hint_names_the_binary_and_session() {
        let fleet = fleet_dir("parl-run-");
        let run_dir = fleet.join("runs/auth-20260828141530");
        std::fs::create_dir_all(run_dir.join("session")).unwrap();
        std::fs::write(run_dir.join("session").join("s1.jsonl"), "{}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(run_dir.join("session").join("s2.jsonl"), "{}\n").unwrap();
        let s = base_state(&fleet, "auth-20260828141530");
        let hint = resume_hint(&s, &run_dir);
        assert!(hint.starts_with("parl spawn auth-2 --session "), "{hint}");
        assert!(hint.contains("s2.jsonl"), "{hint}");
        // Without session files, a placeholder stands in.
        let hint2 = resume_hint(&s, &fleet.join("runs/none-20260828141530"));
        assert!(hint2.contains("session/<session-file>"), "{hint2}");
    }
}
