//! The session drill-down: the transcript of one session, blocks set off by
//! blank lines, tool output as a preview with a count of what was left out.
//! Implemented in the tui-render step.

/// Draw one session's transcript for one frame.
pub fn draw(_frame: &mut ratatui::Frame) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: session view")
}
