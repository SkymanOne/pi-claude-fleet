//! The draw functions: one module per region of the screen, one
//! orchestration point here. Every draw call is pure over the view model:
//! the `Console` state machine, plus the [`Feeds`] the runtime polled from
//! `.parl` this frame. Nothing here mutates state except
//! `console.viewport_rows`, which the state machine's scrolling keys read.

pub mod composer;
pub mod dashboard;
pub mod overlay;
pub mod session;
pub mod statusline;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

use crate::orch::records::OrchestratorState;
use crate::tui::app::{Console, RunEntry, View};
use crate::tui::theme::Palette;

/// The facts the runtime polled from `.parl` and hands the renderer beside
/// the `Console`: the orchestrator's durable state (permission mode, pending
/// approvals) and every run's, so the status line and the permission overlay
/// can read what the state machine deliberately keeps private.
pub struct Feeds<'a> {
    pub orch: &'a OrchestratorState,
    pub runs: &'a [RunEntry],
}

/// Draw the whole console for one frame. Infallible: every widget here
/// renders into the buffer, nothing touches fallible IO.
pub fn draw(frame: &mut Frame, console: &mut Console, feeds: &Feeds<'_>, pal: &Palette) {
    let area = frame.area();
    let [main, status] = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(area);
    match console.view() {
        View::Dashboard => dashboard::draw(frame, main, console, pal),
        View::Session => session::draw(frame, main, console, feeds, pal),
    }
    statusline::draw(frame, status, console, feeds, pal);
    // overlays go last so they sit over everything, dimming what is behind
    if let Some(overlay) = console.overlay().cloned() {
        overlay::draw(frame, area, console, feeds, &overlay, pal);
    }
}

/// Clip to `max` printed columns, ellipsis on the cut. Shared by the
/// dashboard and the session list, whose names yield for the age column.
pub(crate) fn clip_to(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = ch.width().unwrap_or(1);
        if used + w > max.saturating_sub(1) {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}
