//! Source-free v4 negotiation. Theme and catalogue state is owned by the caller.
use crate::{
    actor::PoolHandle,
    ingress::{Control, ControlDelivery},
    protocol::Fault,
    runtime_request::Operation,
    semantic_description,
    semantic_engine::Limits,
};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct Authority {
    pool: PoolHandle,
    instance: String,
    limits: Limits,
    alive: AtomicBool,
}
impl Authority {
    pub fn new(pool: PoolHandle, instance: String, limits: Limits) -> Self {
        Self {
            pool,
            instance,
            limits,
            alive: AtomicBool::new(true),
        }
    }
    pub fn instance(&self) -> &str {
        &self.instance
    }
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && self.pool.stats().is_ok()
    }
    pub fn retire(&self) {
        self.alive.store(false, Ordering::Release);
    }

    pub async fn control(&self, control: Box<Control>) -> Result<ControlDelivery, Fault> {
        if !self.is_alive() {
            return control.error(&self.instance, Fault::not_started("scope_gone"));
        }
        if control.request().op != Operation::Describe {
            return control.error(&self.instance, Fault::not_started("invalid_request"));
        }
        let stats = self.pool.stats()?;
        control.reply(
            &self.instance,
            semantic_description::describe(&self.limits, stats),
        )
    }
}
