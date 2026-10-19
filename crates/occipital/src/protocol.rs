use serde::{Deserialize, Serialize};

pub const SERVICE: &str = "syntax";

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Counters {
    // Actual parser calls and parsed prefix bytes, not skipped source bytes or
    // the number of line commitments satisfied from a frozen provisional prefix.
    pub committed_line_calls: u64,
    pub committed_line_bytes: u64,
    pub tail_calls: u64,
    pub tail_bytes: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyntaxHint {
    pub language: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fault {
    pub code: &'static str,
    pub started: bool,
}

impl Fault {
    pub fn not_started(code: &'static str) -> Self {
        Self {
            code,
            started: false,
        }
    }
    pub fn started(code: &'static str) -> Self {
        Self {
            code,
            started: true,
        }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for Fault {}
