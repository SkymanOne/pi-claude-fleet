//! The console-side orchestrator client: it never owns the `claude` child —
//! a detached monitor does — so quitting the console leaves the session
//! running and reopening it picks the conversation back up. It attaches to a
//! live monitor (or spawns one), tails `events.jsonl`, mirrors `state.json`,
//! and appends commands to `inbox.jsonl`.
//!
//! Ported from the TypeScript `src/orchestrator/client.ts`. Node's
//! EventEmitter becomes a broadcast channel plus a held buffer: records read
//! before anything is listening are held, not dropped, so a console renders
//! after `start()` just like the TypeScript one does.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use anyhow::Context as _;
use tokio::sync::mpsc;

use crate::fleet::run::is_alive;
use crate::orch::monitor::{append_command, load_orchestrator_state};
use crate::orch::records::{
    EventRecord, OrchestratorCommand, OrchestratorEvent, OrchestratorState,
    PermissionDecisionRecord,
};
use crate::orch::session::{self, LaunchOptions, OrchestratorSession};
use crate::paths::FleetPaths;
use crate::util::read_new_lines;

/// How much of an old transcript is carried into a restarted session.
pub const MAX_RESTORED_LINES: usize = 2000;
/// Cap on what is held for a console that has not attached yet.
const MAX_BUFFERED_RECORDS: usize = 5000;

/// Everything a console needs to hear from the monitor.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientEvent {
    /// Anything the monitor recorded: claude's messages and its own records.
    Record(EventRecord),
    State(OrchestratorState),
    /// A pending permission request this console has not shown yet.
    PermissionRequest(crate::orch::protocol::PermissionRequest),
    Exit {
        code: Option<i32>,
        signal: Option<String>,
    },
}

/// What the client needs to attach to (or start) an orchestrator.
#[derive(Debug, Clone)]
pub struct OrchestratorClientOptions {
    pub fleet_dir: PathBuf,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub budget: Option<String>,
    /// Start a new orchestrator session instead of resuming the saved one.
    pub fresh: bool,
    /// Starting permission mode for a monitor this client has to start.
    pub permission_mode: Option<String>,
    /// Remote Control name for a monitor this client has to start; an empty
    /// name means "on, name it yourself". None leaves it off.
    pub remote_control: Option<String>,
    /// How often the monitor's files are re-read (milliseconds).
    pub poll_ms: u64,
    /// The binary the monitor is spawned from; defaults to this executable.
    pub monitor_bin: Option<PathBuf>,
    /// Extra environment for the spawned monitor, on top of ours (tests point
    /// `PARL_CLAUDE_BIN` at a scripted stand-in).
    pub monitor_env: Option<HashMap<String, String>>,
}

impl OrchestratorClientOptions {
    /// Options for a console in `cwd`.
    #[must_use]
    pub const fn new(fleet_dir: PathBuf, cwd: PathBuf) -> Self {
        Self {
            fleet_dir,
            cwd,
            model: None,
            budget: None,
            fresh: false,
            permission_mode: None,
            remote_control: None,
            poll_ms: 200,
            monitor_bin: None,
            monitor_env: None,
        }
    }
}

/// Client-side bookkeeping, behind one mutex (never held across an await).
struct ClientInner {
    offset: u64,
    /// The catch-up read of an existing transcript is history, not news.
    caught_up: bool,
    /// Pending requests this console has already announced.
    announced: HashSet<String>,
    last_state_json: String,
    /// Records read before anything subscribed; a console renders after
    /// start(), so the restored transcript is held, not dropped.
    buffered: Vec<ClientEvent>,
    sender: Option<mpsc::UnboundedSender<ClientEvent>>,
}

impl ClientInner {
    fn send(&mut self, event: ClientEvent) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(event);
        } else {
            self.buffered.push(event);
            while self.buffered.len() > MAX_BUFFERED_RECORDS {
                self.buffered.remove(0);
            }
        }
    }
}

/// The console's handle on the orchestrator.
pub struct OrchestratorClient {
    options: OrchestratorClientOptions,
    inner: Mutex<ClientInner>,
    poll_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl OrchestratorClient {
    /// A client for the fleet rooted at `fleet_dir`.
    #[must_use]
    pub fn new(options: OrchestratorClientOptions) -> Arc<Self> {
        Arc::new(Self {
            options,
            inner: Mutex::new(ClientInner {
                offset: 0,
                caught_up: false,
                announced: HashSet::new(),
                last_state_json: String::new(),
                buffered: Vec::new(),
                sender: None,
            }),
            poll_task: Mutex::new(None),
        })
    }

    fn paths(&self) -> FleetPaths {
        FleetPaths::new(&self.options.fleet_dir)
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, ClientInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Receive events from here on, plus everything held before this call —
    /// the console renders after `start()`, so the restored transcript is
    /// replayed into the first subscriber.
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<ClientEvent> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut inner = self.inner();
        inner.sender = Some(sender.clone());
        let pending = std::mem::take(&mut inner.buffered);
        drop(inner);
        for event in pending {
            let _ = sender.send(event);
        }
        receiver
    }

    /// True when a monitor is alive and owns a claude child.
    #[must_use]
    pub fn running(&self) -> bool {
        let Some(state) = load_orchestrator_state(&self.options.fleet_dir) else {
            return false;
        };
        is_alive(state.pid) && state.exited.is_none()
    }

    /// Attach to the running orchestrator, starting one if there is none.
    ///
    /// A fresh start clears the transcript; otherwise the existing one is
    /// replayed. Returns whether it attached to a live monitor.
    ///
    /// # Errors
    ///
    /// Returns an error when the orchestrator directory cannot be created or
    /// the monitor cannot be spawned.
    pub fn start(self: &Arc<Self>) -> anyhow::Result<bool> {
        let paths = self.paths();
        std::fs::create_dir_all(paths.orchestrator_dir())?;
        let attached = self.running() && !self.options.fresh;
        if !attached {
            if self.options.fresh {
                // only --fresh throws the conversation away; otherwise the
                // transcript is the history, and the monitor resumes the same
                // claude session under it
                let _ = std::fs::remove_file(paths.orchestrator_events());
                let _ = std::fs::remove_file(paths.orchestrator_inbox());
            } else {
                // a control file from a dead monitor would be replayed by the new one
                let _ = std::fs::remove_file(paths.orchestrator_inbox());
                Self::trim_transcript(&paths.orchestrator_events());
            }
            self.spawn_monitor()?;
        }
        self.tick();
        let client = self.clone();
        let poll_ms = self.options.poll_ms;
        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(poll_ms));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                client.tick();
            }
        });
        *self.poll_task() = Some(handle);
        Ok(attached)
    }

    fn poll_task(&self) -> MutexGuard<'_, Option<tokio::task::JoinHandle<()>>> {
        self.poll_task
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Stop the poll loop; the monitor itself keeps running.
    pub fn stop(&self) {
        let task = self.poll_task().take();
        if let Some(task) = task {
            task.abort();
        }
    }

    /// One pass over the monitor's files. Public so tests drive it by hand.
    pub fn tick(&self) {
        let lines = {
            let mut inner = self.inner();
            let (lines, offset) = read_new_lines(&self.paths().orchestrator_events(), inner.offset);
            inner.offset = offset;
            lines
        };
        let mut inner = self.inner();
        for line in lines {
            let Ok(record) = serde_json::from_str::<EventRecord>(&line) else {
                continue;
            };
            // an exit in a restored transcript belongs to the session that
            // ended, and announcing it would close a console over a
            // conversation that is running
            let is_exit = record.kind == "exit";
            inner.send(ClientEvent::Record(record.clone()));
            if is_exit
                && inner.caught_up
                && let Some((code, signal)) = exit_of(&record.decode())
            {
                inner.send(ClientEvent::Exit { code, signal });
            }
        }
        inner.caught_up = true;

        let Some(state) = load_orchestrator_state(&self.options.fleet_dir) else {
            return;
        };
        let json = serde_json::to_string(&state).unwrap_or_default();
        if json != inner.last_state_json {
            inner.last_state_json = json;
            inner.send(ClientEvent::State(state.clone()));
        }
        // a request the monitor is still holding, that this console has not
        // shown yet; with nothing subscribed it stays unannounced, so the one
        // that attaches next is still asked
        for pending in &state.pending_requests {
            if inner.announced.contains(&pending.request_id) {
                continue;
            }
            if inner.sender.is_none() {
                continue;
            }
            inner.announced.insert(pending.request_id.clone());
            inner.send(ClientEvent::PermissionRequest(pending.clone()));
        }
        inner
            .announced
            .retain(|id| state.pending_requests.iter().any(|p| &p.request_id == id));
    }

    /// Ask the monitor to shut the orchestrator down for good.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox (no monitor, or an unwritable fleet directory).
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Stop).await
    }

    /// A user turn for the orchestrator.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn send(&self, text: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::User {
            text: text.to_string(),
        })
        .await
    }

    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn interrupt(&self) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Interrupt).await
    }

    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn set_effort(&self, level: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Effort {
            level: level.to_string(),
        })
        .await
    }

    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn set_permission_mode(&self, mode: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::PermissionMode {
            mode: mode.to_string(),
        })
        .await
    }

    /// Switch the orchestrator's model live; claude validates the name itself
    /// and its error text is surfaced verbatim in the transcript.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn set_model(&self, name: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Model {
            name: name.to_string(),
        })
        .await
    }

    /// Remote Control is a launch flag, so the monitor gives the session a
    /// new claude child with it set. The monitor stays up and the conversation
    /// is resumed, so nothing here restarts and no console sees an exit.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn enable_remote_control(&self, name: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::RemoteControl {
            name: Some(name.to_string()),
        })
        .await
    }

    /// Allow a pending tool call, optionally adopting claude's suggested rules.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn allow(
        &self,
        request_id: &str,
        updated_permissions: Option<Vec<serde_json::Value>>,
    ) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Permission {
            request_id: request_id.to_string(),
            decision: PermissionDecisionRecord::Allow {
                updated_permissions,
            },
        })
        .await
    }

    /// Deny a pending tool call with a reason shown to the model.
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn deny(&self, request_id: &str, message: &str) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Permission {
            request_id: request_id.to_string(),
            decision: PermissionDecisionRecord::Deny {
                message: message.to_string(),
            },
        })
        .await
    }

    /// Answer an AskUserQuestion (answers keyed by question text).
    ///
    /// # Errors
    ///
    /// Returns an error when the command cannot be written to the
    /// orchestrator's inbox.
    pub async fn answer_question(
        &self,
        request_id: &str,
        answers: serde_json::Value,
    ) -> anyhow::Result<()> {
        self.command(&OrchestratorCommand::Permission {
            request_id: request_id.to_string(),
            decision: PermissionDecisionRecord::Answer { answers },
        })
        .await
    }

    async fn command(&self, command: &OrchestratorCommand) -> anyhow::Result<()> {
        append_command(&self.options.fleet_dir, command)
            .context("cannot write to the orchestrator inbox")
    }

    /// Keep the transcript restorable without letting it grow forever.
    fn trim_transcript(events_path: &std::path::Path) {
        let Ok(raw) = std::fs::read_to_string(events_path) else {
            return; // no transcript yet, or unreadable: nothing to trim
        };
        let lines: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
        if lines.len() <= MAX_RESTORED_LINES {
            return;
        }
        let trimmed = format!("{}\n", lines[lines.len() - MAX_RESTORED_LINES..].join("\n"));
        let _ = std::fs::write(events_path, trimmed);
    }

    /// Spawn the detached monitor. Detached, like the TypeScript `detached:
    /// true`: the console leaves, the orchestrator does not.
    fn spawn_monitor(&self) -> anyhow::Result<()> {
        let paths = self.paths();
        std::fs::create_dir_all(paths.orchestrator_dir())?;
        let cwd_string = self.options.cwd.to_string_lossy().into_owned();

        // a restarted monitor keeps the mode the last one was running in
        let previous = load_orchestrator_state(&self.options.fleet_dir);
        let mode = self.options.permission_mode.clone().or_else(|| {
            previous
                .as_ref()
                .map(|s| s.permission_mode.clone())
                .filter(|mode| !mode.is_empty())
        });
        // None leaves it off; Some("") means on with an automatic name
        let remote = self
            .options
            .remote_control
            .clone()
            .or_else(|| previous.as_ref().and_then(|s| s.remote_control.clone()));

        let mut session_record = if self.options.fresh {
            OrchestratorSession::new(&cwd_string)
        } else {
            // a session file the dead monitor left is still the conversation
            session::load(&self.options.fleet_dir)
                .unwrap_or_else(|| OrchestratorSession::new(&cwd_string))
        };
        session_record.cwd = cwd_string;
        session_record.launch = LaunchOptions {
            model: self.options.model.clone(),
            budget_usd: self
                .options
                .budget
                .as_deref()
                .and_then(|budget| budget.trim().parse::<f64>().ok())
                .filter(|usd| *usd > 0.0),
            permission_mode: mode,
            remote_control: remote,
            fresh: Some(self.options.fresh),
        };
        session::save(&self.options.fleet_dir, &mut session_record)?;

        // The monitor outlives the console: its own process group, streams to
        // the orchestrator log. The child is reaped by a background task —
        // Node's unref() reaped for free; here nobody waits on the handle, so
        // an unreaped monitor would linger as a zombie and keep its pid
        // looking alive.
        let binary = match &self.options.monitor_bin {
            Some(binary) => binary.clone(),
            None => std::env::current_exe().context("locate the parl binary for the monitor")?,
        };
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.claude_log())
            .context("cannot open the orchestrator log for the monitor")?;
        let stderr = log
            .try_clone()
            .context("cannot share the log file handle")?;
        let mut command = tokio::process::Command::new(binary);
        command
            .args(["orchestrator-monitor", "--fleet-dir"])
            .arg(&self.options.fleet_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::from(log))
            .stderr(std::process::Stdio::from(stderr));
        if let Some(env) = &self.options.monitor_env {
            command.envs(env);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .context("cannot spawn the orchestrator monitor")?;
        tokio::spawn(async move {
            // reap whenever the monitor exits; the runtime outlives the console
            let _ = child.wait().await;
        });
        Ok(())
    }
}

/// The exit info of a decoded record, when it is one.
fn exit_of(event: &OrchestratorEvent) -> Option<(Option<i32>, Option<String>)> {
    match event {
        OrchestratorEvent::Exit { code, signal } => Some((*code, signal.clone())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::atomic_write_json;
    use serde_json::json;
    use std::fmt::Write as _;

    fn record(kind: &str, text: &str) -> EventRecord {
        EventRecord {
            kind: kind.to_string(),
            body: serde_json::Map::from_iter([("text".to_string(), json!(text))]),
        }
    }

    /// The buffering rule: records read before anything is listening are
    /// held, not dropped — the console renders after start().
    #[test]
    fn records_read_before_anything_subscribes_are_held_then_flushed() {
        let tmp = tempfile::tempdir().unwrap();
        let client = OrchestratorClient::new(OrchestratorClientOptions::new(
            tmp.path().join(".parl"),
            tmp.path().to_path_buf(),
        ));
        let events = client.paths().orchestrator_events();
        std::fs::create_dir_all(events.parent().unwrap()).unwrap();
        for text in ["one", "two"] {
            crate::util::append_json_line(&events, &record("stream_text", text)).unwrap();
        }

        client.tick();
        // records read before anything listened are held, not dropped
        let mut rx = client.subscribe();
        let first = rx.try_recv().unwrap();
        let ClientEvent::Record(first) = &first else {
            unreachable!()
        };
        assert_eq!(first.body["text"], "one");
        // the second held record follows
        let second = rx.try_recv().unwrap();
        let ClientEvent::Record(second) = &second else {
            unreachable!()
        };
        assert_eq!(second.body["text"], "two");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn an_exit_in_a_restored_transcript_is_not_announced() {
        let tmp = tempfile::tempdir().unwrap();
        let fleet = tmp.path().join(".parl");
        std::fs::create_dir_all(fleet.join("orchestrator")).unwrap();
        let events = fleet.join("orchestrator/events.jsonl");
        crate::util::append_json_line(
            &events,
            &crate::orch::records::OrchestratorEvent::Exit {
                code: Some(0),
                signal: None,
            }
            .to_record(),
        )
        .unwrap();

        let client = OrchestratorClient::new(OrchestratorClientOptions::new(
            fleet,
            tmp.path().to_path_buf(),
        ));
        let mut rx = client.subscribe();
        client.tick();
        // the restored record is replayed...
        assert!(rx.try_recv().is_ok());
        // ...but no exit is announced: the session that ended is history
        assert!(matches!(
            rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        // a live exit (after catch-up) is announced
        crate::util::append_json_line(
            &events,
            &crate::orch::records::OrchestratorEvent::Exit {
                code: Some(0),
                signal: None,
            }
            .to_record(),
        )
        .unwrap();
        client.tick();
        // the second exit announces twice over: the record, then the exit
        let announced = std::iter::from_fn(|| rx.try_recv().ok())
            .find(|event| matches!(event, ClientEvent::Exit { .. }))
            .expect("a live exit is announced after catch-up");
        assert_eq!(
            announced,
            ClientEvent::Exit {
                code: Some(0),
                signal: None
            }
        );
    }

    #[test]
    fn pending_requests_are_reannounced_to_a_console_that_attaches_later() {
        let tmp = tempfile::tempdir().unwrap();
        let fleet = tmp.path().join(".parl");
        std::fs::create_dir_all(fleet.join("orchestrator")).unwrap();
        let mut state = crate::orch::records::new_orchestrator_state("/repo");
        state.pending_requests = vec![crate::orch::protocol::PermissionRequest {
            request_id: "req_1".into(),
            request: crate::orch::protocol::CanUseToolRequest::default(),
            received_at: crate::util::now_iso(),
        }];
        crate::util::atomic_write_json(&FleetPaths::new(&fleet).orchestrator_state(), &state)
            .unwrap();

        let client = OrchestratorClient::new(OrchestratorClientOptions::new(
            fleet.clone(),
            tmp.path().to_path_buf(),
        ));
        client.tick(); // nothing subscribed: the request stays unannounced
        let mut rx = client.subscribe();
        client.tick();
        // skip the state mirror; the pending request is announced to this
        // console because it has a listener now
        let announced = std::iter::from_fn(|| rx.try_recv().ok())
            .find_map(|event| match event {
                ClientEvent::PermissionRequest(pending) => Some(pending),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the new console is shown the same question"));
        assert_eq!(announced.request_id, "req_1");
        // answered (removed from state): the announced id is pruned
        state.pending_requests.clear();
        atomic_write_json(&FleetPaths::new(&fleet).orchestrator_state(), &state).unwrap();
        client.tick();
        client.tick();
        // no duplicate announcements for the same request
        let mut more = 0;
        while let Ok(event) = rx.try_recv() {
            if matches!(event, ClientEvent::PermissionRequest(_)) {
                more += 1;
            }
        }
        assert_eq!(more, 0);
    }

    #[test]
    fn the_transcript_is_trimmed_to_the_restorable_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let events_path = tmp.path().join("events.jsonl");
        let mut raw = String::new();
        for i in 0..(MAX_RESTORED_LINES + 10) {
            let _ = writeln!(raw, "{{\"type\":\"stream_text\",\"text\":\"{i}\"}}");
        }
        std::fs::write(&events_path, &raw).unwrap();
        OrchestratorClient::trim_transcript(&events_path);
        let kept = std::fs::read_to_string(&events_path).unwrap();
        let count = kept.split('\n').filter(|l| !l.is_empty()).count();
        assert_eq!(count, MAX_RESTORED_LINES);
        assert!(kept.contains(&format!("\"text\":\"{}\"", MAX_RESTORED_LINES + 9)));
    }
}
