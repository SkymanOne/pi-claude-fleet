//! Orchestrator health: is the `claude` we are about to drive a version this
//! app was tested against, and is there an orphaned one left over from a
//! console that crashed?
//!
//! Ported from the TypeScript `src/orchestrator/health.ts`.

use std::process::Command;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

use crate::fleet::run::is_alive;
use crate::orch::args::claude_command_from_spec;
use crate::paths::env_var;

/// Claude Code versions whose stream-json protocol this app was verified
/// against: 2.1.x up to but not including 2.2.
pub const TESTED_CLAUDE_RANGE: ((u64, u64), (u64, u64)) = ((2, 1), (2, 2));

/// The substring `reap_orphan_orchestrator` looks for in a pid's command line.
pub const ORPHAN_MATCHER: &str = "claude";

/// What the version check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionCheck {
    pub version: Option<String>,
    pub supported: bool,
    pub warning: Option<String>,
}

/// Extract the first `major.minor.patch` from a `claude --version` output.
#[must_use]
pub fn parse_claude_version(output: &str) -> Option<String> {
    let regex = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").ok()?;
    regex
        .captures(output)
        .and_then(|caps| caps.get(0))
        .map(|matched| matched.as_str().to_string())
}

/// Whether the version falls inside the tested range. None is not. Never
/// fatal either way: an unsupported version still runs, it just says so.
#[must_use]
pub fn version_supported(version: Option<&str>) -> bool {
    let Some(version) = version else {
        return false;
    };
    let mut parts = version.split('.');
    let (Some(Ok(major)), Some(Ok(minor))) = (
        parts.next().map(str::parse::<u64>),
        parts.next().map(str::parse::<u64>),
    ) else {
        return false;
    };
    let ((min_major, min_minor), (max_major, max_minor)) = TESTED_CLAUDE_RANGE;
    if major < min_major || (major == min_major && minor < min_minor) {
        return false;
    }
    major < max_major || (major == max_major && minor < max_minor)
}

/// `claude --version` against the real environment.
pub async fn check_claude_version() -> VersionCheck {
    check_claude_version_with_spec(std::env::var(env_var("CLAUDE_BIN")).ok().as_deref())
}

/// [`check_claude_version`] against an explicit binary spec (tests).
#[must_use]
pub fn check_claude_version_with_spec(spec: Option<&str>) -> VersionCheck {
    let (bin, prefix) = claude_command_from_spec(spec);
    let output = Command::new(&bin).args(&prefix).arg("--version").output();
    let Ok(output) = output else {
        return VersionCheck {
            version: None,
            supported: false,
            warning: Some(format!(
                "could not run `{bin} --version` — is Claude Code installed and on your PATH?"
            )),
        };
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = parse_claude_version(&text);
    match version {
        None => VersionCheck {
            version: None,
            supported: false,
            warning: Some(format!(
                "could not read a version from `{bin} --version` — continuing anyway"
            )),
        },
        Some(version) if version_supported(Some(&version)) => VersionCheck {
            version: Some(version),
            supported: true,
            warning: None,
        },
        Some(version) => {
            let ((min_major, min_minor), (max_major, max_minor)) = TESTED_CLAUDE_RANGE;
            VersionCheck {
                version: Some(version.clone()),
                supported: false,
                warning: Some(format!(
                    "Claude Code {version} is outside the tested range \
                     ({min_major}.{min_minor}.x up to but not including {max_major}.{max_minor}) \
                     — the stream-json protocol may have changed"
                )),
            }
        }
    }
}

/// A process's command line (`ps -p <pid> -o command=`), or none when it
/// cannot be read (missing, or not POSIX).
#[must_use]
pub fn command_line_of(pid: i32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// What [`reap_orphan_orchestrator`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReapResult {
    pub reaped: bool,
    pub reason: Option<String>,
}

/// Kill an orchestrator left behind by a console that died. Only a live pid
/// whose command line still looks like the claude child is touched: pids get
/// reused, and killing the wrong process would be far worse than leaving one
/// behind.
#[must_use]
pub fn reap_orphan_orchestrator(pid: Option<i32>, matcher: &str) -> ReapResult {
    if !is_alive(pid) {
        return ReapResult {
            reaped: false,
            reason: None,
        };
    }
    let Some(pid) = pid else {
        return ReapResult {
            reaped: false,
            reason: None,
        };
    };
    let Some(command) = command_line_of(pid) else {
        return ReapResult {
            reaped: false,
            reason: Some(format!(
                "pid {pid} is alive but its command line could not be read — leaving it alone"
            )),
        };
    };
    if !command.contains(matcher) {
        return ReapResult {
            reaped: false,
            reason: Some(format!(
                "pid {pid} is alive but is not a {ORPHAN_MATCHER} process — leaving it alone"
            )),
        };
    }
    match kill(Pid::from_raw(pid), Signal::SIGTERM) {
        Ok(()) => ReapResult {
            reaped: true,
            reason: Some(format!(
                "stopped an orphaned orchestrator (pid {pid}) left by an earlier console"
            )),
        },
        Err(_) => ReapResult {
            reaped: false,
            reason: Some(format!("pid {pid} could not be signalled")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_and_the_tested_range() {
        assert_eq!(
            parse_claude_version("2.1.251 (Claude Code)"),
            Some("2.1.251".to_string())
        );
        assert_eq!(parse_claude_version("no version here"), None);
        assert_eq!(TESTED_CLAUDE_RANGE.0, (2, 1));
        assert!(version_supported(Some("2.1.0")));
        assert!(version_supported(Some("2.1.251")));
        assert!(!version_supported(Some("2.0.9")));
        assert!(!version_supported(Some("2.2.0")));
        assert!(!version_supported(Some("3.0.0")));
        assert!(!version_supported(None));
    }

    /// A `claude --version` stand-in that prints a fixed version.
    fn version_spec(version: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-claude-version.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"{version} (Claude Code)\"\n"),
        )
        .unwrap();
        let spec = format!("sh {}", script.display());
        (dir, spec)
    }

    #[test]
    fn the_version_check_reports_a_supported_version() {
        let (_dir, spec) = version_spec("2.1.251");
        let check = check_claude_version_with_spec(Some(&spec));
        assert_eq!(check.version.as_deref(), Some("2.1.251"));
        assert!(check.supported);
        assert_eq!(check.warning, None);
    }

    #[test]
    fn a_version_outside_the_range_warns_but_is_not_fatal() {
        let (_dir, spec) = version_spec("2.0.9");
        let check = check_claude_version_with_spec(Some(&spec));
        assert_eq!(check.version.as_deref(), Some("2.0.9"));
        assert!(!check.supported);
        let warning = check.warning.expect("a warning names the range");
        assert!(warning.contains("outside the tested range"), "{warning}");
    }

    #[test]
    fn a_missing_binary_reports_a_warning_instead_of_failing() {
        let check = check_claude_version_with_spec(Some("/nonexistent/claude-binary"));
        assert_eq!(check.version, None);
        assert!(!check.supported);
        let warning = check
            .warning
            .expect("the warning explains what to look for");
        assert!(warning.contains("could not run"), "{warning}");
    }

    #[test]
    fn the_reaper_touches_only_a_live_process_that_looks_like_the_child() {
        // none and a dead pid: nothing to do, nothing to say
        assert_eq!(
            reap_orphan_orchestrator(None, ORPHAN_MATCHER),
            ReapResult {
                reaped: false,
                reason: None
            }
        );
        assert_eq!(
            reap_orphan_orchestrator(Some(999_999_999), ORPHAN_MATCHER),
            ReapResult {
                reaped: false,
                reason: None
            }
        );

        // our own process is alive but does not look like the child: this
        // repo path contains "claude", so the match would be fatal — the
        // matcher is the caller's contract, and it must be precise
        let own_pid = i32::try_from(std::process::id()).unwrap_or(1);
        let not_the_child = reap_orphan_orchestrator(Some(own_pid), "definitely-not-a-match");
        assert!(!not_the_child.reaped);
        let reason = not_the_child
            .reason
            .expect("it explains why it left it alone");
        assert!(reason.contains("is not a"), "{reason}");
        assert!(command_line_of(own_pid).is_some());
        assert_eq!(command_line_of(999_999_999), None);

        // a stand-in for an orphaned child: matched by its command line, then killed
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("sleep is available");
        let pid = i32::try_from(child.id()).unwrap_or(1);
        let result = reap_orphan_orchestrator(Some(pid), "sleep");
        assert!(result.reaped, "{result:?}");
        let reason = result.reason.expect("it says what it stopped");
        assert!(
            reason.contains("stopped an orphaned orchestrator"),
            "{reason}"
        );
        let _ = child.wait();
        assert!(!is_alive(Some(pid)), "the sleep was terminated");
    }
}
