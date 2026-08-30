//! The console: a ratatui TUI with an orchestrator-and-workers dashboard,
//! per-session drill-down, and modal (normal/insert) keys. Implemented in the
//! tui-model and tui-render steps.

pub mod app;
pub mod completions;
pub mod keys;
pub mod markdown;
pub mod model;
pub mod palette;
pub mod runtime;
pub mod theme;
pub mod transcript;
pub mod view;
