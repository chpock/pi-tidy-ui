//! Bounded pre-decode admission shared by pipe and public module frontends.
//! The small control lane cannot be exhausted by two unsettled source deliveries.
use crate::{
    credit::{Budget, Credit},
    fault::Fault,
    limits::{self, Limits, CONTROL_REPLY_BYTES, CONTROL_REQUEST_BYTES},
    protocol::{
        probe::routing_header,
        reply,
        request::{self, ControlRequest, Operation},
    },
    scheduler::{Submission, Ticket, Wake},
};
use serde::Serialize;
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
    request: ControlRequest,
    credit: Credit,
}
impl Control {
    pub fn request(&self) -> &ControlRequest {
        &self.request
    }
    pub fn reply<T: Serialize>(self, instance: &str, body: T) -> Result<ControlDelivery, Fault> {
        let encoded = {
            let reply = reply::ok(&self.request.ticket, instance, body);
            reply.encode_with_cap(CONTROL_REPLY_BYTES)
        };
        self.deliver(encoded?)
    }
    pub fn error(self, instance: &str, fault: Fault) -> Result<ControlDelivery, Fault> {
        let bytes = reply::error::<()>(&self.request.ticket, instance, fault)
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
    (scope, instance): (&str, &str),
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
        .is_some_and(|(_, op)| matches!(op, Operation::Describe));
    let ticket = header.map(|(ticket, _)| ticket);
    let result = (|| {
        if bytes.len() > limits::WIRE_BYTES {
            return Err(Fault::not_started("frame_limit"));
        }
        if is_control {
            if bytes.len() > CONTROL_REQUEST_BYTES {
                return Err(Fault::not_started("frame_limit"));
            }
            let mut credit = controls.reserve(Some(scope), CONTROL_RESERVATION)?;
            credit.started();
            let decoded = request::control(&bytes);
            drop(bytes);
            let request = decoded?;
            if matches!(request.op, Operation::Describe) {
                return Ok(Prepared::Control(Control { request, credit }));
            }
            // A mismatching decoded control kind is never routed into source work.
            Err(Fault::not_started("invalid_request"))
        } else {
            if bytes.len() > crate::limits::DATA_WIRE_BYTES {
                return Err(Fault::not_started("frame_limit"));
            }
            let (submission, ticket) =
                Submission::decode(scope, bytes, now, data, limits, instance, wake)?;
            Ok(Prepared::Data(submission, ticket))
        }
    })();
    result.map_err(|fault| Rejection { ticket, fault })
}
