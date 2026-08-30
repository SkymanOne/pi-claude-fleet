//! The `.parl` state layout: one directory under the repo root holding every
//! durable fact the fleet produces. Nothing outside this module should spell
//! the directory name or the env-var prefix, so a future rename touches only
//! the two constants below.

use std::path::{Path, PathBuf};

/// The fleet's state directory, created under the repository root.
pub const STATE_DIR_NAME: &str = ".parl";
/// Prefix for every environment variable this tool reads (`PARL_DIR`, …).
pub const ENV_PREFIX: &str = "PARL";
/// The command name users type; used in help text, hints, and the prompt.
pub const BIN_NAME: &str = "parl";

/// Env-var name from its suffix: `_DIR` -> `PARL_DIR`.
#[must_use]
pub fn env_var(suffix: &str) -> String {
    format!("{ENV_PREFIX}_{suffix}")
}

/// Resolved `.parl` layout for one fleet.
///
/// Every path the console, monitors, or tools touch is derived here; see the
/// tree in AGENTS.md. An old `.pi-fleet` directory is ignored entirely — there
/// is no migration and none is wanted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetPaths {
    root: PathBuf,
}

impl FleetPaths {
    /// The layout rooted at an explicit directory (the `.parl` dir itself).
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Resolve the fleet dir for `cwd`: `$PARL_DIR` when set, else `<cwd>/.parl`.
    #[must_use]
    pub fn discover(cwd: &Path) -> Self {
        Self::discover_with_env(cwd, std::env::var(env_var("DIR")).ok().as_deref())
    }

    /// [`FleetPaths::discover`] with the env value injected (tests).
    #[must_use]
    pub fn discover_with_env(cwd: &Path, parl_dir: Option<&str>) -> Self {
        match parl_dir {
            Some(dir) if !dir.trim().is_empty() => Self::new(dir.trim()),
            _ => Self::new(cwd.join(STATE_DIR_NAME)),
        }
    }

    /// `.parl/` itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `fleet.json` — console + watcher cursors, the claude session id,
    /// remembered prefs.
    pub fn fleet_json(&self) -> PathBuf {
        self.root.join("fleet.json")
    }

    /// `console.lock` — single-instance lock for the TUI.
    pub fn console_lock(&self) -> PathBuf {
        self.root.join("console.lock")
    }

    /// `orchestrator/`.
    pub fn orchestrator_dir(&self) -> PathBuf {
        self.root.join("orchestrator")
    }

    /// `orchestrator/state.json` — monitor pid, session id, model, commands,
    /// cost, turns, activity, pending permission.
    pub fn orchestrator_state(&self) -> PathBuf {
        self.orchestrator_dir().join("state.json")
    }

    /// `orchestrator/events.jsonl` — the orchestrator transcript.
    pub fn orchestrator_events(&self) -> PathBuf {
        self.orchestrator_dir().join("events.jsonl")
    }

    /// `orchestrator/inbox.jsonl` — console -> monitor.
    pub fn orchestrator_inbox(&self) -> PathBuf {
        self.orchestrator_dir().join("inbox.jsonl")
    }

    /// `orchestrator/claude.log` — raw protocol both directions, plus the
    /// monitor's own diagnostics.
    pub fn claude_log(&self) -> PathBuf {
        self.orchestrator_dir().join("claude.log")
    }

    /// `runs/`.
    pub fn runs_dir(&self) -> PathBuf {
        self.root.join("runs")
    }

    /// `runs/<runId>/`.
    pub fn run_dir(&self, run_id: &str) -> PathBuf {
        self.runs_dir().join(run_id)
    }

    /// `runs/<runId>/run.json` — the run's durable facts.
    pub fn run_json(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("run.json")
    }

    /// `runs/<runId>/events.jsonl` — the run transcript.
    pub fn run_events(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("events.jsonl")
    }

    /// `runs/<runId>/inbox.jsonl` — orchestrator/console -> monitor.
    pub fn run_inbox(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("inbox.jsonl")
    }

    /// `runs/<runId>/outbox.jsonl` — worker -> monitor.
    pub fn run_outbox(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("outbox.jsonl")
    }

    /// `runs/<runId>/report.md` — the worker's final report.
    pub fn run_report(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("report.md")
    }

    /// `runs/<runId>/pi.log` — raw pi RPC stream, plus the monitor's own
    /// diagnostics.
    pub fn pi_log(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("pi.log")
    }

    /// `runs/<runId>/session/` — pi session files.
    pub fn run_session_dir(&self, run_id: &str) -> PathBuf {
        self.run_dir(run_id).join("session")
    }

    /// `pi/extensions/fleet-worker.ts` — the worker extension, embedded in
    /// the binary and materialized here at spawn time (single-binary
    /// installs cannot rely on the package's `pi/` tree existing).
    pub fn pi_extension(&self) -> PathBuf {
        self.root
            .join("pi")
            .join("extensions")
            .join("fleet-worker.ts")
    }

    /// `pi/skills/fleet-worker-report/SKILL.md` — the report skill, embedded
    /// and materialized like [`FleetPaths::pi_extension`].
    pub fn pi_skill(&self) -> PathBuf {
        self.root
            .join("pi")
            .join("skills")
            .join("fleet-worker-report")
            .join("SKILL.md")
    }

    /// Create the layout and make sure git ignores it.
    ///
    /// Returns whether the `.gitignore` gained an entry. Subdirectories
    /// (`runs/`, `orchestrator/`) are created here too: they are part of the
    /// fixed layout and callers otherwise race to make them.
    pub fn ensure(&self) -> std::io::Result<bool> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(self.runs_dir())?;
        std::fs::create_dir_all(self.orchestrator_dir())?;
        ensure_gitignore_entry(&git_root_of(&self.root), &format!("{STATE_DIR_NAME}/"))
    }
}

/// The repository root containing `dir`, or `dir` itself when it is not
/// inside a git work tree (best effort; `ensure` still writes the file).
fn git_root_of(dir: &Path) -> PathBuf {
    std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
        .unwrap_or_else(|| dir.to_path_buf())
}

/// Append `entry` to `<root>/.gitignore` unless a line already covers it.
///
/// Introduces the `# parl` marker on first touch. Returns whether the file
/// changed. Ported from the TypeScript `ensureGitignoreEntry`.
pub fn ensure_gitignore_entry(root: &Path, entry: &str) -> std::io::Result<bool> {
    let gitignore_path = root.join(".gitignore");
    let content = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
    let lines: Vec<String> = content.split('\n').map(|l| l.trim().to_string()).collect();
    if lines.iter().any(|l| l == entry) {
        return Ok(false);
    }
    let needs_marker = !lines.iter().any(|l| l == "# parl");
    let addition = format!("{}{entry}\n", if needs_marker { "# parl\n" } else { "" });
    let prefix = if !content.is_empty() && !content.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore_path)?;
    use std::io::Write;
    file.write_all(format!("{prefix}{addition}").as_bytes())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{RETRY_BOUND, RETRY_INTERVAL, git_sync, tmp_dir};
    use std::time::Instant;

    /// `ensure` touches several fresh paths, and under this machine's
    /// parallel load a call has been observed to fail with NotFound on a
    /// path it had itself just created. It self-heals (`create_dir_all`
    /// rebuilds whatever vanished), so poll `Err` against the shared bound
    /// instead of failing the test; the first `Ok` is returned unchanged.
    fn ensure_with_retry(paths: &FleetPaths) -> std::io::Result<bool> {
        let deadline = Instant::now() + RETRY_BOUND;
        loop {
            match paths.ensure() {
                Ok(changed) => return Ok(changed),
                Err(err) => {
                    if Instant::now() >= deadline {
                        return Err(err);
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
            }
        }
    }

    #[test]
    fn layout_paths_are_derived_from_the_root() {
        let paths = FleetPaths::new("/repo/x/.parl");
        assert_eq!(paths.root(), Path::new("/repo/x/.parl"));
        assert_eq!(
            paths.fleet_json(),
            PathBuf::from("/repo/x/.parl/fleet.json")
        );
        assert_eq!(
            paths.console_lock(),
            PathBuf::from("/repo/x/.parl/console.lock")
        );
        assert_eq!(
            paths.orchestrator_state(),
            PathBuf::from("/repo/x/.parl/orchestrator/state.json")
        );
        assert_eq!(
            paths.orchestrator_inbox(),
            PathBuf::from("/repo/x/.parl/orchestrator/inbox.jsonl")
        );
        assert_eq!(
            paths.claude_log(),
            PathBuf::from("/repo/x/.parl/orchestrator/claude.log")
        );
        assert_eq!(
            paths.run_json("a-20260828141530"),
            PathBuf::from("/repo/x/.parl/runs/a-20260828141530/run.json")
        );
        assert_eq!(
            paths.run_report("a-20260828141530"),
            PathBuf::from("/repo/x/.parl/runs/a-20260828141530/report.md")
        );
        assert_eq!(
            paths.pi_log("a-20260828141530"),
            PathBuf::from("/repo/x/.parl/runs/a-20260828141530/pi.log")
        );
        assert_eq!(
            paths.run_session_dir("a-20260828141530"),
            PathBuf::from("/repo/x/.parl/runs/a-20260828141530/session")
        );
        assert_eq!(
            paths.pi_extension(),
            PathBuf::from("/repo/x/.parl/pi/extensions/fleet-worker.ts")
        );
        assert_eq!(
            paths.pi_skill(),
            PathBuf::from("/repo/x/.parl/pi/skills/fleet-worker-report/SKILL.md")
        );
    }

    #[test]
    fn discover_prefers_parl_dir_env_over_cwd() {
        let cwd = Path::new("/repo");
        assert_eq!(
            FleetPaths::discover_with_env(cwd, None),
            FleetPaths::new("/repo/.parl")
        );
        assert_eq!(
            FleetPaths::discover_with_env(cwd, Some("/elsewhere/fleet")),
            FleetPaths::new("/elsewhere/fleet")
        );
        assert_eq!(
            FleetPaths::discover_with_env(cwd, Some("  ")),
            FleetPaths::new("/repo/.parl")
        );
        // The env name itself is derived, never spelled in full.
        assert_eq!(env_var("DIR"), "PARL_DIR");
        assert_eq!(env_var("RUN"), "PARL_RUN");
    }

    #[test]
    fn ensure_creates_layout_and_gitignores_once() {
        let root = tmp_dir("parl-paths-");
        // Both spawns transiently fail under full-suite parallel load; the
        // shared bounded retry covers them, and the rev-parse probe confirms
        // the repo answers before `ensure` consults it.
        git_sync(&root, &["init", "-q", "-b", "main"]);
        git_sync(&root, &["rev-parse", "--show-toplevel"]);
        let paths = FleetPaths::new(root.join(STATE_DIR_NAME));
        assert!(ensure_with_retry(&paths).unwrap());
        assert!(paths.root().is_dir());
        assert!(paths.runs_dir().is_dir());
        assert!(paths.orchestrator_dir().is_dir());
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains("# parl\n.parl/"), "{gitignore}");
        // Second run: already covered, no change.
        assert!(!ensure_with_retry(&paths).unwrap());
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(gitignore.matches(".parl/").count(), 1);
        // An existing unrelated entry survives and gets the marker once.
        std::fs::write(root.join(".gitignore"), "node_modules/\n.parl/\ndist/").unwrap();
        assert!(!ensure_gitignore_entry(&root, ".parl/").unwrap());
        assert!(!ensure_gitignore_entry(&root, ".parl/").unwrap());
    }
}
