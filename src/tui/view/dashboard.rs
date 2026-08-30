//! The dashboard: the session rail beside the selected transcript, glyph
//! (`○ ● ? ✓ !`) carrying the state and the row widening to fit the worker
//! names. Implemented in the tui-render step.

/// Draw the whole dashboard for one frame.
pub fn draw(_frame: &mut ratatui::Frame) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: dashboard view")
}
