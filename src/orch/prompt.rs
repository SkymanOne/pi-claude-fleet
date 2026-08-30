//! The orchestrator's system prompt travels inside the binary: nothing is
//! ever copied into a project.
//!
//! The shipped template ([`ORCHESTRATOR_PROMPT_TEMPLATE`], embedded with
//! `include_str!`) is rendered with the fleet's placeholders and written under
//! the orchestrator directory for `--append-system-prompt-file`. Overrides,
//! in order: `$PARL_PROMPT` (a path; a dangling one is an error, it is
//! explicit user intent), then `<repo>/.parl/orchestrator.md`, then
//! `~/.config/parl/orchestrator.md`, then the embedded copy. Unknown
//! `{{PLACEHOLDER}}`s are left untouched.

use std::path::{Path, PathBuf};

use crate::orch::records::prompt_path;
use crate::paths::{BIN_NAME, STATE_DIR_NAME, env_var};

/// The shipped template, embedded in the binary.
pub const ORCHESTRATOR_PROMPT_TEMPLATE: &str = include_str!("../../prompts/orchestrator.md");

/// Workers that may run at once, when the template is not overridden.
pub const DEFAULT_MAX_WORKERS: usize = 3;

/// What fills the template's `{{PLACEHOLDER}}`s.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PromptVars {
    pub fleet_dir: String,
    pub repo_root: String,
    pub max_workers: Option<usize>,
    pub bin_name: Option<String>,
}

/// Render the shipped template for a fleet.
#[must_use]
pub fn render_orchestrator_prompt(vars: &PromptVars) -> String {
    render_prompt_template(ORCHESTRATOR_PROMPT_TEMPLATE, vars)
}

/// Fill a template's known `{{PLACEHOLDER}}`s; unknown ones stay as written.
///
/// Same scan as the TypeScript: a regex over `{{[A-Z_]+}}`, so a known
/// placeholder is replaced even when it sits inside an unclosed `{{` block.
#[must_use]
pub fn render_prompt_template(template: &str, vars: &PromptVars) -> String {
    let values = [
        ("FLEET_DIR", vars.fleet_dir.clone()),
        ("REPO_ROOT", vars.repo_root.clone()),
        (
            "MAX_WORKERS",
            vars.max_workers.unwrap_or(DEFAULT_MAX_WORKERS).to_string(),
        ),
        (
            "BIN_NAME",
            vars.bin_name
                .clone()
                .unwrap_or_else(|| BIN_NAME.to_string()),
        ),
    ];
    let Some(re) = placeholder_regex() else {
        return template.to_string();
    };
    re.replace_all(template, |caps: &regex::Captures| {
        let key = caps
            .get(1)
            .map_or(String::new(), |m| m.as_str().to_string());
        values.iter().find(|(k, _)| *k == key).map_or_else(
            || {
                caps.get(0)
                    .map_or(String::new(), |m| m.as_str().to_string())
            },
            |(_, value)| value.clone(),
        )
    })
    .into_owned()
}

fn placeholder_regex() -> Option<&'static regex::Regex> {
    static RE: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\{\{([A-Z_]+)\}\}").ok())
        .as_ref()
}

/// Where the prompt comes from, in override order; `None` means the embedded
/// copy. An explicit `$PARL_PROMPT` that does not exist is an error — it is
/// user intent, and silently falling back would hide the mistake.
///
/// The env value and home directory are injectable (tests).
///
/// # Errors
///
/// Returns an error when `$PARL_PROMPT` points at something that is not a file.
pub fn resolve_prompt_source(
    parl_prompt: Option<&str>,
    repo_root: &Path,
    home: Option<&Path>,
) -> anyhow::Result<Option<PathBuf>> {
    if let Some(path) = parl_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(Some(path));
        }
        anyhow::bail!(
            "$PARL_PROMPT is set to {}, which is not a file",
            path.display()
        );
    }
    let repo_override = repo_root.join(STATE_DIR_NAME).join("orchestrator.md");
    if repo_override.is_file() {
        return Ok(Some(repo_override));
    }
    if let Some(home) = home {
        let user_override = home.join(".config").join("parl").join("orchestrator.md");
        if user_override.is_file() {
            return Ok(Some(user_override));
        }
    }
    Ok(None)
}

/// [`resolve_prompt_source`] against the real environment.
///
/// # Errors
///
/// Returns an error when `$PARL_PROMPT` points at something that is not a file.
pub fn prompt_source(repo_root: &Path) -> anyhow::Result<Option<PathBuf>> {
    resolve_prompt_source(
        std::env::var(env_var("PROMPT")).ok().as_deref(),
        repo_root,
        dirs::home_dir().as_deref(),
    )
}

/// Render the prompt for the fleet rooted at `fleet_dir` working in `repo_root`.
///
/// # Errors
///
/// Returns an error when the resolved override cannot be read.
pub fn render_prompt(fleet_dir: &Path, repo_root: &Path) -> anyhow::Result<String> {
    let template = match prompt_source(repo_root)? {
        Some(path) => std::fs::read_to_string(&path)?,
        None => ORCHESTRATOR_PROMPT_TEMPLATE.to_string(),
    };
    Ok(render_prompt_template(
        &template,
        &PromptVars {
            fleet_dir: fleet_dir.to_string_lossy().into_owned(),
            repo_root: repo_root.to_string_lossy().into_owned(),
            max_workers: None,
            bin_name: None,
        },
    ))
}

/// Render and write to `<fleetDir>/orchestrator/prompt.md` (what
/// `--append-system-prompt-file` reads); returns the path.
///
/// # Errors
///
/// Returns an error when the prompt cannot be rendered or the file written.
pub fn write_prompt(fleet_dir: &Path, repo_root: &Path) -> anyhow::Result<PathBuf> {
    let target = prompt_path(fleet_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, render_prompt(fleet_dir, repo_root)?)?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_template_renders_every_placeholder_and_names_every_tool_and_event() {
        let text = render_orchestrator_prompt(&PromptVars {
            fleet_dir: "/repo/.parl".into(),
            repo_root: "/repo".into(),
            max_workers: None,
            bin_name: None,
        });
        assert!(!text.contains("{{"), "no unrendered placeholders: {text}");
        assert!(text.contains("`/repo/.parl`"), "{text}");
        assert!(text.contains("`/repo`"), "{text}");
        assert!(
            text.contains(&format!("At most {DEFAULT_MAX_WORKERS} workers")),
            "{text}"
        );
        assert!(text.contains(&format!("`{BIN_NAME}`")), "{text}");
        for tool in [
            "fleet_spawn",
            "fleet_status",
            "fleet_wait",
            "fleet_output",
            "fleet_logs",
            "fleet_send",
            "fleet_followup",
            "fleet_answer",
            "fleet_stop",
            "fleet_report",
            "fleet_diff",
            "fleet_merge",
            "fleet_cleanup",
        ] {
            assert!(text.contains(&format!("`{tool}`")), "mentions {tool}");
        }
        assert!(text.contains(r#"<fleet-event kind="settled""#), "{text}");
        for kind in [
            "settled",
            "stopped",
            "error",
            "dead",
            "question",
            "answered_by_console",
            "question_resolved",
            "console_steer",
            "progress",
            "snapshot",
        ] {
            assert!(
                text.contains(&format!("`{kind}`")),
                "explains event kind {kind}"
            );
        }
        assert!(
            text.contains("Never merge a run that is not `settled`"),
            "{text}"
        );
        assert!(text.contains("Never edit files yourself"), "{text}");
        assert!(text.contains("AskUserQuestion"), "{text}");
        assert!(text.contains("exit 5"), "{text}");
        // the rewritten facts: parl branch prefix and the new report layout
        assert!(text.contains("`parl/<name>-<7 chars>`"), "{text}");
        assert!(text.contains("runs/<runId>/report.md"), "{text}");
        assert!(!text.contains("pi-fleet"), "{text}");
        assert!(!text.contains(".pi-fleet"), "{text}");
    }

    #[test]
    fn overrides_honor_custom_values_and_leave_unknown_placeholders_alone() {
        let text = render_prompt_template(
            "{{BIN_NAME}} {{MAX_WORKERS}} {{FLEET_DIR}} {{REPO_ROOT}} {{UNKNOWN}}",
            &PromptVars {
                fleet_dir: "/f".into(),
                repo_root: "/r".into(),
                max_workers: Some(5),
                bin_name: Some("fleetx".into()),
            },
        );
        assert_eq!(text, "fleetx 5 /f /r {{UNKNOWN}}");
    }

    #[test]
    fn malformed_and_unknown_keys_stay_verbatim() {
        // {{Foo}} and {{UNCLOSED never match the scan; {{NOPE}} and {{A_B}} are
        // well-shaped but unknown; the nested {{FLEET_DIR}} inside the unclosed
        // block is well-shaped and known, so it renders — as the regex scan
        // always did.
        let out = render_prompt_template(
            "a {{Foo}} b {{NOPE}} c {{A_B}} {{UNCLOSED d {{FLEET_DIR}} e",
            &PromptVars {
                fleet_dir: "/f".into(),
                repo_root: "/r".into(),
                max_workers: None,
                bin_name: None,
            },
        );
        assert_eq!(out, "a {{Foo}} b {{NOPE}} c {{A_B}} {{UNCLOSED d /f e");
    }

    #[test]
    fn write_prompt_lands_under_the_orchestrator_dir() {
        let root = std::env::temp_dir().join(format!(
            "parl-prompt-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(&root).unwrap();
        let fleet_dir = root.join(STATE_DIR_NAME);
        let path = write_prompt(&fleet_dir, &root).unwrap();
        assert_eq!(path, prompt_path(&fleet_dir));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# Fleet orchestrator"), "{text}");
    }

    #[test]
    fn overrides_resolve_in_order_and_a_dangling_parl_prompt_is_an_error() {
        let repo = std::env::temp_dir().join(format!(
            "parl-prompt-res-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        let parl = repo.join(STATE_DIR_NAME);
        std::fs::create_dir_all(&parl).unwrap();
        let home = std::env::temp_dir().join(format!(
            "parl-prompt-home-{}-{}",
            std::process::id(),
            crate::util::new_id("t").replace('_', "")
        ));
        std::fs::create_dir_all(home.join(".config/parl")).unwrap();

        // nothing anywhere: embedded
        assert_eq!(
            resolve_prompt_source(None, &repo, Some(&home)).unwrap(),
            None
        );
        // ~/.config/parl next
        let user = home.join(".config/parl/orchestrator.md");
        std::fs::write(&user, "user").unwrap();
        assert_eq!(
            resolve_prompt_source(None, &repo, Some(&home)).unwrap(),
            Some(user)
        );
        // <repo>/.parl beats the user config
        let repo_override = parl.join("orchestrator.md");
        std::fs::write(&repo_override, "repo").unwrap();
        assert_eq!(
            resolve_prompt_source(None, &repo, Some(&home)).unwrap(),
            Some(repo_override)
        );
        // $PARL_PROMPT beats everything
        let env_file = repo.join("custom-prompt.md");
        std::fs::write(&env_file, "env").unwrap();
        assert_eq!(
            resolve_prompt_source(env_file.to_str(), &repo, Some(&home)).unwrap(),
            Some(env_file)
        );
        // a dangling $PARL_PROMPT is an error, not a silent fallback
        let err = resolve_prompt_source(repo.join("missing.md").to_str(), &repo, Some(&home))
            .expect_err("dangling override errors");
        assert!(err.to_string().contains("not a file"), "{err}");
    }
}
