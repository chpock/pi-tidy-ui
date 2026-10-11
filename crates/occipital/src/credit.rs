//! Shared reservations for controlled application payloads, not a claim about private parser heaps.
use crate::protocol::Fault;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub bytes: usize,
    pub jobs: usize,
    pub peak_bytes: usize,
    pub peak_jobs: usize,
    pub queued: usize,
}
struct State {
    limits: (usize, usize, usize),
    stats: Snapshot,
    routes: HashMap<String, usize>,
}
#[derive(Clone)]
pub struct Budget(Arc<Mutex<State>>);
pub struct Credit {
    budget: Budget,
    bytes: usize,
    route: Option<String>,
    queued: bool,
}
impl Budget {
    pub fn new(bytes: usize, jobs: usize, per_route: usize) -> Self {
        Self(Arc::new(Mutex::new(State {
            limits: (bytes, jobs, per_route),
            stats: Snapshot::default(),
            routes: HashMap::new(),
        })))
    }
    pub fn snapshot(&self) -> Snapshot {
        self.0.lock().expect("budget poisoned").stats
    }
    pub fn reserve(&self, route: Option<&str>, bytes: usize) -> Result<Credit, Fault> {
        let mut state = self.0.lock().expect("budget poisoned");
        if bytes > state.limits.0.saturating_sub(state.stats.bytes)
            || route.is_some_and(|route| {
                state.stats.jobs >= state.limits.1
                    || state.routes.get(route).copied().unwrap_or(0) >= state.limits.2
            })
        {
            return Err(Fault::not_started("busy"));
        }
        state.stats.bytes += bytes;
        if let Some(route) = route {
            state.stats.jobs += 1;
            state.stats.queued += 1;
            *state.routes.entry(route.into()).or_default() += 1;
        }
        state.stats.peak_bytes = state.stats.peak_bytes.max(state.stats.bytes);
        state.stats.peak_jobs = state.stats.peak_jobs.max(state.stats.jobs);
        Ok(Credit {
            budget: self.clone(),
            bytes,
            route: route.map(String::from),
            queued: route.is_some(),
        })
    }
}
impl Credit {
    /// Reassign an already admitted allowance; aggregate bytes/jobs do not grow.
    pub(crate) fn transfer_to(&mut self, target: &mut Self, bytes: usize) -> Result<(), Fault> {
        if !Arc::ptr_eq(&self.budget.0, &target.budget.0) || bytes > self.bytes {
            return Err(Fault::started("state_limit"));
        }
        let total = target
            .bytes
            .checked_add(bytes)
            .ok_or(Fault::started("state_limit"))?;
        self.bytes -= bytes;
        target.bytes = total;
        Ok(())
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn started(&mut self) {
        if self.queued {
            self.budget.0.lock().expect("budget poisoned").stats.queued -= 1;
            self.queued = false;
        }
    }
    pub fn resize(&mut self, bytes: usize) -> Result<(), Fault> {
        let mut state = self.budget.0.lock().expect("budget poisoned");
        if bytes > self.bytes
            && bytes - self.bytes > state.limits.0.saturating_sub(state.stats.bytes)
        {
            return Err(Fault::not_started("busy"));
        }
        state.stats.bytes = state.stats.bytes - self.bytes + bytes;
        self.bytes = bytes;
        state.stats.peak_bytes = state.stats.peak_bytes.max(state.stats.bytes);
        Ok(())
    }
}
impl Drop for Credit {
    fn drop(&mut self) {
        let mut state = self.budget.0.lock().expect("budget poisoned");
        state.stats.bytes -= self.bytes;
        if let Some(route) = &self.route {
            state.stats.jobs -= 1;
            if self.queued {
                state.stats.queued -= 1;
            }
            let count = state.routes.get_mut(route).expect("credit route");
            *count -= 1;
            if *count == 0 {
                state.routes.remove(route);
            }
        }
    }
}
