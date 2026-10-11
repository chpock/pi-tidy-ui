use serde::{Deserialize, Serialize};

// v2 carries positive run lengths instead of v1 absolute endpoints. Old peers
// must fail negotiation, never silently interpret these different numbers.
pub const PROTOCOL_VERSION: u32 = 2;
pub const CAPABILITY: &str = "syntax-highlight/v2";
pub const SERVICE: &str = "syntax";
pub const ASSETS: &str = "syntect/5.3.0:two-face/0.5.2+bat-0.26.1:roles/v1:line-prefix/65536/v1";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Plain,
    SyntaxComment,
    SyntaxKeyword,
    SyntaxString,
    SyntaxNumber,
    SyntaxType,
    SyntaxFunction,
    SyntaxVariable,
    SyntaxOperator,
    SyntaxPunctuation,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum WireStyle {
    Pi {
        role: Role,
    },
    Rgb {
        rgb: [u8; 3],
        attributes: u8,
    },
    Indexed {
        index: u8,
        attributes: u8,
    },
    TerminalDefault {
        terminal_default: bool,
        attributes: u8,
    },
}

/// [absolute UTF-8 byte start, positive byte length, style-table index].
pub type Run = [u32; 3];

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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Chunk {
    pub revision: u32,
    pub source_bytes: u32,
    pub committed_bytes: u32,
    pub replace_from: u32,
    pub profile: String,
    pub fingerprint: String,
    pub styles: Vec<WireStyle>,
    #[serde(serialize_with = "compact_runs")]
    pub runs: Vec<Run>,
    pub counters: Counters,
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

// JSON wire v2 has implicit starts: [positiveByteLength, styleId, ...].
// Native source projection keeps absolute triples, independent of wire encoding.
// Lengths avoid repeated large decimal offsets; serialization is allocation-free.
fn compact_runs<S: serde::Serializer>(runs: &[Run], serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    let mut seq = serializer.serialize_seq(Some(runs.len() * 2))?;
    for [_, len, id] in runs {
        seq.serialize_element(len)?;
        seq.serialize_element(id)?;
    }
    seq.end()
}
