//! Fair worker-local quanta. Parser jobs never leave this scheduler's owning thread.
use crate::{
    credit::{Budget, Credit, Snapshot},
    engine::Limits,
    protocol::Fault,
    reply::{Reply, SourceBody, REPLY_BYTES},
    request::{self, AdmissionMode, Operation, Request},
    service::{Action, Job, Service},
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
/// Only owned requests/bytes cross threads; no parser state.
pub(crate) struct Submission {
    request: Request,
    deadline: u64,
    sender: oneshot::Sender<Delivery>,
    receipt: Arc<Receipt>,
    credit: Credit,
}
impl Submission {
    pub(crate) fn ticket_id(&self) -> &str {
        &self.request.ticket
    }
    pub(crate) fn decode(
        scope: &str,
        bytes: Vec<u8>,
        now: u64,
        budget: &Budget,
        limits: &Limits,
        wake: Option<Wake>,
    ) -> Result<(Self, Ticket), Fault> {
        // Frame, decoder scratch and decoded strings coexist before raw/work admission.
        let mut credit = budget.reserve(
            Some(scope),
            bytes.capacity().saturating_mul(4).saturating_add(4096),
        )?;
        let decoded = request::decode(&bytes);
        drop(bytes);
        let request = decoded?;
        if matches!(request.op, Operation::Describe | Operation::ThemesRefresh) {
            return Err(Fault::not_started("invalid_request"));
        }
        credit.resize(reservation(limits, &request)?)?;
        Ok(Self::pack(request, now, credit, wake))
    }
    fn new(
        scope: &str,
        request: Request,
        now: u64,
        budget: &Budget,
        limits: &Limits,
        wake: Option<Wake>,
    ) -> Result<(Self, Ticket), Fault> {
        request.validate()?;
        if matches!(request.op, Operation::Describe | Operation::ThemesRefresh) {
            return Err(Fault::not_started("invalid_request"));
        }
        let credit = budget.reserve(Some(scope), reservation(limits, &request)?)?;
        Ok(Self::pack(request, now, credit, wake))
    }
    fn pack(request: Request, now: u64, credit: Credit, wake: Option<Wake>) -> (Self, Ticket) {
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
        (
            Self {
                deadline: now.saturating_add(request.queue_wait_ms.unwrap_or(0) as u64),
                request,
                sender,
                receipt,
                credit,
            },
            ticket,
        )
    }
    pub(crate) fn reject(self, instance: &str, fault: Fault) {
        deliver_error(instance, self.waiting(), fault);
    }
    fn waiting(self) -> Waiting {
        Waiting {
            ticket: self.request.ticket.clone(),
            request: Some(self.request),
            deadline: self.deadline,
            job: None,
            sender: self.sender,
            receipt: self.receipt,
            credit: self.credit,
        }
    }
}
struct Waiting {
    request: Option<Request>,
    job: Option<Job>,
    ticket: String,
    deadline: u64,
    sender: oneshot::Sender<Delivery>,
    receipt: Arc<Receipt>,
    credit: Credit,
}
struct Unhanded {
    job: Job,
    receipt: Arc<Receipt>,
    _credit: Credit,
}
pub struct Scheduler {
    instance: String,
    service: Service,
    budget: Budget,
    idle: Credit,
    queues: HashMap<String, VecDeque<Waiting>>,
    turns: VecDeque<String>,
    unhanded: Vec<Unhanded>,
    limits: Limits,
    wake: Option<Wake>,
}
impl Scheduler {
    pub fn new(instance: String, limits: Limits, budget: Budget) -> Self {
        let idle = budget.reserve(None, 0).expect("empty state reservation");
        Self {
            service: Service::new(limits.clone(), instance.clone()),
            instance,
            budget,
            idle,
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
        self.service.bind(scope)
    }
    pub(crate) fn replace_profiles(
        &mut self,
        profiles: Vec<Arc<crate::profile::Profile>>,
    ) -> Result<(), Fault> {
        self.service.replace_profiles(profiles)?;
        self.sync_idle()
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
        self.sync_idle().expect("closing only releases state");
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
            .chain(self.queues.values().flat_map(|queue| {
                queue.iter().filter_map(|waiting| {
                    waiting
                        .request
                        .as_ref()
                        .filter(|request| request.admission == Some(AdmissionMode::BoundedQueue))
                        .map(|_| waiting.deadline)
                })
            }))
            .min()
    }
    fn blocked(&self, scope: &str) -> bool {
        self.queues
            .get(scope)
            .and_then(|queue| queue.front())
            .and_then(|waiting| waiting.request.as_ref())
            .and_then(|request| request.lease.as_deref())
            .is_some_and(|lease| {
                self.unhanded
                    .iter()
                    .any(|item| item.job.owns_lease(scope, lease))
            })
    }
    pub fn has_work(&self) -> bool {
        self.turns.iter().any(|scope| !self.blocked(scope))
    }
    /// A frame transient is reserved before decoding, then replaced by one bounded
    /// raw/work/result reservation. No parse or lease revision has begun here.
    pub fn submit(&mut self, scope: &str, bytes: Vec<u8>, now: u64) -> Result<Ticket, Fault> {
        let (submission, ticket) = Submission::decode(
            scope,
            bytes,
            now,
            &self.budget,
            &self.limits,
            self.wake.clone(),
        )?;
        self.accept(scope, submission);
        Ok(ticket)
    }
    pub fn submit_request(
        &mut self,
        scope: &str,
        request: Request,
        now: u64,
    ) -> Result<Ticket, Fault> {
        let (submission, ticket) = Submission::new(
            scope,
            request,
            now,
            &self.budget,
            &self.limits,
            self.wake.clone(),
        )?;
        self.accept(scope, submission);
        Ok(ticket)
    }
    pub(crate) fn accept(&mut self, scope: &str, submission: Submission) {
        let waiting = submission.waiting();
        let queue_count: usize = self
            .queues
            .values()
            .map(|queue| {
                queue
                    .iter()
                    .filter(|waiting| waiting.request.is_some())
                    .count()
            })
            .sum();
        let try_now = waiting
            .request
            .as_ref()
            .is_some_and(|request| request.admission == Some(AdmissionMode::TryNow));
        let held = waiting
            .request
            .as_ref()
            .and_then(|request| request.lease.as_deref())
            .is_some_and(|lease| {
                self.unhanded
                    .iter()
                    .any(|item| item.job.owns_lease(scope, lease))
            });
        if (try_now && (!self.turns.is_empty() || held)) || queue_count >= QUEUED {
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
    }
    fn sync_idle(&mut self) -> Result<(), Fault> {
        self.idle.resize(self.service.known_idle_state_bytes())
    }
    fn finish_error(&mut self, mut waiting: Waiting, mut fault: Fault) {
        if let Some(job) = waiting.job.take() {
            fault.started |= job.started();
            self.service.discard(job);
        }
        deliver_error(&self.instance, waiting, fault);
    }
    /// One fair route turn, one kernel quantum; expiry/cancellation precede dispatch.
    pub fn tick(&mut self, now: u64) {
        self.cleanup();
        self.service.advance_clock(now);
        self.sync_idle().expect("expiry only shrinks state");
        // Expire all unopened requests even if another route is running.
        let scopes: Vec<_> = self.queues.keys().cloned().collect();
        for scope in scopes {
            let mut queue = self.queues.remove(&scope).expect("queue exists");
            let mut keep = VecDeque::new();
            while let Some(waiting) = queue.pop_front() {
                if waiting.receipt.state.load(Ordering::Acquire) == CANCELLED {
                    self.finish_error(waiting, Fault::not_started("cancelled"));
                } else if waiting
                    .request
                    .as_ref()
                    .is_some_and(|request| request.admission == Some(AdmissionMode::BoundedQueue))
                    && now >= waiting.deadline
                {
                    self.finish_error(waiting, Fault::not_started("queue_expired"));
                } else {
                    keep.push_back(waiting);
                }
            }
            if !keep.is_empty() {
                self.queues.insert(scope, keep);
            } else {
                self.turns.retain(|turn| turn != &scope);
            }
        }
        let mut entitled = None;
        for _ in 0..self.turns.len() {
            let scope = self.turns.pop_front().expect("finite turn queue");
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
        let mut queue = self.queues.remove(&scope).expect("turn has queue");
        let mut waiting = queue.pop_front().expect("nonempty turn");
        waiting = match self.prepare(&scope, waiting) {
            Some(waiting) => waiting,
            None => {
                if !queue.is_empty() {
                    self.queues.insert(scope.clone(), queue);
                    self.turns.push_back(scope);
                }
                self.sync_idle().expect("immediate operation shrinks state");
                return;
            }
        };
        let job = waiting.job.as_mut().expect("prepared work");
        match self.service.step(job) {
            Ok(Some(body)) => self.finish_success(waiting, body),
            Ok(None) => queue.push_front(waiting),
            Err(fault) => self.finish_error(waiting, fault),
        }
        if !queue.is_empty() {
            self.queues.insert(scope.clone(), queue);
            self.turns.push_back(scope);
        }
        self.sync_idle()
            .expect("successful completion admitted state");
    }
    fn prepare(&mut self, scope: &str, mut waiting: Waiting) -> Option<Waiting> {
        if let Some(request) = waiting.request.take() {
            waiting.credit.started();
            match self.service.start(scope, request) {
                Ok(Action::Job(job)) => waiting.job = Some(job),
                Ok(Action::Immediate(body)) => {
                    self.finish_success(waiting, body);
                    return None;
                }
                Err(fault) => {
                    self.finish_error(waiting, fault);
                    return None;
                }
            }
        }
        Some(waiting)
    }
    fn finish_success(&mut self, mut waiting: Waiting, body: SourceBody) {
        // A match scrutinee's temporary lives through its arm. End this owned
        // Reply's scope first so run vectors cannot outlive their reservation.
        let encoded = {
            let reply = Reply::ok(&waiting.ticket, &self.instance, body);
            reply.encode()
        };
        let bytes = match encoded {
            Ok(bytes) => bytes,
            Err(fault) => {
                self.finish_error(waiting, fault);
                return;
            }
        };
        let idle_bytes = self.service.known_idle_state_bytes();
        let idle_growth = idle_bytes.saturating_sub(self.idle.bytes());
        if let Some(job) = &mut waiting.job {
            job.trim_completed();
        }
        let ack_bytes = waiting
            .job
            .as_ref()
            .map(|job| job.acknowledgement_bytes() + std::mem::size_of::<Unhanded>())
            .unwrap_or(0);
        if idle_growth
            .saturating_add(ack_bytes)
            .saturating_add(bytes.capacity())
            > waiting.credit.bytes()
        {
            drop(bytes);
            self.finish_error(waiting, Fault::started("state_limit"));
            return;
        }
        if idle_growth == 0 {
            self.idle.resize(idle_bytes).expect("idle state shrinks");
        } else if let Err(fault) = waiting.credit.transfer_to(&mut self.idle, idle_growth) {
            drop(bytes);
            self.finish_error(waiting, fault);
            return;
        }
        if let Some(job) = waiting.job.take() {
            let mut credit = self
                .budget
                .reserve(None, 0)
                .expect("zero-byte metadata guard");
            waiting
                .credit
                .transfer_to(&mut credit, ack_bytes)
                .expect("checked metadata allowance");
            self.unhanded.push(Unhanded {
                job,
                receipt: waiting.receipt.clone(),
                _credit: credit,
            });
        }
        waiting
            .credit
            .resize(bytes.capacity())
            .expect("checked encoded allowance");
        let delivery = Delivery {
            bytes,
            receipt: waiting.receipt,
            _credit: waiting.credit,
        };
        let _ = waiting.sender.send(delivery);
    }
}

fn reservation(limits: &Limits, request: &Request) -> Result<usize, Fault> {
    // push() can grow only to the next power of two of the admitted run count,
    // not twice the maximum when that maximum is already a power of two.
    let capacity = |runs: usize| {
        if runs == 0 {
            0
        } else {
            runs.next_power_of_two()
        }
    };
    let (input, runs, containers, sources, prefix_bytes) = if let Some(sources) = &request.sources {
        (
            sources
                .iter()
                .map(|source| source.text.capacity())
                .sum::<usize>(),
            sources
                .iter()
                .map(|source| source.text.len().min(limits.runs))
                .sum::<usize>(),
            sources
                .iter()
                .map(|source| capacity(source.text.len().min(limits.runs)))
                .sum::<usize>(),
            sources.len(),
            sources
                .iter()
                .map(|source| {
                    source
                        .text
                        .split_inclusive('\n')
                        .map(|line| line.len().min(limits.line_bytes))
                        .max()
                        .unwrap_or(0)
                })
                .sum::<usize>(),
        )
    } else if let Some(append) = &request.append {
        let runs = (append.len() + limits.line_bytes).min(limits.runs);
        (
            append.capacity() + limits.line_bytes,
            runs,
            capacity(runs),
            1,
            limits.line_bytes,
        )
    } else {
        return Ok(4096);
    };
    controlled_bytes(input, runs, containers, sources, prefix_bytes, limits)
}

fn controlled_bytes(
    input: usize,
    runs: usize,
    containers: usize,
    sources: usize,
    prefix_bytes: usize,
    limits: &Limits,
) -> Result<usize, Fault> {
    // Bounded tail copies, tables/maps and wire styles. Private Syntect captures
    // are a separate measured envelope, not inferred from these known payloads.
    // A batch's complete text is known: do not reserve a full 64 KiB tail for
    // every short-line source. Appends still allow the previous lease's prefix.
    let state = prefix_bytes * 26 + sources * (limits.styles * 128 + 4096);
    let structured = containers
        .checked_mul(std::mem::size_of::<crate::protocol::Run>())
        .ok_or(Fault::not_started("source_limit"))?;
    let encoded =
        (runs.saturating_mul(24) + sources * (limits.styles * 64 + 4096)).min(REPLY_BYTES);
    input
        .checked_add(state)
        .and_then(|n| n.checked_add(structured))
        .and_then(|n| n.checked_add(encoded))
        .ok_or(Fault::not_started("source_limit"))
}
fn deliver_error(instance: &str, mut waiting: Waiting, fault: Fault) {
    waiting.credit.started();
    // Rejected snapshots are controlled payloads too: destroy before releasing.
    drop(waiting.request.take());
    let bytes = Reply::<SourceBody>::error(&waiting.ticket, instance, fault)
        .encode()
        .expect("bounded error envelope");
    waiting
        .credit
        .resize(bytes.capacity())
        .expect("error shrinks reservation");
    let delivery = Delivery {
        bytes,
        receipt: waiting.receipt,
        _credit: waiting.credit,
    };
    let _ = waiting.sender.send(delivery);
}

#[cfg(test)]
mod allocation_tests {
    use super::*;

    #[test]
    fn large_source_facts_fit_the_controlled_ledger_without_allocating_sources() {
        let limits = Limits::default();
        let charge = |bytes: usize| {
            let runs = bytes.min(limits.runs);
            controlled_bytes(
                bytes,
                runs,
                runs.next_power_of_two(),
                1,
                limits.line_bytes,
                &limits,
            )
            .unwrap()
        };
        assert_eq!(charge(10 << 20), 281_154_688);
        assert_eq!(charge(32 << 20), 304_223_360);
        let decode = crate::request::REQUEST_BYTES * 4 + 4096;
        let total = charge(32 << 20) * 2 + decode;
        assert_eq!(total, 876_886_272);
        assert!(total < crate::limits::DATA_BYTES);
        // Full idle continuation occupancy competes for the same global bytes.
        assert!(total + crate::limits::STATE_BYTES > crate::limits::DATA_BYTES);
    }
}
