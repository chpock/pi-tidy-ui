//! Common v4 DATA envelopes and typed computation results.
use crate::{
    fault::Fault,
    reply::{Outcome, Reply},
    semantic::PROTOCOL_VERSION,
    source::SourceBody,
    style::Styles,
    vocabulary,
};
use serde::Serialize;

/// Both data operations use the same envelope, writer and physical credit.
#[derive(Serialize)]
#[serde(untagged)]
pub enum DataBody {
    Source(SourceBody),
    Styles(Styles),
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
