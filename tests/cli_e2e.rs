#![allow(clippy::unwrap_used)]

//! End-to-end tests driving the built `parl` binary the way a user (or the
//! orchestrator's scripts) invokes it: every subcommand dispatched, the
//! exit-code contract, a full worker lifecycle against the scripted fake pi,
//! the `.parl` layout on disk, and the requirements that travel inside the
//! binary (the orchestrator prompt and the pi worker extension). Hermetic:
//! no real `pi`, no real `claude`, no network, no tokens — everything runs
//! against `tests/fixtures/` fakes, like `mcp_stdio.rs` and
//! `worker_monitor.rs`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command as StdCommand, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};

/// Subprocess-heavy tests run one at a time (same reason as `mcp_stdio.rs`).
static SERIAL: Mutex<()> = Mutex::new(());

/// Poll cadence for the polling waits.
const POLL: Duration = Duration::from_millis(150);

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn parl() -> assert_cmd::Command {
    let mut command = assert_cmd::Command::new(assert_cmd::cargo_bin!("parl"));
    command
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t");
    command
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn fake_pi() -> PathBuf {
    fixture("fake-pi-parl.mjs")
}

/// `PARL_PI_BIN` is an executable spec split on spaces.
fn pi_spec(path: &Path) -> String {
    format!("node {}", path.display())
}

/// A plain (non-git) directory for runs without a worktree.
fn plain_dir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    (tmp, root)
}

/// Run a subcommand and return (exit code, stdout, stderr).
fn run(root: &Path, args: &[&str]) -> (i32, String, String) {
    let output = parl().args(args).current_dir(root).output().unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

// ---------------------------------------------------------------------------
// 1. Dispatch and the CLI surface.
// ---------------------------------------------------------------------------

#[test]
fn help_and_version_exit_zero_and_hide_the_internal_monitors() {
    let help = parl().arg("--help").output().unwrap();
    assert_eq!(help.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&help.stdout);
    for public in [
        "spawn", "status", "wait", "output", "logs", "send", "followup", "answer", "stop",
        "report", "diff", "merge", "cleanup", "attach", "mcp",
    ] {
        assert!(
            stdout.contains(public),
            "--help mentions {public}: {stdout}"
        );
    }
    assert!(stdout.contains("Usage: parl"), "{stdout}");
    // The two internal monitors are hidden from the public help…
    assert!(!stdout.contains("orchestrator-monitor"), "{stdout}");
    assert!(!stdout.contains("fleet-dir"), "{stdout}");

    let version = parl().arg("--version").output().unwrap();
    assert_eq!(version.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&version.stdout);
    assert!(
        stdout.contains("parl") && stdout.contains("0.2.0"),
        "{stdout}"
    );

    // …but respond to --help themselves: they parse.
    let monitor = parl().args(["monitor", "--help"]).output().unwrap();
    assert_eq!(monitor.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&monitor.stdout);
    assert!(
        stdout.contains("--fleet-dir") && stdout.contains("--run"),
        "{stdout}"
    );
    let orch = parl()
        .args(["orchestrator-monitor", "--help"])
        .output()
        .unwrap();
    assert_eq!(orch.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&orch.stdout).contains("--fleet-dir"),
        "{}",
        String::from_utf8_lossy(&orch.stdout)
    );
}

#[test]
fn unknown_subcommand_and_missing_required_arguments_exit_one() {
    let (code, _, stderr) = run(&std::env::temp_dir(), &["frobnicate"]);
    assert_eq!(code, 1, "stderr: {stderr}");
    assert!(stderr.contains("unrecognized subcommand"), "{stderr}");

    for args in [
        vec!["wait"],          // <name> required
        vec!["spawn"],         // <name> required
        vec!["cleanup"],       // <name|all> required
        vec!["send", "ghost"], // message required after --
        vec!["monitor"],       // --run required for the internal monitor
    ] {
        let (code, _, stderr) = run(&std::env::temp_dir(), &args);
        assert_eq!(code, 1, "parl {args:?} → {code}: {stderr}");
    }
}

/// Every public subcommand reaches its implementation and answers with a
/// sane exit code even on an empty fleet: refusals name the missing run, and
/// the read-only queries answer.
#[test]
fn every_public_subcommand_reaches_its_implementation() {
    let (_tmp, root) = plain_dir();

    let (code, stdout, _) = run(&root, &["status"]);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "(no runs)");
    let (code, stdout, _) = run(&root, &["status", "--json"]);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "[]");

    // spawn's refusals are ops results, not parse errors.
    let (code, _, stderr) = run(&root, &["spawn", "x", "--", "  "]);
    assert_eq!(code, 1);
    assert!(stderr.contains("task brief required"), "{stderr}");
    let (code, _, stderr) = run(&root, &["spawn", "!!!", "--", "b"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("<name> required"), "{stderr}");
    let (code, _, stderr) = run(
        &root,
        &["spawn", "x", "--model", "no-such-model", "--", "b"],
    );
    assert_eq!(
        code, 2,
        "an unknown model is refused with the NoReport code: {stderr}"
    );
    assert!(stderr.contains("unknown model"), "{stderr}");
    // The model check happens before anything is created.
    assert!(
        root.join(parl::paths::STATE_DIR_NAME)
            .join("runs")
            .read_dir()
            .map(|entries| entries.count())
            .unwrap_or(0)
            == 0,
        "no run was created"
    );

    // Everything that addresses a run refuses an unknown one with exit 1.
    for args in [
        vec!["status", "ghost"],
        vec!["wait", "ghost"],
        vec!["output", "ghost"],
        vec!["logs", "ghost"],
        vec!["report", "ghost"],
        vec!["attach", "ghost"],
        vec!["send", "ghost", "--", "m"],
        vec!["followup", "ghost", "--", "m"],
        vec!["answer", "ghost", "--", "m"],
        vec!["stop", "ghost"],
        vec!["diff", "ghost"],
        vec!["merge", "ghost"],
        vec!["cleanup", "ghost"],
    ] {
        let (code, _, stderr) = run(&root, &args);
        assert_eq!(code, 1, "parl {args:?} → {code}: {stderr}");
        assert!(
            stderr.contains("No run found matching \"ghost\""),
            "parl {args:?}: {stderr}"
        );
    }
}

/// The hidden worker monitor parses and reaches its implementation: a run
/// without a readable run.json is a startup failure with exit 1.
#[test]
fn the_hidden_worker_monitor_reaches_its_implementation() {
    let (_tmp, root) = plain_dir();
    let fleet_dir = root.join(parl::paths::STATE_DIR_NAME);
    std::fs::create_dir_all(&fleet_dir).unwrap();
    let (code, _, stderr) = run(
        &root,
        &[
            "monitor",
            "--fleet-dir",
            fleet_dir.to_str().unwrap(),
            "--run",
            "ghost-20260828141530",
        ],
    );
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains("cannot start"), "{stderr}");
}

/// The hidden orchestrator monitor parses and reaches its implementation: an
/// unspawnable claude is recorded (claude.log) and the monitor ends cleanly
/// instead of hanging or crashing.
#[test]
fn the_hidden_orchestrator_monitor_reaches_its_implementation() {
    let (_tmp, root) = plain_dir();
    let fleet_dir = root.join(parl::paths::STATE_DIR_NAME);
    let output = StdCommand::new(assert_cmd::cargo_bin!("parl"))
        .args(["orchestrator-monitor", "--fleet-dir"])
        .arg(&fleet_dir)
        .env("PARL_CLAUDE_BIN", "definitely-not-a-real-claude")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(&root)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "the monitor ends cleanly when claude cannot start"
    );
    // The boot state landed in the documented layout, and the failure was
    // diagnosed in the raw protocol log.
    assert!(fleet_dir.join("orchestrator/state.json").is_file());
    let claude_log =
        std::fs::read_to_string(fleet_dir.join("orchestrator/claude.log")).unwrap_or_default();
    assert!(claude_log.contains("could not spawn"), "{claude_log}");
}

/// `parl mcp` serves the fleet tools over stdio; a clean disconnect exits 0.
#[test]
fn mcp_serves_the_fleet_tools_over_stdio() {
    let _serial = serial();
    let (_tmp, root) = plain_dir();
    let mut child = StdCommand::new(assert_cmd::cargo_bin!("parl"))
        .arg("mcp")
        .current_dir(&root)
        .env("PARL_PI_BIN", pi_spec(&fake_pi()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let send = |stdin: &mut ChildStdin, value: &Value| {
        stdin.write_all(value.to_string().as_bytes()).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
    };
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "parl-e2e", "version": "0"},
            },
        }),
    );
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(
        response["result"]["serverInfo"]["name"], "fleet",
        "{response}"
    );
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
    );
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    );
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    let mut names: Vec<&str> = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    names.sort_unstable();
    let mut expected = parl::mcp::server::FLEET_TOOL_NAMES.to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected, "{names:?}");

    // Disconnecting stdin ends the server cleanly.
    drop(stdin);
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let code = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status.code();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the mcp server did not exit after stdin closed"
        );
        std::thread::sleep(POLL);
    };
    assert_eq!(code, Some(0));
}
