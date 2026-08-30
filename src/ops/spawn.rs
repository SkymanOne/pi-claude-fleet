//! Spawning a worker: validate the brief and model, create the worktree,
//! write `run.json`, boot the detached monitor. (Ported from the TypeScript
//! `src/spawn.ts` and `spawnCore` in `src/commands.ts`.)

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::cli::ExitCode;
use crate::fleet::run::{self, RunRef, RunState, RunStatus};
use crate::git;
use crate::paths::FleetPaths;
use crate::util::{now_ms, run_id_for, sanitize_name};
use crate::worker::models::{check_model, pi_bin_spec};

use super::{CommandResult, fail, print_result, resolve_fleet_dir_with_env};

/// Everything `spawn` needs to know; constructed verbatim by `main.rs` from
/// the parsed CLI, so the field set is a frozen contract.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub name: String,
    pub brief: String,
    pub cwd: Option<std::path::PathBuf>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub thinking: Option<String>,
    /// `false` for `--no-worktree`: run in place, read-only tasks.
    pub worktree: bool,
    pub base: Option<String>,
    pub skill: Option<String>,
    pub append_system_prompt: Option<String>,
    pub session: Option<String>,
    pub tools: Option<String>,
    pub exclude_tools: Option<String>,
}

/// What [`spawn_core`] did, for programmatic callers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnData {
    pub run_id: String,
    pub run_dir: String,
    pub fleet_dir: String,
    pub worktree: Option<String>,
    pub branch: Option<String>,
}

/// A run [`create_run`] materialised on disk.
#[derive(Debug, Clone)]
pub struct CreatedRun {
    pub run_id: String,
    pub run_dir: PathBuf,
    pub paths: FleetPaths,
    pub state: RunState,
    pub worktree_path: Option<PathBuf>,
}

/// Spawn one worker: the CLI entry point. Prints the core's lines and hands
/// back its exit code; hard errors (no brief, no name, bad cwd) surface
/// through `main` as `parl: …` and exit 1.
///
/// # Errors
///
/// Fails on a missing brief or name, a bad `cwd`, or a name that already
/// has a live run; model refusal comes back through the printed exit code.
pub async fn spawn_run(request: SpawnRequest) -> anyhow::Result<ExitCode> {
    Ok(print_result(spawn_core(request).await?))
}

/// The spawn core: the model is checked before a worktree and a branch exist,
/// so a wrong name costs a second. The unknown-model refusal is a `fail`,
/// not an error, and keeps the TypeScript exit code (`2`).
///
/// # Errors
///
/// Fails on a missing brief, an unresolvable `cwd`, a same-second name
/// collision, or a name whose previous run is still live.
pub async fn spawn_core(request: SpawnRequest) -> anyhow::Result<CommandResult<SpawnData>> {
    spawn_core_with_env(request, super::ambient_parl_dir().as_deref()).await
}

/// [`spawn_core`] with the `$PARL_DIR` value injected (tests pass `None`).
pub(crate) async fn spawn_core_with_env(
    request: SpawnRequest,
    parl_dir: Option<&str>,
) -> anyhow::Result<CommandResult<SpawnData>> {
    if request.brief.trim().is_empty() {
        anyhow::bail!("spawn: task brief required after \"--\"");
    }
    let pi_bin = pi_bin_spec();
    if let Some(bad) = check_model(&pi_bin, request.model.as_deref()).await? {
        return Ok(fail(ExitCode::NoReport, vec![format!("spawn: {bad}")]));
    }
    let created = create_run_with_env(&request, parl_dir).await?;
    let mut err: Vec<String> = Vec::new();
    if !created.state.is_git && request.worktree {
        err.push("warning: target is not a git repo — running in place without a worktree".into());
    }
    launch_monitor(&created.paths, &created.run_id)?;
    let run_dir = created.run_dir.to_string_lossy().into_owned();
    let mut out = vec![
        format!("Spawned {}", created.run_id),
        format!("  state:    {run_dir}/run.json"),
        format!("  logs:     {run_dir}/{{events.jsonl,inbox.jsonl,outbox.jsonl,pi.log}}"),
        format!("  fleet dir: {}", created.paths.root().display()),
    ];
    if let Some(worktree) = &created.worktree_path {
        out.push(format!("  worktree: {}", worktree.display()));
    }
    if let Some(branch) = &created.state.branch {
        out.push(format!("  branch:   {branch}"));
    }
    let data = SpawnData {
        run_id: created.run_id,
        run_dir,
        fleet_dir: created.paths.root().to_string_lossy().into_owned(),
        worktree: created
            .worktree_path
            .map(|p| p.to_string_lossy().into_owned()),
        branch: created.state.branch.clone(),
    };
    // The no-git warning lives in `err`, so `ok` (which zeroes it) is not used.
    Ok(CommandResult {
        code: ExitCode::Ok,
        out,
        err,
        data,
    })
}

/// Create the run: sanitise the name, stamp the run id, cut the worktree on
/// its own branch from `--base` (or HEAD), and write the initial `run.json`.
///
/// # Errors
///
/// Fails on a missing name, a `cwd` that does not exist, a same-name spawn
/// within one second, a name whose previous run is still live, or a
/// worktree git cannot cut. A prior terminal run of the same name is
/// archived here, not refused.
pub async fn create_run(request: &SpawnRequest) -> anyhow::Result<CreatedRun> {
    create_run_with_env(request, super::ambient_parl_dir().as_deref()).await
}

/// [`create_run`] with the `$PARL_DIR` value injected (tests pass `None`).
async fn create_run_with_env(
    request: &SpawnRequest,
    parl_dir: Option<&str>,
) -> anyhow::Result<CreatedRun> {
    let name = sanitize_name(&request.name);
    if name.is_empty() {
        anyhow::bail!("spawn: <name> required");
    }
    let fleet = resolve_fleet_dir_with_env(request.cwd.as_deref(), parl_dir).await?;
    // The fixed layout plus the gitignore entry; idempotent.
    fleet.paths.ensure()?;
    let run_id = run_id_for(&name);
    let run_dir = fleet.paths.run_dir(&run_id);
    if run_dir.exists() {
        anyhow::bail!(
            "spawn: run {run_id} already exists (same name spawned twice within one second) — retry"
        );
    }
    // A name may have only one live run. A prior terminal run of the same
    // name is archived here as part of the spawn, so `cleanup <name>` and
    // the other ops never resolve to a stale twin; a still-running namesake
    // refuses the spawn — silently duplicating it is how a live worker was
    // archived by accident before.
    for prior in live_namesakes(fleet.paths.root(), &name) {
        let derived = run::derive_status(&prior.state, run::is_alive, now_ms());
        if !derived.is_terminal() {
            anyhow::bail!(
                "spawn: run {} (name \"{}\") is still {derived} — a name may have only \
one live run; stop or clean it first, or use another name.",
                prior.run_id,
                name
            );
        }
        let mut stale = prior.state.clone();
        stale.status = RunStatus::Archived;
        run::save_state(&prior.run_dir, &stale)?;
    }

    let (worktree_path, branch) = match fleet.repo_root.as_deref().filter(|_| request.worktree) {
        Some(root) => {
            let worktrees_dir = fleet.paths.root().join("worktrees");
            let created = git::ensure_worktree(
                root,
                &worktrees_dir,
                &run_id,
                &name,
                request.base.as_deref(),
            )
            .await?;
            (Some(created.worktree_path), Some(created.branch))
        }
        None => (None, None),
    };
    // The base commit is pinned by ensure_worktree and must survive into
    // run.json even when the run has no worktree — diff falls back to the
    // recorded ref, so only set it from the worktree path we actually got.
    let base_commit = if let (Some(root), true) = (fleet.repo_root.as_deref(), request.worktree) {
        Some(git::resolve_commit(root, request.base.as_deref().unwrap_or("HEAD")).await?)
    } else {
        None
    };

    std::fs::create_dir_all(&run_dir)?;
    let mut state = RunState::new(
        fleet.paths.root().to_string_lossy().as_ref(),
        &run_id,
        &name,
        &fleet.target_dir.to_string_lossy(),
        &request.brief,
        worktree_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        branch,
        request.base.clone(),
        request.model.clone(),
        request.provider.clone(),
        request.thinking.clone(),
        request.session.clone(),
        request.skill.clone(),
        request.append_system_prompt.clone(),
        request.tools.clone(),
        request.exclude_tools.clone(),
    );
    state.repo_root = fleet
        .repo_root
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    state.is_git = fleet.is_git;
    state.base_commit = base_commit;
    crate::fleet::run::save_state(&run_dir, &state)?;
    Ok(CreatedRun {
        run_id,
        run_dir,
        paths: fleet.paths,
        state,
        worktree_path,
    })
}

/// The non-archived runs sharing `name` — exact id or `<name>-<14-digit
/// stamp>`, the same resolution set [`run::find_run`] picks from — newest
/// first. Unreadable `run.json` files are skipped, like everywhere else.
fn live_namesakes(fleet_dir: &Path, name: &str) -> Vec<RunRef> {
    let key = sanitize_name(name);
    let Ok(of_name) = regex::Regex::new(&format!("^{}-\\d{{14}}$", regex::escape(&key))) else {
        return Vec::new();
    };
    run::list_runs(fleet_dir)
        .into_iter()
        .filter(|r| r.run_id == key || of_name.is_match(&r.run_id))
        .filter_map(|r| {
            run::load_state(&r.run_dir).ok().map(|state| RunRef {
                run_id: r.run_id,
                run_dir: r.run_dir,
                state,
            })
        })
        .filter(|r| r.state.status != RunStatus::Archived)
        .collect()
}

/// Launch `parl monitor` for the run, detached: its own process group
/// (`process_group(0)` — the safe equivalent of Node's `detached: true`),
/// stdio into the run's `pi.log`. The child outlives this process, and it is
/// reaped by a background task: nobody waits on the handle, and an unreaped
/// child would linger as a zombie whose pid keeps answering `kill(pid, 0)` —
/// so a crashed monitor could never read as dead. Returns the monitor's pid.
fn launch_monitor(paths: &FleetPaths, run_id: &str) -> std::io::Result<u32> {
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.pi_log(run_id))?;
    let errors = log.try_clone()?;
    let fleet_dir = paths.root().to_string_lossy().into_owned();
    let mut command = tokio::process::Command::new(exe);
    command
        .args(["monitor", "--fleet-dir", &fleet_dir, "--run", run_id])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors))
        .process_group(0);
    let mut child = command.spawn()?;
    let pid = child.id();
    tokio::spawn(async move {
        // Reap whenever the monitor exits; the runtime outlives the caller,
        // so the pid is gone from the process table while we still run.
        let _ = child.wait().await;
    });
    pid.ok_or_else(|| std::io::Error::other("monitor exited before its pid could be read"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::run::{RunStatus, save_state};
    use crate::git::test_support::{git_sync, tmp_dir};
    use crate::ops::resolve_fleet_dir_with_env;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    /// `create_run` drives several real git spawns, and under this machine's
    /// parallel-suite load a fresh repo has been observed to read as "not a
    /// git repository" to a mid-test spawn that earlier spawns had just used
    /// fine. Each attempt is self-contained — a new run id every second, so
    /// no collision with a failed attempt's leftovers — so poll `Err` and
    /// return the first `Ok`; a persistent failure surfaces as the last Err.
    async fn create_run_with_retry(request: &SpawnRequest) -> anyhow::Result<CreatedRun> {
        // Operation-level, so a longer bound than the per-spawn helper's.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match create_run_with_env(request, None).await {
                Ok(created) => return Ok(created),
                Err(err) => {
                    if Instant::now() >= deadline {
                        return Err(err);
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    fn init_repo(name: &str) -> PathBuf {
        let root = tmp_dir(name);
        git_sync(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git_sync(&root, &["add", "."]);
        git_sync(&root, &["commit", "-qm", "seed"]);
        root
    }

    fn request(name: &str, brief: &str, cwd: &Path, worktree: bool) -> SpawnRequest {
        SpawnRequest {
            name: name.into(),
            brief: brief.into(),
            cwd: Some(cwd.to_path_buf()),
            model: None,
            provider: None,
            thinking: None,
            worktree,
            base: None,
            skill: None,
            append_system_prompt: None,
            session: None,
            tools: None,
            exclude_tools: None,
        }
    }

    #[tokio::test]
    async fn create_run_builds_layout_worktree_and_initial_state() {
        let root = init_repo("parl-spawn-");
        let created = create_run_with_retry(&request("auth-worker", "create hello", &root, true))
            .await
            .unwrap();
        assert!(
            regex::Regex::new(r"^auth-worker-\d{14}$")
                .unwrap()
                .is_match(&created.run_id)
        );
        assert!(created.paths.run_json(&created.run_id).is_file());
        let gitignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains(".parl/"), "{gitignore}");

        let worktree = created.worktree_path.clone().unwrap();
        assert!(worktree.join("seed.txt").exists());
        assert!(worktree.starts_with(created.paths.root().join("worktrees")));
        assert!(
            created
                .state
                .branch
                .clone()
                .unwrap()
                .starts_with("parl/auth-worker-")
        );
        assert_eq!(
            created.state.repo_root.as_deref(),
            Some(root.canonicalize().unwrap().to_string_lossy().as_ref())
        );
        assert!(created.state.is_git);
        let head = git::resolve_commit(&root, "HEAD").await.unwrap();
        assert_eq!(created.state.base_commit.as_deref(), Some(head.as_str()));
        assert_eq!(created.state.task_brief, "create hello");
        assert_eq!(created.state.status, crate::fleet::run::RunStatus::Starting);
        assert_eq!(
            created.state.cwd,
            root.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[tokio::test]
    async fn create_run_in_a_plain_directory_runs_in_place() {
        let dir = tmp_dir("parl-spawn-plain-");
        let created = create_run_with_retry(&request("flat", "b", &dir, true))
            .await
            .unwrap();
        assert_eq!(created.worktree_path, None);
        assert_eq!(created.state.branch, None);
        assert!(!created.state.is_git);
        assert_eq!(created.state.repo_root, None);
        assert_eq!(created.state.base_commit, None);
    }

    #[tokio::test]
    async fn create_run_skips_the_worktree_when_asked() {
        let root = init_repo("parl-spawn-");
        let created = create_run_with_retry(&request("nowt", "b", &root, false))
            .await
            .unwrap();
        assert_eq!(created.worktree_path, None);
        assert_eq!(created.state.branch, None);
        assert!(
            created.state.is_git,
            "still a git repo, just running in place"
        );
    }

    #[tokio::test]
    async fn an_exited_monitor_is_reaped_so_a_crash_can_read_dead() {
        let dir = tmp_dir("parl-spawn-reap-");
        let paths = FleetPaths::new(dir);
        let run_id = "reap-20260828141530";
        std::fs::create_dir_all(paths.run_dir(run_id)).unwrap();
        // `launch_monitor` always runs `current_exe monitor …`; from the test
        // harness that is this test binary itself, which rejects the unknown
        // `--fleet-dir`/`--run` flags and exits at once — a short-lived
        // stand-in for a monitor that crashes. This process stays alive
        // throughout, so reaping must come from the background task.
        let pid = launch_monitor(&paths, run_id).unwrap();
        let pid = i32::try_from(pid).unwrap();
        // A dropped (unreaped) child stays a zombie, and a zombie answers
        // `kill(pid, 0)` — exactly what `fleet::run::is_alive` checks. Poll
        // until the pid is truly gone from the process table.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while crate::fleet::run::is_alive(Some(pid)) {
            assert!(
                std::time::Instant::now() < deadline,
                "monitor pid {pid} still answers kill(pid, 0) — it was not reaped"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// A hand-written prior run on disk, the way an earlier spawn left it:
    /// no worktree, a fixed id so it never collides with a live stamp.
    fn put_run(
        paths: &FleetPaths,
        name: &str,
        run_id: &str,
        status: RunStatus,
        pid: Option<i32>,
    ) -> PathBuf {
        let run_dir = paths.run_dir(run_id);
        std::fs::create_dir_all(&run_dir).unwrap();
        let mut state = RunState::new(
            paths.root().to_string_lossy().as_ref(),
            run_id,
            name,
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
        state.status = status;
        state.pid = pid;
        save_state(&run_dir, &state).unwrap();
        run_dir
    }

    #[tokio::test]
    async fn spawn_archives_a_stale_namesake() {
        let root = init_repo("parl-spawn-dupe-");
        let fleet = resolve_fleet_dir_with_env(Some(&root), None).await.unwrap();
        fleet.paths.ensure().unwrap();
        // A settled prior run of the same name: spawning anew archives it as
        // part of the spawn, so the name keeps exactly one live entry and
        // `cleanup <name>` cannot resolve to a stale twin.
        let stale = put_run(
            &fleet.paths,
            "auth",
            "auth-20990101000000",
            RunStatus::Settled,
            None,
        );
        let created = create_run_with_retry(&request("auth", "new work", &root, true))
            .await
            .unwrap();
        assert_ne!(created.run_id, "auth-20990101000000", "a fresh run id");
        assert_eq!(
            crate::fleet::run::load_state(&stale).unwrap().status,
            RunStatus::Archived,
            "spawn archives the stale namesake"
        );
        assert_eq!(
            crate::fleet::run::load_state(&created.run_dir)
                .unwrap()
                .status,
            RunStatus::Starting
        );
    }

    #[tokio::test]
    async fn spawn_refuses_when_the_name_still_runs() {
        let root = init_repo("parl-spawn-live-");
        let fleet = resolve_fleet_dir_with_env(Some(&root), None).await.unwrap();
        fleet.paths.ensure().unwrap();
        // A still-running namesake refuses the spawn, naming the live run:
        // silently duplicating the name is how a live worker was archived.
        let live_id = "auth-20990101000001";
        let live_dir = put_run(
            &fleet.paths,
            "auth",
            live_id,
            RunStatus::Running,
            Some(std::process::id().cast_signed()),
        );
        let err = create_run_with_env(&request("auth", "again", &root, true), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(live_id), "{err}");
        assert!(err.contains("still running"), "{err}");
        assert!(err.contains("one live run"), "{err}");
        assert_eq!(
            crate::fleet::run::load_state(&live_dir).unwrap().status,
            RunStatus::Running,
            "the live run is untouched"
        );
    }

    #[tokio::test]
    async fn empty_names_and_briefs_are_refused() {
        let dir = tmp_dir("parl-spawn-bad-");
        let err = create_run_with_env(&request("!!!", "b", &dir, false), None)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(err, "spawn: <name> required");
        let err = spawn_core(request("x", "  ", &dir, false))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(err, "spawn: task brief required after \"--\"");
    }
}
