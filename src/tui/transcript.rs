//! Building a session's transcript from its `events.jsonl`: prompts,
//! reasoning, replies, tool calls and fleet events as renderable blocks.
//! Implemented in the tui-render step (see the TypeScript
//! `src/tui/Transcript.tsx`).

/// The transcript blocks for one session, oldest first.
pub fn build(_events_path: &std::path::Path) -> anyhow::Result<Vec<serde_json::Value>> {
    anyhow::bail!("not implemented yet: transcript builder")
}
