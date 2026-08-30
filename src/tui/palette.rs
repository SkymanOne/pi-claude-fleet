//! Fuzzy command palette over the console's commands and the agents' own
//! commands, ranked with nucleo-matcher. Implemented in the tui-render step
//! (see the TypeScript `src/tui/Suggestions.tsx`).

/// Rank `candidates` against the typed query, best first.
pub fn rank<'a>(_query: &str, _candidates: &[&'a str]) -> anyhow::Result<Vec<&'a str>> {
    anyhow::bail!("not implemented yet: command palette")
}
