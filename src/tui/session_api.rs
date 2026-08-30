//! TEMPORARY STAND-IN for the orchestrator slice's session API.
//!
//! The console needs four functions that ship with the orchestrator slice
//! (merge order: orchestrator slice first, then this branch):
//!
//! - `list_sessions`, `create_session`, `session_by_key`, `touch_heartbeat`
//!
//! Until that branch lands in this worktree they live here — same paths,
//! same signatures, same semantics as the brief pins — so the console
//! compiles and its tests run green locally. They are built on the stage-1
//! store (`crate::orch::session`: `load`/`save`/`FleetSessions`/
//! `OrchestratorSession`), which is already in the tree.
//!
//! When the real API arrives, delete THIS module and flip the
//! `crate::tui::session_api::` call sites in `src/tui/app.rs` and
//! `src/tui/runtime.rs` to `crate::orch::session::` — the shapes are
//! identical, so the swap is mechanical (a rename, then a delete).

use std::path::Path;

use uuid::Uuid;

use crate::orch::session::{FleetSessions, OrchestratorSession, load, save, session_path};

/// Every orchestrator session of the fleet, most recently used first.
/// A store that is missing, unreadable or from a newer version reads as
/// no sessions.
#[must_use]
pub fn list_sessions(fleet_dir: &Path) -> Vec<OrchestratorSession> {
    let mut sessions: Vec<OrchestratorSession> = load(fleet_dir)
        .map(|store| store.sessions.into_values().collect())
        .unwrap_or_default();
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(crate::util::parse_ts_ms(&session.last_used_at).unwrap_or(0))
    });
    sessions
}

/// Create (and persist) a fresh session row, with an optional alias — the
/// human handle the orchestrator later derives itself when none is given,
/// so a row may well stay alias-less.
///
/// # Errors
///
/// A store the code cannot parse — a newer parl's — is never clobbered;
/// that errors instead.
pub fn create_session(
    fleet_dir: &Path,
    alias: Option<&str>,
) -> anyhow::Result<OrchestratorSession> {
    if load(fleet_dir).is_none() && session_path(fleet_dir).exists() {
        anyhow::bail!(
            "the session store is unreadable or written by a newer parl — refusing to overwrite it"
        );
    }
    let mut store = load(fleet_dir).unwrap_or_default();
    let cwd = fleet_dir
        .parent()
        .map_or_else(|| "".to_string(), |p| p.to_string_lossy().into_owned());
    let mut session = OrchestratorSession::new(&cwd);
    session.alias = alias.map(str::to_string);
    let key = session.key();
    store.upsert(session);
    save(fleet_dir, &mut store)?;
    // `save` owned the row; the record below is what the caller switches to.
    Ok(store
        .sessions
        .get(&key.uuid)
        .cloned()
        .unwrap_or_else(|| OrchestratorSession::new(&cwd)))
}

/// Resolve `<uuid>` first, then an alias, to one session. An alias shared
/// by several live sessions is ambiguous and refuses to pick silently —
/// the caller sees `None` and says so.
#[must_use]
pub fn session_by_key(fleet_dir: &Path, key: &str) -> Option<OrchestratorSession> {
    let raw = key.trim();
    let store = load(fleet_dir)?;
    if let Ok(uuid) = Uuid::parse_str(raw) {
        return store.sessions.get(&uuid).cloned();
    }
    let mut matches = store
        .sessions
        .values()
        .filter(|session| session.alias.as_deref() == Some(raw));
    let first = matches.next()?;
    (matches.next().is_none()).then_some(first.clone())
}

/// Stamp a session's `last_heartbeat` — the monitor-side liveness signal
/// the console's `/sessions` reads. The console itself never calls it (the
/// solo monitor is the heartbeat's writer); it exists here for API parity
/// with the orchestrator slice. A missing row is a no-op.
///
/// # Errors
///
/// Returns an I/O error when the store cannot be written.
pub fn touch_heartbeat(fleet_dir: &Path, uuid: Uuid) -> std::io::Result<()> {
    let mut store: FleetSessions = load(fleet_dir).unwrap_or_default();
    let Some(record) = store.sessions.get_mut(&uuid) else {
        return Ok(());
    };
    record.last_heartbeat = Some(crate::util::now_iso());
    save(fleet_dir, &mut store)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn tmp_fleet(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_lists_and_resolves_by_uuid_then_alias() {
        let fleet = tmp_fleet("parl-session-api-");
        assert_eq!(list_sessions(&fleet), Vec::<OrchestratorSession>::new());

        let first = create_session(&fleet, None).unwrap();
        assert!(first.alias.is_none(), "the alias is optional");
        let second = create_session(&fleet, Some("add-auth")).unwrap();
        assert_eq!(second.alias.as_deref(), Some("add-auth"));

        let sessions = list_sessions(&fleet);
        assert_eq!(sessions.len(), 2);
        // most recently created first
        assert_eq!(sessions[0].uuid, second.uuid);

        // uuid resolves before alias
        assert_eq!(
            session_by_key(&fleet, &second.uuid.to_string())
                .unwrap()
                .uuid,
            second.uuid
        );
        assert_eq!(
            session_by_key(&fleet, "add-auth").unwrap().uuid,
            second.uuid
        );
        // an alias the row never got reads as nothing
        assert_eq!(session_by_key(&fleet, "nonexistent"), None);
        assert_eq!(session_by_key(&fleet, ""), None);
    }

    #[test]
    fn an_alias_shared_by_two_sessions_is_ambiguous_and_refused() {
        let fleet = tmp_fleet("parl-session-api-amb-");
        let first = create_session(&fleet, Some("dup")).unwrap();
        let second = create_session(&fleet, Some("dup")).unwrap();
        assert_ne!(first.uuid, second.uuid);
        assert_eq!(
            session_by_key(&fleet, "dup"),
            None,
            "never a silent pick between live sessions"
        );
        // each uuid still resolves to its own row
        assert_eq!(
            session_by_key(&fleet, &first.uuid.to_string())
                .unwrap()
                .uuid,
            first.uuid
        );
        assert_eq!(
            session_by_key(&fleet, &second.uuid.to_string())
                .unwrap()
                .uuid,
            second.uuid
        );
    }

    #[test]
    fn heartbeats_stamp_and_rows_persist_round_trip() {
        let fleet = tmp_fleet("parl-session-api-hb-");
        let session = create_session(&fleet, None).unwrap();
        assert_eq!(session.last_heartbeat, None);

        touch_heartbeat(&fleet, session.uuid).unwrap();
        let store = load(&fleet).unwrap();
        assert!(
            store.sessions[&session.uuid]
                .last_heartbeat
                .as_deref()
                .is_some_and(|ts| ts.starts_with('2')),
            "an RFC3339 timestamp was written"
        );
        // touching a row that is not there is a no-op, not an error
        touch_heartbeat(&fleet, Uuid::new_v4()).unwrap();
    }

    #[test]
    fn a_foreign_store_is_never_clobbered() {
        let fleet = tmp_fleet("parl-session-api-foreign-");
        std::fs::write(session_path(&fleet), r#"{"version":3,"sessions":{}}"#).unwrap();
        assert_eq!(list_sessions(&fleet), Vec::<OrchestratorSession>::new());
        let err = create_session(&fleet, None)
            .expect_err("a newer writer's store is not overwritten")
            .to_string();
        assert!(err.contains("refusing"), "{err}");
    }
}
