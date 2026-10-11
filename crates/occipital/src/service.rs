//! Worker-local source authority. The actor owns scheduling, credits and transports.
//! Opaque lease keys never identify a reusable client key or another route's state.
use crate::{
    engine::{Engine, Limits, Work},
    profile::Profile,
    protocol::Fault,
    reply::{SourceBody, SourceReply},
    request::{Operation, Request, Source},
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

// Worker replacement and two actors within one provider must not reuse lease IDs.
static SERVICE_INCARNATION: AtomicU64 = AtomicU64::new(0);

pub enum Action {
    Immediate(SourceBody),
    Job(Job),
}
struct Binding {
    key: String,
    generation: u32,
    profile: String,
    fingerprint: String,
    source_version: u32,
}
struct Pending {
    key: String,
    generation: u32,
    source_version: u32,
    lease: Option<String>,
    complete: bool,
    work: Work,
}
pub struct Job {
    scope: String,
    pending: VecDeque<Pending>,
    ready: Vec<SourceReply>,
    affected_leases: Vec<String>,
    started: bool,
    done: bool,
}
impl Job {
    pub fn started(&self) -> bool {
        self.started || self.pending.iter().any(|pending| pending.work.started())
    }
    pub(crate) fn in_scope(&self, scope: &str) -> bool {
        self.scope == scope
    }
    pub(crate) fn owns_lease(&self, scope: &str, lease: &str) -> bool {
        self.scope == scope && self.affected_leases.iter().any(|value| value == lease)
    }
    pub(crate) fn trim_completed(&mut self) {
        debug_assert!(self.done && self.pending.is_empty() && self.ready.is_empty());
        self.pending = VecDeque::new();
        self.ready = Vec::new();
    }
    pub(crate) fn acknowledgement_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.scope.capacity()
            + self.affected_leases.capacity() * std::mem::size_of::<String>()
            + self
                .affected_leases
                .iter()
                .map(String::capacity)
                .sum::<usize>()
    }
    pub fn input_bytes(&self) -> usize {
        self.pending
            .iter()
            .map(|pending| pending.work.retained_input_bytes())
            .sum()
    }
}
pub struct Service {
    engine: Engine,
    instance: String,
    scopes: HashSet<String>,
    bindings: HashMap<(String, String), Binding>,
    next_lease: u64,
    incarnation: u64,
}
impl Service {
    pub fn new(limits: Limits, instance: String) -> Self {
        Self {
            engine: Engine::new(limits),
            instance,
            scopes: HashSet::new(),
            bindings: HashMap::new(),
            next_lease: 0,
            incarnation: SERVICE_INCARNATION
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(1)
                })
                .expect("service incarnation exhausted"),
        }
    }
    pub fn bind(&mut self, scope: &str) -> Result<(), Fault> {
        if scope.is_empty() || scope.len() > 64 {
            return Err(Fault::not_started("invalid_scope"));
        }
        if !self.scopes.contains(scope) && self.scopes.len() >= 8 {
            return Err(Fault::not_started("route_limit"));
        }
        self.scopes.insert(scope.into());
        Ok(())
    }
    pub fn close_scope(&mut self, scope: &str) {
        self.scopes.remove(scope);
        self.engine.close_scope(scope);
        self.bindings.retain(|(owner, _), _| owner != scope);
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
    pub fn known_state_bytes(&self) -> usize {
        self.engine.retained_state_bytes()
    }
    pub(crate) fn known_idle_state_bytes(&self) -> usize {
        self.engine.retained_idle_state_bytes()
            + self
                .bindings
                .iter()
                .filter(|((scope, lease), _)| self.engine.is_idle(scope, lease))
                .map(|((scope, lease), binding)| {
                    std::mem::size_of::<Binding>()
                        + std::mem::size_of::<(String, String)>()
                        + scope.capacity()
                        + lease.capacity()
                        + binding.key.capacity()
                        + binding.profile.capacity()
                        + binding.fingerprint.capacity()
                })
                .sum::<usize>()
    }
    fn prune(&mut self) {
        self.bindings
            .retain(|(scope, lease), _| self.engine.contains(scope, lease));
    }
    pub fn replace_profiles(&mut self, profiles: Vec<Arc<Profile>>) -> Result<(), Fault> {
        self.engine.replace_profiles(profiles)?;
        let engine = &mut self.engine;
        self.bindings.retain(|(scope, lease), binding| {
            let valid = engine
                .profile(&binding.profile)
                .is_ok_and(|profile| profile.fingerprint == binding.fingerprint);
            if !valid {
                engine.close(scope, lease);
            }
            valid
        });
        Ok(())
    }
    fn check_profile(&self, profile: &str, fingerprint: &str) -> Result<(), Fault> {
        let current = self
            .engine
            .profile(profile)
            .map_err(|_| Fault::not_started("theme_unavailable"))?;
        if current.fingerprint != fingerprint {
            return Err(Fault::not_started("profile_changed"));
        }
        Ok(())
    }
    fn lease(&mut self) -> Result<String, Fault> {
        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or(Fault::not_started("session_limit"))?;
        Ok(format!(
            "{:x}",
            Sha256::digest(
                format!("{}:{}:{}", self.instance, self.incarnation, self.next_lease).as_bytes()
            )
        ))
    }
    /// Invoke only at the entitled fair turn, after aggregate admission. Source
    /// preparation validates the whole batch before any Work is stepped.
    pub fn start(&mut self, scope: &str, mut request: Request) -> Result<Action, Fault> {
        request.validate()?;
        if !self.scopes.contains(scope) {
            return Err(Fault::not_started("scope_gone"));
        }
        if request.instance.as_deref() != Some(&self.instance) {
            return Err(Fault::not_started("restart_required"));
        }
        self.prune();
        let mut pending = VecDeque::new();
        match request.op {
            Operation::Highlight | Operation::StreamOpen => {
                let sources = request
                    .sources
                    .take()
                    .ok_or(Fault::not_started("invalid_request"))?;
                for source in &sources {
                    self.check_profile(&source.profile, &source.fingerprint)?;
                }
                for source in sources {
                    let Source {
                        key,
                        generation,
                        source_version,
                        profile,
                        fingerprint,
                        hint,
                        text,
                    } = source;
                    let (lease, work) = if request.op == Operation::StreamOpen {
                        let lease = self.lease()?;
                        let work = self
                            .engine
                            .begin_open(scope, &lease, text, &hint, &profile)?;
                        self.bindings.insert(
                            (scope.into(), lease.clone()),
                            Binding {
                                key: key.clone(),
                                generation,
                                profile,
                                fingerprint,
                                source_version,
                            },
                        );
                        (Some(lease), work)
                    } else {
                        (None, self.engine.begin_one_shot(text, &hint, &profile)?)
                    };
                    pending.push_back(Pending {
                        key,
                        generation,
                        source_version,
                        lease,
                        complete: request.op == Operation::Highlight,
                        work,
                    });
                }
            }
            Operation::StreamAppend => {
                let key = request
                    .key
                    .take()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let lease = request
                    .lease
                    .take()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let generation = request
                    .generation
                    .ok_or(Fault::not_started("invalid_request"))?;
                let source_version = request
                    .source_version
                    .ok_or(Fault::not_started("invalid_request"))?;
                let profile = request
                    .profile
                    .as_deref()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let fingerprint = request
                    .fingerprint
                    .as_deref()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let Some(binding) = self.bindings.get(&(scope.into(), lease.clone())) else {
                    return Err(Fault::not_started("restart_required"));
                };
                if binding.key != key || binding.generation != generation {
                    return Err(Fault::not_started("restart_required"));
                }
                self.check_profile(profile, fingerprint)?;
                if binding.profile != profile || binding.fingerprint != fingerprint {
                    return Err(Fault::not_started("profile_changed"));
                }
                if source_version < binding.source_version {
                    return Err(Fault::not_started("restart_required"));
                }
                let complete = request
                    .finalize
                    .ok_or(Fault::not_started("invalid_request"))?;
                let work = self.engine.begin_append(
                    scope,
                    &lease,
                    request
                        .base_revision
                        .ok_or(Fault::not_started("invalid_request"))?,
                    request
                        .base_bytes
                        .ok_or(Fault::not_started("invalid_request"))?,
                    request
                        .append
                        .take()
                        .ok_or(Fault::not_started("invalid_request"))?,
                    complete,
                )?;
                pending.push_back(Pending {
                    key,
                    generation,
                    source_version,
                    lease: Some(lease),
                    complete,
                    work,
                });
            }
            Operation::StreamClose => {
                let key = request
                    .key
                    .as_deref()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let lease = request
                    .lease
                    .as_deref()
                    .ok_or(Fault::not_started("invalid_request"))?;
                let id = (scope.into(), lease.into());
                if self.bindings.get(&id).is_some_and(|binding| {
                    binding.key == key && Some(binding.generation) == request.generation
                }) {
                    self.engine.close(scope, lease);
                    self.bindings.remove(&id);
                }
                return Ok(Action::Immediate(SourceBody::Closed));
            }
            Operation::Describe | Operation::ThemesRefresh => {
                return Err(Fault::not_started("invalid_request"))
            }
        }
        Ok(Action::Job(Job {
            scope: scope.into(),
            affected_leases: pending
                .iter()
                .filter_map(|pending| pending.lease.clone())
                .collect(),
            pending,
            ready: Vec::new(),
            started: false,
            done: false,
        }))
    }
    /// One worker-local quantum; no network wait, cross-thread parser or full-source cache.
    pub fn step(&mut self, job: &mut Job) -> Result<Option<SourceBody>, Fault> {
        if job.done {
            return Err(Fault::not_started("job_complete"));
        }
        if !self.scopes.contains(&job.scope) {
            return Err(Fault {
                code: "scope_gone",
                started: job.started(),
            });
        }
        let Some(pending) = job.pending.front_mut() else {
            return Err(Fault {
                code: "invalid_request",
                started: job.started(),
            });
        };
        let ready = match self.engine.step(&mut pending.work) {
            Ok(ready) => ready,
            Err(mut fault) => {
                fault.started |= job.started();
                return Err(fault);
            }
        };
        job.started |= pending.work.started();
        if !ready {
            return Ok(None);
        }
        let Pending {
            key,
            generation,
            source_version,
            lease,
            complete,
            work,
        } = job.pending.pop_front().expect("front was validated");
        let chunk = self.engine.finish(work).map_err(|mut fault| {
            fault.started |= job.started;
            fault
        })?;
        if let Some(lease) = &lease {
            let id = (job.scope.clone(), lease.clone());
            if complete {
                self.bindings.remove(&id);
            } else if let Some(binding) = self.bindings.get_mut(&id) {
                binding.source_version = source_version;
            }
        }
        job.ready.push(SourceReply {
            key,
            generation,
            source_version,
            lease,
            complete,
            chunk,
        });
        if job.pending.is_empty() {
            job.done = true;
            Ok(Some(SourceBody::Source {
                sources: std::mem::take(&mut job.ready),
            }))
        } else {
            Ok(None)
        }
    }
    pub fn discard(&mut self, job: Job) {
        // Completion is not transport handoff. Retain only finite authority metadata
        // until handoff so cancelling an already-ready reply still closes its lease.
        for lease in job.affected_leases {
            self.engine.close(&job.scope, &lease);
            self.bindings.remove(&(job.scope.clone(), lease));
        }
        for pending in job.pending {
            self.engine.discard(pending.work);
            if let Some(lease) = pending.lease {
                self.bindings.remove(&(job.scope.clone(), lease));
            }
        }
        self.prune();
    }
}
