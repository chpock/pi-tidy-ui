//! Borrowed styles.resolve admission; neither source parsing nor transport ownership.
use crate::{
    protocol::Fault,
    semantic::{Bounds, ContextPlan},
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input<'a> {
    #[serde(borrow)]
    kind: &'a RawValue,
    #[serde(borrow, default, deserialize_with = "present")]
    id: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    fingerprint: Option<&'a RawValue>,
    #[serde(borrow, default, deserialize_with = "present")]
    definition: Option<&'a RawValue>,
}
pub enum RuleInput<'a> {
    Native {
        id: Cow<'a, str>,
        fingerprint: Cow<'a, str>,
    },
    Client(ClientRulePlan<'a>),
}
pub struct StyleRequestPlan<'a> {
    pub ticket: Cow<'a, str>,
    pub admission: Admission,
    pub contexts: ContextPlan<'a>,
    pub rules: RuleInput<'a>,
    /// Context expansion and client-rule compilation only. Raw-frame capture,
    /// native immutable assets, matching workspace and output need separate credit.
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
        if unsigned(request.v, u32::MAX)? != 3 {
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
        let input: Input<'a> = decode(request.rules)?;
        let (rules, rule_bytes) = match text(input.kind, 64)?.as_ref() {
            "native" if input.definition.is_none() => (
                RuleInput::Native {
                    id: text(input.id.ok_or_else(invalid)?, 64)?,
                    fingerprint: fingerprint(input.fingerprint.ok_or_else(invalid)?)?,
                },
                0,
            ),
            "client" if input.id.is_none() && input.fingerprint.is_none() => {
                let plan =
                    ClientRulePlan::inspect(input.definition.ok_or_else(invalid)?, available_bytes)
                        .map_err(|e| e.fault())?;
                let bytes = plan.measurement().policy_bytes;
                (RuleInput::Client(plan), bytes)
            }
            _ => return Err(invalid()),
        };
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
