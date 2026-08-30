//! Integrating a worker's work: diff against its base, merge its branch
//! (exit 5 on conflicts), and cleanup (worktree + branch removal, archive).
//! These are the sharp edges: diff and merge only see committed work, the
//! merge lands in the run's recorded repo root wherever the CLI is invoked
//! from, and conflicts are aborted so the worker can rebase — the
//! orchestrator never edits files itself. (Ported from `diffCore`,
//! `mergeCore` and `cleanupCore`/`cleanupRuns` in the TypeScript
//! `src/commands.ts`.)

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::cli::ExitCode;
use crate::fleet::envelope::{Envelope, Party, append_envelope};
use crate::fleet::run::{self, RunRef, RunStatus};
use crate::git::{self, MergeOutcome};
use crate::util::now_ms;

use super::steer::resolve_run_with_env;
use super::{CommandResult, fail, ok, print_result, resolve_fleet_dir};

/// How long `cleanup --force` waits for an aborted run to be terminal *and*
/// have its monitor gone, so the monitor's final flush cannot race the
/// archive write.
pub const CLEANUP_ABORT_WAIT_MS: u64 = 10_000;

/// What `diff` found, for programmatic callers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffData {
    /// False when the run has no isolated worktree (or it is gone).
    pub applicable: bool,
    pub text: String,
    /// Uncommitted paths in the worktree (invisible to diff/merge).
    pub dirty: Vec<String>,
}

/// What `merge` did, for programmatic callers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeData {
    pub branch: String,
    /// The checkout the branch was merged into (the run's recorded repo root).
    pub into: String,
    /// `false` for `--no-commit` (staged only) and conflicts.
    pub committed: bool,
    pub conflicts: Vec<String>,
}

/// What `cleanup` archived and refused, for programmatic callers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupData {
    pub archived: Vec<String>,
    pub refused: Vec<String>,
}

/// The worker's changes vs its base (git diff --stat, or --name-only).
pub async fn diff(
    name: &str,
    cwd: Option<&Path>,
    name_only: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(diff_core(name, cwd, name_only).await?))
}

/// Merge the settled worker's branch into the run's recorded checkout.
/// Exit 5 on conflicts.
pub async fn merge(
    name: &str,
    cwd: Option<&Path>,
    no_commit: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    Ok(print_result(merge_core(name, cwd, no_commit).await?))
}

/// Remove a run's worktree + branch and archive it (`<name>` or `all`).
pub async fn cleanup(
    target: &str,
    cwd: Option<&Path>,
    force: bool,
) -> anyhow::Result<crate::cli::ExitCode> {
    let fleet = resolve_fleet_dir(cwd).await?;
    Ok(print_result(
        cleanup_runs(fleet.paths.root(), target, force).await?,
    ))
}

/// The diff core: committed work only. A dirty worktree warns on stderr —
/// uncommitted changes are invisible to diff and merge.
pub async fn diff_core(
    name: &str,
    cwd: Option<&Path>,
    name_only: bool,
) -> anyhow::Result<CommandResult<DiffData>> {
    diff_core_with_env(name, cwd, name_only, super::ambient_parl_dir().as_deref()).await
}

/// [`diff_core`] with the `$PARL_DIR` value injected (tests pass `None`);
/// the dashboard's poller pins its own anchored fleet dir instead.
pub(crate) async fn diff_core_with_env(
    name: &str,
    cwd: Option<&Path>,
    name_only: bool,
    parl_dir: Option<&str>,
) -> anyhow::Result<CommandResult<DiffData>> {
    let (_paths, target) = resolve_run_with_env(name, cwd, parl_dir).await?;
    let state = &target.state;
    let worktree = state
        .worktree
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.exists());
    let Some(worktree) = worktree else {
        let text = "not applicable (run has no isolated worktree)";
        return Ok(ok(
            DiffData {
                applicable: false,
                text: text.to_string(),
                dirty: Vec::new(),
            },
            vec![text.to_string()],
        ));
    };
    let base = state
        .base_commit
        .clone()
        .or_else(|| state.base.clone())
        .unwrap_or_else(|| "HEAD".to_string());
    let text = match git::diff_against_base(&worktree, &base, name_only).await {
        Ok(out) if out.is_empty() => "(no changes)".to_string(),
        Ok(text) => text,
        Err(err) => return Ok(fail(ExitCode::Error, vec![format!("{err:#}")])),
    };
    let dirty = git::dirty_files(&worktree).await;
    // Built by hand: `ok` zeroes err, and the dirty warning must survive.
    Ok(CommandResult {
        code: ExitCode::Ok,
        out: vec![text.clone()],
        err: if dirty.is_empty() {
            Vec::new()
        } else {
            vec![dirty_warning(&dirty, "diff", "merge will not include them")]
        },
        data: DiffData {
            applicable: true,
            text,
            dirty,
        },
    })
}

/// Uncommitted worker output is invisible to diff/merge and lost by
/// `cleanup --force`; the warning names the files so the loss is visible.
fn dirty_warning(files: &[String], command: &str, consequence: &str) -> String {
    format!(
        "{command}: warning — worktree has {} uncommitted change(s) (worker did not commit); {consequence}:\n{}",
        files.len(),
        files
            .iter()
            .map(|f| format!("  {f}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// Merge the settled worker's branch into the checkout the run was spawned
/// from, wherever this was invoked from. Exit 5 on conflicts; the merge is
/// always rolled back so the checkout stays clean and the worker can rebase
/// in its own worktree — the orchestrator never edits files itself.
pub async fn merge_core(
    name: &str,
    cwd: Option<&Path>,
    no_commit: bool,
) -> anyhow::Result<CommandResult<MergeData>> {
    merge_core_with_env(name, cwd, no_commit, super::ambient_parl_dir().as_deref()).await
}

/// [`merge_core`] with the `$PARL_DIR` value injected (tests pass `None`).
pub(crate) async fn merge_core_with_env(
    name: &str,
    cwd: Option<&Path>,
    no_commit: bool,
    parl_dir: Option<&str>,
) -> anyhow::Result<CommandResult<MergeData>> {
    let (_paths, target) = resolve_run_with_env(name, cwd, parl_dir).await?;
    let state = &target.state;
    let derived = run::derive_status(state, run::is_alive, now_ms());
    if derived != RunStatus::Settled {
        return Ok(fail(
            ExitCode::Error,
            vec![format!(
                "merge: run {} is {derived} — only settled runs can be merged.",
                state.name
            )],
        ));
    }
    let Some(branch) = state.branch.clone() else {
        return Ok(fail(
            ExitCode::Error,
            vec![format!(
                "merge: run {} has no branch (spawned without a worktree) — nothing to merge.",
                state.name
            )],
        ));
    };
    // The orchestrating checkout is the repo the run was spawned from,
    // wherever we're invoked from.
    let Some(repo_root) = state.repo_root.as_deref().map(PathBuf::from) else {
        return Ok(fail(
            ExitCode::Error,
            vec![format!(
                "merge: run {} has no git checkout to merge into (repoRoot: none).",
                state.name
            )],
        ));
    };
    if !git::is_git_repo(&repo_root).await {
        return Ok(fail(
            ExitCode::Error,
            vec![format!(
                "merge: run {} has no git checkout to merge into (repoRoot: {}).",
                state.name,
                repo_root.display()
            )],
        ));
    }
    let mut err: Vec<String> = Vec::new();
    if let Some(worktree) = state.worktree.as_deref() {
        let dirty = git::dirty_files(Path::new(worktree)).await;
        if !dirty.is_empty() {
            err.push(dirty_warning(
                &dirty,
                "merge",
                "they are not part of the branch",
            ));
        }
    }
    match git::merge_branch(&repo_root, &branch, no_commit, true).await {
        MergeOutcome::Conflicted(files) => {
            let base = state
                .base_commit
                .as_deref()
                .and_then(|c| c.get(..7).map(str::to_string))
                .unwrap_or_else(|| "the base commit".to_string());
            err.push(format!(
                "merge: conflicts in:\n{}\nThe merge was aborted; the checkout is clean. \
Have the worker rebase its branch {branch} onto the current HEAD of {} (it was cut from {base}) \
in its own worktree, resolve the conflicts there, commit, and then merge again.",
                files.join("\n"),
                repo_root.display(),
            ));
            Ok(CommandResult {
                code: crate::cli::ExitCode::MergeConflict,
                out: Vec::new(),
                err,
                data: MergeData {
                    branch,
                    into: repo_root.to_string_lossy().into_owned(),
                    committed: false,
                    conflicts: files,
                },
            })
        }
        MergeOutcome::Failed(stderr) => Ok(fail(
            ExitCode::Error,
            vec![format!("merge: git merge failed:\n{}", stderr.trim())],
        )),
        outcome => {
            let staged = matches!(outcome, MergeOutcome::Staged);
            let mut out = vec![format!(
                "merged {branch} into {}{}",
                repo_root.display(),
                if staged {
                    " (staged, not committed)"
                } else {
                    ""
                }
            )];
            out.push("Run your integration checks before cleanup.".to_string());
            Ok(CommandResult {
                code: ExitCode::Ok,
                out,
                err,
                data: MergeData {
                    branch,
                    into: repo_root.to_string_lossy().into_owned(),
                    committed: !no_commit,
                    conflicts: Vec::new(),
                },
            })
        }
    }
}

/// The same cleanup, for callers that already know the fleet dir (the
/// console, the reaper). Archived by setting the status: reports and events
/// are always kept.
pub async fn cleanup_runs(
    fleet_dir: &Path,
    target: &str,
    force: bool,
) -> anyhow::Result<CommandResult<CleanupData>> {
    if target.trim().is_empty() {
        anyhow::bail!("cleanup: <name|all> required");
    }
    let all = target.trim() == "all";
    let targets: Vec<RunRef> = if all {
        run::list_runs(fleet_dir)
            .into_iter()
            .filter_map(|r| {
                run::load_state(&r.run_dir).ok().map(|state| RunRef {
                    run_id: r.run_id,
                    run_dir: r.run_dir,
                    state,
                })
            })
            .collect()
    } else {
        vec![run::find_run(fleet_dir, target)?]
    };

    let mut out: Vec<String> = Vec::new();
    let mut err: Vec<String> = Vec::new();
    let mut data = CleanupData::default();
    let mut refused_any = false;
    for target in targets {
        if target.state.status == RunStatus::Archived {
            if !all {
                out.push(format!("{} is already archived", target.run_id));
            }
            continue;
        }
        let derived = run::derive_status(&target.state, run::is_alive, crate::util::now_ms());
        if !derived.is_terminal() {
            if !force {
                // `all` skips and moves on; a single named run is a refusal.
                let verb = if all { "skipping" } else { "refusing" };
                err.push(format!(
                    "cleanup: {verb} {} ({derived}) — use --force to abort and clean.",
                    target.state.name
                ));
                data.refused.push(target.run_id.clone());
                if !all {
                    refused_any = true;
                }
                continue;
            }
            let stopped = abort_and_wait(&target).await;
            if !stopped {
                err.push(format!(
                    "cleanup: {} did not stop within {}s — archiving anyway",
                    target.state.name,
                    CLEANUP_ABORT_WAIT_MS / 1000
                ));
            }
        }
        if let (Some(worktree), Some(repo_root)) = (
            target.state.worktree.clone(),
            target.state.repo_root.clone(),
        ) {
            let removed = git::remove_worktree(
                Path::new(&repo_root),
                Path::new(&worktree),
                target.state.branch.as_deref(),
                force,
            )
            .await?;
            if !removed.worktree_removed && Path::new(&worktree).exists() {
                let verb = if all { "skipping" } else { "refusing" };
                err.push(format!(
                    "cleanup: {verb} {} — worktree {worktree} could not be removed \
(uncommitted changes?) — inspect or commit them, or use --force to discard.",
                    target.state.name
                ));
                data.refused.push(target.run_id.clone());
                if !all {
                    refused_any = true;
                }
                continue;
            }
            if let Some(branch) = &target.state.branch
                && !removed.branch_deleted
            {
                err.push(format!(
                    "cleanup: kept unmerged branch {branch} (use --force to delete it)"
                ));
            }
        }
        // Archive by setting the status; reports and events are always kept.
        let mut state = target.state.clone();
        state.status = RunStatus::Archived;
        run::save_state(&target.run_dir, &state)?;
        out.push(format!("archived {}", target.run_id));
        data.archived.push(target.run_id.clone());
    }
    let code = if refused_any {
        ExitCode::Error
    } else {
        ExitCode::Ok
    };
    Ok(CommandResult {
        code,
        out,
        err,
        data,
    })
}

/// Send the abort envelope and wait (up to [`CLEANUP_ABORT_WAIT_MS`]) for
/// the run to be terminal *and* its monitor gone — the monitor's final
/// flush must not race the archive write. `true` when it stopped in time.
async fn abort_and_wait(target: &RunRef) -> bool {
    let paths = run::fleet_paths_of(&target.state);
    append_envelope(
        &paths.run_inbox(&target.run_id),
        &Envelope::abort(Party::Orchestrator, Party::worker(&target.run_id)),
    )
    .ok();
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_millis(CLEANUP_ABORT_WAIT_MS) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if let Ok(state) = run::load_state(&target.run_dir) {
            let derived = run::derive_status(&state, run::is_alive, crate::util::now_ms());
            // Terminal AND monitor gone: its final flush can no longer race
            // our archive write.
            if derived.is_terminal() && !run::is_alive(state.pid) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::run::RunState;
    use crate::ops::resolve_fleet_dir_with_env;
    use crate::util::new_id;
    use std::path::PathBuf;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{name}-{}-{}",
            std::process::id(),
            new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_sync(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo with one committed seed file; the fleet dir is gitignored like
    /// production, so `status --porcelain` reads clean.
    fn init_repo(name: &str) -> PathBuf {
        let root = tmp_dir(name);
        git_sync(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join(".gitignore"), ".parl/\n").unwrap();
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git_sync(&root, &["add", "."]);
        git_sync(&root, &["commit", "-qm", "seed"]);
        root
    }

    /// A run created the way spawn does (worktree cut by the real git
    /// helper), without booting a monitor: state on disk, base pinned.
    async fn make_run(root: &Path, name: &str, with_worktree: bool) -> (PathBuf, RunRef) {
        let fleet = resolve_fleet_dir_with_env(Some(root), None).await.unwrap();
        fleet.paths.ensure().unwrap();
        let run_id = format!("{name}-20260828141530");
        let run_dir = fleet.paths.run_dir(&run_id);
        std::fs::create_dir_all(&run_dir).unwrap();
        let mut state = RunState::new(
            fleet.paths.root().to_string_lossy().as_ref(),
            &run_id,
            name,
            &root.to_string_lossy(),
            "b",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        if with_worktree {
            let info = git::ensure_worktree(
                root,
                &fleet.paths.root().join("worktrees"),
                &run_id,
                name,
                None,
            )
            .await
            .unwrap();
            state.worktree = Some(info.worktree_path.to_string_lossy().into_owned());
            state.branch = Some(info.branch);
            state.base_commit = Some(info.base_commit);
        }
        state.repo_root = Some(root.to_string_lossy().into_owned());
        state.is_git = true;
        run::save_state(&run_dir, &state).unwrap();
        (
            fleet.paths.root().to_path_buf(),
            RunRef {
                run_id,
                run_dir,
                state,
            },
        )
    }

    fn commit_worktree_file(worktree: &Path, file: &str, body: &str) {
        std::fs::write(worktree.join(file), body).unwrap();
        git_sync(worktree, &["add", "."]);
        git_sync(worktree, &["commit", "-qm", &format!("write {file}")]);
    }

    fn settle(run_dir: &Path) {
        let mut state = run::load_state(run_dir).unwrap();
        state.status = RunStatus::Settled;
        state.settled_at = Some(crate::util::now_iso());
        run::save_state(run_dir, &state).unwrap();
    }

    #[tokio::test]
    async fn diff_on_a_run_without_a_worktree_is_not_applicable() {
        let dir = tmp_dir("parl-int-flat-");
        make_run(&dir, "flat", false).await;
        let result = diff_core_with_env("flat", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Ok);
        assert_eq!(
            result.out,
            vec!["not applicable (run has no isolated worktree)"]
        );
        assert!(!result.data.applicable);
        assert!(result.data.dirty.is_empty());
    }

    #[tokio::test]
    async fn diff_shows_committed_work_and_warns_about_dirty_files() {
        let dir = init_repo("parl-int-diff-");
        let (_fleet, target) = make_run(&dir, "worker", true).await;
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        commit_worktree_file(&worktree, "hello.txt", "hi\n");

        let stat = diff_core_with_env("worker", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(stat.code, ExitCode::Ok);
        assert!(stat.out[0].contains("hello.txt"), "{}", stat.out[0]);
        assert!(stat.err.is_empty(), "{:?}", stat.err);

        // An uncommitted change is invisible to diff but warned about.
        std::fs::write(worktree.join("forgot.txt"), "u\n").unwrap();
        let dirty = diff_core_with_env("worker", Some(&dir), true, None)
            .await
            .unwrap();
        assert_eq!(dirty.out[0], "hello.txt");
        assert_eq!(dirty.data.dirty, vec!["?? forgot.txt".to_string()]);
        assert!(
            dirty.err[0].contains("1 uncommitted change(s)") && dirty.err[0].contains("forgot.txt"),
            "{}",
            dirty.err[0]
        );
    }

    #[tokio::test]
    async fn merge_lands_in_the_recorded_repo_root_wherever_invoked_from() {
        let dir = init_repo("parl-int-merge-");
        let (_fleet, target) = make_run(&dir, "worker", true).await;
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        commit_worktree_file(&worktree, "hello.txt", "hi\n");
        settle(&target.run_dir);

        let result = merge_core_with_env("worker", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Ok, "{:?}", result.err);
        assert_eq!(result.data.branch, "parl/worker-8141530");
        assert!(result.data.committed);
        assert!(
            result.out[0].starts_with("merged parl/worker-8141530 into "),
            "{:?}",
            result.out
        );
        assert_eq!(result.data.into, target.state.repo_root.clone().unwrap());
        assert!(result.out[1].contains("integration checks"));
        let hello = std::fs::read_to_string(dir.join("hello.txt")).unwrap();
        assert_eq!(hello, "hi\n", "the branch actually landed");
    }

    #[tokio::test]
    async fn merge_refuses_unsettled_runs_and_missing_branches() {
        let dir = init_repo("parl-int-mergegates-");
        let (_fleet, target) = make_run(&dir, "flat", false).await;
        let result = merge_core_with_env("flat", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Error);
        assert!(
            result.err[0].contains("is starting — only settled runs can be merged"),
            "{}",
            result.err[0]
        );
        // Settled but without a branch.
        let mut state = target.state.clone();
        state.status = RunStatus::Settled;
        state.settled_at = Some(crate::util::now_iso());
        run::save_state(&target.run_dir, &state).unwrap();
        let result = merge_core_with_env("flat", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Error);
        assert!(result.err[0].contains("has no branch"), "{}", result.err[0]);
    }

    #[tokio::test]
    async fn merge_conflicts_exit_5_with_the_rebase_hint() {
        let dir = init_repo("parl-int-conflict-");
        let (_fleet, target) = make_run(&dir, "worker", true).await;
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        // Worker edits seed.txt on its branch; the parent moves on too.
        std::fs::write(worktree.join("seed.txt"), "worker version\n").unwrap();
        git_sync(&worktree, &["add", "."]);
        git_sync(&worktree, &["commit", "-qm", "worker version"]);
        std::fs::write(dir.join("seed.txt"), "parent version\n").unwrap();
        git_sync(&dir, &["commit", "-qam", "parent version"]);
        settle(&target.run_dir);

        let result = merge_core_with_env("worker", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::MergeConflict);
        assert_eq!(result.out, Vec::<String>::new());
        let err = result.err.join("\n");
        assert!(err.contains("conflicts in:\nseed.txt"), "{err}");
        assert!(err.contains("The merge was aborted; the checkout is clean"));
        assert!(err.contains("rebase its branch parl/worker-8141530"));
        assert!(
            err.contains(
                target
                    .state
                    .base_commit
                    .as_deref()
                    .and_then(|c| c.get(..7))
                    .unwrap()
            )
        );
        // The abort left the checkout clean, and the data names the conflicts.
        assert!(!git::worktree_is_dirty(&dir).await);
        assert_eq!(result.data.conflicts, vec!["seed.txt".to_string()]);
    }

    #[tokio::test]
    async fn merge_stages_with_no_commit() {
        let dir = init_repo("parl-int-nocommit-");
        let (_fleet, target) = make_run(&dir, "worker", true).await;
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        commit_worktree_file(&worktree, "feat.txt", "f\n");
        settle(&target.run_dir);

        let result = merge_core_with_env("worker", Some(&dir), true, None)
            .await
            .unwrap();
        assert_eq!(result.code, ExitCode::Ok);
        assert!(
            result.out[0].contains("(staged, not committed)"),
            "{:?}",
            result.out
        );
        assert!(!result.data.committed);
        let status = git::git_raw(&["status", "--porcelain"], &dir).await;
        assert!(status.stdout.contains('A'), "{}", status.stdout);
        git_sync(&dir, &["merge", "--abort"]);
    }

    #[tokio::test]
    async fn cleanup_archives_removes_worktree_and_keeps_the_report() {
        let dir = init_repo("parl-int-cleanup-");
        let (fleet, target) = make_run(&dir, "worker", true).await;
        let report = crate::fleet::report::report_path(&fleet, &target.run_id);
        std::fs::write(&report, "# Fleet Report\n").unwrap();
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        commit_worktree_file(&worktree, "hello.txt", "hi\n");
        settle(&target.run_dir);

        let result = cleanup_runs(&fleet, "worker", false).await.unwrap();
        assert_eq!(result.code, ExitCode::Ok, "{:?}", result.err);
        assert_eq!(result.out, vec![format!("archived {}", target.run_id)]);
        assert_eq!(result.data.archived, vec![target.run_id.clone()]);
        assert!(!worktree.exists());
        let listed = git::git_raw(
            &["branch", "--list", target.state.branch.as_deref().unwrap()],
            &dir,
        )
        .await;
        // The branch was never merged, so non-force cleanup keeps it.
        assert!(!listed.stdout.trim().is_empty(), "unmerged branch kept");
        assert!(
            result
                .err
                .iter()
                .any(|e| e.contains("kept unmerged branch")),
            "{:?}",
            result.err
        );
        // The report and events survive the archive.
        assert!(crate::fleet::report::report_path(&fleet, &target.run_id).is_file());

        let again = cleanup_runs(&fleet, "worker", false).await.unwrap();
        assert_eq!(
            again.out,
            vec![format!("{} is already archived", target.run_id)]
        );
        // diff on an archived (worktree gone) run is not applicable.
        let diffed = diff_core_with_env("worker", Some(&dir), false, None)
            .await
            .unwrap();
        assert_eq!(
            diffed.out,
            vec!["not applicable (run has no isolated worktree)"]
        );
    }

    #[tokio::test]
    async fn cleanup_refuses_a_dirty_worktree_without_force_and_forces_with_it() {
        let dir = init_repo("parl-int-dirty-");
        let (fleet, target) = make_run(&dir, "worker", true).await;
        let worktree = PathBuf::from(target.state.worktree.clone().unwrap());
        commit_worktree_file(&worktree, "hello.txt", "hi\n");
        std::fs::write(worktree.join("forgot.txt"), "uncommitted\n").unwrap();
        settle(&target.run_dir);

        let refused = cleanup_runs(&fleet, "worker", false).await.unwrap();
        assert_eq!(refused.code, ExitCode::Error);
        assert!(
            refused.err[0].contains("could not be removed"),
            "{}",
            refused.err[0]
        );
        assert_eq!(refused.data.refused, vec![target.run_id.clone()]);
        assert!(worktree.exists());
        let state = run::load_state(&target.run_dir).unwrap();
        assert_ne!(state.status, RunStatus::Archived);

        let forced = cleanup_runs(&fleet, "worker", true).await.unwrap();
        assert_eq!(forced.code, ExitCode::Ok, "{:?}", forced.err);
        assert!(!worktree.exists());
        let state = run::load_state(&target.run_dir).unwrap();
        assert_eq!(state.status, RunStatus::Archived);
    }

    #[tokio::test]
    async fn cleanup_force_aborts_a_running_run_then_archives() {
        let dir = init_repo("parl-int-forceabort-");
        let (fleet, target) = make_run(&dir, "slow", false).await;
        // A "monitor" that processes the abort 500 ms in: status goes
        // stopped and the pid (our own test process) goes away. While it is
        // still Running with a live pid, a plain cleanup would refuse.
        let mut state = run::load_state(&target.run_dir).unwrap();
        state.status = RunStatus::Running;
        state.pid = Some(std::process::id() as i32);
        run::save_state(&target.run_dir, &state).unwrap();
        let tardy = target.run_dir.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Ok(mut s) = run::load_state(&tardy) {
                s.status = RunStatus::Stopped;
                s.pid = None;
                run::save_state(&tardy, &s).unwrap();
            }
        });

        let forced = cleanup_runs(&fleet, "slow", true).await.unwrap();
        assert_eq!(forced.code, ExitCode::Ok, "{:?}", forced.err);
        assert!(!forced.err.iter().any(|e| e.contains("archiving anyway")));
        let state = run::load_state(&target.run_dir).unwrap();
        assert_eq!(state.status, RunStatus::Archived);
        // The abort envelope reached the inbox for the monitor to see.
        let raw = std::fs::read_to_string(
            crate::paths::FleetPaths::new(&fleet).run_inbox(&target.run_id),
        )
        .unwrap();
        assert!(raw.contains("\"abort\""), "{raw}");
    }

    #[tokio::test]
    async fn cleanup_all_archives_finished_runs_and_skips_running_ones() {
        let dir = init_repo("parl-int-all-");
        let (fleet, _settled) = make_run(&dir, "done", false).await;
        settle(&fleet.join("runs").join("done-20260828141530"));
        // A second run that looks alive.
        let busy_id = "busy-20260828141531";
        let busy_dir = fleet.join("runs").join(busy_id);
        std::fs::create_dir_all(&busy_dir).unwrap();
        let mut busy = RunState::new(
            fleet.to_string_lossy().as_ref(),
            busy_id,
            "busy",
            "/tmp/x",
            "b",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        busy.status = RunStatus::Running;
        busy.pid = Some(std::process::id() as i32);
        run::save_state(&busy_dir, &busy).unwrap();

        let all = cleanup_runs(&fleet, "all", false).await.unwrap();
        assert_eq!(all.code, ExitCode::Ok);
        assert_eq!(all.data.archived, vec!["done-20260828141530".to_string()]);
        assert!(
            all.err.iter().any(|e| e.contains("skipping busy")),
            "{:?}",
            all.err
        );
        assert_eq!(
            run::load_state(&busy_dir).unwrap().status,
            RunStatus::Running
        );
        // --force archives the rest.
        let forced = cleanup_runs(&fleet, "all", true).await.unwrap();
        assert_eq!(forced.code, ExitCode::Ok, "{:?}", forced.err);
        assert_eq!(
            run::load_state(&busy_dir).unwrap().status,
            RunStatus::Archived
        );
    }

    #[tokio::test]
    async fn cleanup_target_rules() {
        let dir = init_repo("parl-int-targets-");
        let (fleet, _target) = make_run(&dir, "flat", false).await;
        // An unknown target is a hard error.
        let err = cleanup_runs(&fleet, "ghost", false).await.unwrap_err();
        assert!(err.to_string().contains("No run found"), "{err}");
        let err = cleanup_runs(&fleet, "  ", false).await.unwrap_err();
        assert_eq!(err.to_string(), "cleanup: <name|all> required");
    }
}
