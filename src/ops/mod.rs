//! The shared operation layer: every fleet action lives here once, and the
//! CLI subcommands, the MCP tools and the console all call the same code.
//! Each file owns one verb family; the signatures taking CLI-parsed values
//! are the frozen contract with `main.rs` (which later workers never edit).
//!
//! Every core returns a [`CommandResult`] and never prints; [`print_result`]
//! is the single place that turns one into stdout, stderr and an exit code.
//! The next wave's MCP server renders the same struct as tool output, so the
//! `data` stays typed and serialisable rather than pre-formatted.

pub mod integrate;
pub mod query;
pub mod spawn;
pub mod steer;

use std::path::{Path, PathBuf};

use crate::cli::ExitCode;
use crate::git;
use crate::paths::FleetPaths;

/// What a command core produces: the exit code, the lines the CLI prints on
/// stdout (`out`) and stderr (`err`), and structured data for programmatic
/// callers such as the MCP server.
#[derive(Debug, Clone)]
pub struct CommandResult<T = serde_json::Value> {
    pub code: ExitCode,
    pub out: Vec<String>,
    pub err: Vec<String>,
    pub data: T,
}

/// A successful core result. Failure paths use [`fail`] or a literal when the
/// code itself carries meaning (wait timeouts, merge conflicts).
pub fn ok<T>(data: T, out: Vec<String>) -> CommandResult<T> {
    CommandResult {
        code: ExitCode::Ok,
        out,
        err: Vec::new(),
        data,
    }
}

/// A refused core result; `data` falls back to `Default` because failures
/// carry their meaning in `err` and the exit code.
pub fn fail<T: Default>(code: ExitCode, err: Vec<String>) -> CommandResult<T> {
    CommandResult {
        code,
        out: Vec::new(),
        err,
        data: T::default(),
    }
}

/// Print a core's lines the way the CLI always has, and hand back its exit code.
pub fn print_result<T>(result: CommandResult<T>) -> ExitCode {
    for line in result.out {
        println!("{line}");
    }
    for line in result.err {
        eprintln!("{line}");
    }
    result.code
}

/// Where a fleet's state lives once `cwd` is anchored: the repo root when the
/// target is inside one, the target itself otherwise (and `PARL_DIR` wins over
/// both — see [`FleetPaths::discover`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFleet {
    /// The caller's target, symlinks resolved so non-git targets compare
    /// equal to git's real paths (e.g. macOS `/var` -> `/private/var`).
    pub target_dir: PathBuf,
    pub repo_root: Option<PathBuf>,
    pub is_git: bool,
    pub paths: FleetPaths,
}

/// Locate the fleet dir for `cwd` (default: the process's working directory).
pub async fn resolve_fleet_dir(cwd: Option<&Path>) -> anyhow::Result<ResolvedFleet> {
    let requested = match cwd {
        Some(dir) => dir.to_path_buf(),
        None => std::env::current_dir()?,
    };
    if !requested.exists() {
        anyhow::bail!("--cwd does not exist: {}", requested.display());
    }
    let target_dir = std::fs::canonicalize(&requested)?;
    let is_git = git::is_git_repo(&target_dir).await;
    let root = if is_git {
        git::repo_root(&target_dir).await
    } else {
        None
    };
    let resolved_root = root.clone().unwrap_or_else(|| target_dir.clone());
    Ok(ResolvedFleet {
        repo_root: is_git.then_some(resolved_root.clone()),
        is_git,
        paths: FleetPaths::discover(&resolved_root),
        target_dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{RETRY_BOUND, RETRY_INTERVAL, git_sync, tmp_dir};
    use std::time::Instant;

    #[test]
    fn ok_and_fail_carry_their_sides_without_data() {
        let good = ok(vec!["x".to_string()], vec!["a".into(), "b".into()]);
        assert_eq!(good.code, ExitCode::Ok);
        assert_eq!(good.out, vec!["a", "b"]);
        assert!(good.err.is_empty());
        let bad: CommandResult = fail(ExitCode::MergeConflict, vec!["boom".into()]);
        assert_eq!(bad.code, ExitCode::MergeConflict);
        assert!(bad.out.is_empty());
        assert_eq!(bad.err, vec!["boom"]);
    }

    #[tokio::test]
    async fn resolve_fleet_dir_anchors_at_the_repo_root_and_realpaths() {
        // Under full-suite parallel load the git spawn behind the resolution
        // fails transiently, and canonicalize() of the root git reports can
        // come back NotFound a moment later — the environmental loss
        // documented in src/git.rs, whose probe this retries the same way,
        // repo setup included in the retried condition. The bound is tripled
        // from the shared budget: when another suite churns the same OS temp
        // directory, the NotFound windows outlast it, and a share-sized
        // bound burned out without a surviving attempt (observed once in
        // sixteen full-suite runs). A genuinely broken resolution still
        // fails loudly via the bound, with what the last attempt saw.
        let deadline = Instant::now() + 3 * RETRY_BOUND;
        let mut last_seen = String::from("no attempt completed");
        let (sub_real, in_repo) = loop {
            if Instant::now() >= deadline {
                panic!("resolve_fleet_dir never anchored at the repo root: {last_seen}");
            }
            let root = tmp_dir("parl-ops-resolve-");
            git_sync(&root, &["init", "-q", "-b", "main"]);
            let sub = root.join("sub");
            std::fs::create_dir_all(&sub).unwrap();
            let (root_real, sub_real) = match (root.canonicalize(), sub.canonicalize()) {
                (Ok(root_real), Ok(sub_real)) => (root_real, sub_real),
                (root_real, sub_real) => {
                    last_seen = format!("setup canonicalize: root={root_real:?} sub={sub_real:?}");
                    tokio::time::sleep(RETRY_INTERVAL).await;
                    continue;
                }
            };
            match resolve_fleet_dir(Some(&sub)).await {
                Ok(resolved)
                    if resolved.is_git
                        && resolved
                            .repo_root
                            .as_ref()
                            .and_then(|repo| repo.canonicalize().ok())
                            .is_some_and(|real| *real == root_real)
                        && resolved.paths.root() == root_real.join(".parl")
                        && resolved.target_dir == sub_real =>
                {
                    break (sub_real, resolved);
                }
                Ok(resolved) => {
                    // keep what the failed attempt actually saw
                    last_seen = format!(
                        "last attempt: is_git={} repo_root={:?} repo_root.canonicalize={:?} paths.root={:?}",
                        resolved.is_git,
                        resolved.repo_root,
                        resolved
                            .repo_root
                            .as_ref()
                            .and_then(|repo| repo.canonicalize().ok()),
                        resolved.paths.root()
                    );
                }
                Err(err) => last_seen = format!("last attempt errored: {err:#}"),
            }
            tokio::time::sleep(RETRY_INTERVAL).await;
        };
        assert_eq!(
            in_repo.target_dir, sub_real,
            "the target stays where the caller pointed"
        );

        let plain = tmp_dir("parl-ops-plain-");
        let standalone = resolve_fleet_dir(Some(&plain)).await.unwrap();
        assert!(!standalone.is_git);
        assert_eq!(standalone.repo_root, None);
        assert_eq!(
            standalone.paths.root(),
            plain.canonicalize().unwrap().join(".parl")
        );

        let missing = resolve_fleet_dir(Some(&plain.join("nope"))).await;
        let err = missing.unwrap_err().to_string();
        assert!(err.contains("does not exist"), "{err}");
    }
}
