//! Borrowed v4 styles.resolve admission; neither source parsing nor transport ownership.
use crate::{
    protocol::Fault,
    semantic::{Bounds, ContextPlan, PROTOCOL_VERSION},
    style_rules::ClientRulePlan,
    vocabulary,
    wire::{admission, decode, fingerprint, invalid, present, text, unsigned},
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::borrow::Cow;

pub use crate::wire::Admission;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request<'a> {
    #[serde(borrow)]
    v: &'a RawValue,
    #[serde(borrow)]
    op: &'a RawValue,
    #[serde(borrow)]
    ticket: &'a RawValue,
    #[serde(borrow)]
    instance: &'a RawValue,
    #[serde(borrow)]
    admission: &'a RawValue,
    #[serde(borrow, default, deserialize_with = "present")]
    queue_wait_ms: Option<&'a RawValue>,
    #[serde(borrow)]
    vocabulary: &'a RawValue,
    #[serde(borrow)]
    contexts: &'a RawValue,
    #[serde(borrow)]
    rules: &'a RawValue,
}
pub struct StyleRequestPlan<'a> {
    pub ticket: Cow<'a, str>,
    pub admission: Admission,
    pub contexts: ContextPlan<'a>,
    pub rules: ClientRulePlan<'a>,
    /// Context expansion and rule compilation only. Raw-frame capture,
    /// matching workspace and output need separate credit.
    pub policy_bytes: usize,
}
impl<'a> StyleRequestPlan<'a> {
    pub fn inspect(
        raw: &'a RawValue,
        instance: &str,
        available_bytes: usize,
    ) -> Result<Self, Fault> {
        if raw.get().len() > crate::limits::DATA_WIRE_BYTES {
            return Err(Fault::not_started("frame_limit"));
        }
        let request: Request<'a> = decode(raw)?;
        if unsigned(request.v, u32::MAX)? != PROTOCOL_VERSION {
            return Err(Fault::not_started("protocol_mismatch"));
        }
        if text(request.op, 64)? != "styles.resolve" || text(request.instance, 64)? != instance {
            return Err(invalid());
        }
        let ticket = text(request.ticket, 64)?;
        if fingerprint(request.vocabulary)?.as_ref() != vocabulary::FINGERPRINT {
            return Err(Fault::not_started("vocabulary_changed"));
        }
        let admission = admission(Some(request.admission), request.queue_wait_ms)?;
        let rules = ClientRulePlan::inspect(request.rules, available_bytes)
            .map_err(|error| error.fault())?;
        let rule_bytes = rules.measurement().policy_bytes;
        let remaining = available_bytes
            .checked_sub(rule_bytes)
            .ok_or(Fault::not_started("data_limit"))?;
        let contexts = ContextPlan::inspect(
            &[request.contexts],
            Bounds {
                vocabulary_size: vocabulary::SCOPE_COUNT as u32,
                max_bytes: remaining,
            },
        )
        .map_err(|e| Fault::not_started(e.code()))?;
        let policy_bytes = rule_bytes
            .checked_add(contexts.measurement().policy_bytes)
            .ok_or(Fault::not_started("data_limit"))?;
        Ok(Self {
            ticket,
            admission,
            contexts,
            rules,
            policy_bytes,
        })
    }
}
