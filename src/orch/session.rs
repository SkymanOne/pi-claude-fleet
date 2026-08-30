//! The durable session store: `.parl/fleet.json` holds every orchestrator
//! session, keyed by session uuid. The console and the watcher keep their
//! cursors here — they are per-conversation, so each session owns its own
//! [`WatcherState`] — and the orchestrator keeps its claude session id, so
//! reopening the console picks the same conversation back up.
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
//! not know is treated as no sessions at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::paths::{FleetPaths, SessionKey};
use crate::util::{atomic_write_json, now_iso};

/// The only version this code reads; anything else starts fresh. Version 2
/// is the sessions map (v1 held a single session object).
pub const SESSION_VERSION: u8 = 2;

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
    /// The model asked for at launch (claude's default when none). Most
    /// specific wins: the explicit flag, then this persisted record, then
    /// `~/.parl/config.toml`'s `[orchestrator] model`.
    pub model: Option<String>,
    pub budget_usd: Option<f64>,
    pub permission_mode: Option<String>,
    /// Remote Control name, `Some("")` for an automatic one, none for off.
    pub remote_control: Option<String>,
    pub fresh: Option<bool>,
}

/// The claude session, as persisted in `fleet.json`, one per session row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OrchestratorSession {
    pub version: u8,
    /// This session's uuid — the map key, the `Party::Orchestrator`
    /// identity and the `orchestrators/<alias>-<short-uuid>/` directory
    /// suffix. `Uuid::nil()` only in rows written before the field existed
    /// (explicitly nil, never `Uuid::default()`: under the v4 feature that
    /// is a *random* uuid, so a legacy row would read as a fresh identity
    /// every load).
    #[serde(default = "crate::util::nil_uuid")]
    pub uuid: Uuid,
    /// The human handle; absent until a later stage derives one from the
    /// session's first prompt.
    pub alias: Option<String>,
    /// When the session's monitor last reported liveness; a later stage
    /// writes it, this shape just carries it.
    pub last_heartbeat: Option<String>,
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
            uuid: Uuid::new_v4(),
            alias: None,
            last_heartbeat: None,
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

    /// The session's layout key: its uuid and (optional) alias.
    #[must_use]
    pub fn key(&self) -> SessionKey {
        SessionKey::new(self.alias.clone(), self.uuid)
    }
}

/// Every orchestrator session of one fleet, as persisted in `fleet.json`
/// (`{"version":2,"sessions":{…}}`, keyed by session uuid).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FleetSessions {
    pub version: u8,
    pub sessions: HashMap<Uuid, OrchestratorSession>,
}

impl FleetSessions {
    /// A fresh, empty store at the current version.
    #[must_use]
    pub fn new() -> Self {
        Self {
            version: SESSION_VERSION,
            sessions: HashMap::new(),
        }
    }

    /// The session used most recently, which is the one a console reopens
    /// and a monitor serves while nothing names a session explicitly;
    /// `None` when the map is empty.
    #[must_use]
    pub fn last_used(&self) -> Option<&OrchestratorSession> {
        self.sessions
            .values()
            .max_by_key(|s| crate::util::parse_ts_ms(&s.last_used_at).unwrap_or(0))
    }

    /// Insert (or replace) one session.
    pub fn upsert(&mut self, session: OrchestratorSession) {
        self.sessions.insert(session.uuid, session);
    }
}

/// `fleet.json` — there is no separate `orchestrator.json` any more.
#[must_use]
pub fn session_path(fleet_dir: &Path) -> PathBuf {
    FleetPaths::new(fleet_dir).fleet_json()
}

/// Load the session store, or none when the file is missing, unreadable, or
/// written by a version this code does not know (it starts fresh instead).
#[must_use]
pub fn load(fleet_dir: &Path) -> Option<FleetSessions> {
    let raw = std::fs::read_to_string(session_path(fleet_dir)).ok()?;
    let parsed: FleetSessions = serde_json::from_str(&raw).ok()?;
    (parsed.version == SESSION_VERSION).then_some(parsed)
}

/// The fleet's current session, when it has one: the most recently used row.
/// This is the session a console reopens and a monitor serves while nothing
/// names a session explicitly.
#[must_use]
pub fn resolve_session(fleet_dir: &Path) -> Option<OrchestratorSession> {
    load(fleet_dir).and_then(|store| store.last_used().cloned())
}

/// Persist the session store. Recency is the caller's business — `save`
/// does not stamp anything, so nothing a monitor writes can bump ownership.
///
/// # Errors
///
/// Returns an I/O error when the fleet directory cannot be created or the
/// session file cannot be written.
pub fn save(fleet_dir: &Path, store: &mut FleetSessions) -> std::io::Result<()> {
    store.version = SESSION_VERSION;
    let to_write = store.clone();
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
    fn a_new_session_has_no_session_id_a_fresh_uuid_and_version_two() {
        let session = OrchestratorSession::new("/repo");
        assert_eq!(session.version, SESSION_VERSION);
        assert!(!session.uuid.is_nil(), "every new session gets an identity");
        assert_eq!(session.alias, None);
        assert_eq!(session.last_heartbeat, None);
        assert_eq!(session.session_id, None);
        assert_eq!(session.pid, None);
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.launch, LaunchOptions::default());
        assert!(session.watcher.cursors.is_empty());
        assert!(session.started_at.ends_with('Z'));
        // The layout key mirrors the session's identity.
        let key = session.key();
        assert_eq!(key.uuid, session.uuid);
        assert!(
            key.dir_name()
                .ends_with(&crate::util::short_uuid(&session.uuid))
        );
    }

    #[test]
    fn save_and_load_round_trip_a_map_of_sessions_with_cursors_and_launch() {
        let fleet = tmp_fleet("parl-session-");
        let mut store = FleetSessions::new();
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
            remote_control: Some(String::new()),
            fresh: Some(true),
        };
        let session_uuid = session.uuid;
        store.upsert(session);
        // A second session shares the store; each keeps its own cursors.
        let mut other = OrchestratorSession::new("/elsewhere");
        other.watcher.cursors.insert(
            "db-9f8e7d6".into(),
            RunCursor {
                events_offset: 64,
                last_view: Some("running".into()),
            },
        );
        let other_uuid = other.uuid;
        store.upsert(other);
        save(&fleet, &mut store).unwrap();

        let loaded = load(&fleet).unwrap();
        assert_eq!(loaded.sessions.len(), 2);
        let session = &loaded.sessions[&session_uuid];
        assert_eq!(session.session_id.as_deref(), Some("sess-abc12345"));
        assert_eq!(session.pid, Some(4321));
        assert_eq!(session.model.as_deref(), Some("claude-fable-5"));
        let (run_id, cursor) = session.watcher.cursors.iter().next().unwrap();
        assert_eq!(run_id, "auth-20260828141530");
        assert_eq!(cursor.events_offset, 128);
        assert_eq!(cursor.last_view.as_deref(), Some("blocked"));
        assert_eq!(session.launch.budget_usd, Some(5.0));
        assert_eq!(
            session.launch.permission_mode.as_deref(),
            Some("acceptEdits")
        );
        assert_eq!(session.launch.remote_control.as_deref(), Some(""));
        // The other session's cursors are its own.
        assert_eq!(
            loaded.sessions[&other_uuid]
                .watcher
                .cursors
                .get("db-9f8e7d6")
                .unwrap()
                .events_offset,
            64
        );
        // camelCase on disk (pretty-printed, like every atomic write),
        // matching the JSON the fleet tooling speaks.
        let raw = std::fs::read_to_string(session_path(&fleet)).unwrap();
        assert!(raw.contains(r#""version": 2"#), "{raw}");
        assert!(raw.contains(r#""sessionId": "sess-abc12345""#), "{raw}");
        assert!(raw.contains(r#""eventsOffset": 128"#), "{raw}");
        assert!(raw.contains(r#""lastUsedAt":"#), "{raw}");
        assert!(raw.contains(&format!("\"{session_uuid}\"")), "{raw}");
    }

    #[test]
    fn last_used_picks_the_newest_session_and_resolution_follows() {
        let fleet = tmp_fleet("parl-session-used-");
        // A console touches last_used_at when it opens a session.
        let mut store = FleetSessions::new();
        let mut older = OrchestratorSession::new("/repo");
        older.last_used_at = "2026-08-01T00:00:00.000Z".into();
        let mut newer = OrchestratorSession::new("/repo");
        newer.last_used_at = "2026-09-01T00:00:00.000Z".into();
        let newer_uuid = newer.uuid;
        store.upsert(older);
        store.upsert(newer);
        assert_eq!(store.last_used().unwrap().uuid, newer_uuid);
        save(&fleet, &mut store).unwrap();
        let resolved = resolve_session(&fleet).unwrap();
        assert_eq!(resolved.uuid, newer_uuid);
        // An empty store has no session to resolve.
        let none_fleet = tmp_fleet("parl-session-none-");
        assert_eq!(resolve_session(&none_fleet), None);
    }

    #[test]
    fn a_missing_file_and_a_foreign_version_read_as_no_session() {
        let fleet = tmp_fleet("parl-session-missing-");
        assert_eq!(load(&fleet), None);
        assert_eq!(resolve_session(&fleet), None);
        // A newer writer's version starts fresh.
        std::fs::write(session_path(&fleet), r#"{"version":3,"sessions":{}}"#).unwrap();
        assert_eq!(load(&fleet), None, "a newer writer starts fresh");
        // The v1 single-session shape is foreign too: no migration, no
        // guess at how it keys — it starts fresh.
        std::fs::write(
            session_path(&fleet),
            r#"{"version":1,"cwd":"/repo","sessionId":"s"}"#,
        )
        .unwrap();
        assert_eq!(load(&fleet), None);
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let fleet = tmp_fleet("parl-session-tolerant-");
        // A newer writer with extra fields, an older one without launch info.
        std::fs::write(
            session_path(&fleet),
            json!({
                "version": 2,
                "sessions": {
                    "9ff7d0c4-4f2a-4b1e-8a3c-2d5e6f7a8b9c": {
                        "cwd": "/repo",
                        "someFutureField": {"deep": [1]},
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let store = load(&fleet).unwrap();
        let session = &store.sessions
            [&uuid::Uuid::parse_str("9ff7d0c4-4f2a-4b1e-8a3c-2d5e6f7a8b9c").unwrap()];
        assert_eq!(session.cwd, "/repo");
        assert_eq!(session.session_id, None);
        assert_eq!(session.launch, LaunchOptions::default());
        assert!(session.watcher.cursors.is_empty());
        // A session row without a uuid is a nil-uuid row, which is itself a
        // parseable (if degenerate) identity — never a failure.
        // A session row without a uuid is a nil-uuid row, which is itself a
        // parseable (if degenerate) identity — never a failure.
        assert!(session.uuid.is_nil(), "uuid was {:?}", session.uuid);
        // Corrupt JSON is not a store either.
        std::fs::write(session_path(&fleet), "{oops").unwrap();
        assert_eq!(load(&fleet), None);
    }
}
