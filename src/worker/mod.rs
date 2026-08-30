//! The worker side: the detached monitor that owns one `pi --mode rpc`
//! process, the RPC message types it speaks, and model resolution.
//! Implemented in the worker step.

pub mod models;
pub mod monitor;
pub mod rpc;
