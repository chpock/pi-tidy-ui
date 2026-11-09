//! Fair worker-local quanta shared by source and style work in both transports.
use crate::{
    credit::{Budget, Credit, Snapshot},
    fault::Fault,
    limits::Limits,
    protocol::Admission,
    runtime_request::DataRequest,
    semantic_reply::{self, DataBody},
    source::{request::SourceRequest, Action, Job as SourceJob, Service},
    style_request::StyleRequestPlan,
    style_work::{StyleFailure, StyleWork},
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};
use tokio::sync::oneshot;
const PENDING: u8 = 0;
const COMMITTED: u8 = 1;
const CANCELLED: u8 = 2;
const QUEUED: usize = crate::limits::DATA_JOBS;
pub(crate) type Wake = Arc<dyn Fn() + Send + Sync>;
struct Receipt {
    state: AtomicU8,
    wake: Option<Wake>,
}
impl Receipt {
    fn cancel(&self) {
        let _ =
            self.state
                .compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire);
        if let Some(wake) = &self.wake {
            wake();
        }
    }
}
/// Abandoned work remains credited until actual worker settlement and reply disposal.
pub struct Ticket {
    receiver: oneshot::Receiver<Delivery>,
    receipt: Arc<Receipt>,
    owns_cancellation: bool,
}
impl Ticket {
    pub fn cancel(&self) {
        self.receipt.cancel();
    }
    pub fn try_take(&mut self) -> Result<Option<Delivery>, Fault> {
        match self.receiver.try_recv() {
            Ok(value) => {
                self.owns_cancellation = false;
                Ok(Some(value))
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(_) => Err(Fault::not_started("worker_gone")),
        }
    }
    pub async fn take(&mut self) -> Result<Delivery, Fault> {
        let delivery = (&mut self.receiver)
            .await
            .map_err(|_| Fault::not_started("worker_gone"))?;
        self.owns_cancellation = false;
        Ok(delivery)
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if self.owns_cancellation {
            self.receipt.cancel();
        }
    }
}
/// Keep this guard through direct write/flush or until the public SDK owns the bytes.
/// Dropping without commit releases affected leases at the next owning-worker turn.
pub struct Delivery {
    bytes: Vec<u8>,
    receipt: Arc<Receipt>,
    _credit: Credit,
}
impl Delivery {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// Direct transport has already flushed: destroy bytes before releasing credit.
    pub fn flushed(mut self) {
        self.acknowledge();
        drop(std::mem::take(&mut self.bytes));
    }
    /// Construct the public SDK's owning message before credit/receipt transfer.
    pub(crate) fn handoff<T>(mut self, receive: impl FnOnce(Vec<u8>) -> T) -> T {
        let message = receive(std::mem::take(&mut self.bytes));
        self.acknowledge();
        message
    }
    pub fn commit(mut self) -> Vec<u8> {
        self.acknowledge();
        std::mem::take(&mut self.bytes)
    }
    fn acknowledge(&self) {
        let _ = self.receipt.state.compare_exchange(
            PENDING,
            COMMITTED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if let Some(wake) = &self.receipt.wake {
            wake();
        }
    }
}
impl Drop for Delivery {
    fn drop(&mut self) {
        if self.receipt.state.load(Ordering::Acquire) != COMMITTED {
            self.receipt.cancel();
        }
    }
}
/// Only owned requests/bytes cross threads; no borrowed plan or parser state.
pub(crate) struct Submission {
    request: DataRequest,
    deadline: u64,
    sender: oneshot::Sender<Delivery>,
    receipt: Arc<Receipt>,
    credit: Credit,
}
impl Submission {
    pub(crate) fn ticket_id(&self) -> &str {
        self.request.ticket()
    }
    pub(crate) fn decode(
        scope: &str,
        bytes: Vec<u8>,
        now: u64,
        budget: &Budget,
        limits: &Limits,
        instance: &str,
        wake: Option<Wake>,
    ) -> Result<(Self, Ticket), Fault> {
        let mut credit = budget.reserve(
            Some(scope),
            bytes
                .capacity()
                .checked_mul(4)
                .and_then(|n| n.checked_add(4096))
                .ok_or(Fault::not_started("data_limit"))?,
        )?;
        let request = DataRequest::decode(bytes, instance, limits.source_bytes, &mut credit)?;
        let wait = match request.admission() {
            Some(Admission::BoundedQueue(ms)) => ms,
            _ => 0,
        };
        let (sender, receiver) = oneshot::channel();
        let receipt = Arc::new(Receipt {
            state: AtomicU8::new(PENDING),
            wake,
        });
        let ticket = Ticket {
            receiver,
            receipt: receipt.clone(),
            owns_cancellation: true,
        };
        Ok((
            Self {
                request,
                deadline: now.saturating_add(u64::from(wait)),
                sender,
                receipt,
                credit,
            },
            ticket,
        ))
    }
    pub(crate) fn reject(self, instance: &str, fault: Fault) {
        let envelope = Envelope {
            ticket: self.request.ticket().to_owned(),
            sender: self.sender,
            receipt: self.receipt,
        };
        drop(self.request);
        deliver_error(instance, envelope, self.credit, fault);
    }
    fn waiting(self) -> Waiting {
        Waiting {
            envelope: Envelope {
                ticket: self.request.ticket().to_owned(),
                sender: self.sender,
                receipt: self.receipt,
            },
            phase: Phase::Queued {
                request: self.request,
                deadline: self.deadline,
                funding: Funding::new(self.credit),
            },
        }
    }
}

struct Envelope {
    ticket: String,
    sender: oneshot::Sender<Delivery>,
    receipt: Arc<Receipt>,
}
impl Envelope {
    fn deliver(self, bytes: Vec<u8>, credit: Credit) {
        let _ = self.sender.send(Delivery {
            bytes,
            receipt: self.receipt,
            _credit: credit,
        });
    }
}

struct Funding {
    credit: Credit,
    base: usize,
    transferred: usize,
}
impl Funding {
    fn new(credit: Credit) -> Self {
        Self {
            base: credit.bytes(),
            credit,
            transferred: 0,
        }
    }
    fn reserve(&mut self, additional: usize) -> bool {
        self.base
            .checked_add(additional)
            .and_then(|n| n.checked_sub(self.transferred))
            .is_some_and(|n| self.credit.resize(n).is_ok())
    }
    // Move NET retained growth without reserving twice. Later absolute Work
    // callbacks subtract the allowance already transferred to persistent state.
    fn reconcile(&mut self, retained: usize, idle: &mut Credit) -> Result<(), Fault> {
        if retained > idle.bytes() {
            let growth = retained - idle.bytes();
            self.credit.transfer_to(idle, growth)?;
            self.transferred = self
                .transferred
                .checked_add(growth)
                .ok_or(Fault::started("state_limit"))?;
        } else {
            idle.resize(retained)?;
        }
        Ok(())
    }
}

enum Active {
    Source { job: SourceJob, funding: Funding },
    Styles(StyleWork),
}
enum Phase {
    Queued {
        request: DataRequest,
        deadline: u64,
        funding: Funding,
    },
    Running(Active),
}
struct Waiting {
    envelope: Envelope,
    phase: Phase,
}
impl Waiting {
    fn running(envelope: Envelope, active: Active) -> Self {
        Self {
            envelope,
            phase: Phase::Running(active),
        }
    }
    fn queued_request(&self) -> Option<&DataRequest> {
        match &self.phase {
            Phase::Queued { request, .. } => Some(request),
            Phase::Running(_) => None,
        }
    }
    fn expiry(&self) -> Option<u64> {
        match &self.phase {
            Phase::Queued {
                request, deadline, ..
            } if matches!(request.admission(), Some(Admission::BoundedQueue(_))) => Some(*deadline),
            _ => None,
        }
    }
    fn rejection(&self, now: u64) -> Option<Fault> {
        if self.envelope.receipt.state.load(Ordering::Acquire) == CANCELLED {
            Some(Fault::not_started("cancelled"))
        } else if self.expiry().is_some_and(|deadline| now >= deadline) {
            Some(Fault::not_started("queue_expired"))
        } else {
            None
        }
    }
}

struct Finalization {
    envelope: Envelope,
    funding: Funding,
    source: Option<SourceJob>,
}
impl Finalization {
    fn source(envelope: Envelope, funding: Funding, job: SourceJob) -> Self {
        Self {
            envelope,
            funding,
            source: Some(job),
        }
    }
    fn plain(envelope: Envelope, credit: Credit) -> Self {
        Self {
            envelope,
            funding: Funding::new(credit),
            source: None,
        }
    }
}
struct Unhanded {
    job: SourceJob,
    receipt: Arc<Receipt>,
    _credit: Credit,
}
pub struct Scheduler {
    instance: String,
    service: Service,
    budget: Budget,
    idle: Credit,
    acks: Credit,
    queues: HashMap<String, VecDeque<Waiting>>,
    turns: VecDeque<String>,
    unhanded: Vec<Unhanded>,
    limits: Limits,
    wake: Option<Wake>,
}
impl Scheduler {
    pub fn new(instance: String, limits: Limits, budget: Budget) -> Self {
        let idle = budget.reserve(None, 0).expect("empty state reservation");
        let acks = budget.reserve(None, 0).expect("empty ack metadata");
        Self {
            service: Service::new(limits.clone(), instance.clone()),
            instance,
            budget,
            idle,
            acks,
            queues: HashMap::new(),
            turns: VecDeque::new(),
            unhanded: Vec::new(),
            limits,
            wake: None,
        }
    }
    pub fn set_wake(&mut self, wake: Wake) {
        self.wake = Some(wake);
    }
    pub fn bind(&mut self, scope: &str) -> Result<(), Fault> {
        let result = self
            .service
            .bind(scope, &mut |n| self.idle.resize(n).is_ok());
        self.shrink_idle();
        result
    }
    pub fn close(&mut self, scope: &str) {
        if let Some(queue) = self.queues.remove(scope) {
            for waiting in queue {
                self.finish_error(waiting, Fault::not_started("scope_gone"));
            }
        }
        self.turns.retain(|turn| turn != scope);
        self.service.close_scope(scope);
        for item in &self.unhanded {
            if item.job.in_scope(scope) {
                item.receipt.cancel();
            }
        }
        self.cleanup();
        self.shrink_idle();
    }
    pub fn stats(&self) -> Snapshot {
        self.budget.snapshot()
    }
    pub fn leases(&self) -> usize {
        self.service.leases()
    }
    pub fn next_expiry(&self) -> Option<u64> {
        self.service
            .next_expiry()
            .into_iter()
            .chain(
                self.queues
                    .values()
                    .flat_map(|q| q.iter().filter_map(Waiting::expiry)),
            )
            .min()
    }
    fn blocked(&self, scope: &str) -> bool {
        self.queues
            .get(scope)
            .and_then(|q| q.front())
            .and_then(Waiting::queued_request)
            .and_then(DataRequest::lease)
            .is_some_and(|lease| {
                self.unhanded
                    .iter()
                    .any(|item| item.job.owns_lease(scope, lease))
            })
    }
    pub fn has_work(&self) -> bool {
        self.turns.iter().any(|scope| !self.blocked(scope))
    }
    pub fn submit(&mut self, scope: &str, bytes: Vec<u8>, now: u64) -> Result<Ticket, Fault> {
        let (submission, ticket) = Submission::decode(
            scope,
            bytes,
            now,
            &self.budget,
            &self.limits,
            &self.instance,
            self.wake.clone(),
        )?;
        self.accept(scope, submission);
        Ok(ticket)
    }
    pub(crate) fn accept(&mut self, scope: &str, submission: Submission) {
        let waiting = submission.waiting();
        let count = self
            .queues
            .values()
            .flat_map(|q| q.iter())
            .filter(|w| w.queued_request().is_some())
            .count();
        let held = waiting
            .queued_request()
            .and_then(DataRequest::lease)
            .is_some_and(|lease| {
                self.unhanded
                    .iter()
                    .any(|item| item.job.owns_lease(scope, lease))
            });
        let admission = waiting.queued_request().and_then(DataRequest::admission);
        if (admission == Some(Admission::TryNow) && (!self.turns.is_empty() || held))
            || count >= QUEUED
        {
            self.finish_error(waiting, Fault::not_started("busy"));
            return;
        }
        let queue = self.queues.entry(scope.into()).or_default();
        if queue.is_empty() {
            self.turns.push_back(scope.into());
        }
        queue.push_back(waiting);
    }
    fn cleanup(&mut self) {
        let mut index = 0;
        while index < self.unhanded.len() {
            let state = self.unhanded[index].receipt.state.load(Ordering::Acquire);
            if state == PENDING {
                index += 1;
                continue;
            }
            let item = self.unhanded.swap_remove(index);
            if state != COMMITTED {
                self.service.discard(item.job);
            }
        }
        if self.unhanded.is_empty() {
            self.unhanded = Vec::new();
            self.acks.resize(0).expect("released ack vector");
        }
    }
    fn shrink_idle(&mut self) {
        let bytes = self.service.known_idle_state_bytes();
        if bytes < self.idle.bytes() {
            self.idle.resize(bytes).expect("state shrink");
        }
    }
    fn finish_error(&mut self, waiting: Waiting, mut fault: Fault) {
        let Waiting { envelope, phase } = waiting;
        match phase {
            Phase::Queued {
                request, funding, ..
            } => {
                drop(request);
                self.finish_failure(
                    Finalization {
                        envelope,
                        funding,
                        source: None,
                    },
                    fault,
                );
            }
            Phase::Running(Active::Source { job, funding }) => {
                self.finish_failure(Finalization::source(envelope, funding, job), fault);
            }
            Phase::Running(Active::Styles(work)) => {
                fault.started = true;
                self.finish_style_error(envelope, work.fail(fault));
            }
        }
    }
    fn finish_failure(&mut self, mut finalization: Finalization, mut fault: Fault) {
        if let Some(job) = finalization.source.take() {
            fault.started |= job.started();
            self.service.discard(job);
        }
        // Failed preparation may leave funded table capacity after Work disposal.
        // Transfer that retained growth before shrinking to the error envelope.
        finalization
            .funding
            .reconcile(self.service.known_idle_state_bytes(), &mut self.idle)
            .expect("retained source growth was admitted by the failing job");
        deliver_error(
            &self.instance,
            finalization.envelope,
            finalization.funding.credit,
            fault,
        );
    }
    fn finish_style_error(&mut self, envelope: Envelope, failure: StyleFailure) {
        self.finish_failure(Finalization::plain(envelope, failure.credit), failure.fault);
    }
    fn sweep(&mut self, now: u64) {
        let scopes: Vec<_> = self.queues.keys().cloned().collect();
        for scope in scopes {
            let mut keep = VecDeque::new();
            for waiting in self.queues.remove(&scope).expect("queue exists") {
                if let Some(fault) = waiting.rejection(now) {
                    self.finish_error(waiting, fault);
                } else {
                    keep.push_back(waiting);
                }
            }
            if keep.is_empty() {
                self.turns.retain(|t| t != &scope);
            } else {
                self.queues.insert(scope, keep);
            }
        }
    }
    fn next_turn(&mut self) -> Option<String> {
        for _ in 0..self.turns.len() {
            let scope = self.turns.pop_front().expect("turn");
            if !self.blocked(&scope) {
                return Some(scope);
            }
            self.turns.push_back(scope);
        }
        None
    }
    pub fn tick(&mut self, now: u64) {
        self.cleanup();
        self.service.advance_clock(now);
        self.shrink_idle();
        self.sweep(now);
        let Some(scope) = self.next_turn() else {
            return;
        };
        let mut queue = self.queues.remove(&scope).expect("queue");
        let waiting = queue.pop_front().expect("nonempty");
        if let Some((envelope, active)) = self.prepare(&scope, waiting) {
            let next = match active {
                Active::Source { job, funding } => self.step_source(envelope, job, funding),
                Active::Styles(work) => self.step_styles(envelope, work),
            };
            if let Some(waiting) = next {
                queue.push_front(waiting);
            }
        }
        if !queue.is_empty() {
            self.queues.insert(scope.clone(), queue);
            self.turns.push_back(scope);
        }
        self.shrink_idle();
    }
    fn step_source(
        &mut self,
        envelope: Envelope,
        mut job: SourceJob,
        mut funding: Funding,
    ) -> Option<Waiting> {
        let body = match self.service.step(&mut job, &mut |n| funding.reserve(n)) {
            Ok(body) => body,
            Err(fault) => {
                self.finish_failure(Finalization::source(envelope, funding, job), fault);
                return None;
            }
        };
        if let Err(fault) = funding.reconcile(self.service.known_idle_state_bytes(), &mut self.idle)
        {
            drop(body);
            self.finish_failure(Finalization::source(envelope, funding, job), fault);
            return None;
        }
        if let Some(body) = body {
            self.finish_success(
                Finalization::source(envelope, funding, job),
                DataBody::Source(body),
            );
            None
        } else {
            Some(Waiting::running(envelope, Active::Source { job, funding }))
        }
    }
    fn step_styles(&mut self, envelope: Envelope, mut work: StyleWork) -> Option<Waiting> {
        match work.step() {
            Err(fault) => self.finish_style_error(envelope, work.fail(fault)),
            Ok(false) => return Some(Waiting::running(envelope, Active::Styles(work))),
            Ok(true) => match work.finish() {
                Ok((body, credit)) => {
                    self.finish_success(
                        Finalization::plain(envelope, credit),
                        DataBody::Styles(body),
                    );
                }
                Err(failure) => self.finish_style_error(envelope, failure),
            },
        }
        None
    }
    fn prepare(&mut self, scope: &str, waiting: Waiting) -> Option<(Envelope, Active)> {
        let Waiting { envelope, phase } = waiting;
        let (request, mut funding) = match phase {
            Phase::Running(active) => return Some((envelope, active)),
            Phase::Queued {
                request, funding, ..
            } => (request, funding),
        };
        funding.credit.started();
        match request {
            DataRequest::Source(request) => self.prepare_source(scope, envelope, request, funding),
            DataRequest::Styles { bytes, .. } => match self.prepare_styles(bytes, funding.credit) {
                Ok(work) => Some((envelope, Active::Styles(work))),
                Err(failure) => {
                    self.finish_style_error(envelope, failure);
                    None
                }
            },
        }
    }
    fn prepare_source(
        &mut self,
        scope: &str,
        envelope: Envelope,
        request: SourceRequest,
        mut funding: Funding,
    ) -> Option<(Envelope, Active)> {
        let result = self
            .service
            .start(scope, request.operation, &mut |n| funding.reserve(n));
        // Release decoded request metadata before reconciling or encoding its result.
        drop(request.ticket);
        match result {
            Ok(Action::Job(job)) => {
                if let Err(fault) =
                    funding.reconcile(self.service.known_idle_state_bytes(), &mut self.idle)
                {
                    self.finish_failure(Finalization::source(envelope, funding, job), fault);
                    None
                } else {
                    Some((envelope, Active::Source { job, funding }))
                }
            }
            Ok(Action::Immediate(body)) => {
                self.shrink_idle();
                self.finish_success(
                    Finalization {
                        envelope,
                        funding,
                        source: None,
                    },
                    DataBody::Source(body),
                );
                None
            }
            Err(fault) => {
                self.finish_failure(
                    Finalization {
                        envelope,
                        funding,
                        source: None,
                    },
                    fault,
                );
                None
            }
        }
    }
    fn prepare_styles(
        &mut self,
        bytes: Vec<u8>,
        mut credit: Credit,
    ) -> Result<StyleWork, StyleFailure> {
        let preparation = (|| {
            let raw: &serde_json::value::RawValue = serde_json::from_slice(&bytes)
                .map_err(|_| Fault::not_started("invalid_request"))?;
            let plan = StyleRequestPlan::inspect(raw, &self.instance, crate::limits::DATA_BYTES)?;
            credit.resize(
                credit
                    .bytes()
                    .checked_add(plan.policy_bytes)
                    .ok_or(Fault::not_started("data_limit"))?,
            )?;
            // Both complete plans are admitted before either owned expansion.
            let fingerprint = plan.rules.fingerprint().to_owned();
            let resolver = plan.rules.compile();
            let mut batches = plan.contexts.materialize();
            let contexts = batches.pop().expect("one admitted dictionary");
            Ok((contexts, resolver, fingerprint))
        })();
        let (contexts, resolver, fingerprint) = match preparation {
            Ok(value) => value,
            Err(fault) => return Err(StyleFailure { fault, credit }),
        };
        drop(bytes);
        StyleWork::new(contexts, &resolver, fingerprint, credit)
    }
    fn finish_success(&mut self, finalization: Finalization, body: DataBody) {
        self.finish_success_bounded(finalization, body, crate::limits::DATA_WIRE_BYTES);
    }
    fn finish_success_bounded(
        &mut self,
        mut finalization: Finalization,
        body: DataBody,
        cap: usize,
    ) {
        let encoded = {
            let reply = semantic_reply::ok(&finalization.envelope.ticket, &self.instance, body);
            reply.encode_with_credit(&mut finalization.funding.credit, cap)
        };
        let bytes = match encoded {
            Ok(bytes) => bytes,
            Err(fault) => {
                self.finish_failure(finalization, fault);
                return;
            }
        };
        if let Some(mut job) = finalization.source.take() {
            job.trim_completed();
            let ack_bytes = job.acknowledgement_bytes() + std::mem::size_of::<Unhanded>();
            let credit = &mut finalization.funding.credit;
            // Account the ack vector's gross replacement before allocating it.
            let growth = if self.unhanded.len() == self.unhanded.capacity() {
                (self.unhanded.len() + 1) * std::mem::size_of::<Unhanded>()
            } else {
                0
            };
            if let Err(fault) = credit.resize(
                credit
                    .bytes()
                    .checked_add(ack_bytes + growth)
                    .expect("bounded ack headers"),
            ) {
                finalization.source = Some(job);
                drop(bytes);
                self.finish_failure(finalization, fault);
                return;
            }
            let mut ack = self.budget.reserve(None, 0).expect("zero metadata guard");
            credit
                .transfer_to(&mut ack, ack_bytes)
                .expect("same budget");
            if growth != 0 {
                credit
                    .transfer_to(&mut self.acks, growth)
                    .expect("prepaid ack replacement");
                let mut next = Vec::with_capacity(self.unhanded.len() + 1);
                next.append(&mut self.unhanded);
                let old = std::mem::replace(&mut self.unhanded, next);
                drop(old);
                self.acks
                    .resize(self.unhanded.capacity() * std::mem::size_of::<Unhanded>())
                    .expect("release old ack capacity");
            }
            self.unhanded.push(Unhanded {
                job,
                receipt: finalization.envelope.receipt.clone(),
                _credit: ack,
            });
        }
        let mut credit = finalization.funding.credit;
        credit
            .resize(bytes.capacity())
            .expect("encoded capacity was admitted");
        finalization.envelope.deliver(bytes, credit);
    }
}
fn deliver_error(instance: &str, envelope: Envelope, mut credit: Credit, fault: Fault) {
    credit.started();
    credit
        .resize(4096)
        .expect("prepaid error floor survives state handoff");
    let bytes = semantic_reply::error::<()>(&envelope.ticket, instance, fault)
        .encode_with_cap(4096)
        .expect("bounded fixed error envelope fits prepaid floor");
    credit.resize(bytes.capacity()).expect("encoded allowance");
    envelope.deliver(bytes, credit);
}

#[cfg(test)]
#[allow(dead_code)]
#[path = "../tests/support/mod.rs"]
mod support;
#[cfg(test)]
mod integration_tests {
    use super::*;
    use serde_json::{json, Value};
    fn open() -> Vec<u8> {
        serde_json::to_vec(&json!({"v":4,"op":"stream.open","ticket":"open","instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":"key","generation":1,"source_version":0,"hint":{"language":"rust"},"text":"fn x(){}\n"}]})).unwrap()
    }
    fn four_streams() -> (Scheduler, Budget) {
        let budget = Budget::new(1 << 20, 2, 2);
        let mut scheduler = Scheduler::new("boot".into(), Limits::default(), budget.clone());
        scheduler.bind("route").unwrap();
        for _ in 0..4 {
            let mut ticket = scheduler.submit("route", open(), 0).unwrap();
            loop {
                scheduler.tick(0);
                if let Some(reply) = ticket.try_take().unwrap() {
                    reply.flushed();
                    break;
                }
            }
            scheduler.tick(0);
        }
        assert_eq!(scheduler.leases(), 4);
        (scheduler, budget)
    }
    #[test]
    fn every_failed_open_preparation_funds_retained_capacity_before_error_delivery() {
        let (mut probe, _) = four_streams();
        let (submission, _ticket) = Submission::decode(
            "route",
            open(),
            0,
            &probe.budget,
            &probe.limits,
            "boot",
            None,
        )
        .unwrap();
        let Waiting { envelope, phase } = submission.waiting();
        let Phase::Queued {
            request: DataRequest::Source(request),
            funding,
            ..
        } = phase
        else {
            panic!("source")
        };
        let mut grants = 0;
        let result = probe.service.start("route", request.operation, &mut |_| {
            grants += 1;
            true
        });
        drop(request.ticket);
        let Action::Job(job) = result.unwrap() else {
            panic!("source")
        };
        probe.service.discard(job);
        drop((envelope, funding));
        drop(probe);
        for denied in 0..grants {
            let (mut scheduler, budget) = four_streams();
            let (submission, mut ticket) =
                Submission::decode("route", open(), 0, &budget, &scheduler.limits, "boot", None)
                    .unwrap();
            let Waiting { envelope, phase } = submission.waiting();
            let Phase::Queued {
                request: DataRequest::Source(request),
                mut funding,
                ..
            } = phase
            else {
                panic!("source")
            };
            funding.credit.started();
            let mut calls = 0;
            let result = scheduler
                .service
                .start("route", request.operation, &mut |n| {
                    let allowed = calls != denied;
                    calls += 1;
                    allowed && funding.reserve(n)
                });
            drop(request.ticket);
            let fault = result.err().expect("reservation denied");
            scheduler.finish_failure(
                Finalization {
                    envelope,
                    funding,
                    source: None,
                },
                fault,
            );
            assert_eq!(scheduler.leases(), 4);
            assert_eq!(
                scheduler.idle.bytes(),
                scheduler.service.known_idle_state_bytes(),
                "denied grant {denied}"
            );
            let reply = ticket.try_take().unwrap().unwrap();
            let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
            assert_eq!(value["status"], "error");
            assert_eq!(scheduler.stats().jobs, 1);
            reply.flushed();
            scheduler.tick(0);
            assert_eq!(scheduler.stats().jobs, 0);
            assert_eq!(scheduler.stats().bytes, scheduler.idle.bytes());
            let mut finite: Value = serde_json::from_slice(&open()).unwrap();
            finite["op"] = json!("highlight");
            let mut ticket = scheduler
                .submit("route", serde_json::to_vec(&finite).unwrap(), 0)
                .unwrap();
            loop {
                scheduler.tick(0);
                if let Some(reply) = ticket.try_take().unwrap() {
                    let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
                    assert_eq!(value["status"], "ok", "finite after denied grant {denied}");
                    reply.flushed();
                    break;
                }
            }
            scheduler.tick(0);
            scheduler.close("route");
            assert_eq!(scheduler.service.known_state_bytes(), 0);
            assert_eq!(
                (
                    budget.snapshot().bytes,
                    budget.snapshot().jobs,
                    budget.snapshot().queued
                ),
                (0, 0, 0)
            );
        }
    }
    #[test]
    fn reply_limit_discards_actual_ready_source_but_keeps_the_original_slot_until_error_drain() {
        let budget = Budget::new(1 << 20, 2, 2);
        let mut scheduler = Scheduler::new("boot".into(), Limits::default(), budget.clone());
        scheduler.bind("route").unwrap();
        let bound = scheduler.stats().bytes;
        let (submission, mut ticket) =
            Submission::decode("route", open(), 0, &budget, &scheduler.limits, "boot", None)
                .unwrap();
        let (envelope, active) = scheduler.prepare("route", submission.waiting()).unwrap();
        let Active::Source {
            mut job,
            mut funding,
        } = active
        else {
            panic!("source")
        };
        let body = loop {
            let result = scheduler
                .service
                .step(&mut job, &mut |n| funding.reserve(n))
                .unwrap();
            if let Some(body) = result {
                break body;
            }
        };
        funding
            .reconcile(
                scheduler.service.known_idle_state_bytes(),
                &mut scheduler.idle,
            )
            .unwrap();
        assert_eq!(scheduler.leases(), 1);
        // Same bounded writer/failure/cleanup path with a scaled response cap,
        // rather than generating an unrelated64MiB traffic campaign.
        scheduler.finish_success_bounded(
            Finalization::source(envelope, funding, job),
            DataBody::Source(body),
            128,
        );
        let reply = ticket.try_take().unwrap().unwrap();
        let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
        assert_eq!(value["v"], 4);
        assert_eq!(value["error"]["code"], "reply_limit");
        assert_eq!(value["error"]["execution"], "started");
        assert_eq!(scheduler.leases(), 0);
        assert_eq!(scheduler.stats().jobs, 1);
        assert!(scheduler.stats().bytes > bound);
        reply.flushed();
        scheduler.tick(0);
        assert_eq!(scheduler.stats().jobs, 0);
        assert_eq!(scheduler.stats().bytes, bound);
        scheduler.close("route");
        assert_eq!(budget.snapshot().bytes, 0);
    }
    #[test]
    fn compiled_style_cursor_keeps_source_lease_and_credit_until_actual_settlement() {
        let budget = Budget::new(32 << 20, 4, 2);
        let mut scheduler = Scheduler::new("boot".into(), Limits::default(), budget.clone());
        scheduler.bind("route").unwrap();
        let mut source = scheduler.submit("route", open(), 0).unwrap();
        scheduler.tick(0);
        source.try_take().unwrap().unwrap().flushed();
        scheduler.tick(0);
        assert_eq!(scheduler.leases(), 1);

        let definition = json!({
            "revision": 2,
            "binding_slots": 0,
            "default": {
                "foreground": { "kind": "inherit" },
                "background": { "kind": "inherit" },
                "attributes": 0,
                "attribute_mask": 0
            },
            "rules": []
        });
        let request = json!({
            "v": 4,
            "op": "styles.resolve",
            "ticket": "generic-rules",
            "instance": "boot",
            "admission": "bounded_queue",
            "queue_wait_ms": 1000,
            "vocabulary": crate::vocabulary::FINGERPRINT,
            "contexts": vec![vec![0]; 1000],
            "rules": definition
        });
        let mut ticket = scheduler
            .submit("route", serde_json::to_vec(&request).unwrap(), 0)
            .unwrap();
        scheduler.tick(0);
        assert!(ticket.try_take().unwrap().is_none());
        let charged = scheduler.stats().bytes;
        assert_eq!(scheduler.leases(), 1);
        for _ in 0..1000 {
            scheduler.tick(0);
        }
        let reply = ticket.try_take().unwrap().unwrap();
        let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
        assert_eq!(value["status"], "ok");
        assert!(value["body"]["rules"]
            .as_str()
            .is_some_and(|hash| hash.len() == 64));
        assert!(value["body"].get("palette").is_none());
        assert_eq!(value["body"]["indices"].as_array().unwrap().len(), 1000);
        reply.flushed();
        scheduler.tick(0);
        assert!(scheduler.stats().bytes < charged);
        assert_eq!(scheduler.leases(), 1);
        scheduler.close("route");
        drop(scheduler);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}
