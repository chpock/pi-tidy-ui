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
    let optional = |raw: Option<&RawValue>, cap| match raw {
        None => Ok(None),
        Some(raw) if raw.get() == "null" => Ok(None),
        Some(raw) => text(raw, cap).map(|s| Some(s.into_owned())),
    };
    Ok(SyntaxHint {
        language: optional(value.language, 128)?,
        path: optional(value.path, crate::limits::PATH_HINT_BYTES)?,
    })
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
        if unsigned(r.v, u32::MAX)? != 3 {
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
