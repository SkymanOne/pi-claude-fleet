//! The orchestrator prompt. Override order: `$PARL_PROMPT` (a path), then
//! `<repo>/.parl/orchestrator.md`, then `~/.config/parl/orchestrator.md`,
//! then the copy embedded in the binary with `include_str!`. Nothing is ever
//! copied into a project. Implemented in the orch step (see
//! `prompts/orchestrator.md` for the content).

/// Render the orchestrator prompt for the fleet rooted at `fleet_dir`.
pub fn render_prompt(
    _fleet_dir: &std::path::Path,
    _repo_root: &std::path::Path,
) -> anyhow::Result<String> {
    anyhow::bail!("not implemented yet: orchestrator prompt")
}
