//! Theme-free source authority staged for v3 cutover, not an active second service.
//! The worker owns scheduling, request/response credits and actual transport settlement.
//! bind's callback funds absolute persistent-state overlap. start/step callbacks fund
//! absolute ADDITIONAL Job allowance (on top of decoded request/frame ownership),
//! cumulatively across every Work and ready result; hold their high-water until drain.
use crate::{
    protocol::Fault,
    semantic_engine::{Engine, Lease, Limits, Work},
    semantic_reply::{SourceBody, SourceResult},
    source_request::{SourceOperation, SourceRequest},
};
use sha2::{Digest, Sha256};
use std::{
    mem::size_of,
    sync::atomic::{AtomicU64, Ordering},
};
static SERVICE_INCARNATION: AtomicU64 = AtomicU64::new(0);

pub enum Action {
    Immediate(SourceBody),
    Job(Job),
}
struct Route {
    name: String,
    incarnation: u64,
}
struct Binding {
    scope: String,
    wire: String,
    key: String,
    generation: u32,
    source_version: u32,
    internal: Lease,
}
impl Binding {
    fn strings(&self) -> usize {
        self.scope.capacity() + self.wire.capacity() + self.key.capacity()
    }
}
struct Authority {
    wire: String,
    internal: Lease,
}
struct Pending {
    key: String,
    generation: u32,
    source_version: u32,
    lease: Option<String>,
    complete: bool,
    work: Option<Work>,
    peak: usize,
}
/// Cumulative high-water is deliberately not reclaimed as a source finishes: its
/// ready result and possible state handoff still share the same physical Job credit.
pub struct Job {
    scope: String,
    route: u64,
    pending: Vec<Pending>,
    front: usize,
    ready: Vec<SourceResult>,
    affected: Vec<Authority>,
    started: bool,
    done: bool,
    failed: bool,
    required: usize,
    result_words: usize,
    result_bytes: usize,
}
impl Job {
    pub fn started(&self) -> bool {
        self.started
            || self
                .pending
                .iter()
                .filter_map(|p| p.work.as_ref())
                .any(Work::started)
    }
    pub fn in_scope(&self, scope: &str) -> bool {
        self.scope == scope
    }
    pub fn owns_lease(&self, scope: &str, lease: &str) -> bool {
        self.scope == scope && self.affected.iter().any(|a| a.wire == lease)
    }
    pub fn required_bytes(&self) -> usize {
        self.required
    }
    pub fn input_bytes(&self) -> usize {
        self.pending
            .iter()
            .filter_map(|p| p.work.as_ref())
            .map(Work::retained_input_bytes)
            .sum()
    }
    /// Called only after the body was consumed/encoded, retaining exact cancellation
    /// authority until actual transport settlement. No credit is owned or dropped here.
    pub fn trim_completed(&mut self) {
        assert!(self.done && self.ready.is_empty());
        self.pending = Vec::new();
        self.ready = Vec::new();
    }
    pub fn acknowledgement_bytes(&self) -> usize {
        size_of::<Self>()
            + self.scope.capacity()
            + self.affected.capacity() * size_of::<Authority>()
            + self
                .affected
                .iter()
                .map(|a| a.wire.capacity())
                .sum::<usize>()
    }
}
pub struct Service {
    engine: Engine,
    instance: String,
    routes: Vec<Route>,
    bindings: Vec<Binding>,
    next_route: u64,
    next_lease: u64,
    incarnation: u64,
}
fn add(a: usize, b: usize) -> Result<usize, Fault> {
    a.checked_add(b).ok_or(Fault::not_started("data_limit"))
}
fn units<T>(n: usize) -> Result<usize, Fault> {
    n.checked_mul(size_of::<T>())
        .ok_or(Fault::not_started("data_limit"))
}
fn admit(
    total: &mut usize,
    bytes: usize,
    reserve: &mut dyn FnMut(usize) -> bool,
) -> Result<(), Fault> {
    let required = add(*total, bytes)?;
    if !reserve(required) {
        return Err(Fault::not_started("data_limit"));
    }
    *total = required;
    Ok(())
}
// Charge the gross replacement while the prior buffer is still alive. Deliberately
// retain it in the Job high-water, even after persistent capacity is transferred.
fn grow<T>(
    values: &mut Vec<T>,
    needed: usize,
    total: &mut usize,
    reserve: &mut dyn FnMut(usize) -> bool,
) -> Result<(), Fault> {
    if needed > values.capacity() {
        let cap = needed
            .max(
                values
                    .capacity()
                    .checked_mul(2)
                    .ok_or(Fault::not_started("data_limit"))?,
            )
            .max(4);
        admit(total, units::<T>(cap)?, reserve)?;
        values
            .try_reserve_exact(cap - values.len())
            .map_err(|_| Fault::not_started("data_limit"))?;
    }
    Ok(())
}
// Compose Engine's absolute single-Work peak with every previous/pending/ready
// member, without charging that Work's repeated peak notifications a second time.
fn work_grant<'a>(
    total: &'a mut usize,
    peak: &'a mut usize,
    reserve: &'a mut dyn FnMut(usize) -> bool,
) -> impl FnMut(usize) -> bool + 'a {
    move |required| {
        if required <= *peak {
            return true;
        }
        let Some(next) = total.checked_add(required - *peak) else {
            return false;
        };
        if !reserve(next) {
            return false;
        }
        *total = next;
        *peak = required;
        true
    }
}
impl Service {
    pub fn new(limits: Limits, instance: String) -> Self {
        Self {
            engine: Engine::new(limits),
            instance,
            routes: Vec::new(),
            bindings: Vec::new(),
            next_route: 0,
            next_lease: 0,
            incarnation: SERVICE_INCARNATION
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
                .expect("service incarnation exhausted"),
        }
    }
    /// Absolute service-owned persistent-state peak, INCLUDING currently retained
    /// state, but excluding worker-local Work/reply peaks. Caller uses state credit.
    pub fn bind(
        &mut self,
        scope: &str,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        if scope.is_empty() || scope.len() > 64 {
            return Err(Fault::not_started("invalid_scope"));
        }
        if self.routes.iter().any(|r| r.name == scope) {
            return Ok(());
        }
        if self.routes.len() >= crate::limits::ROUTES {
            return Err(Fault::not_started("route_limit"));
        }
        let next = self
            .next_route
            .checked_add(1)
            .ok_or(Fault::not_started("route_limit"))?;
        let mut required = self.known_state_bytes();
        admit(&mut required, scope.len(), reserve)?;
        let needed = self.routes.len() + 1;
        grow(&mut self.routes, needed, &mut required, reserve)?;
        self.routes.push(Route {
            name: scope.into(),
            incarnation: next,
        });
        self.next_route = next;
        Ok(())
    }
    fn route(&self, scope: &str) -> Option<u64> {
        self.routes
            .iter()
            .find(|r| r.name == scope)
            .map(|r| r.incarnation)
    }
    fn binding(&self, scope: &str, wire: &str) -> Option<usize> {
        self.bindings
            .iter()
            .position(|b| b.scope == scope && b.wire == wire)
    }
    fn remove_binding(&mut self, index: usize) {
        self.bindings.remove(index);
        if self.bindings.is_empty() {
            self.bindings = Vec::new();
        }
    }
    fn prune(&mut self) {
        // Both vectors retain increasing parser incarnations; merge without a
        // per-binding slot search or another persistent allocation/index.
        let mut live = self.engine.ordered_leases().peekable();
        self.bindings.retain(|b| {
            while live.peek().is_some_and(|(_, _, lease)| *lease < b.internal) {
                live.next();
            }
            live.peek().is_some_and(|(scope, wire, lease)| {
                *scope == b.scope && *wire == b.wire && *lease == b.internal
            })
        });
        if self.bindings.is_empty() {
            self.bindings = Vec::new();
        }
    }
    pub fn close_scope(&mut self, scope: &str) {
        self.routes.retain(|r| r.name != scope);
        if self.routes.is_empty() {
            self.routes = Vec::new();
        }
        self.engine.close_scope(scope);
        self.prune();
    }
    pub fn advance_clock(&mut self, now_ms: u64) {
        self.engine.advance_clock(now_ms);
        self.prune();
    }
    pub fn next_expiry(&self) -> Option<u64> {
        self.engine.next_expiry()
    }
    pub fn leases(&self) -> usize {
        self.engine.leases()
    }
    /// Dynamic controlled ownership only; fixed Service/instance storage belongs
    /// to the worker baseline. Shared Vec capacity is counted even when partly empty.
    fn metadata_capacity(&self) -> usize {
        self.routes.capacity() * size_of::<Route>()
            + self.routes.iter().map(|r| r.name.capacity()).sum::<usize>()
            + self.bindings.capacity() * size_of::<Binding>()
    }
    pub fn known_state_bytes(&self) -> usize {
        self.metadata_capacity()
            + self.bindings.iter().map(Binding::strings).sum::<usize>()
            + self.engine.retained_state_bytes()
    }
    pub fn known_idle_state_bytes(&self) -> usize {
        // Binding strings are persistent Service ownership even while their Work
        // is busy. Do not silently move them off state credit between quanta.
        self.metadata_capacity()
            + self.bindings.iter().map(Binding::strings).sum::<usize>()
            + self.engine.retained_idle_state_bytes()
    }
    fn wire_lease(&mut self) -> Result<String, Fault> {
        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or(Fault::not_started("session_limit"))?;
        let mut hash = Sha256::new();
        hash.update(self.instance.as_bytes());
        hash.update(self.incarnation.to_be_bytes());
        hash.update(self.next_lease.to_be_bytes());
        let mut wire = String::with_capacity(64);
        for byte in hash.finalize() {
            wire.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
            wire.push(char::from(b"0123456789abcdef"[(byte & 15) as usize]));
        }
        Ok(wire)
    }
    /// Request must have passed SourceRequest::decode; it owns request/frame credit.
    /// No duplicate raw decoder or source-key/generation validator lives here.
    pub fn start(
        &mut self,
        scope: &str,
        request: SourceRequest,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Action, Fault> {
        let route = self.route(scope).ok_or(Fault::not_started("scope_gone"))?;
        self.prune();
        if let SourceOperation::Close {
            key,
            lease,
            generation,
        } = request.operation
        {
            if let Some(i) = self.binding(scope, &lease) {
                let b = &self.bindings[i];
                if b.key == key && b.generation == generation {
                    self.engine.close(scope, &lease, b.internal);
                    self.remove_binding(i);
                }
            }
            return Ok(Action::Immediate(SourceBody::Closed));
        }
        let count = match &request.operation {
            SourceOperation::Finite { sources, .. } => {
                let mut bytes = 0usize;
                let mut lines = 0usize;
                for source in sources {
                    bytes = add(bytes, source.text.len())?;
                    lines = add(lines, crate::limits::source_lines(&source.text))?;
                    if bytes
                        > self
                            .engine
                            .limits
                            .source_bytes
                            .min(crate::limits::SOURCE_BYTES)
                        || lines > crate::limits::SOURCE_LINES
                    {
                        return Err(Fault::not_started("source_limit"));
                    }
                    self.engine.validate_input(&source.text, &source.hint)?;
                }
                sources.len()
            }
            _ => 1,
        };
        let mut required = 0;
        admit(&mut required, add(size_of::<Job>(), scope.len())?, reserve)?;
        admit(
            &mut required,
            add(units::<Pending>(count)?, units::<SourceResult>(count)?)?,
            reserve,
        )?;
        let affected_count = usize::from(matches!(
            request.operation,
            SourceOperation::Finite { open: true, .. } | SourceOperation::Append { .. }
        ));
        admit(&mut required, units::<Authority>(affected_count)?, reserve)?;
        let mut job = Job {
            scope: scope.into(),
            route,
            pending: Vec::with_capacity(count),
            front: 0,
            ready: Vec::with_capacity(count),
            affected: Vec::with_capacity(affected_count),
            started: false,
            done: false,
            failed: false,
            required,
            result_words: 0,
            result_bytes: 0,
        };
        let result = self.prepare(&mut job, request.operation, reserve);
        if let Err(fault) = result {
            self.discard(job);
            return Err(fault);
        }
        Ok(Action::Job(job))
    }
    fn prepare(
        &mut self,
        job: &mut Job,
        operation: SourceOperation,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<(), Fault> {
        match operation {
            SourceOperation::Finite { sources, open } => {
                for source in sources {
                    // SourceInput keys transfer into Pending/result; reserve their
                    // still-live capacity in addition to the already-decoded request.
                    admit(&mut job.required, source.key.capacity(), reserve)?;
                    let mut peak = 0;
                    let (lease, work) = if open {
                        let strings = add(add(job.scope.len(), source.key.len())?, 3 * 64)?;
                        admit(&mut job.required, strings, reserve)?;
                        let wire = self.wire_lease()?;
                        let work = self.engine.begin_open(
                            &job.scope,
                            &wire,
                            source.text,
                            &source.hint,
                            &mut work_grant(&mut job.required, &mut peak, reserve),
                        )?;
                        let needed = self.bindings.len() + 1;
                        if let Err(fault) =
                            grow(&mut self.bindings, needed, &mut job.required, reserve)
                        {
                            self.engine.discard(work);
                            return Err(fault);
                        }
                        let internal = work.lease().expect("open establishes an incarnation");
                        self.bindings.push(Binding {
                            scope: job.scope.clone(),
                            wire: wire.clone(),
                            key: source.key.clone(),
                            generation: source.generation,
                            source_version: source.source_version,
                            internal,
                        });
                        job.affected.push(Authority {
                            wire: wire.clone(),
                            internal,
                        });
                        (Some(wire), work)
                    } else {
                        (
                            None,
                            self.engine.begin_one_shot(
                                source.text,
                                &source.hint,
                                &mut work_grant(&mut job.required, &mut peak, reserve),
                            )?,
                        )
                    };
                    job.pending.push(Pending {
                        key: source.key,
                        generation: source.generation,
                        source_version: source.source_version,
                        lease,
                        complete: !open,
                        work: Some(work),
                        peak,
                    });
                }
            }
            SourceOperation::Append {
                key,
                lease,
                generation,
                source_version,
                base_revision,
                base_bytes,
                append,
                finalize,
            } => {
                let i = self
                    .binding(&job.scope, &lease)
                    .ok_or(Fault::not_started("restart_required"))?;
                let b = &self.bindings[i];
                if b.key != key || b.generation != generation || source_version < b.source_version {
                    return Err(Fault::not_started("restart_required"));
                }
                let internal = b.internal;
                admit(
                    &mut job.required,
                    add(key.capacity(), 2 * lease.capacity())?,
                    reserve,
                )?;
                let mut peak = 0;
                let work = self.engine.begin_append(
                    &job.scope,
                    &lease,
                    internal,
                    base_revision,
                    base_bytes,
                    append,
                    finalize,
                    &mut work_grant(&mut job.required, &mut peak, reserve),
                )?;
                job.affected.push(Authority {
                    wire: lease.clone(),
                    internal,
                });
                job.pending.push(Pending {
                    key,
                    generation,
                    source_version,
                    lease: Some(lease),
                    complete: finalize,
                    work: Some(work),
                    peak,
                });
            }
            SourceOperation::Close { .. } => unreachable!("close is immediate"),
        }
        Ok(())
    }
    pub fn step(
        &mut self,
        job: &mut Job,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Option<SourceBody>, Fault> {
        if job.done {
            return Err(Fault::not_started("job_complete"));
        }
        if job.failed {
            return Err(Fault {
                code: "job_complete",
                started: job.started(),
            });
        }
        let result = self.step_inner(job, reserve);
        if let Err(mut fault) = result {
            fault.started |= job.started();
            job.failed = true;
            return Err(fault);
        }
        result
    }
    fn step_inner(
        &mut self,
        job: &mut Job,
        reserve: &mut dyn FnMut(usize) -> bool,
    ) -> Result<Option<SourceBody>, Fault> {
        if self.route(&job.scope) != Some(job.route) {
            return Err(Fault::not_started("scope_gone"));
        }
        let pending = job
            .pending
            .get_mut(job.front)
            .ok_or(Fault::not_started("invalid_request"))?;
        let chunk = {
            let work = pending.work.as_mut().expect("current source has work");
            if job.result_bytes
                > crate::limits::DECODED_BYTES
                    - crate::limits::SOURCE_BODY_UNITS
                    - crate::limits::SOURCE_UNITS
            {
                return Err(Fault::not_started("result_limit"));
            }
            work.limit_result(job.result_words, job.result_bytes);
            let mut grant = work_grant(&mut job.required, &mut pending.peak, reserve);
            let ready = self.engine.step(work, &mut grant);
            job.started |= work.started();
            if !ready? {
                return Ok(None);
            }
            let work = pending.work.take().expect("validated work");
            self.engine.finish(work, &mut grant)?
        };
        if let Some(wire) = &pending.lease {
            if let Some(i) = self.binding(&job.scope, wire) {
                if pending.complete {
                    self.remove_binding(i);
                } else {
                    self.bindings[i].source_version = pending.source_version;
                }
            }
        }
        let result_words = chunk
            .contexts
            .iter()
            .map(|row| row[0] as usize + row.len() - 1)
            .sum::<usize>();
        job.result_words += result_words;
        job.result_bytes += crate::limits::SOURCE_UNITS
            + chunk.runs.len() * 8
            + chunk.contexts.len() * crate::limits::CONTEXT_ROW_UNITS
            + result_words * crate::limits::CONTEXT_WORD_UNITS;
        job.ready.push(SourceResult {
            key: std::mem::take(&mut pending.key),
            generation: pending.generation,
            source_version: pending.source_version,
            lease: pending.lease.take(),
            complete: pending.complete,
            chunk,
        });
        job.front += 1;
        if job.front == job.pending.len() {
            job.done = true;
            Ok(Some(SourceBody::sources(std::mem::take(&mut job.ready))))
        } else {
            Ok(None)
        }
    }
    /// Must run on actual cancellation/error cleanup, including a ready result
    /// not yet drained. Dropping Job alone is not authoritative lease retirement.
    pub fn discard(&mut self, job: Job) {
        for authority in job.affected {
            self.engine
                .close(&job.scope, &authority.wire, authority.internal);
            if let Some(i) = self.binding(&job.scope, &authority.wire) {
                if self.bindings[i].internal == authority.internal {
                    self.remove_binding(i);
                }
            }
        }
        for pending in job.pending {
            if let Some(work) = pending.work {
                self.engine.discard(work);
            }
        }
        self.prune();
    }
}

#[cfg(test)]
mod accounting_tests {
    use super::*;
    use crate::credit::Budget;
    use serde_json::{json, value::RawValue};
    use std::io::Write;
    fn input() -> Box<RawValue> {
        RawValue::from_string(json!({"v":3,"op":"stream.open","ticket":"t","instance":"instance","admission":"try_now","sources":[{"key":"key","generation":1,"source_version":0,"hint":{"language":"rust"},"text":"fn x(){}\n"}]}).to_string()).unwrap()
    }
    #[test]
    fn actual_job_credit_covers_state_and_ack_handoff_without_releasing_transport_slot() {
        for cancel in [false, true] {
            let mut service = Service::new(Limits::default(), "instance".into());
            let pool = Budget::new(1 << 20, 1, 1);
            let mut idle = pool.reserve(None, 0).unwrap();
            service.bind("r", &mut |n| idle.resize(n).is_ok()).unwrap();
            let bound = idle.bytes();
            let mut credit = pool.reserve(Some("r"), 0).unwrap();
            let mut decoded = 0;
            let request = SourceRequest::decode(
                &input(),
                "instance",
                crate::limits::SOURCE_BYTES,
                &mut |n| {
                    if credit.resize(n).is_err() {
                        return false;
                    }
                    decoded = n;
                    true
                },
            )
            .unwrap();
            credit.started();
            let (body, mut job) = {
                let mut grant = |n| credit.resize(decoded + n).is_ok();
                let Action::Job(mut job) = service.start("r", request, &mut grant).unwrap() else {
                    panic!("expected job")
                };
                loop {
                    if let Some(body) = service.step(&mut job, &mut grant).unwrap() {
                        break (body, job);
                    }
                }
            };
            let additional = job.required_bytes();
            let idle_bytes = service.known_idle_state_bytes();
            assert_eq!(idle_bytes, service.known_state_bytes());
            let growth = idle_bytes - idle.bytes();
            job.trim_completed();
            let ack_bytes = job.acknowledgement_bytes();
            assert!(growth + ack_bytes <= credit.bytes());
            credit.transfer_to(&mut idle, growth).unwrap();
            let mut ack = pool.reserve(None, 0).unwrap();
            credit.transfer_to(&mut ack, ack_bytes).unwrap();
            assert_eq!(pool.snapshot().jobs, 1);
            assert_eq!(pool.snapshot().queued, 0);
            assert_eq!(idle.bytes(), idle_bytes);
            assert_eq!(service.leases(), 1);
            if cancel {
                service.discard(job);
                idle.resize(service.known_idle_state_bytes()).unwrap();
                assert_eq!(service.leases(), 0);
            } else {
                drop(job);
                assert_eq!(service.leases(), 1);
            }
            // A completed/encoded result is not yet drain: its original physical
            // route credit still exists. Release it only after owned body cleanup.
            assert_eq!(pool.snapshot().jobs, 1);
            drop(body);
            drop(ack);
            drop(credit);
            assert_eq!(pool.snapshot().jobs, 0);
            assert_eq!(pool.snapshot().bytes, idle.bytes());
            if cancel {
                assert_eq!(idle.bytes(), bound);
            }
            service.close_scope("r");
            idle.resize(service.known_idle_state_bytes()).unwrap();
            assert_eq!(service.known_state_bytes(), 0);
            assert_eq!(
                (
                    pool.snapshot().bytes,
                    pool.snapshot().jobs,
                    pool.snapshot().queued
                ),
                (0, 0, 0)
            );
            writeln!(std::io::stdout(),"actual source handoff cancel={cancel}: decoded={decoded}, additional={additional}, idle={idle_bytes}, ack={ack_bytes}; one physical slot through body ownership, then all bytes/jobs/queued0").unwrap();
        }
    }
    #[test]
    fn pruning_live_leases_visits_a_linear_number_of_records() {
        for count in [4, 16, 64, 512] {
            let mut service = Service::new(Limits::default(), "instance".into());
            service.bind("r", &mut |_| true).unwrap();
            for _ in 0..count {
                let request = SourceRequest::decode(
                    &input(),
                    "instance",
                    crate::limits::SOURCE_BYTES,
                    &mut |_| true,
                )
                .unwrap();
                let Action::Job(mut job) = service.start("r", request, &mut |_| true).unwrap()
                else {
                    panic!("expected job")
                };
                while service.step(&mut job, &mut |_| true).unwrap().is_none() {}
            }
            assert_eq!(service.leases(), count);
            service.engine.take_lease_visits();
            for _ in 0..3 {
                service.advance_clock(0);
                let visits = service.engine.take_lease_visits();
                assert!(
                    visits <= 2 * count,
                    "{count} live leases required {visits} record visits"
                );
                assert_eq!(service.bindings.len(), count);
                writeln!(
                    std::io::stdout(),
                    "prune: {count} live leases, {visits} engine record visits"
                )
                .unwrap();
            }
            let first = &service.bindings[0];
            let close = RawValue::from_string(json!({"v":3,"op":"stream.close","ticket":"close","instance":"instance","key":first.key,"generation":first.generation,"lease":first.wire}).to_string()).unwrap();
            let request =
                SourceRequest::decode(&close, "instance", crate::limits::SOURCE_BYTES, &mut |_| {
                    true
                })
                .unwrap();
            assert!(matches!(
                service.start("r", request, &mut |_| true).unwrap(),
                Action::Immediate(_)
            ));
            let request = SourceRequest::decode(
                &input(),
                "instance",
                crate::limits::SOURCE_BYTES,
                &mut |_| true,
            )
            .unwrap();
            let Action::Job(busy) = service.start("r", request, &mut |_| true).unwrap() else {
                panic!("expected busy job")
            };
            service.engine.take_lease_visits();
            service.advance_clock(0);
            let visits = service.engine.take_lease_visits();
            assert!(
                visits <= 2 * count,
                "removal/reopen required {visits} record visits for {count} leases"
            );
            assert_eq!(service.bindings.len(), count);
            assert!(service
                .bindings
                .iter()
                .all(|b| service.engine.contains(&b.scope, &b.wire, b.internal)));
            service.discard(busy);
            assert_eq!(service.bindings.len(), count - 1);
            service.close_scope("r");
            assert_eq!(service.known_state_bytes(), 0);
        }
    }
    #[test]
    fn finish_state_failure_is_started_and_retains_job_cleanup_authority() {
        let mut service = Service::new(Limits::default(), "instance".into());
        service.bind("r", &mut |_| true).unwrap();
        let request = SourceRequest::decode(
            &input(),
            "instance",
            crate::limits::SOURCE_BYTES,
            &mut |_| true,
        )
        .unwrap();
        let Action::Job(mut job) = service.start("r", request, &mut |_| true).unwrap() else {
            panic!("expected job")
        };
        service.engine.limits.state_pool_bytes = service.engine.retained_state_bytes();
        let fault = service.step(&mut job, &mut |_| true).err().unwrap();
        assert_eq!(fault, Fault::started("state_limit"));
        assert!(job.started());
        assert_eq!(job.affected.len(), 1);
        assert!(job.pending[0].work.is_none());
        assert_eq!(service.leases(), 0);
        service.discard(job);
        service.close_scope("r");
        assert_eq!(service.known_state_bytes(), 0);
    }
}
