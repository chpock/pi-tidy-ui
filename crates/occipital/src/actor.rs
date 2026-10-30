//! Fixed owning threads around the same worker-local scheduler in both I/O modes.
//! Only owned requests and guarded encoded replies cross threads.
use crate::{
    credit::{Budget, Snapshot},
    ingress::{self, Incoming, Prepared, Rejection, CONTROL_RESERVATION},
    protocol::Fault,
    scheduler::{Scheduler, Submission, Ticket, Wake},
    semantic_engine::Limits,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
const ROUTES: usize = crate::limits::ROUTES;
const MESSAGES: usize = 2 * crate::limits::DATA_JOBS;
static POOL_INCARNATION: AtomicU64 = AtomicU64::new(1);
enum Message {
    Bind {
        scope: String,
        alive: Arc<AtomicBool>,
        ack: oneshot::Sender<Result<(), Fault>>,
    },
    Submit {
        scope: String,
        alive: Arc<AtomicBool>,
        submission: Box<Submission>,
    },
    Barrier(oneshot::Sender<()>),
    Wake,
}
struct Front {
    sender: SyncSender<Message>,
    leases: Arc<AtomicUsize>,
}
struct Worker {
    instance: String,
    limits: Limits,
    budget: Budget,
    born: Instant,
    stopped: Arc<AtomicBool>,
    receiver: Receiver<Message>,
    leases: Arc<AtomicUsize>,
}
struct Hub {
    fronts: Vec<Front>,
    registry: Mutex<HashMap<u64, usize>>,
    next: AtomicU64,
    stopped: Arc<AtomicBool>,
    instance: String,
    incarnation: u64,
    born: Instant,
    budget: Budget,
    controls: Budget,
    limits: Limits,
}
impl Hub {
    fn now(&self) -> u64 {
        elapsed(self.born)
    }
    fn wake(&self) {
        for front in &self.fronts {
            let _ = front.sender.try_send(Message::Wake);
        }
    }
}
struct ScopeOwner {
    hub: Weak<Hub>,
    id: u64,
    worker: usize,
    scope: String,
    alive: Arc<AtomicBool>,
}
impl ScopeOwner {
    fn close(&self) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Some(hub) = self.hub.upgrade() {
            hub.registry
                .lock()
                .expect("route registry poisoned")
                .remove(&self.id);
            let _ = hub.fronts[self.worker].sender.try_send(Message::Wake);
        }
    }
}
impl Drop for ScopeOwner {
    fn drop(&mut self) {
        self.close();
    }
}
#[derive(Clone)]
pub struct Route(Arc<ScopeOwner>);
impl Route {
    /// Explicit transport teardown retires authority even while handlers retain clones.
    pub fn close(&self) {
        self.0.close();
    }
    pub fn receive(&self, bytes: Vec<u8>) -> Result<Incoming, Rejection> {
        let hub = self.live().map_err(|fault| Rejection {
            ticket: ingress::routing_ticket(&bytes),
            fault,
        })?;
        let sender = hub.fronts[self.0.worker].sender.clone();
        let wake: Wake = Arc::new(move || {
            let _ = sender.try_send(Message::Wake);
        });
        match ingress::prepare(
            (&self.0.scope, &hub.instance),
            bytes,
            hub.now(),
            &hub.budget,
            &hub.controls,
            &hub.limits,
            Some(wake),
        )? {
            Prepared::Control(control) => Ok(Incoming::Control(Box::new(control))),
            Prepared::Data(submission, ticket) => {
                let correlation = submission.ticket_id().to_owned();
                self.dispatch(&hub, submission, ticket)
                    .map(Incoming::Data)
                    .map_err(|fault| Rejection {
                        ticket: Some(correlation),
                        fault,
                    })
            }
        }
    }
    fn live(&self) -> Result<Arc<Hub>, Fault> {
        let hub = self
            .0
            .hub
            .upgrade()
            .ok_or(Fault::not_started("scope_gone"))?;
        if hub.stopped.load(Ordering::Acquire) || !self.0.alive.load(Ordering::Acquire) {
            return Err(Fault::not_started("scope_gone"));
        }
        Ok(hub)
    }
    pub fn submit(&self, bytes: Vec<u8>) -> Result<Ticket, Fault> {
        let hub = self
            .0
            .hub
            .upgrade()
            .ok_or(Fault::not_started("scope_gone"))?;
        if hub.stopped.load(Ordering::Acquire) || !self.0.alive.load(Ordering::Acquire) {
            return Err(Fault::not_started("scope_gone"));
        }
        let sender = hub.fronts[self.0.worker].sender.clone();
        let wake: Wake = Arc::new(move || {
            let _ = sender.try_send(Message::Wake);
        });
        let (submission, ticket) = Submission::decode(
            &self.0.scope,
            bytes,
            hub.now(),
            &hub.budget,
            &hub.limits,
            &hub.instance,
            Some(wake),
        )?;
        self.dispatch(&hub, submission, ticket)
    }
    fn dispatch(&self, hub: &Hub, submission: Submission, ticket: Ticket) -> Result<Ticket, Fault> {
        let message = Message::Submit {
            scope: self.0.scope.clone(),
            alive: self.0.alive.clone(),
            submission: Box::new(submission),
        };
        match hub.fronts[self.0.worker].sender.try_send(message) {
            Ok(()) => Ok(ticket),
            Err(TrySendError::Full(Message::Submit { submission, .. })) => {
                submission.reject(&hub.instance, Fault::not_started("busy"));
                Ok(ticket)
            }
            Err(_) => Err(Fault::not_started("worker_gone")),
        }
    }
}
struct Completion {
    done: oneshot::Receiver<()>,
    join: JoinHandle<()>,
}
pub struct ActorPool {
    hub: Arc<Hub>,
    completions: Vec<Completion>,
}
#[derive(Clone, Copy, Debug)]
pub struct PoolStats {
    pub credits: Snapshot,
    pub control_credits: Snapshot,
    pub workers: usize,
    pub routes: usize,
    pub leases: usize,
}
impl ActorPool {
    pub fn new(instance: String, workers: usize) -> Result<Self, Fault> {
        Self::with_limits(instance, workers, Limits::default())
    }
    pub fn with_limits(
        instance: String,
        workers: usize,
        mut limits: Limits,
    ) -> Result<Self, Fault> {
        if workers == 0
            || workers > 2
            || instance.is_empty()
            || instance.len() > 64
            || instance.chars().any(char::is_control)
        {
            return Err(Fault::not_started("invalid_runtime"));
        }
        // Immutable assets are process-shared; per-worker state quotas sum to the
        // process lease/state maxima. Direct mode selects one, managed at most two.
        limits.leases /= workers;
        limits.state_pool_bytes /= workers;
        let incarnation = POOL_INCARNATION
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| Fault::not_started("runtime_limit"))?;
        let budget = Budget::new(
            crate::limits::DATA_BYTES,
            crate::limits::DATA_JOBS,
            crate::limits::DATA_PER_ROUTE,
        );
        let stopped = Arc::new(AtomicBool::new(false));
        // Finite trusted scope handles are startup assets, never caller names.
        crate::vocabulary::ScopeId::from_raw(1)
            .expect("nonempty generated vocabulary")
            .scope();
        let born = Instant::now();
        let mut fronts: Vec<Front> = Vec::new();
        let mut completions = Vec::new();
        for index in 0..workers {
            let (sender, receiver) = mpsc::sync_channel(MESSAGES);
            let (done_tx, done) = oneshot::channel();
            let leases = Arc::new(AtomicUsize::new(0));
            let observed = leases.clone();
            let stop = stopped.clone();
            let worker_budget = budget.clone();
            let worker_instance = instance.clone();
            let worker_limits = limits.clone();
            let join = match thread::Builder::new()
                .name(format!("occipital-worker-{index}"))
                .spawn(move || {
                    run(Worker {
                        instance: worker_instance,
                        limits: worker_limits,
                        budget: worker_budget,
                        born,
                        stopped: stop,
                        receiver,
                        leases: observed,
                    });
                    let _ = done_tx.send(());
                }) {
                Ok(join) => join,
                Err(_) => {
                    stopped.store(true, Ordering::Release);
                    for front in &fronts {
                        let _ = front.sender.try_send(Message::Wake);
                    }
                    return Err(Fault::not_started("worker_unavailable"));
                }
            };
            fronts.push(Front { sender, leases });
            completions.push(Completion { done, join });
        }
        Ok(Self {
            hub: Arc::new(Hub {
                fronts,
                registry: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
                stopped,
                instance,
                incarnation,
                born,
                budget,
                controls: Budget::new(ROUTES * CONTROL_RESERVATION, ROUTES, 1),
                limits,
            }),
            completions,
        })
    }
    /// A transport handle never owns worker completion/join authority.
    pub fn handle(&self) -> PoolHandle {
        PoolHandle(Arc::downgrade(&self.hub))
    }
    pub async fn bind(&self) -> Result<Route, Fault> {
        self.hub.bind().await
    }
    pub fn stats(&self) -> PoolStats {
        self.hub.stats()
    }
    /// Test/integration control boundary. Ordinary status reads use stats(), not jobs.
    pub async fn barrier(&self) -> Result<(), Fault> {
        for front in &self.hub.fronts {
            let (ack, reply) = oneshot::channel();
            front
                .sender
                .try_send(Message::Barrier(ack))
                .map_err(|_| Fault::not_started("worker_gone"))?;
            reply.await.map_err(|_| Fault::not_started("worker_gone"))?;
        }
        Ok(())
    }
    /// Cooperative native shutdown. An in-progress regex is not interruptible;
    /// the owned-process controller applies its separate finite kill/reap boundary.
    pub async fn shutdown(mut self) -> Result<(), Fault> {
        self.hub.stopped.store(true, Ordering::Release);
        self.hub.wake();
        let completions = std::mem::take(&mut self.completions);
        let mut failed = false;
        for completion in completions {
            failed |= completion.done.await.is_err();
            failed |= completion.join.join().is_err();
        }
        if failed {
            Err(Fault::not_started("worker_gone"))
        } else {
            Ok(())
        }
    }
}
impl Drop for ActorPool {
    fn drop(&mut self) {
        self.hub.stopped.store(true, Ordering::Release);
        self.hub.wake();
    }
}
fn elapsed(born: Instant) -> u64 {
    born.elapsed().as_millis().min(u64::MAX as u128) as u64
}
fn prune(scopes: &mut HashMap<String, Arc<AtomicBool>>, scheduler: &mut Scheduler) {
    scopes.retain(|scope, alive| {
        if alive.load(Ordering::Acquire) {
            true
        } else {
            scheduler.close(scope);
            false
        }
    });
}
fn run(worker: Worker) {
    let Worker {
        instance,
        limits,
        budget,
        born,
        stopped,
        receiver,
        leases,
    } = worker;

    // Construction, mutation and destruction of every !Send Work occur here.
    let mut scheduler = Scheduler::new(instance.clone(), limits, budget);
    let mut scopes: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    loop {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        prune(&mut scopes, &mut scheduler);
        if stopped.load(Ordering::Acquire) {
            break;
        }
        scheduler.tick(elapsed(born));
        leases.store(scheduler.leases(), Ordering::Release);
        let message = if scheduler.has_work() {
            match receiver.try_recv() {
                Ok(message) => Some(message),
                Err(mpsc::TryRecvError::Empty) => None,
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        } else if let Some(deadline) = scheduler.next_expiry() {
            match receiver.recv_timeout(Duration::from_millis(
                deadline.saturating_sub(elapsed(born)),
            )) {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match receiver.recv() {
                Ok(message) => Some(message),
                Err(_) => break,
            }
        };
        match message {
            Some(Message::Bind { scope, alive, ack }) => {
                let result = if alive.load(Ordering::Acquire) {
                    scheduler.bind(&scope)
                } else {
                    Err(Fault::not_started("scope_gone"))
                };
                if result.is_ok() {
                    scopes.insert(scope, alive);
                }
                let _ = ack.send(result);
            }
            Some(Message::Submit {
                scope,
                alive,
                submission,
            }) => {
                if alive.load(Ordering::Acquire) && scopes.contains_key(&scope) {
                    scheduler.accept(&scope, *submission);
                } else {
                    submission.reject(&instance, Fault::not_started("scope_gone"));
                }
            }
            Some(Message::Barrier(ack)) => {
                prune(&mut scopes, &mut scheduler);
                scheduler.tick(elapsed(born));
                leases.store(scheduler.leases(), Ordering::Release);
                let _ = ack.send(());
            }
            Some(Message::Wake) | None => {}
        }
    }
    for scope in scopes.keys() {
        scheduler.close(scope);
    }
    // Reject already-credited requests instead of retaining them in a dead mailbox.
    while let Ok(message) = receiver.try_recv() {
        if let Message::Submit { submission, .. } = message {
            submission.reject(&instance, Fault::not_started("scope_gone"));
        }
    }
    leases.store(0, Ordering::Release);
}

/// Serve callbacks may outlive their connection. They retain only a weak facade,
/// so the one main owner can always stop/join its pool on normal or error exits.
#[derive(Clone)]
pub struct PoolHandle(Weak<Hub>);
impl PoolHandle {
    fn live(&self) -> Result<Arc<Hub>, Fault> {
        let hub = self.0.upgrade().ok_or(Fault::not_started("scope_gone"))?;
        if hub.stopped.load(Ordering::Acquire) {
            return Err(Fault::not_started("scope_gone"));
        }
        Ok(hub)
    }
    pub async fn bind(&self) -> Result<Route, Fault> {
        self.live()?.bind().await
    }
    pub fn stats(&self) -> Result<PoolStats, Fault> {
        Ok(self.live()?.stats())
    }
}
impl Hub {
    async fn bind(self: &Arc<Self>) -> Result<Route, Fault> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(Fault::not_started("scope_gone"));
        }
        let id = self
            .next
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| Fault::not_started("route_limit"))?;
        let worker = {
            let mut registry = self.registry.lock().expect("route registry poisoned");
            if registry.len() >= ROUTES {
                return Err(Fault::not_started("route_limit"));
            }
            let worker = (0..self.fronts.len())
                .min_by_key(|index| registry.values().filter(|value| *value == index).count())
                .expect("nonempty worker set");
            registry.insert(id, worker);
            worker
        };
        let alive = Arc::new(AtomicBool::new(true));
        let scope = format!("{:x}-{:x}", self.incarnation, id);
        let owner = Arc::new(ScopeOwner {
            hub: Arc::downgrade(self),
            id,
            worker,
            scope: scope.clone(),
            alive: alive.clone(),
        });
        let (ack, reply) = oneshot::channel();
        self.fronts[worker]
            .sender
            .try_send(Message::Bind { scope, alive, ack })
            .map_err(|_| Fault::not_started("worker_gone"))?;
        reply
            .await
            .map_err(|_| Fault::not_started("worker_gone"))??;
        if self.stopped.load(Ordering::Acquire) {
            return Err(Fault::not_started("scope_gone"));
        }
        Ok(Route(owner))
    }
    fn stats(&self) -> PoolStats {
        PoolStats {
            credits: self.budget.snapshot(),
            control_credits: self.controls.snapshot(),
            workers: self.fronts.len(),
            routes: self.registry.lock().expect("route registry poisoned").len(),
            leases: self
                .fronts
                .iter()
                .map(|front| front.leases.load(Ordering::Acquire))
                .sum(),
        }
    }
}
