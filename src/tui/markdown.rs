//! Markdown -> ratatui Text: headings, emphasis, inline code, lists, links
//! and tables laid out in columns (pulldown-cmark). Implemented in the
//! tui-render step (see the TypeScript `src/tui/markdown.ts`).

/// Render markdown into styled lines no wider than `width`.
pub fn render(_markdown: &str, _width: usize) -> anyhow::Result<Vec<ratatui::text::Line<'static>>> {
    anyhow::bail!("not implemented yet: markdown rendering")
}
