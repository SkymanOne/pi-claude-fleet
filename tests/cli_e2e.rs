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

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::{Value, json};

/// Generous ceilings: three workers build and test on this machine at once,
/// so every wait polls instead of sleeping and every deadline assumes load.
const SETTLE: Duration = Duration::from_secs(40);
const MONITOR_EXIT: Duration = Duration::from_secs(20);

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

/// pi replacement that dies immediately (the monitor's error path).
fn fail_pi() -> PathBuf {
    fixture("fail-pi.mjs")
}

/// The shared fake plus the session files real pi writes into
/// `--session-dir`, for the documented-layout assertions.
fn session_pi() -> PathBuf {
    fixture("fake-pi-session.mjs")
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

fn git(dir: &Path, args: &[&str]) {
    let output = StdCommand::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A git repo with one committed seed file and no `.gitignore` yet — spawn
/// adds the `.parl/` entry itself, which the gitignore and conflict tests
/// assert against.
fn init_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "seed"]);
    (tmp, root)
}

/// Spawn a worker through the real binary with the fake pi; returns the run
/// id parsed from the output's first line (`Spawned <id>`).
fn spawn_ok(
    root: &Path,
    name: &str,
    brief: &str,
    pi: &Path,
    extra_env: &[(&str, &str)],
    flags: &[&str],
) -> String {
    let output = parl()
        .args(["spawn", name])
        .args(flags)
        .args(["--", brief])
        .current_dir(root)
        .env("PARL_PI_BIN", pi_spec(pi))
        .envs(extra_env.iter().copied())
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "spawn failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    stdout
        .lines()
        .next()
        .unwrap()
        .strip_prefix("Spawned ")
        .unwrap_or_else(|| panic!("unexpected spawn output: {stdout}"))
        .to_string()
}

/// Parsed `parl status <name> --json` (the single-run state object).
fn status_json(root: &Path, name: &str) -> Value {
    let output = parl()
        .args(["status", name, "--json"])
        .current_dir(root)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "status {name} failed");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    serde_json::from_str(&stdout)
        .unwrap_or_else(|err| panic!("status {name} was not one JSON object: {err}: {stdout}"))
}

/// Poll `parl status <name> --json` until `check` holds or the timeout lapses.
fn poll_status(
    root: &Path,
    name: &str,
    timeout: Duration,
    check: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let state = status_json(root, name);
        if check(&state) {
            return state;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting on {name}; last state: {state}"
        );
        std::thread::sleep(POLL);
    }
}

/// Wait for any terminal state (what `parl wait` exits on).
fn settled(root: &Path, name: &str) -> Value {
    poll_status(root, name, SETTLE, |state| {
        matches!(
            state["status"].as_str(),
            Some("settled" | "stopped" | "error" | "dead" | "archived")
        )
    })
}

/// `parl wait`'s exit code, for the exit-code matrix.
fn wait_code(root: &Path, name: &str, timeout_secs: u64) -> i32 {
    parl()
        .args(["wait", name, "--timeout", &timeout_secs.to_string()])
        .current_dir(root)
        .output()
        .unwrap()
        .status
        .code()
        .unwrap_or(-1)
}

fn monitor_pid(run_json: &Path) -> Option<i32> {
    let raw = std::fs::read_to_string(run_json).ok()?;
    let state: Value = serde_json::from_str(&raw).ok()?;
    state["pid"].as_i64().map(|pid| pid as i32)
}

/// Block until the run's detached monitor is gone, so a test never leaves a
/// stray process behind; a SIGKILL is the last resort. The monitor is
/// orphaned (its parent, `parl spawn`, has exited), so an exited pid is
/// reaped by launchd and `kill(pid, 0)` reads it as gone — checked with the
/// product's own liveness rule.
fn reap_monitor(root: &Path, run_id: &str) {
    let run_json = root
        .canonicalize()
        .unwrap()
        .join(parl::paths::STATE_DIR_NAME)
        .join("runs")
        .join(run_id)
        .join("run.json");
    let deadline = std::time::Instant::now() + MONITOR_EXIT;
    loop {
        let Some(pid) = monitor_pid(&run_json) else {
            return;
        };
        if !parl::fleet::run::is_alive(Some(pid)) {
            return;
        }
        if std::time::Instant::now() >= deadline {
            let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
            return;
        }
        std::thread::sleep(POLL);
    }
}

/// Safety net for failed assertions: a bounded reap when the test itself
/// did not get there. Declared before the temp dir so it drops (kills)
/// while the tree still exists.
struct ReapOnDrop {
    run_json: PathBuf,
}

impl Drop for ReapOnDrop {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while let Some(pid) = monitor_pid(&self.run_json) {
            if !parl::fleet::run::is_alive(Some(pid)) {
                return;
            }
            if std::time::Instant::now() >= deadline {
                let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
                return;
            }
            std::thread::sleep(POLL);
        }
    }
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

// ---------------------------------------------------------------------------
// 3. A full worker lifecycle against the fake pi.
// ---------------------------------------------------------------------------

/// spawn → status (table and --json) → send → answer a fleet_ask question →
/// wait → report → output/logs/attach → diff → merge → cleanup, then the
/// on-disk proof: the branch really merged, the worktree and branch are
/// gone, the run reads `archived`, and `.parl` holds exactly the documented
/// tree — none of the removed one.
#[test]
fn full_worker_lifecycle_happy_path() {
    let _serial = serial();
    let (_tmp, root) = init_repo();
    let run_id = spawn_ok(
        &root,
        "alpha",
        "create hello.txt with greeting content",
        &session_pi(),
        &[
            ("FAKE_PI_WRITE_HELLO", "1"),
            ("FAKE_PI_ASK", "1"),
            ("FAKE_PI_DELAY_MS", "4000"),
        ],
        &[],
    );
    assert!(
        regex::Regex::new(r"^alpha-\d{14}$")
            .unwrap()
            .is_match(&run_id),
        "{run_id}"
    );
    let fleet = root
        .canonicalize()
        .unwrap()
        .join(parl::paths::STATE_DIR_NAME);
    let run_dir = fleet.join("runs").join(&run_id);
    let _reap_guard = ReapOnDrop {
        run_json: run_dir.join("run.json"),
    };

    let state = status_json(&root, "alpha");
    assert_eq!(state["id"], run_id.as_str(), "{state}");
    assert_eq!(state["name"], "alpha");
    assert_eq!(state["taskBrief"], "create hello.txt with greeting content");
    let worktree = PathBuf::from(state["worktree"].as_str().unwrap());
    let branch = state["branch"].as_str().unwrap().to_string();
    assert!(branch.starts_with("parl/alpha-"), "{branch}");
    assert!(
        worktree.join("seed.txt").exists(),
        "the worktree is a checkout"
    );
    assert!(state["baseCommit"].as_str().is_some());
    assert_eq!(state["isGit"], json!(true));

    // The fleet table shows the run.
    let (code, stdout, _) = run(&root, &["status"]);
    assert_eq!(code, 0);
    assert!(
        stdout.contains("NAME") && stdout.contains("STATE"),
        "{stdout}"
    );
    assert!(stdout.contains("alpha"), "{stdout}");

    // Steer while the worker runs (it blocks on its question, so the window
    // is wide), then wait for the question to surface as `blocked`.
    let (code, stdout, stderr) = run(&root, &["send", "alpha", "--", "use tabs not spaces"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.trim(), "steer queued for alpha", "{stdout}");
    let blocked = poll_status(&root, "alpha", SETTLE, |state| {
        state["pendingQuestion"].is_object() || state["pendingDialog"].is_object()
    });
    let question_id = blocked["pendingQuestion"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(blocked["status"], "blocked", "{blocked}");
    assert_eq!(blocked["pendingQuestion"]["question"], "bcrypt or argon2?");

    // The worker has not finished, so there is no report yet.
    let (code, _, stderr) = run(&root, &["report", "alpha"]);
    assert_eq!(code, 2, "{stderr}");

    // Answer the question; the worker proceeds and settles.
    let (code, stdout, stderr) = run(&root, &["answer", "alpha", "--", "argon2"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains(&format!("answer queued for alpha (question {question_id})")),
        "{stdout}"
    );
    assert_eq!(
        wait_code(&root, "alpha", 60),
        0,
        "an answered, settled run waits with exit 0"
    );
    let state = settled(&root, "alpha");
    assert_eq!(state["status"], "settled", "{state}");
    assert_eq!(state["pendingQuestion"], json!(null));

    // The report is the worker's file, enriched with the answer and the
    // steering, plus the orchestrator-side appendix.
    let (code, stdout, stderr) = run(&root, &["report", "alpha"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("# Fleet Report:"), "{stdout}");
    assert!(stdout.contains("## Status\ndone"), "{stdout}");
    assert!(stdout.contains("Answer received: argon2"), "{stdout}");
    assert!(
        stdout.contains("## Steering received\n- use tabs not spaces"),
        "{stdout}"
    );
    assert!(
        stdout.contains("## Steering log (orchestrator-side, most recent last)"),
        "{stdout}"
    );
    assert!(stdout.contains("- [orchestrator]"), "{stdout}");
    assert!(stdout.contains("use tabs not spaces"), "{stdout}");

    // Output: the captured last text, or the tool trail with --tail.
    let (code, stdout, _) = run(&root, &["output", "alpha"]);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "Working: wrote hello.txt");
    let (code, stdout, _) = run(&root, &["output", "alpha", "--tail", "5"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("bash: hi"), "{stdout}");
    assert!(stdout.contains("fleet_ask:"), "{stdout}");
    let (code, stdout, _) = run(&root, &["logs", "alpha", "--tail", "50"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("agent_settled"), "{stdout}");
    let (code, stdout, stderr) = run(&root, &["attach", "alpha"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("▶ task: create hello.txt"), "{stdout}");
    assert!(stdout.contains("● settled"), "{stdout}");
    assert!(
        stdout.contains("▶ orchestrator: use tabs not spaces"),
        "{stdout}"
    );
    assert!(
        stderr.contains("static tail — run `parl` for the live console"),
        "{stderr}"
    );

    // The single-run JSON carries the session file pi wrote.
    let state = status_json(&root, "alpha");
    let session_file = state["sessionFile"].as_str().unwrap_or_default();
    assert!(
        session_file.starts_with(run_dir.join("session").to_str().unwrap())
            && session_file.ends_with(".jsonl"),
        "{state}"
    );
    assert!(Path::new(session_file).is_file());

    // Diff sees the worker's committed work once it is committed.
    git(&worktree, &["add", "."]);
    git(&worktree, &["commit", "-qm", "worker hello"]);
    let (code, stdout, _) = run(&root, &["diff", "alpha"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("hello.txt"), "{stdout}");
    let (code, stdout, _) = run(&root, &["diff", "alpha", "--name-only"]);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "hello.txt");

    // Merge lands the branch in the recorded checkout.
    let (code, stdout, stderr) = run(&root, &["merge", "alpha"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains(&format!("merged {branch} into")),
        "{stdout}"
    );
    assert!(stdout.contains("Run your integration checks"), "{stdout}");
    assert_eq!(
        std::fs::read_to_string(root.join("hello.txt")).unwrap(),
        "hi\n",
        "the branch actually landed"
    );

    // Cleanup archives the run, removes the worktree and deletes the merged
    // branch.
    let (code, stdout, stderr) = run(&root, &["cleanup", "alpha"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains(&format!("archived {run_id}")), "{stdout}");
    assert!(!worktree.exists(), "the worktree is gone");
    let listed = StdCommand::new("git")
        .args(["branch", "--list", &branch])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&listed.stdout).trim().is_empty());
    let (code, stdout, _) = run(&root, &["cleanup", "alpha"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("already archived"), "{stdout}");

    // The run reads archived; the default fleet view hides it.
    assert_eq!(status_json(&root, "alpha")["status"], "archived");
    let (code, stdout, _) = run(&root, &["status", "--json"]);
    assert_eq!(code, 0);
    assert_eq!(stdout.trim(), "[]", "archived runs are hidden by default");
    let (code, stdout, _) = run(&root, &["status", "--all", "--json"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("archived"), "{stdout}");

    reap_monitor(&root, &run_id);

    // ------------------------------------------------------------------
    // The `.parl` layout is what AGENTS.md says it is.
    // ------------------------------------------------------------------
    for path in [
        run_dir.join("run.json"),
        run_dir.join("events.jsonl"),
        run_dir.join("inbox.jsonl"),
        run_dir.join("outbox.jsonl"),
        run_dir.join("report.md"),
        run_dir.join("pi.log"),
        run_dir.join("session"),
        fleet.join("runs"),
        fleet.join("orchestrator"),
        fleet.join("pi").join("extensions").join("fleet-worker.ts"),
        fleet
            .join("pi")
            .join("skills")
            .join("fleet-worker-report")
            .join("SKILL.md"),
    ] {
        assert!(
            path.exists(),
            "documented layout missing: {}",
            path.display()
        );
    }
    for gone in [
        fleet.join("reports"),
        root.join("reports"),
        fleet.join("orchestrator.json"),
        run_dir.join("monitor.log"),
        run_dir.join("progress.md"),
        fleet.join("progress.md"),
        run_dir.join("control.jsonl"),
        fleet.join("tui.lock"),
    ] {
        assert!(
            !path_exists(&gone),
            "removed layout came back: {}",
            gone.display()
        );
    }
    // The mailbox files carry real envelopes.
    let inbox = std::fs::read_to_string(run_dir.join("inbox.jsonl")).unwrap();
    assert!(
        inbox.contains("\"steer\"") && inbox.contains("\"answer\""),
        "{inbox}"
    );
    let outbox = std::fs::read_to_string(run_dir.join("outbox.jsonl")).unwrap();
    assert!(outbox.contains("\"question\""), "{outbox}");
    // events.jsonl captured the run transcript.
    let events = std::fs::read_to_string(run_dir.join("events.jsonl")).unwrap();
    assert!(events.contains("\"task_prompt\""), "{events}");
    assert!(events.contains("\"worker_question\""), "{events}");
    assert!(events.contains("\"agent_settled\""), "{events}");
}

fn path_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

// ---------------------------------------------------------------------------
// 2. The exit-code matrix — the contract scripts depend on.
// ---------------------------------------------------------------------------

/// One slow, running worker drives every refusal exit code: merging an
/// unsettled run (1), answering with nothing pending (1), a wait timeout (3),
/// then the run ends stopped (4 via `wait`), and steering a finished run is
/// refused (1).
#[test]
fn refusal_exit_codes_on_a_running_then_stopped_run() {
    let _serial = serial();
    let (tmp, root) = plain_dir();
    let run_id = spawn_ok(
        &root,
        "slowpoke",
        "long task",
        &fake_pi(),
        &[("FAKE_PI_DELAY_MS", "20000")],
        &["--no-worktree"],
    );
    let _reap_guard = ReapOnDrop {
        run_json: tmp
            .path()
            .join(parl::paths::STATE_DIR_NAME)
            .join("runs")
            .join(&run_id)
            .join("run.json"),
    };

    // A running run cannot be merged (1) and has nothing to answer (1).
    let (code, _, stderr) = run(&root, &["merge", "slowpoke"]);
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains("is running"), "{stderr}");
    assert!(
        stderr.contains("only settled runs can be merged"),
        "{stderr}"
    );
    let (code, _, stderr) = run(&root, &["answer", "slowpoke", "--", "argon2"]);
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains("no pending question"), "{stderr}");

    // A wait that outlives its timeout is exit 3, not an error.
    assert_eq!(wait_code(&root, "slowpoke", 1), 3, "timeout is exit 3");
    let (code, _, stderr) = run(&root, &["wait", "slowpoke", "--timeout", "1"]);
    assert_eq!(code, 3);
    assert!(stderr.contains("timed out after 1s"), "{stderr}");

    // Stop settles the run as stopped; `wait` then reports the bad end (4).
    let (code, _, stderr) = run(&root, &["stop", "slowpoke"]);
    assert_eq!(code, 0, "{stderr}");
    let state = settled(&root, "slowpoke");
    assert_eq!(state["status"], "stopped", "{state}");
    assert_eq!(
        wait_code(&root, "slowpoke", 30),
        4,
        "a stopped run is exit 4"
    );

    // A finished run refuses steering (1) with the resume hint.
    let (code, _, stderr) = run(&root, &["send", "slowpoke", "--", "too late"]);
    assert_eq!(code, 1, "{stderr}");
    assert!(stderr.contains("steering refused"), "{stderr}");
    assert!(
        stderr.contains("parl spawn slowpoke-2 --session"),
        "carries the resume hint: {stderr}"
    );

    reap_monitor(&root, &run_id);
}

/// A worker whose pi dies without settling reads `error`, its reason names
/// the cause, `wait` is exit 4, and with no report and no captured text
/// `report` is exit 2.
#[test]
fn an_error_run_names_its_cause_and_report_is_exit_two() {
    let _serial = serial();
    let (tmp, root) = plain_dir();
    let run_id = spawn_ok(&root, "doomed", "b", &fail_pi(), &[], &["--no-worktree"]);
    let _reap_guard = ReapOnDrop {
        run_json: tmp
            .path()
            .join(parl::paths::STATE_DIR_NAME)
            .join("runs")
            .join(&run_id)
            .join("run.json"),
    };

    assert_eq!(wait_code(&root, "doomed", 30), 4, "an error run is exit 4");
    let state = settled(&root, "doomed");
    assert_eq!(state["status"], "error", "{state}");
    let error = state["error"].as_str().unwrap_or_default();
    assert!(error.contains("exited with code 1"), "{error}");
    assert!(error.contains("model provider unreachable"), "{error}");

    let (code, _, stderr) = run(&root, &["report", "doomed"]);
    assert_eq!(code, 2, "no report and no captured text: {stderr}");
    assert!(
        stderr.contains("no report file and no captured output for doomed"),
        "{stderr}"
    );

    reap_monitor(&root, &run_id);
}

/// A conflicting branch merges with exit 5: the merge is aborted, the
/// checkout is left clean, and the message tells the caller to have the
/// worker rebase — the orchestrator never edits files itself.
#[test]
fn a_conflicting_branch_merges_with_exit_five_and_a_clean_checkout() {
    let _serial = serial();
    let (_tmp, root) = init_repo();
    let run_id = spawn_ok(
        &root,
        "conflicter",
        "write hello.txt",
        &fake_pi(),
        &[("FAKE_PI_WRITE_HELLO", "1")],
        &[],
    );
    let _reap_guard = ReapOnDrop {
        run_json: root
            .canonicalize()
            .unwrap()
            .join(parl::paths::STATE_DIR_NAME)
            .join("runs")
            .join(&run_id)
            .join("run.json"),
    };

    let state = settled(&root, "conflicter");
    assert_eq!(state["status"], "settled", "{state}");
    let branch = state["branch"].as_str().unwrap().to_string();
    let worktree = PathBuf::from(state["worktree"].as_str().unwrap());
    assert!(branch.starts_with("parl/conflicter-"), "{branch}");

    // The fake wrote hello.txt but did not commit; the worker commits.
    git(&worktree, &["add", "."]);
    git(&worktree, &["commit", "-qm", "worker hello"]);
    let base = state["baseCommit"].as_str().unwrap().to_string();

    // A conflicting change lands on the main checkout.
    std::fs::write(root.join("hello.txt"), "different\n").unwrap();
    git(&root, &["add", "hello.txt"]);
    git(&root, &["commit", "-qm", "conflict"]);

    let (code, stdout, stderr) = run(&root, &["merge", "conflicter"]);
    assert_eq!(code, 5, "stdout: {stdout}\nstderr: {stderr}");
    assert!(
        stdout.is_empty(),
        "a conflict prints to stderr only: {stdout:?}"
    );
    assert!(stderr.contains("conflicts in:\nhello.txt"), "{stderr}");
    assert!(
        stderr.contains("The merge was aborted; the checkout is clean"),
        "{stderr}"
    );
    assert!(
        stderr.contains(&format!("rebase its branch {branch}")),
        "{stderr}"
    );
    assert!(
        stderr.contains(&base[..7]),
        "names the commit the branch was cut from: {stderr}"
    );

    // The abort left the checkout clean and the worker's file untouched.
    let status = StdCommand::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .unwrap();
    let porcelain_text = String::from_utf8_lossy(&status.stdout).into_owned();
    let porcelain: Vec<&str> = porcelain_text
        .lines()
        .filter(|line| !line.is_empty() && *line != "?? .gitignore")
        .collect();
    assert_eq!(porcelain, Vec::<&str>::new(), "{porcelain:?}");
    assert!(!root.join(".git").join("MERGE_HEAD").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("hello.txt")).unwrap(),
        "different\n"
    );

    reap_monitor(&root, &run_id);
}
