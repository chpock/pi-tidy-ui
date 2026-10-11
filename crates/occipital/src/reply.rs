//! Shared JSON replies; adapters hand these exact encoded bytes to their transport.
use crate::protocol::{Chunk, Fault, ASSETS, PROTOCOL_VERSION};
use serde::Serialize;

pub const REPLY_BYTES: usize = crate::limits::WIRE_BYTES;

#[derive(Debug, Serialize)]
pub struct SourceReply {
    pub key: String,
    pub generation: u32,
    pub source_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<String>,
    pub complete: bool,
    #[serde(flatten)]
    pub chunk: Chunk,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceBody {
    Source { sources: Vec<SourceReply> },
    Closed,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Execution {
    NotStarted,
    Started,
}
#[derive(Debug, Serialize)]
pub struct ErrorReply {
    pub code: &'static str,
    pub execution: Execution,
}
impl From<Fault> for ErrorReply {
    fn from(fault: Fault) -> Self {
        Self {
            code: fault.code,
            execution: if fault.started {
                Execution::Started
            } else {
                Execution::NotStarted
            },
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome<T> {
    Ok { body: T },
    Error { error: ErrorReply },
}
#[derive(Debug, Serialize)]
pub struct Reply<'a, T> {
    pub v: u32,
    pub ticket: &'a str,
    pub instance: &'a str,
    pub assets: &'static str,
    #[serde(flatten)]
    pub outcome: Outcome<T>,
}
impl<'a, T: Serialize> Reply<'a, T> {
    pub fn ok(ticket: &'a str, instance: &'a str, body: T) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            ticket,
            instance,
            assets: ASSETS,
            outcome: Outcome::Ok { body },
        }
    }
    pub fn error(ticket: &'a str, instance: &'a str, fault: Fault) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            ticket,
            instance,
            assets: ASSETS,
            outcome: Outcome::Error {
                error: fault.into(),
            },
        }
    }
    /// The bounded writer rejects during encoding, not after a giant Vec is built.
    pub fn encode(&self) -> Result<Vec<u8>, Fault> {
        self.encode_with_cap(REPLY_BYTES)
    }
    pub(crate) fn encode_with_cap(&self, cap: usize) -> Result<Vec<u8>, Fault> {
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            cap,
        };
        serde_json::to_writer(&mut writer, self).map_err(|_| Fault::started("reply_limit"))?;
        Ok(writer.bytes)
    }
}
struct LimitedWriter {
    bytes: Vec<u8>,
    cap: usize,
}
impl std::io::Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.cap.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("reply byte limit"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.cap);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod bounded_encoding_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writer_enforces_encoded_bytes_including_escape_amplification() {
        // Exercise the production writer with a scaled cap, not a 64 MiB corpus.
        let cap = 2048;
        for text in ["a".repeat(cap), "\u{0}".repeat(cap / 6)] {
            let error = Reply::ok("ticket", "instance", json!({"text":text}))
                .encode_with_cap(cap)
                .unwrap_err();
            assert_eq!(error.code, "reply_limit");
            assert!(error.started);
        }
        let bytes = Reply::ok("ticket", "instance", json!({"text":"a".repeat(cap-512)}))
            .encode_with_cap(cap)
            .unwrap();
        assert!(bytes.len() <= cap);
    }
}
