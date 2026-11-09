//! Wire identity, request probes, typed envelopes and bounded serialization.
pub mod description;
pub mod probe;
pub mod reply;
pub mod request;
pub(crate) mod wire;

pub const PROTOCOL_VERSION: u32 = 4;
pub const CAPABILITY: &str = "syntax-highlight/v4";
pub const SERVICE: &str = "syntax";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    TryNow,
    BoundedQueue(u32),
}
