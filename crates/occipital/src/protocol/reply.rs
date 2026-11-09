//! Shared JSON replies; adapters hand these exact encoded bytes to their transport.
use super::PROTOCOL_VERSION;
use crate::{fault::Fault, vocabulary};
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
        self.encode_bounded(cap, |_| true)
    }
    /// Authorize each new absolute output capacity before allocation. Any funding
    /// must remain owned by the caller alongside the body and returned bytes.
    pub fn encode_bounded(
        &self,
        cap: usize,
        authorize: impl FnMut(usize) -> bool,
    ) -> Result<Vec<u8>, Fault> {
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            cap: cap.min(REPLY_BYTES),
            authorize,
            failure: "reply_limit",
        };
        if serde_json::to_writer(&mut writer, self).is_err() {
            return Err(Fault::started(writer.failure));
        }
        Ok(writer.bytes)
    }
}
struct LimitedWriter<F> {
    bytes: Vec<u8>,
    cap: usize,
    authorize: F,
    failure: &'static str,
}
impl<F: FnMut(usize) -> bool> std::io::Write for LimitedWriter<F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.cap.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other("reply byte limit"));
        }
        let needed = self.bytes.len() + bytes.len();
        if needed > self.bytes.capacity() {
            let capacity = needed
                .max(self.bytes.capacity().saturating_mul(2))
                .min(self.cap);
            if !(self.authorize)(capacity) {
                self.failure = "data_limit";
                return Err(std::io::Error::other("reply allocation credit"));
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

#[cfg(test)]
mod bounded_encoding_tests {
    use serde_json::json;

    #[test]
    fn denied_growth_preserves_the_existing_buffer_and_capacity_authority() {
        use std::{cell::Cell, io::Write};

        for initial in [&b""[..], &b"01234567"[..]] {
            let reserved = Cell::new(0);
            {
                let mut writer = super::LimitedWriter {
                    bytes: Vec::new(),
                    cap: 4096,
                    authorize: |capacity| {
                        if capacity > initial.len() {
                            return false;
                        }
                        reserved.set(capacity);
                        true
                    },
                    failure: "reply_limit",
                };
                writer.write_all(initial).unwrap();
                assert!(writer.write_all(b"x").is_err());
                assert_eq!(writer.bytes.as_slice(), initial);
                assert_eq!(writer.bytes.capacity(), initial.len());
                assert_eq!(writer.failure, "data_limit");
            }
            assert_eq!(reserved.get(), initial.len());
        }
    }

    #[test]
    fn writer_enforces_encoded_bytes_including_escape_amplification() {
        // Exercise the production writer with a scaled cap, not a 64 MiB corpus.
        let cap = 2048;
        for text in ["a".repeat(cap), "\u{0}".repeat(cap / 6)] {
            let error = super::ok("ticket", "instance", json!({"text":text}))
                .encode_with_cap(cap)
                .unwrap_err();
            assert_eq!(error.code, "reply_limit");
            assert!(error.started);
        }
        let bytes = super::ok("ticket", "instance", json!({"text":"a".repeat(cap-512)}))
            .encode_with_cap(cap)
            .unwrap();
        assert!(bytes.len() <= cap);
    }
}
