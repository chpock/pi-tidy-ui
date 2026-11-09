//! Common service identity and request admission metadata.

pub const SERVICE: &str = "syntax";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    TryNow,
    BoundedQueue(u32),
}
