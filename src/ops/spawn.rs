//! Spawning a worker: validate the brief and model, create the worktree,
//! write `run.json`, boot the detached monitor. (Ported from the TypeScript
//! `src/spawn.ts` and `spawnCore` in `src/commands.ts`.)

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;

use crate::cli::ExitCode;
use crate::fleet::run::RunState;
use crate::git;
use crate::paths::FleetPaths;
use crate::util::{run_id_for, sanitize_name};
use crate::worker::models::{check_model, pi_bin_spec};

use super::{CommandResult, fail, ok, print_result, resolve_fleet_dir};

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
pub async fn spawn_run(request: SpawnRequest) -> anyhow::Result<ExitCode> {
    Ok(print_result(spawn_core(request).await?))
}

/// The spawn core: the model is checked before a worktree and a branch exist,
/// so a wrong name costs a second. The unknown-model refusal is a `fail`,
/// not an error, and keeps the TypeScript exit code (`2`).
pub async fn spawn_core(request: SpawnRequest) -> anyhow::Result<CommandResult<SpawnData>> {
    if request.brief.trim().is_empty() {
        anyhow::bail!("spawn: task brief required after \"--\"");
    }
    let pi_bin = pi_bin_spec();
    if let Some(bad) = check_model(&pi_bin, request.model.as_deref()).await? {
        return Ok(fail(ExitCode::NoReport, vec![format!("spawn: {bad}")]));
    }
    let created = create_run(&request).await?;
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
    Ok(ok(data, out))
}

/// Create the run: sanitise the name, stamp the run id, cut the worktree on
/// its own branch from `--base` (or HEAD), and write the initial `run.json`.
pub async fn create_run(request: &SpawnRequest) -> anyhow::Result<CreatedRun> {
    let name = sanitize_name(&request.name);
    if name.is_empty() {
        anyhow::bail!("spawn: <name> required");
    }
    let fleet = resolve_fleet_dir(request.cwd.as_deref()).await?;
    // The fixed layout plus the gitignore entry; idempotent.
    fleet.paths.ensure()?;
    let run_id = run_id_for(&name);
    let run_dir = fleet.paths.run_dir(&run_id);
    if run_dir.exists() {
        anyhow::bail!(
            "spawn: run {run_id} already exists (same name spawned twice within one second) — retry"
        );
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

/// Launch `parl monitor` for the run, detached: its own process group
/// (`process_group(0)` — the safe equivalent of Node's `detached: true`),
/// stdio into the run's `pi.log`. The child is deliberately not waited on;
/// it outlives this process.
fn launch_monitor(paths: &FleetPaths, run_id: &str) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.pi_log(run_id))?;
    let errors = log.try_clone()?;
    let fleet_dir = paths.root().to_string_lossy().into_owned();
    let child = std::process::Command::new(exe)
        .args(["monitor", "--fleet-dir", &fleet_dir, "--run", run_id])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors))
        .process_group(0)
        .spawn()?;
    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::new_id;
    use std::path::{Path, PathBuf};

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
        let created = create_run(&request("auth-worker", "create hello", &root, true))
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
        let created = create_run(&request("flat", "b", &dir, true)).await.unwrap();
        assert_eq!(created.worktree_path, None);
        assert_eq!(created.state.branch, None);
        assert!(!created.state.is_git);
        assert_eq!(created.state.repo_root, None);
        assert_eq!(created.state.base_commit, None);
    }

    #[tokio::test]
    async fn create_run_skips_the_worktree_when_asked() {
        let root = init_repo("parl-spawn-");
        let created = create_run(&request("nowt", "b", &root, false))
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
    async fn empty_names_and_briefs_are_refused() {
        let dir = tmp_dir("parl-spawn-bad-");
        let err = create_run(&request("!!!", "b", &dir, false))
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
