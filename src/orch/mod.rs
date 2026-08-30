//! The orchestrator side: the detached monitor owning the `claude` child,
//! the stream-json protocol it speaks, the console-side client, the embedded
//! prompt, and the run-state watcher feeding fleet events back in.
//! Implemented in the orch step.

pub mod args;
pub mod client;
pub mod health;
pub mod mcp_config;
pub mod monitor;
pub mod process;
pub mod prompt;
pub mod protocol;
pub mod records;
pub mod watcher;
