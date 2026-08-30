//! `/` and `@` completions in the composer: the commands the selected
//! session offers, then workers, then repository files. Implemented in the
//! tui-render step (see the TypeScript `src/tui/completions.ts`).

/// Suggestions for the word the cursor is on.
pub fn suggestions(_input: &str, _cursor: usize) -> anyhow::Result<Vec<String>> {
    anyhow::bail!("not implemented yet: composer completions")
}
