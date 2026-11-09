//! Owned SOURCE commands and parser results, independent of request envelopes.

use serde::{Deserialize, Serialize};

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

pub struct SourceInput {
    pub key: String,
    pub generation: u32,
    pub source_version: u32,
    pub hint: SyntaxHint,
    pub text: String,
}

pub enum SourceOperation {
    Finite {
        sources: Vec<SourceInput>,
        open: bool,
    },
    Append {
        key: String,
        lease: String,
        generation: u32,
        source_version: u32,
        base_revision: u32,
        base_bytes: u32,
        append: String,
        finalize: bool,
    },
    Close {
        key: String,
        lease: String,
        generation: u32,
    },
}

#[derive(Debug)]
pub struct SourceChunk {
    pub revision: u32,
    pub source_bytes: u32,
    pub committed_bytes: u32,
    pub replace_from: u32,
    /// Front-coded reply-local rows. Positive run IDs are one-based positions here.
    pub contexts: Vec<Vec<u32>>,
    /// [positive byte length, reply-local context ID]; zero means unclassified.
    pub runs: Vec<[u32; 2]>,
    pub counters: Counters,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceBody {
    Source {
        vocabulary: &'static str,
        sources: Vec<SourceResult>,
    },
    Closed,
}
impl SourceBody {
    pub fn sources(sources: Vec<SourceResult>) -> Self {
        Self::Source {
            vocabulary: crate::vocabulary::FINGERPRINT,
            sources,
        }
    }
}

pub struct SourceResult {
    pub key: String,
    pub generation: u32,
    pub source_version: u32,
    pub complete: bool,
    pub lease: Option<String>,
    pub chunk: SourceChunk,
}
