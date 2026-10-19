//! Shared borrowed v3 request primitives. No source or context materialization.
use crate::protocol::Fault;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    TryNow,
    BoundedQueue(u32),
}
pub(crate) fn invalid() -> Fault {
    Fault::not_started("invalid_request")
}
pub(crate) fn present<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(d).map(Some)
}
pub(crate) fn decode<'a, T: Deserialize<'a>>(raw: &'a RawValue) -> Result<T, Fault> {
    if !raw.get().trim_start().starts_with('{') {
        return Err(invalid());
    }
    serde_json::from_str(raw.get()).map_err(|_| invalid())
}
pub(crate) fn text(raw: &RawValue, cap: usize) -> Result<Cow<'_, str>, Fault> {
    if raw.get().len() > cap * 6 + 2 {
        return Err(invalid());
    }
    let value: Cow<'_, str> = serde_json::from_str(raw.get()).map_err(|_| invalid())?;
    if value.is_empty() || value.len() > cap || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(value)
}
pub(crate) fn unsigned(raw: &RawValue, max: u32) -> Result<u32, Fault> {
    let n = raw.get().trim().parse::<f64>().map_err(|_| invalid())?;
    if !n.is_finite() || n < 0.0 || n > f64::from(max) || n.fract() != 0.0 {
        return Err(invalid());
    }
    Ok(n as u32)
}
pub(crate) fn fingerprint(raw: &RawValue) -> Result<Cow<'_, str>, Fault> {
    let value = text(raw, 64)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(value)
}
pub(crate) fn admission(
    raw: Option<&RawValue>,
    wait: Option<&RawValue>,
) -> Result<Admission, Fault> {
    match text(raw.ok_or_else(invalid)?, 64)?.as_ref() {
        "try_now" if wait.is_none() => Ok(Admission::TryNow),
        "bounded_queue" => {
            let wait = unsigned(wait.ok_or_else(invalid)?, crate::request::QUEUE_WAIT_MS)?;
            if wait == 0 {
                return Err(invalid());
            }
            Ok(Admission::BoundedQueue(wait))
        }
        _ => Err(invalid()),
    }
}
