//! The composer: the input box the console talks through, the activity line
//! above it (`✻ thinking… 12s`, `✎ replying…`, the tool in flight), the
//! flash note, and the suggestion popup floating above the box. The text
//! itself is owned by the state machine (`Composer.input` + a char cursor);
//! it is mirrored into a `tui-textarea` each frame so the widget handles
//! multi-line layout, growth to a cap, and scrolling under the cursor.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear};
use tui_textarea::TextArea;
use unicode_width::UnicodeWidthStr;

use crate::tui::app::Console;
use crate::tui::keys::Mode;
use crate::tui::theme::Palette;

/// The composer grows with the message, up to this many text rows.
pub const MAX_LINES: usize = 5;

/// Draw the chrome under the transcript: flash note, activity line, composer.
pub fn draw(frame: &mut Frame, area: Rect, console: &Console, pal: &Palette, now: i64) {
    let flash = console.flash();
    let activity = console.activity_line(now);
    let mut parts: Vec<Constraint> = Vec::new();
    if flash.is_some() {
        parts.push(Constraint::Length(1));
    }
    if activity.is_some() {
        parts.push(Constraint::Length(1));
    }
    parts.push(Constraint::Min(1));
    let chunks = Layout::vertical(parts).split(area);

    let mut at = 0;
    if let Some(flash) = flash {
        let style = if flash.error { pal.error() } else { pal.dim() };
        frame.render_widget(
            ratatui::widgets::Paragraph::new(Line::styled(flash.text.clone(), style)),
            chunks[at],
        );
        at += 1;
    }
    if let Some(line) = activity {
        frame.render_widget(
            ratatui::widgets::Paragraph::new(Line::styled(line, pal.dim())),
            chunks[at],
        );
        at += 1;
    }
    draw_box(frame, chunks[at], console, pal);
}

/// The input box itself: what it is aimed at as the title, a caret only when
/// the console is in insert mode, an amber title while answering a question.
fn draw_box(frame: &mut Frame, area: Rect, console: &Console, pal: &Palette) {
    let composer = console.composer();
    let insert = console.mode() == Mode::Insert;
    let answering = composer.answering.is_some();
    let style = if answering {
        pal.attention()
    } else if insert {
        pal.accent()
    } else {
        pal.dim()
    };
    let block = Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(style)
        .title(Span::styled(
            format!(" {}", console.composer_prompt()),
            style,
        ));

    let mut textarea = TextArea::new(
        composer
            .input
            .split('\n')
            .map(str::to_string)
            .collect::<Vec<_>>(),
    );
    textarea.set_block(block);
    textarea.set_style(Style::default());
    textarea.set_cursor_line_style(Style::default());
    if insert {
        textarea.set_cursor_style(Style::default().add_modifier(Modifier::REVERSED));
    } else {
        // the same style as the cursor line hides the caret: the composer is
        // not focused in normal mode
        textarea.set_cursor_style(Style::default());
    }
    let (row, col) = cursor_pos(&composer.input, composer.cursor);
    textarea.move_cursor(tui_textarea::CursorMove::Jump(row as u16, col as u16));
    // a &TextArea renders as a widget directly (0.7 deprecated .widget())
    frame.render_widget(&textarea, area);
}

/// The suggestion popup: a floating list above the composer, the highlighted
/// entry marked, kind-coloured labels with their details dimmed.
pub fn draw_popup(
    frame: &mut Frame,
    transcript_area: Rect,
    composer_area: Rect,
    console: &Console,
    pal: &Palette,
) {
    let composer = console.composer();
    let Some(completion) = composer.completion.clone() else {
        return;
    };
    if composer.dismissed || completion.items.is_empty() {
        return;
    }
    let selected = composer.completion_index.min(completion.items.len() - 1);

    // the widest row decides the width; it never leaves the pane
    let wanted = completion
        .items
        .iter()
        .map(|s| s.label.width() + s.detail.width() + 8)
        .max()
        .unwrap_or(20) as u16;
    let x = composer_area.x.saturating_add(1);
    let max_width = transcript_area
        .width
        .saturating_sub(x.saturating_sub(transcript_area.x));
    let width = wanted.min(max_width).max(12);
    let height = (completion.items.len() as u16 + 3).min(transcript_area.height.max(3));
    let y = composer_area.y.saturating_sub(height);
    if y < transcript_area.y {
        return; // no room above the composer
    }
    let area = Rect::new(x, y, width, height);
    frame.render_widget(Clear, area);
    let block = Block::new()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(pal.accent());
    let inner = block.inner(area);
    frame.render_widget(block, area);

    // one row for each suggestion plus the hint line
    let rows = inner.height.saturating_sub(1) as usize;
    for (i, item) in completion.items.iter().enumerate() {
        if i >= rows {
            break;
        }
        let is_selected = i == selected;
        let marker = if is_selected { "▸ " } else { "  " };
        let label_style = pal.suggestion(item.kind);
        let label_style = if is_selected {
            label_style.add_modifier(Modifier::REVERSED)
        } else {
            label_style
        };
        let detail_style = if is_selected {
            pal.dim().add_modifier(Modifier::REVERSED)
        } else {
            pal.dim()
        };
        let mut spans = vec![
            Span::styled(marker.to_string(), label_style),
            Span::styled(item.label.clone(), label_style),
        ];
        if !item.detail.is_empty() {
            spans.push(Span::styled(format!("  {}", item.detail), detail_style));
        }
        frame.render_widget(
            ratatui::widgets::Paragraph::new(Line::from(spans)),
            Rect::new(inner.x, inner.y + i as u16, inner.width, 1),
        );
    }
    frame.render_widget(
        ratatui::widgets::Paragraph::new(Line::styled(
            "tab accept · esc dismiss".to_string(),
            pal.dim(),
        )),
        Rect::new(
            inner.x,
            inner.y + inner.height.saturating_sub(1),
            inner.width,
            1,
        ),
    );
}

/// The char cursor as a (row, col) pair, which is what the textarea jumps to.
fn cursor_pos(input: &str, cursor: usize) -> (usize, usize) {
    let mut row = 0;
    let mut col = 0;
    for (seen, ch) in input.chars().enumerate() {
        if seen >= cursor {
            break;
        }
        if ch == '\n' {
            row += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (row, col)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_lands_after_newlines() {
        assert_eq!(cursor_pos("hello", 3), (0, 3));
        assert_eq!(cursor_pos("hello", 5), (0, 5));
        assert_eq!(
            cursor_pos("a\nb\nc", 2),
            (1, 0),
            "the char after the newline"
        );
        assert_eq!(cursor_pos("a\nb\nc", 4), (2, 0), "'c' opens row 2");
        assert_eq!(cursor_pos("a\nb\nc", 5), (2, 1));
        assert_eq!(cursor_pos("a\nb", 3), (1, 1), "one past the end");
        assert_eq!(cursor_pos("", 0), (0, 0));
    }

    #[test]
    fn composer_height_grows_to_the_cap() {
        let lines = |input: &str| input.split('\n').count().clamp(1, MAX_LINES);
        assert_eq!(lines("one"), 1);
        assert_eq!(lines("one\ntwo\nthree"), 3);
        let tall = "x\n".repeat(10);
        assert_eq!(lines(tall.trim_end()), MAX_LINES, "capped");
    }
}
