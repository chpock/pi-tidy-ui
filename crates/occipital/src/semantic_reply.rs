//! Flat source replies; source identity/lease authority stays with the service.
use crate::{
    protocol::Fault,
    reply::{Outcome, Reply},
    semantic::{Styles, PROTOCOL_VERSION},
    semantic_engine::SourceChunk,
    vocabulary,
};
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Serialize, Serializer,
};

/// Both data operations use the same envelope, writer and physical credit.
#[derive(Serialize)]
#[serde(untagged)]
#[expect(
    clippy::large_enum_variant,
    reason = "Keep admitted result headers inline; boxing here would add an allocation at reply handoff"
)]
pub enum DataBody {
    Source(SourceBody),
    Styles(Styles),
}

pub fn ok<'a, T>(ticket: &'a str, instance: &'a str, body: T) -> Reply<'a, T> {
    Reply {
        v: PROTOCOL_VERSION,
        ticket,
        instance,
        assets: vocabulary::ASSET_FINGERPRINT,
        outcome: Outcome::Ok { body },
    }
}
pub fn error<'a, T>(ticket: &'a str, instance: &'a str, fault: Fault) -> Reply<'a, T> {
    Reply {
        v: PROTOCOL_VERSION,
        ticket,
        instance,
        assets: vocabulary::ASSET_FINGERPRINT,
        outcome: Outcome::Error {
            error: fault.into(),
        },
    }
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
            vocabulary: vocabulary::FINGERPRINT,
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
impl Serialize for SourceResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_map(Some(11 + usize::from(self.lease.is_some())))?;
        out.serialize_entry("key", &self.key)?;
        out.serialize_entry("generation", &self.generation)?;
        out.serialize_entry("source_version", &self.source_version)?;
        out.serialize_entry("revision", &self.chunk.revision)?;
        out.serialize_entry("source_bytes", &self.chunk.source_bytes)?;
        out.serialize_entry("replace_from", &self.chunk.replace_from)?;
        out.serialize_entry("committed_bytes", &self.chunk.committed_bytes)?;
        out.serialize_entry("complete", &self.complete)?;
        out.serialize_entry("counters", &self.chunk.counters)?;
        out.serialize_entry("contexts", &self.chunk.contexts)?;
        out.serialize_entry("runs", &FlatRuns(&self.chunk.runs))?;
        if let Some(lease) = &self.lease {
            out.serialize_entry("lease", lease)?;
        }
        out.end()
    }
}
struct FlatRuns<'a>(&'a [[u32; 2]]);
impl Serialize for FlatRuns<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_seq(Some(self.0.len() * 2))?;
        for value in self.0.iter().flatten() {
            out.serialize_element(value)?;
        }
        out.end()
    }
}
