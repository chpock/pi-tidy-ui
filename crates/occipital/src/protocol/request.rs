//! Common operation names and source-free CONTROL request decoding.
use super::{wire, PROTOCOL_VERSION};
use crate::fault::Fault;
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
    if wire::unsigned(value.v, u32::MAX)? != PROTOCOL_VERSION {
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
