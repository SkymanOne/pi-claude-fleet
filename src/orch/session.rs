//! The durable claude session record: `.parl/fleet.json`. The console and the
//! watcher keep their cursors here and the orchestrator keeps its claude
//! session id, so reopening the console picks the same conversation back up.
//!
//! Ported from the TypeScript `src/orchestrator/session.ts` (which stored
//! `orchestrator.json`) onto the one `fleet.json` the new layout defines.
//! One Rust-specific addition: the CLI hands the monitor nothing but
//! `--fleet-dir`, so the console records the launch flags here under
//! [`LaunchOptions`] for the monitor it spawns — and the monitor writes mode
//! changes back, so a restarted monitor keeps running the way the last one
//! did.
//!
//! Tolerant serde, like every state file in this crate: unknown fields are
//! ignored, missing ones fall back to defaults, and a version this code does
//! not know is treated as no session at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::FleetPaths;
use crate::util::{atomic_write_json, now_iso};

/// The only version this code reads; anything else starts fresh.
pub const SESSION_VERSION: u8 = 1;

/// One run's watcher cursor: how much of its `events.jsonl` is consumed, and
/// the last view reported (so terminal transitions are not re-reported).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunCursor {
    /// Byte offset already consumed in the run's events file.
    pub events_offset: u64,
    /// Last derived view reported for this run, as its display name
    /// (`"running"`, `"blocked"`, `"settled"`, …); none before the first.
    pub last_view: Option<String>,
}

/// The watcher's cursors, saved so a resumed console does not replay history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WatcherState {
    pub cursors: HashMap<String, RunCursor>,
}

/// Launch flags the console records for the monitor it spawns. `fresh` is a
/// one-shot instruction (start a new session) and clears once used; the rest
/// describe how to bring claude up, updated live by the monitor so a
/// restarted monitor keeps the mode and Remote Control state in force.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchOptions {
    /// The model asked for at launch (claude's default when none).
    pub model: Option<String>,
    pub budget_usd: Option<f64>,
    pub permission_mode: Option<String>,
    /// Remote Control name, `Some("")` for an automatic one, none for off.
    pub remote_control: Option<String>,
    pub fresh: Option<bool>,
}

/// The claude session, as persisted in `fleet.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OrchestratorSession {
    pub version: u8,
    /// The claude session id; none until the first child reports init.
    pub session_id: Option<String>,
    /// The monitor's pid while it runs; used to reap an orphan after a crash.
    pub pid: Option<i32>,
    /// The model claude is running (what init reported, not what was asked for).
    pub model: Option<String>,
    pub claude_version: Option<String>,
    pub started_at: String,
    pub last_used_at: String,
    pub cwd: String,
    pub watcher: WatcherState,
    pub launch: LaunchOptions,
}

impl Default for OrchestratorSession {
    fn default() -> Self {
        Self::new("")
    }
}

impl OrchestratorSession {
    /// A fresh session record for a console opening in `cwd`.
    #[must_use]
    pub fn new(cwd: &str) -> Self {
        let now = now_iso();
        Self {
            version: SESSION_VERSION,
            session_id: None,
            pid: None,
            model: None,
            claude_version: None,
            started_at: now.clone(),
            last_used_at: now,
            cwd: cwd.to_string(),
            watcher: WatcherState::default(),
            launch: LaunchOptions::default(),
        }
    }
}

/// `fleet.json` — there is no separate `orchestrator.json` any more.
#[must_use]
pub fn session_path(fleet_dir: &Path) -> PathBuf {
    FleetPaths::new(fleet_dir).fleet_json()
}

/// Load the session, or none when the file is missing, unreadable, or written
/// by a version this code does not know (it starts fresh instead).
#[must_use]
pub fn load(fleet_dir: &Path) -> Option<OrchestratorSession> {
    let raw = std::fs::read_to_string(session_path(fleet_dir)).ok()?;
    let parsed: OrchestratorSession = serde_json::from_str(&raw).ok()?;
    (parsed.version == SESSION_VERSION).then_some(parsed)
}

/// Persist the session, stamping `last_used_at`.
pub fn save(fleet_dir: &Path, session: &mut OrchestratorSession) -> std::io::Result<()> {
    session.last_used_at = now_iso();
    let mut to_write = session.clone();
    to_write.version = SESSION_VERSION;
    if let Some(parent) = session_path(fleet_dir).parent() {
        std::fs::create_dir_all(parent)?;
    }
    atomic_write_json(&session_path(fleet_dir), &to_write)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_fleet(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_new_session_has_no_session_id_and_version_one() {
        let session = OrchestratorSession::new("/repo");
        assert_eq!(session.version, SESSION_VERSION);
        assert_eq!(session.session_id, None);
        assert_eq!(session.pid, None);
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.launch, LaunchOptions::default());
        assert!(session.watcher.cursors.is_empty());
        assert!(session.started_at.ends_with('Z'));
    }

    #[test]
    fn save_and_load_round_trip_cursors_and_launch_options() {
        let fleet = tmp_fleet("parl-session-");
        let mut session = OrchestratorSession::new("/repo");
        session.session_id = Some("sess-abc12345".into());
        session.pid = Some(4321);
        session.model = Some("claude-fable-5".into());
        session.claude_version = Some("2.1.251".into());
        session.watcher.cursors.insert(
            "auth-20260828141530".into(),
            RunCursor {
                events_offset: 128,
                last_view: Some("blocked".into()),
            },
        );
        session.launch = LaunchOptions {
            model: Some("fable".into()),
            budget_usd: Some(5.0),
            permission_mode: Some("acceptEdits".into()),
            remote_control: Some("".into()),
            fresh: Some(true),
        };
        save(&fleet, &mut session).unwrap();
        let loaded = load(&fleet).unwrap();
        assert_eq!(loaded.session_id.as_deref(), Some("sess-abc12345"));
        assert_eq!(loaded.pid, Some(4321));
        assert_eq!(loaded.model.as_deref(), Some("claude-fable-5"));
        let (run_id, cursor) = loaded.watcher.cursors.iter().next().unwrap();
        assert_eq!(run_id, "auth-20260828141530");
        assert_eq!(cursor.events_offset, 128);
        assert_eq!(cursor.last_view.as_deref(), Some("blocked"));
        assert_eq!(loaded.launch.budget_usd, Some(5.0));
        assert_eq!(
            loaded.launch.permission_mode.as_deref(),
            Some("acceptEdits")
        );
        assert_eq!(loaded.launch.remote_control.as_deref(), Some(""));
        // camelCase on disk (pretty-printed, like every atomic write),
        // matching the JSON the fleet tooling speaks.
        let raw = std::fs::read_to_string(session_path(&fleet)).unwrap();
        assert!(raw.contains(r#""sessionId": "sess-abc12345""#), "{raw}");
        assert!(raw.contains(r#""eventsOffset": 128"#), "{raw}");
        assert!(raw.contains(r#""lastUsedAt":"#), "{raw}");
    }

    #[test]
    fn save_stamps_last_used_at() {
        let fleet = tmp_fleet("parl-session-stamp-");
        let mut session = OrchestratorSession::new("/repo");
        session.last_used_at = "2020-01-01T00:00:00.000Z".into();
        save(&fleet, &mut session).unwrap();
        let raw = std::fs::read_to_string(session_path(&fleet)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let stamped = parsed["lastUsedAt"].as_str().unwrap();
        assert_ne!(stamped, "2020-01-01T00:00:00.000Z", "{raw}");
        assert!(crate::util::parse_ts_ms(stamped).is_some());
    }

    #[test]
    fn a_missing_file_and_a_foreign_version_read_as_no_session() {
        assert_eq!(load(&tmp_fleet("parl-session-missing-")), None);
        let fleet = tmp_fleet("parl-session-version-");
        std::fs::write(
            session_path(&fleet),
            r#"{"version":2,"cwd":"/repo","sessionId":"s"}"#,
        )
        .unwrap();
        assert_eq!(load(&fleet), None, "a newer writer starts fresh");
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let fleet = tmp_fleet("parl-session-tolerant-");
        // A newer writer with extra fields, an older one without launch info.
        std::fs::write(
            session_path(&fleet),
            json!({
                "version": 1,
                "cwd": "/repo",
                "someFutureField": {"deep": [1]},
            })
            .to_string(),
        )
        .unwrap();
        let session = load(&fleet).unwrap();
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.session_id, None);
        assert_eq!(session.launch, LaunchOptions::default());
        assert!(session.watcher.cursors.is_empty());
        // Corrupt JSON is not a session either.
        std::fs::write(session_path(&fleet), "{oops").unwrap();
        assert_eq!(load(&fleet), None);
    }
}
