//! Crossterm runtime and terminal setup: raw mode, the alternate screen, the
//! event stream, restore on panic and on every exit path — a console that
//! dies in raw mode leaves the user's shell unusable, so teardown outranks
//! every feature here. Also the single-instance console lock (a second
//! console must not fight the first over the terminal state) and the feed
//! loop that polls `.parl` into the state machine.

use std::collections::HashMap;
use std::io;
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::id as process_id;
use std::time::Duration;

use anyhow::Context;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use futures::StreamExt;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use serde_json::{Value, json};
use tokio::time::MissedTickBehavior;

use crate::cli::ExitCode;
use crate::orch::records::{EventRecord, OrchestratorState};
use crate::paths::FleetPaths;
use crate::tui::app::{Console, Effect, RunEntry};
use crate::tui::completions::list_repo_files;
use crate::tui::theme::Palette;
use crate::tui::view::{self, Feeds};
use crate::util::{now_iso, now_ms, parse_ts_ms, read_new_lines};

// ---------------------------------------------------------------------------
// Terminal install / teardown

/// Is this an interactive terminal? A size query only succeeds on a TTY,
/// which is exactly what raw mode and the alternate screen need.
#[must_use]
pub fn is_interactive() -> bool {
    crossterm::terminal::size().is_ok()
}

/// Install the terminal: raw mode, alternate screen, backend.
///
/// # Errors
/// Raw mode or the screen switch failing — there is nothing to restore yet.
pub fn enter() -> io::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    Terminal::new(CrosstermBackend::new(stdout))
}

/// Undo [`enter`]: leave the alternate screen, drop raw mode, flush. Best
/// effort and idempotent — called from the panic hook and every exit path,
/// and it must never mask the error that brought us here.
pub fn restore() {
    let _ = execute!(io::stdout(), LeaveAlternateScreen);
    let _ = disable_raw_mode();
    use std::io::Write as _;
    let _ = io::stdout().flush();
}

/// Restore the terminal when the process panics anywhere.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
}

// ---------------------------------------------------------------------------
// The single-instance lock (`console.lock`, same shape the TypeScript wrote)

/// A lock older than this is a crashed console, not a live one.
const LOCK_STALE_MS: i64 = 15_000;

/// The console's hold on the fleet: one live console per `.parl`.
pub struct ConsoleLock {
    path: PathBuf,
}

impl ConsoleLock {
    /// Take the lock, refusing when another live console holds it.
    ///
    /// # Errors
    /// A live lock (fresh ts, foreign pid) — the refusal names its pid.
    pub fn acquire(fleet: &FleetPaths) -> anyhow::Result<Self> {
        let path = fleet.console_lock();
        if let Some(pid) = active_lock(&path) {
            anyhow::bail!(
                "another console (pid {pid}) is already open on {}",
                fleet.root().display()
            );
        }
        write_lock(&path)?;
        Ok(Self { path })
    }

    /// The heartbeat: a stale lock reads as a crashed console, so a
    /// long-lived console keeps stamping its own.
    pub fn refresh(&self) {
        let _ = write_lock(&self.path);
    }
}

impl Drop for ConsoleLock {
    fn drop(&mut self) {
        // remove only if still ours: a takeover already owns the file
        if let Ok(raw) = std::fs::read_to_string(&self.path)
            && let Ok(value) = serde_json::from_str::<Value>(&raw)
            && value.get("pid").and_then(Value::as_u64) == Some(u64::from(process_id()))
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Another live console's pid, or none (missing, malformed, stale, or ours).
fn active_lock(path: &Path) -> Option<u64> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let pid = value.get("pid")?.as_u64()?;
    let ts = value.get("ts")?.as_str()?;
    let age = now_ms().saturating_sub(parse_ts_ms(ts).unwrap_or(0));
    if age > LOCK_STALE_MS {
        return None;
    }
    (pid != u64::from(process_id())).then_some(pid)
}

fn write_lock(path: &Path) -> std::io::Result<()> {
    std::fs::write(
        path,
        json!({ "pid": process_id(), "ts": now_iso() }).to_string(),
    )
}

// ---------------------------------------------------------------------------
// Feeds: what `.parl` says, folded into the state machine

/// The runtime's polled view of `.parl`, kept beside the `Console`: the
/// renderer reads the orchestrator state and run entries directly (they carry
/// the permission mode, pending approvals and worker facts the status line
/// needs), while the `Console` gets the same facts through its feeds.
struct Poll {
    fleet: FleetPaths,
    runs: Vec<RunEntry>,
    orch: OrchestratorState,
    orch_offset: u64,
    worker_offsets: HashMap<String, u64>,
    watcher_disabled: bool,
}

impl Poll {
    fn new(fleet: FleetPaths) -> Self {
        Self {
            fleet,
            runs: Vec::new(),
            orch: OrchestratorState::default(),
            orch_offset: 0,
            worker_offsets: HashMap::new(),
            watcher_disabled: false,
        }
    }

    fn reload_runs(&mut self) {
        self.runs = crate::fleet::run::list_runs(self.fleet.root())
            .into_iter()
            .filter_map(|summary| {
                crate::fleet::run::load_state(&summary.run_dir)
                    .ok()
                    .map(|state| RunEntry {
                        run_id: summary.run_id,
                        state,
                    })
            })
            .collect();
    }

    fn reload_orchestrator(&mut self) {
        let Ok(raw) = std::fs::read_to_string(self.fleet.orchestrator_state()) else {
            return;
        };
        if let Ok(state) = serde_json::from_str::<OrchestratorState>(&raw) {
            self.orch = state;
        }
    }

    /// Fold everything new into the console: the orchestrator's transcript
    /// and every worker's events. Offsets start at zero, so the first poll
    /// *is* the replay on console open — the same ingest path a live tail
    /// uses.
    fn tail_events(&mut self, console: &mut Console) {
        let (lines, offset) = read_new_lines(&self.fleet.orchestrator_events(), self.orch_offset);
        self.orch_offset = offset;
        for line in &lines {
            if let Ok(record) = serde_json::from_str::<EventRecord>(line) {
                console.ingest_orchestrator_record(&record);
            }
        }
        // offsets for runs that vanished are dead weight
        self.worker_offsets
            .retain(|run_id, _| self.runs.iter().any(|run| &run.run_id == run_id));
        for run in &self.runs {
            let offset = self.worker_offsets.entry(run.run_id.clone()).or_insert(0);
            let (lines, next) = read_new_lines(&self.fleet.run_events(&run.run_id), *offset);
            *offset = next;
            for line in &lines {
                if let Ok(event) = serde_json::from_str::<Value>(line) {
                    console.ingest_worker_event(&run.run_id, &event);
                }
            }
        }
    }

    /// The watcher seam (`orch::watcher`): observed fleet events are
    /// forwarded to the orchestrator as one batch. Until the watcher step
    /// lands, `poll_events` is a stub that errors with "not implemented" —
    /// noted once, then quiet.
    async fn forward_fleet_events(&mut self, console: &mut Console) {
        if self.watcher_disabled {
            return;
        }
        match crate::orch::watcher::poll_events(self.fleet.root()).await {
            Ok(events) if !events.is_empty() => {
                let batch = crate::fleet::event::format_fleet_batch(&events, 10);
                let effects = console.ingest_fleet_events(&events, &batch);
                console.execute_all(effects).await;
            }
            Ok(_) => {}
            Err(err) => {
                if err.to_string().contains("not implemented") {
                    self.watcher_disabled = true;
                } else {
                    console.toast(format!("! fleet watcher: {err:#}"), true);
                }
            }
        }
    }
}

/// The orchestrator monitor keeps the claude child alive across consoles;
/// the console only makes sure one is running, detached, with its output on
/// `orchestrator/claude.log`.
///
/// Returns whether a monitor was started (`false`: one was already running
/// and this console is attaching). Launch flags — model, budget, permission
/// mode, Remote Control — are not part of the frozen `orchestrator-monitor`
/// CLI yet, so they ride unused for now; the integration step wires them
/// through (the console can still set model, effort and permission mode live
/// once attached).
fn ensure_orchestrator(fleet: &FleetPaths) -> anyhow::Result<bool> {
    let state = std::fs::read_to_string(fleet.orchestrator_state())
        .ok()
        .and_then(|raw| serde_json::from_str::<OrchestratorState>(&raw).ok());
    if let Some(pid) = state.as_ref().and_then(|s| s.pid)
        && crate::fleet::run::is_alive(Some(pid))
    {
        return Ok(false);
    }
    let exe = std::env::current_exe().context("finding the parl binary")?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(fleet.claude_log())
        .context("opening orchestrator/claude.log")?;
    let err = log.try_clone().context("cloning the log handle")?;
    std::process::Command::new(exe)
        .args(["orchestrator-monitor", "--fleet-dir"])
        .arg(fleet.root())
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err)
        .process_group(0) // detached: outlives the console, no signal relay
        .spawn()
        .context("spawning the orchestrator monitor")?;
    Ok(true)
}

/// Raw mode means ctrl-c never becomes SIGINT: the runtime reads it as the
/// console's own quit, the way the old ink app's `exitOnCtrlC` did.
fn is_interrupt(key: &KeyEvent) -> bool {
    key.kind != KeyEventKind::Release
        && key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C'))
}

// ---------------------------------------------------------------------------
// The event loop

/// Run the console until the user quits: one draw per pass, key events
/// through the state machine and its effects, `.parl` polled into the feeds
/// on a timer, the lock heartbeating. Workers keep running afterwards.
///
/// # Errors
/// Terminal draw failures only; console errors surface as notices.
pub async fn run_console(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    fleet: FleetPaths,
    lock: &ConsoleLock,
) -> anyhow::Result<ExitCode> {
    let repo_root = fleet.root().parent().unwrap_or(fleet.root()).to_path_buf();
    let mut console = Console::new(fleet.clone());
    console.load_prefs();

    let mut poll = Poll::new(fleet.clone());
    poll.reload_runs();
    poll.reload_orchestrator();
    console.set_runs(poll.runs.clone());
    console.set_orchestrator_state(poll.orch.clone());
    poll.tail_events(&mut console);
    console.set_files(list_repo_files(&repo_root).await);

    match ensure_orchestrator(&fleet) {
        Ok(true) => console.notice("· orchestrator monitor started", false),
        Ok(false) => console.notice(
            "· attaching to the orchestrator that is already running here",
            false,
        ),
        Err(err) => console.notice(format!("! orchestrator: {err:#}"), true),
    }

    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut feed = tokio::time::interval(Duration::from_millis(400));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    for timer in [&mut tick, &mut feed, &mut heartbeat] {
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    }

    loop {
        // the flash's expiry is a clock matter, not an event matter
        console.tick(now_ms());
        let feeds = Feeds {
            orch: &poll.orch,
            runs: &poll.runs,
        };
        let palette = Palette::detect();
        terminal.draw(|frame| view::draw(frame, &mut console, &feeds, &palette))?;

        tokio::select! {
            maybe = events.next() => match maybe {
                Some(Ok(Event::Key(key))) => {
                    if is_interrupt(&key) {
                        break;
                    }
                    let effects = console.handle_key(key);
                    let quit = effects.iter().any(|effect| matches!(effect, Effect::Quit));
                    console.execute_all(effects).await;
                    if quit {
                        break;
                    }
                }
                // resize redraws on the next pass; mouse and focus are unused
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
            // the clock: ages, activity lines and the elapsed counters move
            _ = tick.tick() => {}
            _ = feed.tick() => {
                poll.reload_runs();
                poll.reload_orchestrator();
                console.set_runs(poll.runs.clone());
                console.set_orchestrator_state(poll.orch.clone());
                poll.tail_events(&mut console);
                poll.forward_fleet_events(&mut console).await;
            }
            _ = heartbeat.tick() => lock.refresh(),
        }
    }
    Ok(ExitCode::Ok)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn tmp_fleet() -> (std::path::PathBuf, FleetPaths) {
        let dir = std::env::temp_dir().join(format!(
            "parl-tui-runtime-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), FleetPaths::new(dir))
    }

    #[test]
    fn the_lock_refuses_a_live_second_console_and_expires_a_stale_one() {
        let (_dir, fleet) = tmp_fleet();
        let path = fleet.console_lock();

        // no lock at all: acquirable
        assert_eq!(active_lock(&path), None);

        // a fresh foreign lock is refused
        std::fs::write(
            &path,
            json!({ "pid": std::process::id() as u64 + 1, "ts": now_iso() }).to_string(),
        )
        .unwrap();
        assert_eq!(active_lock(&path), Some(std::process::id() as u64 + 1));

        // a stale lock is a crashed console, not a live one
        let stale = json!({
            "pid": std::process::id() as u64 + 1,
            "ts": crate::util::now_iso(),
        });
        let stale = match &stale {
            Value::Object(map) => {
                let mut map = map.clone();
                map.insert("ts".into(), json!("2026-01-01T00:00:00.000Z"));
                Value::Object(map)
            }
            _ => unreachable!(),
        };
        std::fs::write(&path, stale.to_string()).unwrap();
        assert_eq!(active_lock(&path), None);

        // a malformed lock does not wedge the console either
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(active_lock(&path), None);
    }

    #[test]
    fn acquiring_writes_the_lock_and_dropping_removes_it_if_ours() {
        let (_dir, fleet) = tmp_fleet();
        let path = fleet.console_lock();
        {
            let lock = ConsoleLock::acquire(&fleet).unwrap();
            lock.refresh();
            let raw = std::fs::read_to_string(&path).unwrap();
            let value: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                value.get("pid").unwrap().as_u64(),
                Some(u64::from(process_id()))
            );
        }
        assert!(!path.exists(), "our own lock is removed on drop");
    }

    #[test]
    fn dropping_leaves_a_taken_over_lock_alone() {
        let (_dir, fleet) = tmp_fleet();
        let path = fleet.console_lock();
        let foreign = process_id() as u64 + 1;
        std::fs::write(
            &path,
            json!({ "pid": foreign, "ts": now_iso() }).to_string(),
        )
        .unwrap();
        // simulate a stale lock being taken over: active_lock says none
        assert_eq!(
            active_lock(&path),
            Some(foreign),
            "fresh foreign lock is live"
        );
        // ...but a ConsoleLock dropped over a foreign file must not delete it
        let lock = ConsoleLock { path: path.clone() };
        drop(lock);
        assert!(path.exists());
    }

    #[test]
    fn ctrl_c_is_the_interrupt_and_plain_c_is_not() {
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(is_interrupt(&ctrl_c));
        assert!(!is_interrupt(&KeyEvent::new(
            KeyCode::Char('c'),
            KeyModifiers::NONE
        )));
        // release events never count
        let released = KeyEvent {
            kind: KeyEventKind::Release,
            ..KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)
        };
        assert!(!is_interrupt(&released));
    }

    #[test]
    fn ensure_orchestrator_attaches_to_a_live_monitor_pid() {
        let (_dir, fleet) = tmp_fleet();
        std::fs::create_dir_all(fleet.orchestrator_dir()).unwrap();
        let state = OrchestratorState {
            pid: Some(std::process::id() as i32),
            ..OrchestratorState::default()
        };
        crate::util::atomic_write_json(&fleet.orchestrator_state(), &state).unwrap();
        // our own pid is alive: no spawn
        assert!(!ensure_orchestrator(&fleet).unwrap());
    }
}
