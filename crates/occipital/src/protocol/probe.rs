//! Borrow-only routing and depth probes before authoritative request decoding.
use super::request::Operation;
use crate::limits;
use serde::{de, Deserialize};
use serde_json::value::RawValue;
use std::fmt;

pub fn routing_ticket(frame: &[u8]) -> Option<String> {
    routing_header(frame).map(|(ticket, _)| ticket)
}
pub(crate) fn routing_header(frame: &[u8]) -> Option<(String, Operation)> {
    if frame.len() > limits::WIRE_BYTES || !bounded_depth(frame) {
        return None;
    }
    struct Header<'a>(&'a RawValue, &'a RawValue);
    impl<'de> Deserialize<'de> for Header<'de> {
        fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> de::Visitor<'de> for Visitor {
                type Value = Header<'de>;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("bounded request header")
                }
                fn visit_map<A: de::MapAccess<'de>>(
                    self,
                    mut map: A,
                ) -> Result<Self::Value, A::Error> {
                    let mut ticket = None;
                    let mut op = None;
                    // Capture even escaped keys as borrowed raw JSON first; only
                    // bounded names are decoded, never an arbitrary scratch String.
                    while let Some(raw_key) = map.next_key::<&'de RawValue>()? {
                        if raw_key.get().len() > 128 {
                            return Err(de::Error::custom("header key limit"));
                        }
                        let key: String =
                            serde_json::from_str(raw_key.get()).map_err(de::Error::custom)?;
                        if key == "ticket" {
                            if ticket.is_some() {
                                return Err(de::Error::custom("duplicate ticket"));
                            }
                            ticket = Some(map.next_value::<&'de RawValue>()?);
                        } else if key == "op" {
                            if op.is_some() {
                                return Err(de::Error::custom("duplicate operation"));
                            }
                            op = Some(map.next_value::<&'de RawValue>()?);
                        } else {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                    match (ticket, op) {
                        (Some(ticket), Some(op)) => Ok(Header(ticket, op)),
                        _ => Err(de::Error::custom("missing routing header")),
                    }
                }
            }
            d.deserialize_map(Visitor)
        }
    }
    let header = serde_json::from_slice::<Header<'_>>(frame).ok()?;
    let raw = header.0.get();
    if header.1.get().len() > 128 {
        return None;
    }
    let op: Operation = serde_json::from_str(header.1.get()).ok()?;
    // At most64 UTF-8 bytes, even if every ASCII byte uses a six-byte escape.
    if raw.len() > 64 * 6 + 2 {
        return None;
    }
    let value: String = serde_json::from_str(raw).ok()?;
    (!value.is_empty() && value.len() <= 64 && !value.chars().any(char::is_control))
        .then_some((value, op))
}

/// serde_json's ignored/raw value scanner uses a growable nesting stack rather
/// than its typed recursion guard. Bound that stack before any routing probe.
pub(crate) fn bounded_depth(frame: &[u8]) -> bool {
    let (mut depth, mut quoted, mut escaped) = (0u8, false, false);
    for &byte in frame {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > 64 {
                        return false;
                    }
                }
                b']' | b'}' => {
                    if depth == 0 {
                        return false;
                    }
                    depth -= 1;
                }
                _ => {}
            }
        }
    }
    depth == 0 && !quoted
}
