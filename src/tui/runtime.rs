//! Crossterm event loop and terminal setup: raw mode, the event stream,
//! restore on panic and exit — the console needs an interactive terminal and
//! refuses non-TTY launches with guidance. Implemented in the tui-render
//! step (see the TypeScript `src/tui/index.tsx`).

/// Install the terminal, run `body`, then always restore.
pub async fn with_terminal(_body: impl FnOnce() -> anyhow::Result<()>) -> anyhow::Result<()> {
    anyhow::bail!("not implemented yet: terminal runtime")
}
