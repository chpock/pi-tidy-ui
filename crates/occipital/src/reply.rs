//! Shared JSON replies; adapters hand these exact encoded bytes to their transport.
use crate::protocol::Fault;
use serde::Serialize;

pub const REPLY_BYTES: usize = crate::limits::WIRE_BYTES;

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
    /// The bounded writer rejects during encoding, not after a giant Vec is built.
    pub fn encode(&self) -> Result<Vec<u8>, Fault> {
        self.encode_with_cap(REPLY_BYTES)
    }
    pub(crate) fn encode_with_cap(&self, cap: usize) -> Result<Vec<u8>, Fault> {
        self.encode_bounded(cap, None)
    }
    /// The owner retains this credit alongside the encoded buffer until transport
    /// settlement. Growth adds actual buffer capacity, not a whole reply ceiling.
    pub fn encode_with_credit(
        &self,
        credit: &mut crate::credit::Credit,
        cap: usize,
    ) -> Result<Vec<u8>, Fault> {
        self.encode_bounded(cap.min(REPLY_BYTES), Some(credit))
    }
    fn encode_bounded(
        &self,
        cap: usize,
        credit: Option<&mut crate::credit::Credit>,
    ) -> Result<Vec<u8>, Fault> {
        let base = credit.as_ref().map_or(0, |credit| credit.bytes());
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            cap,
            credit,
            base,
            failure: "reply_limit",
        };
        if serde_json::to_writer(&mut writer, self).is_err() {
            return Err(Fault::started(writer.failure));
        }
        Ok(writer.bytes)
    }
}
struct LimitedWriter<'a> {
    bytes: Vec<u8>,
    cap: usize,
    credit: Option<&'a mut crate::credit::Credit>,
    base: usize,
    failure: &'static str,
}
impl std::io::Write for LimitedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.cap.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("reply byte limit"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.cap);
            if let Some(credit) = &mut self.credit {
                let total = self.base.checked_add(capacity);
                if total.is_none_or(|total| credit.resize(total).is_err()) {
                    self.failure = "data_limit";
                    return Err(std::io::Error::other("reply allocation credit"));
                }
            }
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
    use serde_json::json;

    #[test]
    fn writer_enforces_encoded_bytes_including_escape_amplification() {
        // Exercise the production writer with a scaled cap, not a 64 MiB corpus.
        let cap = 2048;
        for text in ["a".repeat(cap), "\u{0}".repeat(cap / 6)] {
            let error = crate::semantic_reply::ok("ticket", "instance", json!({"text":text}))
                .encode_with_cap(cap)
                .unwrap_err();
            assert_eq!(error.code, "reply_limit");
            assert!(error.started);
        }
        let bytes =
            crate::semantic_reply::ok("ticket", "instance", json!({"text":"a".repeat(cap-512)}))
                .encode_with_cap(cap)
                .unwrap();
        assert!(bytes.len() <= cap);
    }
}
