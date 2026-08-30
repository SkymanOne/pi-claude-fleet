//! Approval, question and confirm popups: `y` allows once, `a` allows for
//! the session, `n` denies with a reason; questions get an option picker.
//! Implemented in the tui-render step (see the TypeScript
//! `src/tui/Approval.tsx`, `Confirm.tsx`).

/// Draw an overlay popup for one frame.
pub fn draw(_frame: &mut ratatui::Frame) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: overlay view")
}
