//! `pi --list-models` and model checking: refuse a `--model` pattern pi
//! cannot resolve before a worktree exists, naming the closest models it
//! does have. Implemented in the worker step (see the TypeScript
//! `src/models.ts`).

/// The models pi offers, as `provider/model-id`.
pub async fn list_models(_pi_bin: &str) -> anyhow::Result<Vec<String>> {
    anyhow::bail!("not implemented yet: pi model list")
}

/// Check a `--model` pattern against pi's models before spawning anything.
pub async fn check_model(_pi_bin: &str, _pattern: &str) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: model check")
}
