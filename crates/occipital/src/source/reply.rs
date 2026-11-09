//! Flat SOURCE result encoding without a common request or reply envelope.

use super::model::SourceResult;
use serde::{
    ser::{SerializeMap, SerializeSeq},
    Serialize, Serializer,
};

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
