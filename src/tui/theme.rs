//! The console's colors and glyphs: prompts in cyan, reasoning dimmed, tool
//! calls in blue, fleet events in yellow; state glyphs `○ ● ? ✓ !`.
//! Implemented in the tui-render step (see the TypeScript
//! `src/tui/layout.ts`).

/// The color for a transcript block kind.
pub fn block_color(_kind: &str) -> anyhow::Result<ratatui::style::Color> {
    anyhow::bail!("not implemented yet: theme")
}
