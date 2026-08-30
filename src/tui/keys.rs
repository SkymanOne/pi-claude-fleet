//! Modal key map: normal-mode bindings vs the composer's insert mode, so a
//! message that starts with "q" does not quit the app — only non-printable
//! keys are bound. Implemented in the tui-model step (see the TypeScript
//! `src/tui/keys.ts`).

/// Which key mode the console is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Insert,
}

/// What a keypress means in the current mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Quit,
    SwitchSession,
    Interrupt,
    Insert(char),
    Other,
}

/// Map a key press to an action.
pub fn map_key(_mode: Mode, _key: crossterm::event::KeyEvent) -> anyhow::Result<KeyAction> {
    anyhow::bail!("not implemented yet: key map")
}
