//! Fair worker-local quanta shared by source and style work in both transports.
use crate::{
    credit::{Budget, Credit, Snapshot},
    protocol::Fault,
    runtime_request::DataRequest,
    semantic_engine::Limits,
    semantic_reply::{self, DataBody},
    source_request::Admission,
    source_service::{Action, Job as SourceJob, Service},
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
        deliver_error(instance, self.waiting(), fault);
    }
    fn waiting(self) -> Waiting {
        let base = self.credit.bytes();
        let ticket = self.request.ticket().to_owned();
        let admission = self.request.admission();
        Waiting {
            request: Some(self.request),
            job: None,
            ticket,
            admission,
            deadline: self.deadline,
            sender: self.sender,
            receipt: self.receipt,
            credit: Some(self.credit),
            base,
            transferred: 0,
        }
    }
}
#[expect(
    clippy::large_enum_variant,
    reason = "Keep admitted Work headers inline without an unplanned boxed allocation"
)]
enum Job {
    Source(SourceJob),
    Styles(StyleWork),
}
impl Job {
    fn started(&self) -> bool {
        match self {
            Self::Source(j) => j.started(),
            Self::Styles(_) => true,
        }
    }
}
struct Waiting {
    request: Option<DataRequest>,
    job: Option<Job>,
    ticket: String,
    admission: Option<Admission>,
    deadline: u64,
    sender: oneshot::Sender<Delivery>,
    receipt: Arc<Receipt>,
    credit: Option<Credit>,
    base: usize,
    transferred: usize,
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
            .chain(self.queues.values().flat_map(|q| {
                q.iter().filter_map(|w| match w.admission {
                    Some(Admission::BoundedQueue(_)) if w.request.is_some() => Some(w.deadline),
                    _ => None,
                })
            }))
            .min()
    }
    fn blocked(&self, scope: &str) -> bool {
        self.queues
            .get(scope)
            .and_then(|q| q.front())
            .and_then(|w| w.request.as_ref())
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
            .filter(|w| w.request.is_some())
            .count();
        let held = waiting
            .request
            .as_ref()
            .and_then(DataRequest::lease)
            .is_some_and(|lease| {
                self.unhanded
                    .iter()
                    .any(|item| item.job.owns_lease(scope, lease))
            });
        if (waiting.admission == Some(Admission::TryNow) && (!self.turns.is_empty() || held))
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
    // New state was admitted by this physical Job. Move its NET retained growth
    // without reserving twice; future absolute Work callbacks subtract transfers.
    fn reconcile(&mut self, waiting: &mut Waiting) -> Result<(), Fault> {
        let bytes = self.service.known_idle_state_bytes();
        if bytes > self.idle.bytes() {
            let growth = bytes - self.idle.bytes();
            waiting
                .credit
                .as_mut()
                .expect("source owns credit")
                .transfer_to(&mut self.idle, growth)?;
            waiting.transferred = waiting
                .transferred
                .checked_add(growth)
                .ok_or(Fault::started("state_limit"))?;
        } else {
            self.idle.resize(bytes)?;
        }
        Ok(())
    }
    fn finish_error(&mut self, mut waiting: Waiting, mut fault: Fault) {
        if let Some(job) = waiting.job.take() {
            fault.started |= job.started();
            match job {
                Job::Source(job) => self.service.discard(job),
                Job::Styles(work) => waiting.credit = Some(work.fail(fault).credit),
            }
        }
        // Preparation may leave funded Vec capacity behind even after its Work
        // is discarded. Transfer it before reducing this job to an error envelope.
        self.reconcile(&mut waiting)
            .expect("retained source growth was admitted by the failing job");
        deliver_error(&self.instance, waiting, fault);
    }
    pub fn tick(&mut self, now: u64) {
        self.cleanup();
        self.service.advance_clock(now);
        self.shrink_idle();
        let scopes: Vec<_> = self.queues.keys().cloned().collect();
        for scope in scopes {
            let mut keep = VecDeque::new();
            for waiting in self.queues.remove(&scope).expect("queue exists") {
                if waiting.receipt.state.load(Ordering::Acquire) == CANCELLED {
                    self.finish_error(waiting, Fault::not_started("cancelled"));
                } else if waiting.request.is_some()
                    && matches!(waiting.admission, Some(Admission::BoundedQueue(_)))
                    && now >= waiting.deadline
                {
                    self.finish_error(waiting, Fault::not_started("queue_expired"));
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
        let mut entitled = None;
        for _ in 0..self.turns.len() {
            let scope = self.turns.pop_front().expect("turn");
            if self.blocked(&scope) {
                self.turns.push_back(scope);
            } else {
                entitled = Some(scope);
                break;
            }
        }
        let Some(scope) = entitled else {
            return;
        };
        let mut queue = self.queues.remove(&scope).expect("queue");
        let waiting = queue.pop_front().expect("nonempty");
        if let Some(mut waiting) = self.prepare(&scope, waiting) {
            let job = waiting.job.take().expect("prepared work");
            match job {
                Job::Source(mut job) => {
                    let base = waiting.base;
                    let transferred = waiting.transferred;
                    let credit = waiting.credit.as_mut().expect("source credit");
                    let result = self.service.step(&mut job, &mut |n| {
                        base.checked_add(n)
                            .and_then(|n| n.checked_sub(transferred))
                            .is_some_and(|n| credit.resize(n).is_ok())
                    });
                    waiting.job = Some(Job::Source(job));
                    match result {
                        Err(fault) => self.finish_error(waiting, fault),
                        Ok(body) => match self.reconcile(&mut waiting) {
                            Err(fault) => self.finish_error(waiting, fault),
                            Ok(()) => {
                                if let Some(body) = body {
                                    self.finish_success(waiting, DataBody::Source(body));
                                } else {
                                    queue.push_front(waiting);
                                }
                            }
                        },
                    }
                }
                Job::Styles(mut work) => match work.step() {
                    Err(fault) => {
                        let failure = work.fail(fault);
                        waiting.credit = Some(failure.credit);
                        self.finish_error(waiting, failure.fault);
                    }
                    Ok(false) => {
                        waiting.job = Some(Job::Styles(work));
                        queue.push_front(waiting);
                    }
                    Ok(true) => match work.finish() {
                        Ok((body, credit)) => {
                            waiting.credit = Some(credit);
                            self.finish_success(waiting, DataBody::Styles(body));
                        }
                        Err(failure) => {
                            waiting.credit = Some(failure.credit);
                            self.finish_error(waiting, failure.fault);
                        }
                    },
                },
            }
        }
        if !queue.is_empty() {
            self.queues.insert(scope.clone(), queue);
            self.turns.push_back(scope);
        }
        self.shrink_idle();
    }
    fn prepare(&mut self, scope: &str, mut waiting: Waiting) -> Option<Waiting> {
        if let Some(request) = waiting.request.take() {
            waiting.credit.as_mut().expect("queued credit").started();
            match request {
                DataRequest::Source(request) => {
                    let credit = waiting.credit.as_mut().expect("source credit");
                    let base = waiting.base;
                    match self.service.start(scope, request, &mut |n| {
                        base.checked_add(n)
                            .is_some_and(|n| credit.resize(n).is_ok())
                    }) {
                        Ok(Action::Job(job)) => {
                            waiting.job = Some(Job::Source(job));
                            if let Err(fault) = self.reconcile(&mut waiting) {
                                self.finish_error(waiting, fault);
                                return None;
                            }
                        }
                        Ok(Action::Immediate(body)) => {
                            self.shrink_idle();
                            self.finish_success(waiting, DataBody::Source(body));
                            return None;
                        }
                        Err(fault) => {
                            self.finish_error(waiting, fault);
                            return None;
                        }
                    }
                }
                DataRequest::Styles { bytes, .. } => {
                    let credit = waiting.credit.take().expect("original physical credit");
                    match self.prepare_styles(bytes, credit) {
                        Ok(work) => waiting.job = Some(Job::Styles(work)),
                        Err(failure) => {
                            waiting.credit = Some(failure.credit);
                            self.finish_error(waiting, failure.fault);
                            return None;
                        }
                    }
                }
            }
        }
        Some(waiting)
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
    fn finish_success(&mut self, waiting: Waiting, body: DataBody) {
        self.finish_success_bounded(waiting, body, crate::limits::DATA_WIRE_BYTES);
    }
    fn finish_success_bounded(&mut self, mut waiting: Waiting, body: DataBody, cap: usize) {
        let encoded = {
            let reply = semantic_reply::ok(&waiting.ticket, &self.instance, body);
            reply.encode_with_credit(waiting.credit.as_mut().expect("finished credit"), cap)
        };
        let bytes = match encoded {
            Ok(bytes) => bytes,
            Err(fault) => {
                self.finish_error(waiting, fault);
                return;
            }
        };
        if let Some(Job::Source(mut job)) = waiting.job.take() {
            job.trim_completed();
            let ack_bytes = job.acknowledgement_bytes() + std::mem::size_of::<Unhanded>();
            let credit = waiting.credit.as_mut().expect("source credit");
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
                waiting.job = Some(Job::Source(job));
                drop(bytes);
                self.finish_error(waiting, fault);
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
                receipt: waiting.receipt.clone(),
                _credit: ack,
            });
        }
        let mut credit = waiting
            .credit
            .take()
            .expect("delivery retains original slot");
        credit
            .resize(bytes.capacity())
            .expect("encoded capacity was admitted");
        let _ = waiting.sender.send(Delivery {
            bytes,
            receipt: waiting.receipt,
            _credit: credit,
        });
    }
}
fn deliver_error(instance: &str, mut waiting: Waiting, fault: Fault) {
    drop(waiting.request.take());
    let mut credit = waiting
        .credit
        .take()
        .expect("failure returns original physical credit");
    credit.started();
    credit
        .resize(4096)
        .expect("prepaid error floor survives state handoff");
    let bytes = semantic_reply::error::<()>(&waiting.ticket, instance, fault)
        .encode_with_cap(4096)
        .expect("bounded fixed error envelope fits prepaid floor");
    credit.resize(bytes.capacity()).expect("encoded allowance");
    let _ = waiting.sender.send(Delivery {
        bytes,
        receipt: waiting.receipt,
        _credit: credit,
    });
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
        let mut waiting = submission.waiting();
        let DataRequest::Source(request) = waiting.request.take().unwrap() else {
            panic!("source")
        };
        let mut grants = 0;
        let Action::Job(job) = probe
            .service
            .start("route", request, &mut |_| {
                grants += 1;
                true
            })
            .unwrap()
        else {
            panic!("source")
        };
        probe.service.discard(job);
        drop(waiting);
        drop(probe);
        for denied in 0..grants {
            let (mut scheduler, budget) = four_streams();
            let (submission, mut ticket) =
                Submission::decode("route", open(), 0, &budget, &scheduler.limits, "boot", None)
                    .unwrap();
            let mut waiting = submission.waiting();
            let DataRequest::Source(request) = waiting.request.take().unwrap() else {
                panic!("source")
            };
            let base = waiting.base;
            let credit = waiting.credit.as_mut().unwrap();
            credit.started();
            let mut calls = 0;
            let fault = scheduler
                .service
                .start("route", request, &mut |n| {
                    let allowed = calls != denied;
                    calls += 1;
                    allowed && credit.resize(base + n).is_ok()
                })
                .err()
                .expect("reservation denied");
            scheduler.finish_error(waiting, fault);
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
        let mut waiting = scheduler.prepare("route", submission.waiting()).unwrap();
        let Job::Source(mut job) = waiting.job.take().unwrap() else {
            panic!("source")
        };
        let body = loop {
            let credit = waiting.credit.as_mut().unwrap();
            let result = scheduler
                .service
                .step(&mut job, &mut |n| {
                    credit
                        .resize(waiting.base + n - waiting.transferred)
                        .is_ok()
                })
                .unwrap();
            if let Some(body) = result {
                break body;
            }
        };
        waiting.job = Some(Job::Source(job));
        scheduler.reconcile(&mut waiting).unwrap();
        assert_eq!(scheduler.leases(), 1);
        // Same bounded writer/failure/cleanup path with a scaled response cap,
        // rather than generating an unrelated64MiB traffic campaign.
        scheduler.finish_success_bounded(waiting, DataBody::Source(body), 128);
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
