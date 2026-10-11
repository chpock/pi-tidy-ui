//! Transport-independent request decoding. Call only after a bounded frame read.
//! No parser/session mutation or unbounded JSON Value tree exists at this boundary.
use crate::protocol::{Fault, SyntaxHint, PROTOCOL_VERSION};
use serde::{de, Deserialize};
use std::{collections::HashSet, fmt};

pub const REQUEST_BYTES: usize = crate::limits::WIRE_BYTES;
pub const SOURCE_BYTES: usize = crate::limits::SOURCE_BYTES;
/// Classified prefix of each line; longer source text is still admitted.
pub const LINE_BYTES: usize = 64 * 1024;
pub const BATCH_SOURCES: usize = 8;
pub const QUEUE_WAIT_MS: u32 = 1000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum Operation {
    #[serde(rename = "describe")]
    Describe,
    #[serde(rename = "themes.refresh")]
    ThemesRefresh,
    #[serde(rename = "highlight")]
    Highlight,
    #[serde(rename = "stream.open")]
    StreamOpen,
    #[serde(rename = "stream.append")]
    StreamAppend,
    #[serde(rename = "stream.close")]
    StreamClose,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionMode {
    TryNow,
    BoundedQueue,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub key: String,
    pub generation: u32,
    pub source_version: u32,
    pub profile: String,
    pub fingerprint: String,
    pub hint: SyntaxHint,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub ticket: String,
    pub op: Operation,
    pub instance: Option<String>,
    pub admission: Option<AdmissionMode>,
    pub queue_wait_ms: Option<u32>,
    #[serde(default, deserialize_with = "bounded_sources")]
    pub sources: Option<Vec<Source>>,
    pub key: Option<String>,
    pub lease: Option<String>,
    pub generation: Option<u32>,
    pub source_version: Option<u32>,
    pub base_revision: Option<u32>,
    pub base_bytes: Option<u32>,
    pub profile: Option<String>,
    pub fingerprint: Option<String>,
    pub append: Option<String>,
    #[serde(rename = "final")]
    pub finalize: Option<bool>,
}

fn bounded_sources<'de, D: de::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<Source>>, D::Error> {
    struct Sources;
    impl<'de> de::Visitor<'de> for Sources {
        type Value = Option<Vec<Source>>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            write!(f, "at most {BATCH_SOURCES} source objects")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut sources = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(BATCH_SOURCES));
            while sources.len() < BATCH_SOURCES {
                match seq.next_element::<Source>()? {
                    Some(source) => sources.push(source),
                    None => return Ok(Some(sources)),
                }
            }
            if seq.next_element::<de::IgnoredAny>()?.is_some() {
                return Err(de::Error::custom("source count limit"));
            }
            Ok(Some(sources))
        }
    }
    deserializer.deserialize_seq(Sources)
}
fn invalid() -> Fault {
    Fault::not_started("invalid_request")
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && !value.chars().any(char::is_control)
}
fn fingerprint(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn option_id(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(identifier)
}
fn option_fingerprint(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(fingerprint)
}
fn source_bytes(text: &str, cap: usize) -> Result<(), Fault> {
    if text.len() > cap {
        return Err(Fault::not_started("source_limit"));
    }
    Ok(())
}
fn hint_valid(hint: &SyntaxHint) -> bool {
    hint.language.as_deref().is_none_or(|value| {
        !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
    }) && hint.path.as_deref().is_none_or(|value| {
        !value.is_empty()
            && value.len() <= crate::limits::PATH_HINT_BYTES
            && !value.chars().any(char::is_control)
    })
}

pub fn decode(frame: &[u8]) -> Result<Request, Fault> {
    decode_bounded(frame, REQUEST_BYTES, SOURCE_BYTES)
}
fn decode_bounded(frame: &[u8], frame_cap: usize, source_cap: usize) -> Result<Request, Fault> {
    if frame.len() > frame_cap {
        return Err(Fault::not_started("frame_limit"));
    }
    let request: Request = serde_json::from_slice(frame).map_err(|_| invalid())?;
    request.validate_bounded(source_cap)?;
    Ok(request)
}
impl Request {
    pub fn validate(&self) -> Result<(), Fault> {
        self.validate_bounded(SOURCE_BYTES)
    }
    fn validate_bounded(&self, source_cap: usize) -> Result<(), Fault> {
        if self.v != PROTOCOL_VERSION {
            return Err(Fault::not_started("protocol_mismatch"));
        }
        if !identifier(&self.ticket)
            || self
                .instance
                .as_deref()
                .is_some_and(|value| !identifier(value))
        {
            return Err(invalid());
        }
        let stream_fields = self.key.is_some()
            || self.lease.is_some()
            || self.generation.is_some()
            || self.source_version.is_some()
            || self.base_revision.is_some()
            || self.base_bytes.is_some()
            || self.profile.is_some()
            || self.fingerprint.is_some()
            || self.append.is_some()
            || self.finalize.is_some();
        match self.op {
            Operation::Describe | Operation::ThemesRefresh => {
                if self.sources.is_some()
                    || stream_fields
                    || self.admission.is_some()
                    || self.queue_wait_ms.is_some()
                {
                    return Err(invalid());
                }
            }
            Operation::Highlight | Operation::StreamOpen => {
                self.data_admission()?;
                if stream_fields {
                    return Err(invalid());
                }
                let sources = self.sources.as_ref().ok_or_else(invalid)?;
                if sources.is_empty()
                    || sources.len() > BATCH_SOURCES
                    || (self.op == Operation::StreamOpen && sources.len() != 1)
                {
                    return Err(invalid());
                }
                let mut total = 0usize;
                let mut keys = HashSet::new();
                for source in sources {
                    if !identifier(&source.key)
                        || source.generation == 0
                        || !identifier(&source.profile)
                        || !fingerprint(&source.fingerprint)
                        || !hint_valid(&source.hint)
                        || !keys.insert((&source.key, source.generation))
                    {
                        return Err(invalid());
                    }
                    source_bytes(&source.text, source_cap)?;
                    total = total
                        .checked_add(source.text.len())
                        .ok_or(Fault::not_started("source_limit"))?;
                    if total > source_cap {
                        return Err(Fault::not_started("source_limit"));
                    }
                }
            }
            Operation::StreamAppend => {
                self.data_admission()?;
                if self.sources.is_some()
                    || !option_id(&self.key)
                    || !option_id(&self.lease)
                    || self.generation.is_none_or(|value| value == 0)
                    || self.source_version.is_none()
                    || self.base_revision.is_none_or(|value| value == 0)
                    || self
                        .base_bytes
                        .is_none_or(|value| value as usize > source_cap)
                    || !option_id(&self.profile)
                    || !option_fingerprint(&self.fingerprint)
                    || self.finalize.is_none()
                {
                    return Err(invalid());
                }
                source_bytes(self.append.as_deref().ok_or_else(invalid)?, source_cap)?;
            }
            Operation::StreamClose => {
                if !option_id(&self.instance)
                    || self.sources.is_some()
                    || !option_id(&self.key)
                    || !option_id(&self.lease)
                    || self.generation.is_none_or(|value| value == 0)
                    || self.source_version.is_some()
                    || self.base_revision.is_some()
                    || self.base_bytes.is_some()
                    || self.profile.is_some()
                    || self.fingerprint.is_some()
                    || self.append.is_some()
                    || self.finalize.is_some()
                    || self.admission.is_some()
                    || self.queue_wait_ms.is_some()
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
    fn data_admission(&self) -> Result<(), Fault> {
        if !option_id(&self.instance) {
            return Err(invalid());
        }
        match self.admission {
            Some(AdmissionMode::TryNow) if self.queue_wait_ms.is_none() => Ok(()),
            Some(AdmissionMode::BoundedQueue)
                if self
                    .queue_wait_ms
                    .is_some_and(|value| value > 0 && value <= QUEUE_WAIT_MS) =>
            {
                Ok(())
            }
            _ => Err(invalid()),
        }
    }
}

#[cfg(test)]
mod bounded_admission_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_frame_and_cumulative_source_caps_reject_before_parser_work() {
        // Production uses the same decoder; these caps keep allocation tiny.
        let error = decode_bounded(&[b' '; 257], 256, 6).unwrap_err();
        assert_eq!(error.code, "frame_limit");
        assert!(!error.started);
        let source = |key, text| {
            json!({"key":key,"generation":1,"source_version":0,"profile":"pi",
            "fingerprint":"a".repeat(64),"hint":{"language":"text"},"text":text})
        };
        let frame = |sources| {
            serde_json::to_vec(&json!({"v":2,"ticket":"bounded","op":"highlight",
            "instance":"boot","admission":"try_now","sources":sources}))
            .unwrap()
        };
        let accepted = frame(vec![source("left", "λ"), source("right", "abcd")]);
        assert!(decode_bounded(&accepted, 2048, 6).is_ok());
        for sources in [
            vec![source("left", "abcdefg")],
            vec![source("left", "λ"), source("right", "abcde")],
        ] {
            let error = decode_bounded(&frame(sources), 2048, 6).unwrap_err();
            assert_eq!(error.code, "source_limit");
            assert!(!error.started);
        }
    }
}
