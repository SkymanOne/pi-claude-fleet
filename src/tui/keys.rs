//! Modal key map: normal-mode bindings vs the composer's insert mode, so a
//! message that starts with "q" does not quit the app — in insert mode only
//! the composer's own keys are bound. The help overlay is built from the same
//! tables, so the bindings and the help cannot drift.
//!
//! The map is pure: it turns one [`KeyEvent`] into one [`KeyAction`] and the
//! app decides what the action does in the current view.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

/// Which key mode the console is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// Single-letter keys are free because the composer does not have focus.
    #[default]
    Normal,
    /// The composer has focus and types freely.
    Insert,
}

/// What a keypress means in the current mode. The app interprets it; the map
/// only translates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    // -- navigation (normal mode, both views) --
    /// `j`/`k`/arrows: move the selection by one row.
    Move(i32),
    /// `g`/Home: the first row, or the top of the transcript.
    First,
    /// `G`/End: the last row, or the bottom of the transcript.
    Last,
    /// Enter: open the selected session (dashboard only).
    Open,
    /// Esc: back to the dashboard (session view only).
    Back,
    /// Tab / Shift-Tab: next / previous session.
    NextSession,
    PrevSession,
    /// `1`–`9`: jump to the nth session.
    JumpTo(usize),
    /// `/`: search the open session's transcript.
    Search,
    /// `:` or Ctrl-K: the command palette.
    OpenPalette,
    /// `?`: the help overlay.
    Help,
    /// `q`: close the console; workers keep running.
    Quit,
    /// `Q`: stop the orchestrator and every worker (asks first).
    Shutdown,
    // -- session actions on the selected session (normal mode) --
    /// `a`: answer the pending question or dialog.
    Answer,
    /// `s`: stop the selected worker.
    Stop,
    /// `x`: remove the selected worker (asks first).
    Remove,
    /// `t`: cycle the thinking level of the selected session.
    CycleThinking,
    /// `m`: the palette, over models.
    Models,
    /// `p`: cycle the orchestrator's permission mode.
    PermissionMode,
    // -- transcript scrolling (session view) --
    ScrollHalfDown,
    ScrollHalfUp,
    ScrollPageDown,
    ScrollPageUp,
    /// `n`/`N`: next / previous search match.
    NextMatch,
    PrevMatch,
    // -- insert mode --
    /// A printable character typed into the composer.
    InsertChar(char),
    InsertBackspace,
    InsertDelete,
    InsertLeft,
    InsertRight,
    InsertHome,
    InsertEnd,
    /// Enter: send the composer's line.
    Send,
    /// Alt-Enter (or Ctrl-J): a newline, not a send.
    Newline,
    /// Tab: accept the highlighted completion.
    AcceptCompletion,
    /// Up/Down: through completions, or recall history when none are open.
    CompletionPrev,
    CompletionNext,
    /// Esc: back to normal mode.
    LeaveInsert,
    /// Ctrl-K: the palette, from the composer.
    PaletteInInsert,
    /// Bound to nothing.
    Ignored,
}

/// Is this key event a real press (not a kitty-protocol release)?
fn is_press(key: &KeyEvent) -> bool {
    key.kind != KeyEventKind::Release
}

fn ctrl(key: &KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
}

/// Map a key press to an action. Printables in normal mode fall through to
/// [`KeyAction::InsertChar`] — starting to type is never punished.
#[must_use]
pub fn map_key(mode: Mode, key: KeyEvent) -> KeyAction {
    if !is_press(&key) {
        return KeyAction::Ignored;
    }
    match mode {
        Mode::Normal => map_normal(key),
        Mode::Insert => map_insert(key),
    }
}

fn map_normal(key: KeyEvent) -> KeyAction {
    use KeyAction as A;
    match key.code {
        KeyCode::Char('j') | KeyCode::Down => A::Move(1),
        // ctrl+k must be tested before the bare k that moves up
        KeyCode::Char('k') if ctrl(&key) => A::OpenPalette,
        KeyCode::Char('k') | KeyCode::Up => A::Move(-1),
        KeyCode::Char('g') | KeyCode::Home => A::First,
        KeyCode::Char('G') | KeyCode::End => A::Last,
        KeyCode::Enter => A::Open,
        KeyCode::Esc => A::Back,
        KeyCode::Tab => A::NextSession,
        KeyCode::BackTab => A::PrevSession,
        KeyCode::Char(ch @ '1'..='9') => A::JumpTo(ch as usize - '1' as usize),
        KeyCode::Char('/') => A::Search,
        KeyCode::Char(':') => A::OpenPalette,
        KeyCode::Char('?') => A::Help,
        KeyCode::Char('q') => A::Quit,
        KeyCode::Char('Q') => A::Shutdown,
        KeyCode::Char('a') => A::Answer,
        KeyCode::Char('s') => A::Stop,
        KeyCode::Char('x') => A::Remove,
        KeyCode::Char('t') => A::CycleThinking,
        KeyCode::Char('m') => A::Models,
        KeyCode::Char('p') => A::PermissionMode,
        KeyCode::Char('n') => A::NextMatch,
        KeyCode::Char('N') => A::PrevMatch,
        KeyCode::Char('d') if ctrl(&key) => A::ScrollHalfDown,
        KeyCode::Char('u') if ctrl(&key) => A::ScrollHalfUp,
        KeyCode::Char('f') if ctrl(&key) => A::ScrollPageDown,
        KeyCode::Char('b') if ctrl(&key) => A::ScrollPageUp,
        KeyCode::PageDown => A::ScrollPageDown,
        KeyCode::PageUp => A::ScrollPageUp,
        // Any other printable starts a message: normal mode keeps the char.
        KeyCode::Char(ch) if !ctrl(&key) => A::InsertChar(ch),
        _ => A::Ignored,
    }
}

fn map_insert(key: KeyEvent) -> KeyAction {
    use KeyAction as A;
    match key.code {
        KeyCode::Char(ch) if !ctrl(&key) => A::InsertChar(ch),
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::ALT) => A::Newline,
        KeyCode::Char('j') if ctrl(&key) => A::Newline,
        KeyCode::Enter => A::Send,
        KeyCode::Tab => A::AcceptCompletion,
        KeyCode::Backspace => A::InsertBackspace,
        KeyCode::Delete => A::InsertDelete,
        KeyCode::Left => A::InsertLeft,
        KeyCode::Right => A::InsertRight,
        KeyCode::Home => A::InsertHome,
        KeyCode::End => A::InsertEnd,
        KeyCode::Up => A::CompletionPrev,
        KeyCode::Down => A::CompletionNext,
        KeyCode::Esc => A::LeaveInsert,
        KeyCode::Char('k') if ctrl(&key) => A::PaletteInInsert,
        _ => A::Ignored,
    }
}

// ---------------------------------------------------------------------------
// The help overlay, built from the same table as the bindings above

/// One row of the help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyHelp {
    pub keys: &'static str,
    pub what: &'static str,
}

/// Compact on purpose: the help shares the pane with everything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelpSection {
    pub title: &'static str,
    pub rows: &'static [KeyHelp],
}

pub const NORMAL_KEYS: &[KeyHelp] = &[
    KeyHelp {
        keys: "j k / arrows",
        what: "move the selection",
    },
    KeyHelp {
        keys: "g / G",
        what: "first / last row, or top / bottom of the transcript",
    },
    KeyHelp {
        keys: "enter",
        what: "open the selected session",
    },
    KeyHelp {
        keys: "esc",
        what: "back to the dashboard",
    },
    KeyHelp {
        keys: "tab / shift-tab",
        what: "next / previous session",
    },
    KeyHelp {
        keys: "1-9",
        what: "jump to the nth session",
    },
    KeyHelp {
        keys: "/",
        what: "search this session",
    },
    KeyHelp {
        keys: ": or ctrl-k",
        what: "the command palette",
    },
    KeyHelp {
        keys: "?",
        what: "this help",
    },
    KeyHelp {
        keys: "a",
        what: "answer the pending question or dialog",
    },
    KeyHelp {
        keys: "s",
        what: "stop the selected worker",
    },
    KeyHelp {
        keys: "x",
        what: "remove the selected worker (asks first)",
    },
    KeyHelp {
        keys: "t",
        what: "cycle the thinking level",
    },
    KeyHelp {
        keys: "m",
        what: "switch the model (palette)",
    },
    KeyHelp {
        keys: "p",
        what: "permission mode (orchestrator only)",
    },
    KeyHelp {
        keys: "ctrl-d / ctrl-u",
        what: "scroll half a page down / up",
    },
    KeyHelp {
        keys: "ctrl-f / ctrl-b",
        what: "scroll a page down / up",
    },
    KeyHelp {
        keys: "n / N",
        what: "next / previous search match",
    },
    KeyHelp {
        keys: "q",
        what: "close the console; workers keep running",
    },
    KeyHelp {
        keys: "Q",
        what: "stop the orchestrator and every worker, then exit",
    },
    KeyHelp {
        keys: "i (or any letter)",
        what: "compose: enter insert mode, keeping the key",
    },
];

pub const INSERT_KEYS: &[KeyHelp] = &[
    KeyHelp {
        keys: "type + enter",
        what: "message the orchestrator, or steer the selected worker",
    },
    KeyHelp {
        keys: "alt-enter",
        what: "newline",
    },
    KeyHelp {
        keys: "/",
        what: "commands and skills",
    },
    KeyHelp {
        keys: "@",
        what: "workers and repository files",
    },
    KeyHelp {
        keys: "tab",
        what: "accept the highlighted suggestion",
    },
    KeyHelp {
        keys: "up / down",
        what: "move through suggestions, or recall what you sent",
    },
    KeyHelp {
        keys: "esc",
        what: "back to normal mode",
    },
    KeyHelp {
        keys: "ctrl-k",
        what: "the command palette",
    },
];

/// The help as sections, so it can be laid out in columns and always fit.
#[must_use]
pub fn help_sections() -> Vec<HelpSection> {
    vec![
        HelpSection {
            title: "Normal",
            rows: NORMAL_KEYS,
        },
        HelpSection {
            title: "Insert",
            rows: INSERT_KEYS,
        },
    ]
}

/// The help as one string, for tests and for narrow renderers.
#[must_use]
pub fn help_text() -> String {
    let mut out = String::new();
    for section in help_sections() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&render_section(&section));
    }
    out
}

fn render_section(section: &HelpSection) -> String {
    let mut out = String::from(section.title);
    out.push(':');
    for row in section.rows {
        out.push_str(&format!("\n  {:18} {}", row.keys, row.what));
    }
    out
}

/// The help as lines that fit `width`, capped at `maxRows`. What does not fit
/// is counted rather than silently cut off the bottom.
#[must_use]
pub fn help_lines(width: usize, max_rows: usize) -> Vec<String> {
    use unicode_width::UnicodeWidthStr;
    let mut lines = Vec::new();
    for section in help_sections() {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.extend(render_section(&section).split('\n').map(str::to_string));
    }
    let rows = |line: &str| -> usize {
        let w = line.width();
        if w == 0 { 1 } else { w.div_ceil(width.max(1)) }
    };
    let mut shown = Vec::new();
    let mut used = 0;
    for line in &lines {
        // keep a row for the notice when there is more after this one
        if used + rows(line) > max_rows.saturating_sub(1)
            && !shown.is_empty()
            && shown.len() < lines.len()
        {
            break;
        }
        shown.push(line.clone());
        used += rows(line);
    }
    let hidden = lines.len() - shown.len();
    if hidden > 0 {
        shown.push(format!(
            "… {hidden} more lines — a taller window shows them all"
        ));
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyAction as A;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl_key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::CONTROL)
    }

    #[test]
    fn normal_mode_binds_the_navigation_keys() {
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('j'))), A::Move(1));
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Down)), A::Move(1));
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('k'))), A::Move(-1));
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Up)), A::Move(-1));
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('g'))), A::First);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('G'))), A::Last);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Enter)), A::Open);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Esc)), A::Back);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Tab)), A::NextSession);
        assert_eq!(
            map_key(
                Mode::Normal,
                KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT)
            ),
            A::PrevSession
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('5'))), A::JumpTo(4));
    }

    #[test]
    fn normal_mode_binds_every_session_action() {
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('/'))), A::Search);
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::Char(':'))),
            A::OpenPalette
        );
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('k'))),
            A::OpenPalette
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('?'))), A::Help);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('q'))), A::Quit);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('Q'))), A::Shutdown);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('a'))), A::Answer);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('s'))), A::Stop);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('x'))), A::Remove);
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::Char('t'))),
            A::CycleThinking
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('m'))), A::Models);
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::Char('p'))),
            A::PermissionMode
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('n'))), A::NextMatch);
        assert_eq!(map_key(Mode::Normal, key(KeyCode::Char('N'))), A::PrevMatch);
    }

    #[test]
    fn normal_mode_binds_the_scrolling_keys() {
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('d'))),
            A::ScrollHalfDown
        );
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('u'))),
            A::ScrollHalfUp
        );
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('f'))),
            A::ScrollPageDown
        );
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('b'))),
            A::ScrollPageUp
        );
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::PageDown)),
            A::ScrollPageDown
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::PageUp)), A::ScrollPageUp);
    }

    #[test]
    fn unmapped_printables_start_a_message_keeping_the_key() {
        // 'e' binds to nothing, so it becomes the first character of a message
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::Char('e'))),
            A::InsertChar('e')
        );
        assert_eq!(
            map_key(Mode::Normal, key(KeyCode::Char('W'))),
            A::InsertChar('W')
        );
        // ctrl-modified printables are not text
        assert_eq!(
            map_key(Mode::Normal, ctrl_key(KeyCode::Char('e'))),
            A::Ignored
        );
        assert_eq!(map_key(Mode::Normal, key(KeyCode::F(3))), A::Ignored);
    }

    #[test]
    fn insert_mode_types_and_sends() {
        assert_eq!(
            map_key(Mode::Insert, key(KeyCode::Char('q'))),
            A::InsertChar('q'),
            "typing q must not quit"
        );
        assert_eq!(
            map_key(Mode::Insert, key(KeyCode::Char('/'))),
            A::InsertChar('/')
        );
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Enter)), A::Send);
        assert_eq!(
            map_key(
                Mode::Insert,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)
            ),
            A::Newline
        );
        assert_eq!(
            map_key(Mode::Insert, ctrl_key(KeyCode::Char('j'))),
            A::Newline
        );
        assert_eq!(
            map_key(Mode::Insert, key(KeyCode::Tab)),
            A::AcceptCompletion
        );
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Up)), A::CompletionPrev);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Down)), A::CompletionNext);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Esc)), A::LeaveInsert);
        assert_eq!(
            map_key(Mode::Insert, ctrl_key(KeyCode::Char('k'))),
            A::PaletteInInsert
        );
        assert_eq!(
            map_key(Mode::Insert, key(KeyCode::Backspace)),
            A::InsertBackspace
        );
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Delete)), A::InsertDelete);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Left)), A::InsertLeft);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Right)), A::InsertRight);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::Home)), A::InsertHome);
        assert_eq!(map_key(Mode::Insert, key(KeyCode::End)), A::InsertEnd);
        // ctrl-modified printables other than the palette's are not text
        assert_eq!(
            map_key(Mode::Insert, ctrl_key(KeyCode::Char('a'))),
            A::Ignored
        );
    }

    #[test]
    fn release_events_are_ignored() {
        let released = KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE);
        let released = KeyEvent {
            kind: KeyEventKind::Release,
            ..released
        };
        assert_eq!(map_key(Mode::Normal, released), A::Ignored);
    }

    #[test]
    fn the_help_lists_both_modes_and_counts_what_does_not_fit() {
        let whole = help_text();
        assert!(whole.contains("Normal:"), "{whole}");
        assert!(whole.contains("Insert:"), "{whole}");
        assert!(whole.contains("answer the pending question"), "{whole}");
        assert!(whole.contains("alt-enter"), "{whole}");

        // a tall window shows everything
        let lines = help_lines(100, 100);
        assert_eq!(lines.join("\n"), help_text());

        // a short window shows what fits and counts the rest
        let lines = help_lines(40, 6);
        let last = lines.last().unwrap();
        assert!(last.contains("more lines"), "{last}");
        assert!(lines.len() < help_lines(100, 100).len());
        assert_eq!(lines.first().unwrap(), "Normal:");
    }
}
