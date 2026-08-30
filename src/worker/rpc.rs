//! pi RPC message types: the events and responses parsed from the worker's
//! stdout (`pi --mode rpc`), and the subset copied into `events.jsonl`.
//! Implemented in the worker step (see the TypeScript `src/monitor.ts`).

/// One pi RPC event or response, as parsed from one stdout line.
pub type RpcEvent = serde_json::Value;

/// Parse one line of the pi RPC stream.
pub fn parse_rpc_line(_line: &str) -> anyhow::Result<RpcEvent> {
    anyhow::bail!("not implemented yet: worker rpc parsing")
}
