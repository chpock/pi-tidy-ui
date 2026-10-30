//! Theme-free source admission. Reserve the complete owned request before decoding
//! its payload strings. Bounded JSON decoder scratch belongs to frame admission.
pub use crate::wire::Admission;
use crate::{
    protocol::{Fault, SyntaxHint},
    wire::{admission, decode, invalid, present, text, unsigned},
};
use serde::{de, Deserialize};
use serde_json::value::RawValue;
use std::{borrow::Cow, fmt, mem::size_of};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRequest<'a> {
    #[serde(borrow)]
    v: &'a RawValue,
    #[serde(borrow)]
    op: &'a RawValue,
    #[serde(borrow)]
    ticket: &'a RawValue,
    #[serde(borrow)]
    instance: &'a RawValue,
    #[serde(borrow, default, deserialize_with = "present")]
    admission: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    queue_wait_ms: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    sources: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    key: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    lease: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    generation: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    source_version: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    base_revision: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    base_bytes: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    append: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present", rename = "final")]
    finalize: Option<&'a RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSource<'a> {
    #[serde(borrow)]
    key: &'a RawValue,
    #[serde(borrow)]
    generation: &'a RawValue,
    #[serde(borrow)]
    source_version: &'a RawValue,
    #[serde(borrow)]
    hint: &'a RawValue,
    #[serde(borrow)]
    text: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hint<'a> {
    #[serde(borrow, default, deserialize_with = "present")]
    language: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    path: Option<&'a RawValue>,
}
fn nonzero(raw: &RawValue) -> Result<u32, Fault> {
    let value = unsigned(raw, u32::MAX)?;
    if value == 0 {
        return Err(invalid());
    }
    Ok(value)
}
fn measure(raw: &RawValue) -> Result<(usize, usize), Fault> {
    struct Length;
    impl de::Visitor<'_> for Length {
        type Value = (usize, usize);
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("source string")
        }
        fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
            Ok((value.len(), crate::limits::source_lines(value)))
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    serde::Deserializer::deserialize_str(&mut decoder, Length).map_err(|_| invalid())
}
fn hint(raw: &RawValue) -> Result<SyntaxHint, Fault> {
    let value: Hint<'_> = decode(raw)?;
    let language = match value.language {
        None => None,
        Some(raw) if raw.get().trim() == "null" || raw.get().trim() == "\"\"" => None,
        Some(raw) => text(raw, 128).map(|value| {
            let value = value.into_owned();
            (!value.is_empty()).then_some(value)
        })?,
    };
    let path = match value.path {
        None => None,
        Some(raw) if raw.get().trim() == "null" => None,
        Some(raw) => Some(text(raw, crate::limits::PATH_HINT_BYTES)?.into_owned()),
    };
    Ok(SyntaxHint { language, path })
}
struct SourcePlan<'a> {
    key: Cow<'a, str>,
    generation: u32,
    source_version: u32,
    hint: SyntaxHint,
    text: &'a RawValue,
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
pub struct SourceRequest {
    pub ticket: String,
    pub admission: Option<Admission>,
    pub operation: SourceOperation,
}

// At most eight borrowed entries; an oversized source array never becomes an
// owned payload vector. Escaped-string decoder scratch is bounded by the frame.
fn sources(raw: &RawValue) -> Result<Vec<&RawValue>, Fault> {
    struct Sources;
    impl<'de> de::Visitor<'de> for Sources {
        type Value = Vec<&'de RawValue>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("bounded source array")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut result = Vec::with_capacity(crate::request::BATCH_SOURCES);
            while result.len() < crate::request::BATCH_SOURCES {
                match seq.next_element::<&RawValue>()? {
                    Some(value) => result.push(value),
                    None => return Ok(result),
                }
            }
            if seq.next_element::<de::IgnoredAny>()?.is_some() {
                return Err(de::Error::custom("source count"));
            }
            Ok(result)
        }
    }
    let mut decoder = serde_json::Deserializer::from_str(raw.get());
    serde::Deserializer::deserialize_seq(&mut decoder, Sources).map_err(|_| invalid())
}
fn reserve(bytes: usize, grant: &mut dyn FnMut(usize) -> bool) -> Result<(), Fault> {
    if !grant(bytes) {
        return Err(Fault::not_started("data_limit"));
    }
    Ok(())
}
fn owned(raw: &RawValue) -> Result<String, Fault> {
    serde_json::from_str(raw.get()).map_err(|_| invalid())
}
#[expect(
    clippy::ptr_arg,
    reason = "Charge owned String capacity, not merely the borrowed text length"
)]
fn cow_bytes(value: &Cow<'_, str>) -> usize {
    match value {
        Cow::Owned(value) => value.capacity(),
        Cow::Borrowed(value) => value.len(),
    }
}
fn allowance(parts: &[usize]) -> Result<usize, Fault> {
    parts
        .iter()
        .try_fold(0usize, |n, value| n.checked_add(*value))
        .ok_or(Fault::not_started("data_limit"))
}
impl SourceRequest {
    /// The caller already holds frame/scratch/job credit. `grant` reserves the
    /// additional owned request allowance; it never releases that physical slot.
    pub fn decode(
        raw: &RawValue,
        instance: &str,
        source_cap: usize,
        grant: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Self, Fault> {
        if raw.get().len() > crate::limits::DATA_WIRE_BYTES {
            return Err(Fault::not_started("frame_limit"));
        }
        let source_cap = source_cap.min(crate::limits::SOURCE_BYTES);
        let r: RawRequest<'_> = decode(raw)?;
        if unsigned(r.v, u32::MAX)? != crate::semantic::PROTOCOL_VERSION {
            return Err(Fault::not_started("protocol_mismatch"));
        }
        if text(r.instance, 64)?.as_ref() != instance {
            return Err(Fault::not_started("restart_required"));
        }
        let ticket = text(r.ticket, 64)?;
        let op = text(r.op, 64)?;
        let extra = [
            r.key,
            r.lease,
            r.generation,
            r.source_version,
            r.base_revision,
            r.base_bytes,
            r.append,
            r.finalize,
        ];
        let (operation, admitted) = match op.as_ref() {
            "highlight" | "stream.open" => {
                if extra.iter().any(Option::is_some) {
                    return Err(invalid());
                }
                let mode = admission(r.admission, r.queue_wait_ms)?;
                let values = sources(r.sources.ok_or_else(invalid)?)?;
                if values.is_empty() || op == "stream.open" && values.len() != 1 {
                    return Err(invalid());
                }
                let mut plans: Vec<SourcePlan<'_>> = Vec::with_capacity(values.len());
                let mut total = 0usize;
                let mut lines = 0usize;
                for raw in values {
                    let source: RawSource<'_> = decode(raw)?;
                    let key = text(source.key, 64)?;
                    let generation = nonzero(source.generation)?;
                    let source_version = unsigned(source.source_version, u32::MAX)?;
                    let hint = hint(source.hint)?;
                    let (bytes, count) = measure(source.text)?;
                    lines += count;
                    total = total
                        .checked_add(bytes)
                        .ok_or(Fault::not_started("source_limit"))?;
                    if total > source_cap || lines > crate::limits::SOURCE_LINES {
                        return Err(Fault::not_started("source_limit"));
                    }
                    if plans.iter().any(|p| p.key == key) {
                        return Err(invalid());
                    }
                    plans.push(SourcePlan {
                        key,
                        generation,
                        source_version,
                        hint,
                        text: source.text,
                    });
                }
                // Payload capacity and bounded request/metadata storage; lexer
                // scratch is separately covered by admitted frame credit.
                let metadata = plans.iter().try_fold(cow_bytes(&ticket), |total, plan| {
                    allowance(&[
                        total,
                        cow_bytes(&plan.key),
                        plan.hint.language.as_ref().map_or(0, String::capacity),
                        plan.hint.path.as_ref().map_or(0, String::capacity),
                    ])
                })?;
                let payload = total
                    .checked_mul(2)
                    .ok_or(Fault::not_started("data_limit"))?;
                reserve(
                    allowance(&[
                        size_of::<Self>(),
                        plans.capacity() * size_of::<SourcePlan<'_>>(),
                        plans.len() * size_of::<SourceInput>(),
                        metadata,
                        payload,
                    ])?,
                    grant,
                )?;
                let mut result = Vec::with_capacity(plans.len());
                for plan in plans {
                    result.push(SourceInput {
                        key: plan.key.into_owned(),
                        generation: plan.generation,
                        source_version: plan.source_version,
                        hint: plan.hint,
                        text: owned(plan.text)?,
                    });
                }
                (
                    SourceOperation::Finite {
                        sources: result,
                        open: op == "stream.open",
                    },
                    Some(mode),
                )
            }
            "stream.append" => {
                if r.sources.is_some() {
                    return Err(invalid());
                }
                let mode = admission(r.admission, r.queue_wait_ms)?;
                let key = text(r.key.ok_or_else(invalid)?, 64)?;
                let lease = text(r.lease.ok_or_else(invalid)?, 64)?;
                let generation = nonzero(r.generation.ok_or_else(invalid)?)?;
                let source_version = unsigned(r.source_version.ok_or_else(invalid)?, u32::MAX)?;
                let base_revision = nonzero(r.base_revision.ok_or_else(invalid)?)?;
                let base_bytes = unsigned(r.base_bytes.ok_or_else(invalid)?, u32::MAX)?;
                let raw = r.append.ok_or_else(invalid)?;
                let (size, lines) = measure(raw)?;
                if lines > crate::limits::SOURCE_LINES
                    || size
                        .checked_add(base_bytes as usize)
                        .is_none_or(|n| n > source_cap)
                {
                    return Err(Fault::not_started("source_limit"));
                }
                let finalize: bool = serde_json::from_str(r.finalize.ok_or_else(invalid)?.get())
                    .map_err(|_| invalid())?;
                let payload = size
                    .checked_mul(2)
                    .ok_or(Fault::not_started("data_limit"))?;
                reserve(
                    allowance(&[
                        size_of::<Self>(),
                        cow_bytes(&ticket),
                        cow_bytes(&key),
                        cow_bytes(&lease),
                        payload,
                    ])?,
                    grant,
                )?;
                (
                    SourceOperation::Append {
                        key: key.into_owned(),
                        lease: lease.into_owned(),
                        generation,
                        source_version,
                        base_revision,
                        base_bytes,
                        append: owned(raw)?,
                        finalize,
                    },
                    Some(mode),
                )
            }
            "stream.close" => {
                if r.sources.is_some()
                    || r.admission.is_some()
                    || r.queue_wait_ms.is_some()
                    || extra[3..].iter().any(Option::is_some)
                {
                    return Err(invalid());
                }
                let key = text(r.key.ok_or_else(invalid)?, 64)?;
                let lease = text(r.lease.ok_or_else(invalid)?, 64)?;
                let generation = nonzero(r.generation.ok_or_else(invalid)?)?;
                reserve(
                    allowance(&[
                        size_of::<Self>(),
                        cow_bytes(&ticket),
                        cow_bytes(&key),
                        cow_bytes(&lease),
                    ])?,
                    grant,
                )?;
                (
                    SourceOperation::Close {
                        key: key.into_owned(),
                        lease: lease.into_owned(),
                        generation,
                    },
                    None,
                )
            }
            _ => return Err(invalid()),
        };
        Ok(Self {
            ticket: ticket.into_owned(),
            admission: admitted,
            operation,
        })
    }
}

#[cfg(test)]
mod language_hint_tests {
    use super::*;

    fn raw_operation(operation: &str, hint: &str) -> Box<RawValue> {
        serde_json::from_str(&format!(r#"{{"v":4,"op":"{operation}","ticket":"t","instance":"i","admission":"try_now","sources":[{{"key":"k","generation":1,"source_version":1,"hint":{hint},"text":"print(1)"}}]}}"#)).unwrap()
    }

    fn raw(hint: &str) -> Box<RawValue> {
        raw_operation("highlight", hint)
    }

    fn decoded(hint: &str) -> SyntaxHint {
        let request = SourceRequest::decode(&raw(hint), "i", usize::MAX, &mut |_| true).unwrap();
        let SourceOperation::Finite { sources, .. } = request.operation else {
            panic!("finite source request")
        };
        sources.into_iter().next().unwrap().hint
    }

    #[test]
    fn language_hint_and_optional_path_metadata_are_accounted() {
        fn admitted(hint: &str) -> usize {
            let mut bytes = 0;
            SourceRequest::decode(&raw(hint), "i", usize::MAX, &mut |amount| {
                bytes = amount;
                true
            })
            .unwrap();
            bytes
        }
        let without = admitted(r#"{"language":null,"path":null}"#);
        let with = admitted(r#"{"language":"python","path":null}"#);
        let explicit_null = admitted(r#"{"language":null,"path":null}"#);
        let empty = admitted(r#"{"language":"","path":null}"#);
        assert!(with >= without + "python".len());
        assert_eq!(explicit_null, without);
        assert_eq!(empty, without, "empty language has absence semantics");
    }

    #[test]
    fn shared_vectors_preserve_absent_null_empty_and_explicit_language() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol/syntax-v3/source-hint-vectors.json"
        ))
        .unwrap();
        assert_eq!(vectors["revision"], 2);
        for case in vectors["optional_hint_cases"].as_array().unwrap() {
            let hint = serde_json::to_string(&case["hint"]).unwrap();
            let decoded = decoded(&hint);
            assert_eq!(decoded.language.as_deref(), case["language"].as_str());
            assert_eq!(decoded.path.as_deref(), case["path"].as_str());
        }

        let opened_raw = raw_operation("stream.open", r#"{"language":"python"}"#);
        let opened = SourceRequest::decode(&opened_raw, "i", usize::MAX, &mut |_| true).unwrap();
        let SourceOperation::Finite { sources, open } = opened.operation else {
            panic!("stream open source")
        };
        assert!(open);
        assert_eq!(sources[0].hint.language.as_deref(), Some("python"));
        assert_eq!(
            sources[0].hint.path, None,
            "explicit syntax works without a filename"
        );
    }

    #[test]
    fn empty_language_means_path_selection_but_nonempty_unknown_is_preserved() {
        for empty in [
            r#"{"language":"","path":"script.py"}"#,
            r#"{"language": "", "path":"script.py"}"#,
            r#"{"language":null,"path":"script.py"}"#,
            r#"{"path":"script.py"}"#,
        ] {
            let hint = decoded(empty);
            assert_eq!(hint.language, None);
            assert_eq!(hint.path.as_deref(), Some("script.py"));
        }
        let pathless = decoded(r#"{"language":null}"#);
        assert_eq!(pathless.language, None);
        assert_eq!(pathless.path, None);
        assert_eq!(
            decoded(r#"{"language":"unmapped","path":"script.py"}"#)
                .language
                .as_deref(),
            Some("unmapped")
        );
    }

    #[test]
    fn malformed_language_shape_is_rejected_before_source_admission() {
        let too_long = "x".repeat(129);
        let mut malformed = vec![
            r#"{"language":42}"#.to_owned(),
            r#"{"language":[]}"#.to_owned(),
            r#"{"language":"bad\u0001format"}"#.to_owned(),
            r#"{"shebang_language":"python"}"#.to_owned(),
        ];
        malformed.push(format!(r#"{{"language":"{too_long}"}}"#));
        for hint in &malformed {
            let mut grants = 0;
            let error = SourceRequest::decode(&raw(hint), "i", usize::MAX, &mut |_| {
                grants += 1;
                true
            })
            .err()
            .unwrap();
            assert_eq!(error, Fault::not_started("invalid_request"));
            assert_eq!(grants, 0, "invalid hint must fail before payload admission");
        }
    }

    #[test]
    fn version_three_source_request_is_rejected_before_payload_reservation() {
        let request = raw(r#"{"language":"rust"}"#);
        let old = RawValue::from_string(request.get().replacen("\"v\":4", "\"v\":3", 1)).unwrap();
        let mut grants = 0;
        let fault = SourceRequest::decode(&old, "i", usize::MAX, &mut |_| {
            grants += 1;
            true
        })
        .err()
        .expect("previous protocol version is rejected");
        assert_eq!(fault.code, "protocol_mismatch");
        assert_eq!(grants, 0);
    }
}
