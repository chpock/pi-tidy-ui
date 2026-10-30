//! Active v4 routing ownership. Borrowed plans never outlive the admitted frame;
//! style expansion/compilation is deferred to the existing entitled worker turn.
use crate::{
    credit::Credit,
    protocol::Fault,
    source_request::{Admission, SourceOperation, SourceRequest},
    style_request::StyleRequestPlan,
    wire,
};
use serde::Deserialize;
use serde_json::value::RawValue;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum Operation {
    #[serde(rename = "describe")]
    Describe,
    #[serde(rename = "highlight")]
    Highlight,
    #[serde(rename = "stream.open")]
    StreamOpen,
    #[serde(rename = "stream.append")]
    StreamAppend,
    #[serde(rename = "stream.close")]
    StreamClose,
    #[serde(rename = "styles.resolve")]
    StylesResolve,
}
#[derive(Debug)]
pub struct ControlRequest {
    pub ticket: String,
    pub op: Operation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRaw<'a> {
    #[serde(borrow)]
    v: &'a RawValue,
    #[serde(borrow)]
    ticket: &'a RawValue,
    #[serde(borrow)]
    op: &'a RawValue,
    #[serde(borrow, default, deserialize_with = "wire::present")]
    instance: Option<&'a RawValue>,
}
pub fn control(bytes: &[u8]) -> Result<ControlRequest, Fault> {
    let raw: &RawValue = serde_json::from_slice(bytes).map_err(|_| wire::invalid())?;
    let value: ControlRaw<'_> = wire::decode(raw)?;
    if wire::unsigned(value.v, u32::MAX)? != 4 {
        return Err(Fault::not_started("protocol_mismatch"));
    }
    let op: Operation = serde_json::from_str(value.op.get()).map_err(|_| wire::invalid())?;
    if op != Operation::Describe {
        return Err(wire::invalid());
    }
    if let Some(instance) = value.instance {
        wire::text(instance, 64)?;
    }
    Ok(ControlRequest {
        ticket: wire::text(value.ticket, 64)?.into_owned(),
        op,
    })
}
pub(crate) enum DataRequest {
    Source(SourceRequest),
    Styles {
        bytes: Vec<u8>,
        ticket: String,
        admission: Admission,
    },
}
impl DataRequest {
    pub fn ticket(&self) -> &str {
        match self {
            Self::Source(r) => &r.ticket,
            Self::Styles { ticket, .. } => ticket,
        }
    }
    pub fn admission(&self) -> Option<Admission> {
        match self {
            Self::Source(r) => r.admission,
            Self::Styles { admission, .. } => Some(*admission),
        }
    }
    pub fn lease(&self) -> Option<&str> {
        match self {
            Self::Source(SourceRequest {
                operation:
                    SourceOperation::Append { lease, .. } | SourceOperation::Close { lease, .. },
                ..
            }) => Some(lease),
            _ => None,
        }
    }
    pub fn decode(
        bytes: Vec<u8>,
        instance: &str,
        source_bytes: usize,
        credit: &mut Credit,
    ) -> Result<Self, Fault> {
        if bytes.len() > crate::limits::DATA_WIRE_BYTES {
            return Err(Fault::not_started("frame_limit"));
        }
        if !crate::ingress::bounded_depth(&bytes) {
            return Err(wire::invalid());
        }
        let raw: &RawValue = serde_json::from_slice(&bytes).map_err(|_| wire::invalid())?;
        #[derive(Deserialize)]
        struct Kind<'a> {
            #[serde(borrow)]
            op: &'a RawValue,
        }
        let kind: Kind<'_> = wire::decode(raw)?;
        let op: Operation = serde_json::from_str(kind.op.get()).map_err(|_| wire::invalid())?;
        if op == Operation::StylesResolve {
            let plan = StyleRequestPlan::inspect(raw, instance, crate::limits::DATA_BYTES)?;
            let ticket = plan.ticket.into_owned();
            let admission = plan.admission;
            Ok(Self::Styles {
                bytes,
                ticket,
                admission,
            })
        } else {
            let base = credit.bytes();
            let mut owned = 0;
            let request = SourceRequest::decode(raw, instance, source_bytes, &mut |n| {
                let Some(total) = base.checked_add(n) else {
                    return false;
                };
                if credit.resize(total).is_err() {
                    return false;
                }
                owned = n;
                true
            })?;
            drop(bytes);
            credit.resize(
                owned
                    .checked_add(4096)
                    .ok_or(Fault::not_started("data_limit"))?,
            )?;
            Ok(Self::Source(request))
        }
    }
}
