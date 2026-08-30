//! The status line: for a worker its state, model, reasoning level and
//! branch; for the orchestrator its model, session, spend and turns;
//! permission mode whenever it is not the default. Implemented in the
//! tui-render step.

/// Draw the status line for one frame.
pub fn draw(_frame: &mut ratatui::Frame) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: status line view")
}
