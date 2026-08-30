//! The shared operation layer: every fleet action lives here once, and the
//! CLI subcommands, the MCP tools and the console all call the same code.
//! Each file owns one verb family; the signatures taking CLI-parsed values
//! are the frozen contract with `main.rs` (which later workers never edit).
//! Implemented in the ops step.

pub mod integrate;
pub mod query;
pub mod spawn;
pub mod steer;
