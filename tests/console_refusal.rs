//! The console's non-interactive refusal. A worker session has no TTY, and
//! `parl` must meet that with the friendly guidance (exit 1, nothing left
//! behind) instead of failing raw mode later with a bare io error.

#![allow(clippy::unwrap_used)]

#[test]
fn the_console_refuses_a_non_interactive_terminal_with_guidance() {
    let tmp = tempfile::tempdir().unwrap();
    // CARGO_BIN_EXE_parl is the built binary; neither stdio end is a
    // terminal by construction, whatever the test harness itself has
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_parl"))
        .arg("tui")
        // Deliberately exercises the `<cwd>/.parl` fallback below, so the
        // ambient variable is removed rather than pinned.
        .env_remove("PARL_DIR")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(tmp.path())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "stdout: {stderr}");
    assert!(stderr.contains("interactive terminal"), "{stderr}");
    assert!(stderr.contains("parl spawn"), "{stderr}");
    assert!(stderr.contains("parl status"), "{stderr}");
    // the refusal comes before any fleet state is created
    assert!(
        !tmp.path().join(".parl").exists(),
        "the refusal must not leave a .parl behind"
    );
}
