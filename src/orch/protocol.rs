//! claude stream-json wire types: the messages claude writes to stdout and
//! the user/control messages it accepts on stdin. Implemented in the orch
//! step (see the TypeScript `src/orchestrator/protocol.ts`).

/// One decoded claude protocol message.
pub type ProtocolMessage = serde_json::Value;

/// Decode one stdout line of the claude stream.
pub fn decode_message(_line: &str) -> anyhow::Result<ProtocolMessage> {
    anyhow::bail!("not implemented yet: claude stream-json decode")
}
