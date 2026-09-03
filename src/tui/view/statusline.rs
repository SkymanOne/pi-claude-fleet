//! The status line: what is selected, in one row. For a worker its state,
//! model, reasoning level and branch; for the orchestrator its model,
//! session, spend and turns. Plus the pending-approval count, the
//! permission mode when it is not the default, and the console's mode
//! indicator (NORMAL/INSERT) on the right.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::UnicodeWidthStr;

use crate::fleet::run::derive_view;
use crate::tui::app::Console;
use crate::tui::keys::Mode;
use crate::tui::model::SessionTarget;
use crate::tui::theme::Palette;
use crate::tui::view::Feeds;
use crate::util::now_ms;

/// Draw one status row across `area`.
pub fn draw(frame: &mut Frame, area: Rect, console: &Console, feeds: &Feeds<'_>, pal: &Palette) {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let part = |parts: &mut Vec<Span<'static>>, text: String, style: ratatui::style::Style| {
        if !parts.is_empty() {
            parts.push(Span::styled(" · ".to_string(), pal.dim()));
        }
        parts.push(Span::styled(text, style));
    };

    match console.selected_target() {
        SessionTarget::Worker { run_id } => {
            if let Some(entry) = feeds.runs.iter().find(|r| r.run_id == run_id) {
                let state = &entry.state;
                let view = derive_view(state, crate::fleet::run::is_alive, now_ms());
                let state_style = if state.pending_question.is_some() {
                    pal.attention()
                } else {
                    pal.dim()
                };
                part(&mut spans, state.name.clone(), pal.accent());
                part(&mut spans, view.to_string(), state_style);
                part(
                    &mut spans,
                    state.model_label().unwrap_or("default model").to_string(),
                    pal.dim(),
                );
                if let Some(level) = &state.thinking_level {
                    part(&mut spans, format!("thinking {level}"), pal.dim());
                }
                if let Some(branch) = &state.branch {
                    part(&mut spans, branch.clone(), pal.dim());
                }
            } else {
                part(&mut spans, "gone".to_string(), pal.error());
            }
        }
        SessionTarget::Orchestrator(_) => {
            let transcript = console.orchestrator_transcript();
            let model = transcript
                .model()
                .or(feeds.orch.model.as_deref())
                .unwrap_or("starting…");
            part(&mut spans, model.to_string(), pal.dim());
            part(
                &mut spans,
                transcript.session_id().map_or_else(
                    || "no session".to_string(),
                    |id| id.chars().take(8).collect(),
                ),
                pal.dim(),
            );
            part(
                &mut spans,
                format!("${:.3}", transcript.cost_usd()),
                pal.dim(),
            );
            let turns = transcript.num_turns();
            part(
                &mut spans,
                format!("{turns} turn{}", if turns == 1 { "" } else { "s" }),
                pal.dim(),
            );
            if let Some(effort) = console.effort() {
                part(&mut spans, format!("thinking {effort}"), pal.dim());
            }
            let working = feeds.orch.turn_active || transcript.turn_active();
            if working {
                part(&mut spans, "working".to_string(), pal.attention());
            }
            // only worth saying when it is not the mode that asks about everything
            let mode = &feeds.orch.permission_mode;
            if mode != "default" {
                part(&mut spans, format!("perms {mode}"), pal.attention());
            }
        }
    }

    // a wheel that stopped scrolling must never be a mystery
    if !console.mouse_captured() {
        part(&mut spans, "select".to_string(), pal.attention());
    }

    let approvals = feeds.orch.pending_requests.len();
    if approvals > 0 {
        part(
            &mut spans,
            format!(
                "{} approval{} pending",
                approvals,
                if approvals == 1 { "" } else { "s" }
            ),
            pal.attention(),
        );
    }

    // the mode chip rides on the right: NORMAL rests, INSERT glows
    let chip = match console.mode() {
        Mode::Normal => Span::styled(" NORMAL ".to_string(), pal.dim()),
        Mode::Insert => Span::styled(
            " INSERT ".to_string(),
            pal.accent().add_modifier(Modifier::REVERSED),
        ),
    };
    let used: usize = spans.iter().map(|s| s.content.width()).sum();
    let chip_width = chip.content.width();
    let width = area.width as usize;
    let gap = width.saturating_sub(used + chip_width).max(1);
    if spans.len() < (width.saturating_sub(chip_width + 1)) {
        spans.push(Span::raw(" ".repeat(gap)));
        spans.push(chip);
    } else {
        // too wide for the row: the facts matter more than the chip
        spans.truncate(width);
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}
