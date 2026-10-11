//! Bounded pre-decode admission shared by pipe and public module frontends.
//! The small control lane cannot be exhausted by two unsettled source deliveries.
use crate::{
    credit::{Budget, Credit},
    engine::Limits,
    protocol::Fault,
    reply::Reply,
    request::{self, Operation, Request},
    scheduler::{Submission, Ticket, Wake},
};
use serde::{de, Deserialize, Serialize};
use serde_json::value::RawValue;
use std::fmt;

pub const CONTROL_REQUEST_BYTES: usize = 4096;
pub const CONTROL_REPLY_BYTES: usize = 32 * 1024;
pub const CONTROL_RESERVATION: usize = 64 * 1024;

pub enum Incoming {
    Data(Ticket),
    Control(Box<Control>),
}
#[derive(Debug)]
pub struct Rejection {
    pub ticket: Option<String>,
    pub fault: Fault,
}
/// The complete typed request is credited; no control source work is performed.
pub struct Control {
    request: Request,
    credit: Credit,
}
impl Control {
    pub fn request(&self) -> &Request {
        &self.request
    }
    pub fn reply<T: Serialize>(self, instance: &str, body: T) -> Result<ControlDelivery, Fault> {
        let encoded = {
            let reply = Reply::ok(&self.request.ticket, instance, body);
            reply.encode_with_cap(CONTROL_REPLY_BYTES)
        };
        self.deliver(encoded?)
    }
    pub fn error(self, instance: &str, fault: Fault) -> Result<ControlDelivery, Fault> {
        let bytes = Reply::<()>::error(&self.request.ticket, instance, fault)
            .encode_with_cap(CONTROL_REPLY_BYTES)?;
        self.deliver(bytes)
    }
    fn deliver(self, bytes: Vec<u8>) -> Result<ControlDelivery, Fault> {
        let Self {
            request,
            mut credit,
        } = self;
        drop(request);
        credit.resize(bytes.capacity())?;
        Ok(ControlDelivery {
            bytes,
            _credit: credit,
        })
    }
}
/// Preserve metadata credit through flush or actual SDK ownership transfer.
pub struct ControlDelivery {
    bytes: Vec<u8>,
    _credit: Credit,
}
impl ControlDelivery {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn commit(self) {}
    pub(crate) fn handoff<T>(mut self, receive: impl FnOnce(Vec<u8>) -> T) -> T {
        receive(std::mem::take(&mut self.bytes))
    }
}
pub(crate) enum Prepared {
    Data(Submission, Ticket),
    Control(Control),
}
pub(crate) fn prepare(
    scope: &str,
    bytes: Vec<u8>,
    now: u64,
    data: &Budget,
    controls: &Budget,
    limits: &Limits,
    wake: Option<Wake>,
) -> Result<Prepared, Rejection> {
    // A borrow-only routing probe can recover valid escaped ticket values without
    // materializing source or arbitrary ignored values on pre-decode refusal.
    let header = routing_header(&bytes);
    let is_control = header
        .as_ref()
        .is_some_and(|(_, op)| matches!(op, Operation::Describe | Operation::ThemesRefresh));
    let ticket = header.map(|(ticket, _)| ticket);
    let result = (|| {
        if bytes.len() > request::REQUEST_BYTES {
            return Err(Fault::not_started("frame_limit"));
        }
        if is_control {
            if bytes.len() > CONTROL_REQUEST_BYTES {
                return Err(Fault::not_started("frame_limit"));
            }
            let mut credit = controls.reserve(Some(scope), CONTROL_RESERVATION)?;
            credit.started();
            let decoded = request::decode(&bytes);
            drop(bytes);
            let request = decoded?;
            if matches!(request.op, Operation::Describe | Operation::ThemesRefresh) {
                return Ok(Prepared::Control(Control { request, credit }));
            }
            // A mismatching decoded control kind is never routed into source work.
            Err(Fault::not_started("invalid_request"))
        } else {
            let (submission, ticket) = Submission::decode(scope, bytes, now, data, limits, wake)?;
            Ok(Prepared::Data(submission, ticket))
        }
    })();
    result.map_err(|fault| Rejection { ticket, fault })
}

pub fn routing_ticket(frame: &[u8]) -> Option<String> {
    routing_header(frame).map(|(ticket, _)| ticket)
}
fn routing_header(frame: &[u8]) -> Option<(String, Operation)> {
    if frame.len() > request::REQUEST_BYTES || !bounded_depth(frame) {
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
fn bounded_depth(frame: &[u8]) -> bool {
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
