//! Encode against the existing live request credit without transferring its slot.
use crate::{credit::Credit, fault::Fault, protocol::reply::Reply};
use serde::Serialize;

/// Retain the credit with the result until its transport settlement boundary.
pub fn encode<T: Serialize>(
    reply: &Reply<'_, T>,
    credit: &mut Credit,
    cap: usize,
) -> Result<Vec<u8>, Fault> {
    let base = credit.bytes();
    reply.encode_bounded(cap, |capacity| {
        base.checked_add(capacity)
            .is_some_and(|total| credit.resize(total).is_ok())
    })
}
