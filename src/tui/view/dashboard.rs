//! The dashboard: the home view. The whole fleet at a glance — a header
//! summarising it, one two-line row per session (the orchestrator first),
//! and a footer of key hints for the current mode. The primary line carries
//! the state glyph, the name, and the age on the right; workers also show
//! their branch and diff stat when known. The dimmed second line is what the
//! session is doing right now. A dozen workers stay readable because the
//! rows use the full width — nothing is clipped to a narrow rail.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::tui::app::Console;
use crate::tui::model::DashboardRow;
use crate::tui::theme::Palette;

/// The key hints, by mode (the footer line).
pub const HINTS_NORMAL: &str =
    "j/k move · enter open · a answer · s stop · i compose · : palette · ? help · q quit";
pub const HINTS_INSERT: &str = "enter send · alt-enter newline · tab accept · esc normal";

/// Draw the dashboard over `area` (the frame minus the status line).
pub fn draw(frame: &mut Frame, area: Rect, console: &Console, pal: &Palette) {
    let [header, rows, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .areas(area);
    draw_header(frame, header, console.rows(), pal);
    draw_rows(frame, rows, console, pal);
    draw_footer(frame, footer, console, pal);
}

fn draw_header(frame: &mut Frame, area: Rect, rows: &[DashboardRow], pal: &Palette) {
    let workers = rows.len().saturating_sub(1);
    let mut spans = vec![
        Span::styled("parl".to_string(), pal.heading()),
        Span::raw(" · ".to_string()),
    ];
    if workers == 0 {
        spans.push(Span::raw("orchestrator only".to_string()));
    } else {
        spans.push(Span::raw(format!("orchestrator + {workers} workers")));
    }
    for (glyph, label) in counts_by_state(rows) {
        spans.push(Span::styled(
            format!(" · {label} {}", count_of(rows, glyph)),
            state_style(pal, glyph),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_rows(frame: &mut Frame, area: Rect, console: &Console, pal: &Palette) {
    let all = console.rows();
    let selected = console.selected();
    let capacity = (area.height as usize / 2).max(1);
    // the selection is always in the window
    let start = if all.len() <= capacity {
        0
    } else {
        selected
            .saturating_sub(capacity.saturating_sub(1))
            .min(all.len() - capacity)
    };
    let visible = all.len().saturating_sub(start).min(capacity);
    for i in 0..visible {
        let row = &all[start + i];
        let is_selected = start + i == selected;
        let top = Rect::new(area.x, area.y + (i * 2) as u16, area.width, 1);
        let bottom = Rect::new(area.x, area.y + (i * 2 + 1) as u16, area.width, 1);
        frame.render_widget(
            Paragraph::new(primary_line(row, is_selected, area.width, pal)),
            top,
        );
        frame.render_widget(
            Paragraph::new(secondary_line(row, is_selected, pal)),
            bottom,
        );
    }
    let hidden = all.len() - start - visible;
    if hidden > 0 {
        let at = area.y + (visible as u16 * 2).min(area.height.saturating_sub(1));
        frame.render_widget(
            Paragraph::new(Line::styled(
                format!(
                    "… {hidden} more session{} — j/k to reach them",
                    if hidden == 1 { "" } else { "s" }
                ),
                pal.dim(),
            )),
            Rect::new(area.x, at, area.width, 1),
        );
    }
}

/// The primary row: `▸ ● db    parl/db-… +12 −3   2m` — glyph, name, right
/// side. The age is always visible; the name yields for it.
fn primary_line(row: &DashboardRow, selected: bool, width: u16, pal: &Palette) -> Line<'static> {
    let width = width as usize;
    let marker = if selected { "▸ " } else { "  " };
    let base = if selected {
        pal.selected()
    } else if row.attention {
        pal.attention()
    } else if row.target.is_worker() {
        Style::default()
    } else {
        pal.accent().add_modifier(Modifier::BOLD)
    };
    let mut spans = vec![
        Span::styled(marker.to_string(), base),
        Span::styled(format!("{} ", row.glyph), base),
    ];
    // the right side: branch, diff stat, age
    let mut right = String::new();
    if let Some(branch) = &row.branch {
        right.push_str(branch);
    }
    if let Some(stat) = &row.diff_stat {
        if !right.is_empty() {
            right.push(' ');
        }
        right.push_str(stat);
    }
    if !row.age.is_empty() {
        if !right.is_empty() {
            right.push_str("  ");
        }
        right.push_str(&row.age);
    }
    let used = marker.width() + row.glyph.width() + 1;
    let name_room = width.saturating_sub(used + right.width() + 2).max(3);
    let name = clip_to(&row.name, name_room);
    spans.push(Span::styled(name.clone(), base));
    // fill to the right edge, at least one separating space
    let gap = width
        .saturating_sub(used + name.width() + right.width())
        .max(1);
    spans.push(Span::styled(" ".repeat(gap), base));
    if !right.is_empty() {
        let right_style = if selected { base } else { pal.dim() };
        spans.push(Span::styled(right, right_style));
    }
    Line::from(spans)
}

/// The dimmed second line: what the session is doing right now.
fn secondary_line(row: &DashboardRow, selected: bool, pal: &Palette) -> Line<'static> {
    let base = if selected {
        pal.selected()
    } else if row.attention {
        pal.attention()
    } else {
        pal.dim()
    };
    Line::from(vec![
        Span::styled("    ".to_string(), base),
        Span::styled(row.detail.clone(), base),
    ])
}

fn draw_footer(frame: &mut Frame, area: Rect, console: &Console, pal: &Palette) {
    let line = match console.flash() {
        Some(flash) => Line::styled(
            flash.text.clone(),
            if flash.error { pal.error() } else { pal.dim() },
        ),
        None => {
            let hint = match console.mode() {
                crate::tui::keys::Mode::Normal => HINTS_NORMAL,
                crate::tui::keys::Mode::Insert => HINTS_INSERT,
            };
            Line::styled(hint.to_string(), pal.dim())
        }
    };
    frame.render_widget(Paragraph::new(line), area);
}

fn count_of(rows: &[DashboardRow], glyph: &str) -> usize {
    rows.iter().filter(|r| r.glyph == glyph).count()
}

/// Non-zero state counts in reading order, as `(glyph, label)` pairs.
fn counts_by_state(rows: &[DashboardRow]) -> Vec<(&'static str, &'static str)> {
    [
        ("●", "running"),
        ("?", "needs an answer"),
        ("…", "starting"),
        ("✓", "done"),
        ("■", "stopped"),
        ("!", "failed"),
        ("○", "idle"),
    ]
    .into_iter()
    .filter(|(glyph, _)| count_of(rows, glyph) > 0)
    .collect()
}

fn state_style(pal: &Palette, glyph: &str) -> Style {
    match glyph {
        "?" | "!" => pal.attention(),
        "●" => pal.accent(),
        _ => pal.dim(),
    }
}

/// Clip to `max` printed columns, ellipsis on the cut.
fn clip_to(text: &str, max: usize) -> String {
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
