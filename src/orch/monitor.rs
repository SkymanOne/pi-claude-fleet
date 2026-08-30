//! The detached owner of the `claude` child. It keeps the orchestrator alive
//! while consoles come and go: everything claude says lands in
//! `events.jsonl` and `state.json`, and anything a console wants done arrives
//! through `inbox.jsonl` envelopes. Quitting a console leaves this process
//! running; a `stop` command line is what ends it.
//!
//! Ported from the TypeScript `src/orchestrator/monitor.ts` onto tokio: the
//! Node EventEmitter handlers become one event-loop task over
//! [`ProcEvent`]s, and the timers become tasks sharing a mutex-guarded
//! [`Shared`]. The same timings are kept: 200 ms state flush, 200 ms inbox
//! poll, 150 ms stream-text flush. State writes are serialised under one
//! mutex — the Rust equivalent of the TypeScript `writeChain` promise, for
//! the same reason: two concurrent atomic writes can land out of order, and
//! an older one winning would drop things a console needs to see — a
//! permission request waiting for an answer, say.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::cli::ExitCode;
use crate::fleet::envelope::Envelope;
use crate::orch::process::{
    ControlOutcome, ExitInfo, OrchestratorOptions, OrchestratorProcess, ProcEvent,
};
use crate::orch::protocol::{PermissionRequest, SystemInitMessage};
use crate::orch::records::{
    self, Activity, ActivityKind, OrchestratorCommand, OrchestratorState, PermissionDecisionRecord,
    Transcript, decode_command, new_orchestrator_state, request_value,
};
use crate::orch::session;
use crate::paths::FleetPaths;
use crate::util::{atomic_write_json, now_iso, read_new_lines};

const FLUSH_MS: u64 = 200;
const CONTROL_POLL_MS: u64 = 200;
/// Token deltas are coalesced into one record per tick, so the file stays small.
const STREAM_FLUSH_MS: u64 = 150;

/// Run the orchestrator monitor for the fleet rooted at `fleet_dir`.
pub async fn run_orchestrator_monitor(fleet_dir: &Path) -> anyhow::Result<ExitCode> {
    let monitor = Monitor::boot(fleet_dir)?;
    monitor.run().await?;
    Ok(ExitCode::Ok)
}

/// Read `orchestrator/state.json`, or none when there is none yet.
#[must_use]
pub fn load_orchestrator_state(fleet_dir: &Path) -> Option<OrchestratorState> {
    let path = FleetPaths::new(fleet_dir).orchestrator_state();
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Append one command to the orchestrator's inbox (the console's side of the
/// mailbox); the monitor picks it up within its poll interval.
pub async fn append_command(
    fleet_dir: &Path,
    command: &OrchestratorCommand,
) -> std::io::Result<()> {
    append_envelope(
        fleet_dir,
        &command.to_envelope(crate::fleet::envelope::Party::Console),
    )
    .await
}

/// Append a pre-built envelope to the orchestrator's inbox.
pub async fn append_envelope(fleet_dir: &Path, envelope: &Envelope) -> std::io::Result<()> {
    let path = FleetPaths::new(fleet_dir).orchestrator_inbox();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::fleet::envelope::append_envelope(&path, envelope)
}

/// The claude child being replaced (Remote Control needs a new flag), noted
/// so the monitor does not mistake a restart for an exit.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Restart {
    /// The Remote Control name for the replacement child; none turns it off.
    remote_control: Option<String>,
}

/// Everything the monitor's tasks mutate, behind one std mutex. Never hold
/// the guard across an await: every mutation and write here is synchronous.
struct Shared {
    state: OrchestratorState,
    record: session::OrchestratorSession,
    transcript: Transcript,
    /// Permission requests still waiting, by request id; `state.json` holds
    /// the sorted view.
    pending: HashMap<String, PermissionRequest>,
    dirty: bool,
    finished: bool,
    /// Set while the child is being replaced rather than shut down.
    restart: Option<Restart>,
    process: Option<Arc<OrchestratorProcess>>,
    /// Byte offset into `inbox.jsonl` already consumed.
    control_offset: u64,
}

/// The monitor for one fleet's orchestrator.
pub struct Monitor {
    fleet_dir: PathBuf,
    cwd: PathBuf,
    /// The prompt document claude reads via --append-system-prompt-file.
    prompt_file: String,
    /// The `--mcp-config` document pointing claude at this binary's MCP server.
    mcp_config_json: String,
    monitor_pid: i32,
    /// The model asked for at launch; claude's own default when none.
    launch_model: Option<String>,
    budget_usd: Option<f64>,
    paths: FleetPaths,
    shared: Mutex<Shared>,
}

impl Monitor {
    /// Load the session record and prepare the state, without a child yet.
    fn boot(fleet_dir: &Path) -> anyhow::Result<Arc<Self>> {
        let paths = FleetPaths::new(fleet_dir);
        std::fs::create_dir_all(paths.orchestrator_dir())?;
        // The console records the repo it opened; without a session record
        // that is the directory holding the fleet.
        let stored = session::load(fleet_dir);
        let cwd_string = stored
            .as_ref()
            .map(|s| s.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or_else(|| {
                fleet_dir
                    .parent()
                    .unwrap_or(fleet_dir)
                    .to_string_lossy()
                    .into_owned()
            });
        let cwd = PathBuf::from(&cwd_string);
        let mut record = stored.unwrap_or_else(|| session::OrchestratorSession::new(&cwd_string));
        if record.launch.fresh.unwrap_or(false) {
            // only --fresh throws the conversation away
            record.session_id = None;
        }
        record.pid = Some(i32::try_from(std::process::id()).unwrap_or(1));

        // The prompt is read by the claude child, so it lives beside it;
        // render the current override (or the embedded template) fresh.
        let prompt_file = crate::orch::prompt::write_prompt(fleet_dir, &cwd)
            .map_err(|e| anyhow::anyhow!("cannot write the orchestrator prompt: {e:#}"))?;
        let mcp_config_json = crate::orch::mcp_config::fleet_mcp_config(
            &crate::orch::mcp_config::parl_binary()?,
            fleet_dir,
        )?
        .to_string();

        let launch = record.launch.clone();
        let mut state = new_orchestrator_state(&cwd_string);
        state.pid = Some(i32::try_from(std::process::id()).unwrap_or(1));
        state.permission_mode = launch
            .permission_mode
            .clone()
            .unwrap_or_else(|| "default".to_string());
        state.remote_control = launch.remote_control.clone();
        let events_path = paths.orchestrator_events();

        let monitor = Arc::new(Self {
            fleet_dir: fleet_dir.to_path_buf(),
            cwd,
            prompt_file: prompt_file.to_string_lossy().into_owned(),
            mcp_config_json,
            monitor_pid: i32::try_from(std::process::id()).unwrap_or(1),
            launch_model: launch.model.clone(),
            budget_usd: launch.budget_usd,
            paths,
            shared: Mutex::new(Shared {
                state,
                record,
                transcript: records::Transcript::new(events_path),
                pending: HashMap::new(),
                dirty: false,
                finished: false,
                restart: None,
                process: None,
                control_offset: 0,
            }),
        });
        // The pid is discoverable the moment the monitor boots, like the
        // TypeScript monitor's writeState() before the child starts.
        monitor.flush_state();
        Ok(monitor)
    }

    /// Lock the shared state even if a previous holder panicked.
    fn shared(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Build a claude child for the current session. After a restart the
    /// resume id is the session the previous child was running; `fresh` (the
    /// one-shot launch flag) drops it instead.
    fn new_process(
        &self,
        remote_control: Option<String>,
        fresh: bool,
    ) -> (
        Arc<OrchestratorProcess>,
        tokio::sync::mpsc::UnboundedReceiver<ProcEvent>,
    ) {
        let (resume_id, permission_mode) = {
            let sh = self.shared();
            (
                if fresh {
                    None
                } else {
                    sh.record.session_id.clone()
                },
                sh.state.permission_mode.clone(),
            )
        };
        let mut options = OrchestratorOptions::new(
            self.cwd.clone(),
            self.prompt_file.clone(),
            self.mcp_config_json.clone(),
        );
        options.log_path = Some(self.paths.claude_log());
        options.args.model = self.launch_model.clone();
        // after a restart this is the session the previous child was running
        options.args.resume_session_id = resume_id;
        options.args.max_budget_usd = self.budget_usd;
        options.args.permission_mode = Some(permission_mode);
        options.args.remote_control = remote_control;
        OrchestratorProcess::new(options)
    }

    /// Build and start the first child, write the boot state and notice.
    fn start_child(
        self: &Arc<Self>,
        fresh: bool,
    ) -> anyhow::Result<tokio::sync::mpsc::UnboundedReceiver<ProcEvent>> {
        let remote = self.shared().record.launch.remote_control.clone();
        let (proc, rx) = self.new_process(remote, fresh);
        {
            let mut sh = self.shared();
            sh.process = Some(proc.clone());
            sh.state.pid = Some(self.monitor_pid);
            sh.dirty = true;
        }
        proc.start();
        self.flush_state();
        let text = {
            let sh = self.shared();
            match (fresh, sh.record.session_id.as_deref()) {
                (true, _) => "· new orchestrator session".to_string(),
                (false, Some(id)) => {
                    let end = id.char_indices().nth(8).map_or(id.len(), |(i, _)| i);
                    format!("· resumed the orchestrator session {}", &id[..end])
                }
                _ => "· orchestrator started".to_string(),
            }
        };
        self.write_notice(text, None);
        Ok(rx)
    }

    /// Run the monitor until the claude child ends for good.
    pub async fn run(self: &Arc<Self>) -> anyhow::Result<()> {
        // `fresh` is a one-shot launch instruction: consume it so a restarted
        // monitor resumes instead of starting over.
        let fresh = { self.shared().record.launch.fresh.take().unwrap_or(false) };
        if fresh {
            self.save_record();
        }
        let mut rx = self.start_child(fresh)?;
        self.spawn_timers();

        while let Some(event) = rx.recv().await {
            match event {
                ProcEvent::Message(msg) => self.on_message(&msg),
                ProcEvent::TextDelta(delta) => self.on_text_delta(&delta),
                ProcEvent::Init(init) => self.on_init(&init),
                ProcEvent::Commands(commands) => {
                    let mut sh = self.shared();
                    sh.state.commands = commands;
                    sh.dirty = true;
                }
                ProcEvent::PermissionRequest(request) => self.on_permission_request(&request),
                ProcEvent::Result(_) => self.on_result(),
                ProcEvent::Stderr(text) => {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        self.write_notice(trimmed.to_string(), Some(true));
                    }
                }
                ProcEvent::Exit(info) => {
                    {
                        let mut sh = self.shared();
                        let _ = sh.transcript.flush_text();
                    }
                    // A flag change, not the end of the session: the same
                    // conversation is resumed in a new child and the console
                    // sees no exit at all.
                    let restart = { self.shared().restart.take() };
                    if let Some(restart) = restart {
                        rx = self.restart_child(restart);
                        continue;
                    }
                    self.record_exit(&info);
                    break;
                }
                // A child we could not even spawn (bad binary, missing cwd):
                // process.rs has already marked the child gone, so record the
                // end instead of waiting on a child that never was.
                ProcEvent::Error(message) => {
                    self.write_notice(message.clone(), Some(true));
                    self.record_exit(&ExitInfo {
                        code: None,
                        signal: None,
                    });
                    break;
                }
                // Stream events, control responses, our own writes and spawn
                // receipts carry nothing the transcript needs beyond the
                // typed events above.
                _ => {}
            }
        }

        // The child is gone for good: clear the pid and save the session.
        {
            let mut sh = self.shared();
            sh.record.pid = None;
        }
        self.save_record();
        self.flush_state();
        Ok(())
    }

    /// Record the final exit in the state and the transcript, and clear the pid.
    fn record_exit(&self, info: &ExitInfo) {
        {
            let mut sh = self.shared();
            let _ = sh.transcript.flush_text();
            sh.finished = true;
            sh.state.exited = Some(records::ExitedRecord {
                code: info.code,
                signal: info.signal.clone(),
                at: now_iso(),
            });
            sh.state.turn_active = false;
            sh.state.activity = None;
            sh.state.pid = None;
            let _ = sh.transcript.write(&records::OrchestratorEvent::Exit {
                code: info.code,
                signal: info.signal.clone(),
            });
            sh.dirty = true;
        }
        self.flush_state();
    }

    fn on_message(&self, msg: &serde_json::Value) {
        // Deltas are coalesced by the text_delta handler instead.
        if crate::orch::protocol::text_delta_of(msg).is_some() {
            return;
        }
        let interesting = crate::orch::protocol::is_system_init(msg)
            || crate::orch::protocol::is_assistant(msg)
            || crate::orch::protocol::is_user(msg)
            || crate::orch::protocol::is_result(msg)
            || (msg.get("type").and_then(serde_json::Value::as_str) == Some("system")
                && msg.get("subtype").and_then(serde_json::Value::as_str) == Some("api_retry"));
        if !interesting {
            return;
        }
        let mut sh = self.shared();
        // Ordering stays sane: pending deltas land before the message.
        let _ = sh
            .transcript
            .write(&records::OrchestratorEvent::Passthrough(msg.clone()));
    }

    fn on_text_delta(&self, delta: &str) {
        let mut sh = self.shared();
        sh.transcript.stream_text(delta);
        sh.state.last_activity = Some(now_iso());
        sh.dirty = true;
    }

    fn on_init(&self, init: &SystemInitMessage) {
        {
            let mut sh = self.shared();
            sh.state.session_id = Some(init.session_id.clone());
            if init.model.is_some() {
                sh.state.model = init.model.clone();
            }
            if init.claude_code_version.is_some() {
                sh.state.claude_version = init.claude_code_version.clone();
            }
            sh.state.capabilities = init.capabilities.clone();
            sh.state.mcp_servers = init.mcp_servers.clone();
            sh.record.session_id = Some(init.session_id.clone());
            sh.record.pid = Some(self.monitor_pid);
            sh.record.model = sh.state.model.clone();
            sh.record.claude_version = sh.state.claude_version.clone();
            sh.dirty = true;
        }
        self.save_record();
        self.flush_state();
    }

    fn on_permission_request(&self, request: &PermissionRequest) {
        let mut sh = self.shared();
        sh.pending
            .insert(request.request_id.clone(), request.clone());
        let event = records::OrchestratorEvent::PermissionRequest {
            request_id: request.request_id.clone(),
            request: request_value(&request.request),
        };
        let _ = sh.transcript.write(&event);
        sh.dirty = true;
        drop(sh);
        self.flush_state();
    }

    fn on_result(&self) {
        let proc = { self.shared().process.clone() };
        let Some(proc) = proc else { return };
        {
            let mut sh = self.shared();
            let _ = sh.transcript.flush_text();
            sh.state.cost_usd = proc.cost_usd();
            sh.state.num_turns = proc.num_turns();
            sh.state.turn_active = false;
            sh.state.activity = None;
            sh.dirty = true;
        }
        self.flush_state();
    }

    fn write_notice(&self, text: String, error: Option<bool>) {
        let mut sh = self.shared();
        let _ = sh
            .transcript
            .write(&records::OrchestratorEvent::Notice { text, error });
    }

    // -- timers -------------------------------------------------------------

    fn spawn_timers(self: &Arc<Self>) {
        self.spawn_flusher();
        self.spawn_stream_flusher();
        self.spawn_inbox_poller();
        self.spawn_signal_handlers();
    }

    /// The periodic flusher: writes state when dirty, so a burst of changes
    /// lands in one atomic write instead of one per delta.
    fn spawn_flusher(self: &Arc<Self>) {
        let owner = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(FLUSH_MS)).await;
                if owner.shared().finished {
                    break;
                }
                if owner.shared().dirty {
                    owner.flush_state();
                }
            }
        });
    }

    /// Coalesce token deltas into one record per tick, and derive activity
    /// here so it survives a reattach.
    fn spawn_stream_flusher(self: &Arc<Self>) {
        let owner = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(STREAM_FLUSH_MS)).await;
                if owner.shared().finished {
                    break;
                }
                let Some(proc) = owner.shared().process.clone() else {
                    continue;
                };
                // What the console shows as "thinking…" is derived here, so it
                // survives a reattach.
                let next = if proc.turn_active() {
                    proc.activity()
                } else {
                    None
                };
                let changed = {
                    let mut sh = owner.shared();
                    let changed = match (&next, &sh.state.activity) {
                        (Some(a), Some(b)) => a.kind != b.kind || a.label != b.label,
                        (None, None) => false,
                        _ => true,
                    };
                    if changed {
                        sh.state.activity = next.clone();
                        let _ = sh
                            .transcript
                            .write(&records::OrchestratorEvent::Activity { activity: next });
                        sh.dirty = true;
                    }
                    sh.state.turn_active = proc.turn_active();
                    sh.dirty
                };
                if changed {
                    owner.flush_state();
                }
                {
                    let mut sh = owner.shared();
                    let _ = sh.transcript.flush_text();
                }
            }
        });
    }

    fn spawn_inbox_poller(self: &Arc<Self>) {
        let owner = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(CONTROL_POLL_MS)).await;
                if owner.shared().finished {
                    break;
                }
                owner.poll_inbox().await;
            }
        });
    }

    fn spawn_signal_handlers(self: &Arc<Self>) {
        use tokio::signal::unix::{SignalKind, signal};
        for kind in [SignalKind::terminate(), SignalKind::interrupt()] {
            let owner = self.clone();
            tokio::spawn(async move {
                let Ok(mut signals) = signal(kind) else {
                    return;
                };
                while signals.recv().await.is_some() {
                    if owner.shared().finished {
                        break;
                    }
                    // never hold the guard across the await
                    let proc = owner.shared().process.clone();
                    if let Some(proc) = proc {
                        proc.stop_now().await;
                    }
                }
            });
        }
    }

    // -- inbox --------------------------------------------------------------

    async fn poll_inbox(&self) {
        let lines = {
            let mut sh = self.shared();
            let (lines, offset) =
                read_new_lines(&self.paths.orchestrator_inbox(), sh.control_offset);
            sh.control_offset = offset;
            lines
        };
        for line in lines {
            let Some(envelope) = Envelope::parse_line(&line) else {
                continue;
            };
            let Some(command) = decode_command(&envelope) else {
                continue;
            };
            self.handle_command(&command).await;
        }
    }

    async fn handle_command(&self, command: &OrchestratorCommand) {
        let Some(proc) = ({ self.shared().process.clone() }) else {
            return;
        };
        match command {
            OrchestratorCommand::User { text } => {
                {
                    let mut sh = self.shared();
                    sh.state.turn_active = true;
                    sh.state.last_activity = Some(now_iso());
                    sh.state.activity = Some(Activity::starting(ActivityKind::Thinking, None));
                    let activity = sh.state.activity.clone();
                    let _ = sh
                        .transcript
                        .write(&records::OrchestratorEvent::Activity { activity });
                    sh.dirty = true;
                }
                self.flush_state();
                proc.send(text);
            }
            OrchestratorCommand::Permission {
                request_id,
                decision,
            } => {
                let Some(pending) = ({
                    let mut sh = self.shared();
                    let index = sh
                        .state
                        .pending_requests
                        .iter()
                        .position(|p| p.request_id == *request_id);
                    index.map(|index| sh.state.pending_requests.remove(index))
                }) else {
                    return;
                };
                match &decision {
                    PermissionDecisionRecord::Allow {
                        updated_permissions,
                    } => {
                        proc.allow(request_id, updated_permissions.as_deref());
                    }
                    PermissionDecisionRecord::Deny { message } => {
                        proc.deny(request_id, message);
                    }
                    PermissionDecisionRecord::Answer { answers } => {
                        proc.answer_question(request_id, answers.clone());
                    }
                }
                {
                    let mut sh = self.shared();
                    let _ = sh
                        .transcript
                        .write(&records::OrchestratorEvent::PermissionResolved {
                            request_id: request_id.clone(),
                            how: decision_how(decision).to_string(),
                        });
                    sh.dirty = true;
                }
                let _ = pending;
                self.flush_state();
            }
            OrchestratorCommand::Interrupt => {
                let _ = proc.interrupt(true).await;
                self.write_notice("· interrupt requested".into(), None);
            }
            OrchestratorCommand::PermissionMode { mode } => {
                let outcome = proc.set_permission_mode(mode).await;
                if outcome.as_ref().and_then(ControlOutcome::success).is_none() {
                    self.write_notice(
                        format!("! claude refused the permission mode {mode}"),
                        Some(true),
                    );
                    return;
                }
                {
                    let mut sh = self.shared();
                    sh.state.permission_mode = mode.clone();
                    sh.record.launch.permission_mode = Some(mode.clone());
                    sh.dirty = true;
                }
                self.save_record();
                self.write_notice(format!("· permission mode → {mode}"), None);
                self.flush_state();
            }
            OrchestratorCommand::Effort { level } => {
                // a settings merge, not a message: the conversation is left alone
                let outcome = proc
                    .apply_flag_settings(serde_json::json!({ "effort": level }))
                    .await;
                if outcome.as_ref().and_then(ControlOutcome::success).is_none() {
                    // older CLIs may not know the setting; fall back to the slash command
                    self.write_notice(
                        "· effort set through /effort (this claude has no settings merge)".into(),
                        None,
                    );
                    proc.send(&format!("/effort {level}"));
                }
                {
                    let mut sh = self.shared();
                    sh.state.effort = Some(level.clone());
                    sh.dirty = true;
                }
                self.flush_state();
            }
            OrchestratorCommand::Model { name } => {
                let outcome = proc.set_model(name).await;
                match outcome {
                    Some(ControlOutcome::Success(_)) => {
                        {
                            let mut sh = self.shared();
                            sh.state.model = Some(name.clone());
                            sh.record.model = Some(name.clone());
                            sh.dirty = true;
                        }
                        self.save_record();
                        self.write_notice(format!("· model → {name}"), None);
                        self.flush_state();
                    }
                    Some(ControlOutcome::Error(text)) => {
                        // claude validates model names itself; its message is
                        // better than anything we would invent. The model is
                        // left unchanged.
                        self.write_notice(text, Some(true));
                    }
                    None => {
                        self.write_notice(
                            "! could not change the model: claude did not answer".into(),
                            Some(true),
                        );
                    }
                }
            }
            OrchestratorCommand::RemoteControl { name } => {
                let current = self.shared().state.remote_control.clone();
                if current == *name {
                    self.write_notice("· Remote Control is already on".into(), None);
                    return;
                }
                self.write_notice("· reconnecting claude with Remote Control…".into(), None);
                {
                    let mut sh = self.shared();
                    sh.restart = Some(Restart {
                        remote_control: name.clone(),
                    });
                }
                // the exit handler brings the session straight back up
                proc.stop().await;
            }
            OrchestratorCommand::Stop => {
                self.write_notice("· shutting down".into(), None);
                self.shared().restart = None;
                proc.stop().await;
            }
        }
    }

    /// Replace the claude child for a flag change: the session is resumed in
    /// place and no console ever sees an exit.
    fn restart_child(&self, restart: Restart) -> mpsc::UnboundedReceiver<ProcEvent> {
        {
            let mut sh = self.shared();
            sh.state.remote_control = restart.remote_control.clone();
            sh.record.launch.remote_control = restart.remote_control.clone();
            sh.state.turn_active = false;
            sh.state.activity = None;
            sh.dirty = true;
        }
        self.save_record();
        let (proc, rx) = self.new_process(restart.remote_control.clone(), false);
        {
            let mut sh = self.shared();
            sh.process = Some(proc.clone());
        }
        proc.start();
        let text = match restart.remote_control.as_deref() {
            None => "· Remote Control is off; the session was resumed without it".to_string(),
            Some("") => "· Remote Control is on; the session was resumed under it".to_string(),
            Some(name) => {
                format!("· Remote Control is on as \"{name}\"; the session was resumed under it")
            }
        };
        self.write_notice(text, None);
        self.flush_state();
        rx
    }

    // -- persistence ----------------------------------------------------------

    /// Write the state file. Flushes are serialised under the one mutex (the
    /// Rust equivalent of the TypeScript `writeChain`), and failures mark the
    /// state dirty again so the periodic flush retries.
    fn flush_state(&self) {
        let mut sh = self.shared();
        sh.dirty = false;
        sh.state.pending_requests = records::sorted_pending(&sh.pending);
        if atomic_write_json(&self.paths.orchestrator_state(), &sh.state).is_err() {
            sh.dirty = true; // the periodic flush will try again
        }
    }

    /// Persist the session record (id, pid, model, launch flags).
    fn save_record(&self) {
        let mut sh = self.shared();
        let _ = session::save(&self.fleet_dir, &mut sh.record);
    }
}

/// How a console answered, as the transcript's `how` field spells it.
fn decision_how(decision: &PermissionDecisionRecord) -> &'static str {
    match decision {
        PermissionDecisionRecord::Allow { .. } => "allow",
        PermissionDecisionRecord::Deny { .. } => "deny",
        PermissionDecisionRecord::Answer { .. } => "answer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_decision_spells_its_how_like_the_transcript_contract() {
        assert_eq!(
            decision_how(&PermissionDecisionRecord::Allow {
                updated_permissions: None,
            }),
            "allow"
        );
        assert_eq!(
            decision_how(&PermissionDecisionRecord::Deny {
                message: "no".into(),
            }),
            "deny"
        );
        assert_eq!(
            decision_how(&PermissionDecisionRecord::Answer {
                answers: serde_json::json!({"q": "a"}),
            }),
            "answer"
        );
    }

    /// Booting a monitor over a session record keeps its cwd, launch flags
    /// and (unless --fresh) the claude session id.
    #[test]
    fn boot_honours_the_saved_session_and_launch_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let fleet = tmp.path().join(".parl");
        std::fs::create_dir_all(&fleet).unwrap();
        let mut record = session::OrchestratorSession::new("/repo");
        record.session_id = Some("sess-boot123".into());
        record.launch = session::LaunchOptions {
            model: Some("fable".into()),
            budget_usd: Some(5.0),
            permission_mode: Some("acceptEdits".into()),
            remote_control: Some("".into()),
            fresh: Some(true),
        };
        session::save(&fleet, &mut record).unwrap();

        let monitor = Monitor::boot(&fleet).unwrap();
        let sh = monitor.shared();
        assert_eq!(sh.record.session_id, None, "--fresh drops the session id");
        assert_eq!(sh.state.permission_mode, "acceptEdits");
        assert_eq!(sh.state.remote_control, Some(String::new()));
        assert_eq!(monitor.launch_model.as_deref(), Some("fable"));
        assert_eq!(monitor.budget_usd, Some(5.0));
        assert_eq!(sh.state.pid, Some(monitor.monitor_pid));
        assert_eq!(sh.state.pending_requests, Vec::new());
        // The boot wrote the durable files a console reads back.
        assert!(fleet.join("orchestrator/prompt.md").is_file());
        assert!(load_orchestrator_state(&fleet).is_some());
    }

    #[test]
    fn boot_without_a_session_record_defaults_the_cwd_to_the_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let fleet = tmp.path().join(".parl");
        std::fs::create_dir_all(&fleet).unwrap();
        let monitor = Monitor::boot(&fleet).unwrap();
        let sh = monitor.shared();
        assert_eq!(sh.state.cwd, tmp.path().to_string_lossy());
        assert_eq!(sh.state.permission_mode, "default");
        assert_eq!(sh.state.remote_control, None);
    }
}
