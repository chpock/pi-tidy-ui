//! Process-lifetime catalogue publication and bounded source-free negotiation.
//! Source work remains on the fixed worker actors; only explicit refresh reads files.
use crate::{
    actor::PoolHandle,
    catalogue::{Catalogue, Descriptor, Diagnostic, Snapshot},
    engine::Limits,
    ingress::{Control, ControlDelivery, CONTROL_REPLY_BYTES, CONTROL_REQUEST_BYTES},
    protocol::{Fault, ASSETS, CAPABILITY, PROTOCOL_VERSION, SERVICE},
    reply::REPLY_BYTES,
    request::{Operation, BATCH_SOURCES, QUEUE_WAIT_MS, REQUEST_BYTES},
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct Published {
    snapshot: Arc<Snapshot>,
    diagnostic: Option<Diagnostic>,
}
pub struct Authority {
    pool: PoolHandle,
    instance: String,
    limits: Limits,
    alive: AtomicBool,
    published: Mutex<Published>,
    catalogue: Arc<Mutex<Catalogue>>,
    refresh: tokio::sync::Mutex<()>,
}
impl Authority {
    pub fn new(
        pool: PoolHandle,
        instance: String,
        limits: Limits,
        catalogue: Catalogue,
    ) -> Result<Self, Fault> {
        let snapshot = catalogue.snapshot();
        pool.replace_profiles(snapshot.custom_profiles())?;
        let diagnostic = catalogue.diagnostic();
        Ok(Self {
            pool,
            instance,
            limits,
            alive: AtomicBool::new(true),
            published: Mutex::new(Published {
                snapshot,
                diagnostic,
            }),
            catalogue: Arc::new(Mutex::new(catalogue)),
            refresh: tokio::sync::Mutex::new(()),
        })
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
        if control.request().op == Operation::ThemesRefresh {
            // Admission already bounds this queue to eight held route controls.
            let _serial = self.refresh.lock().await;
            if !self.is_alive() {
                return control.error(&self.instance, Fault::not_started("scope_gone"));
            }
            let catalogue = Arc::clone(&self.catalogue);
            let candidate = tokio::task::spawn_blocking(move || {
                let mut catalogue = catalogue.lock().expect("catalogue poisoned");
                let _ = catalogue.refresh();
                (catalogue.snapshot(), catalogue.diagnostic())
            })
            .await;
            if !self.is_alive() {
                return control.error(&self.instance, Fault::not_started("scope_gone"));
            }
            let (snapshot, diagnostic) = match candidate {
                Ok(value) => value,
                Err(_) => {
                    return control.error(&self.instance, Fault::not_started("control_failed"))
                }
            };
            let mut published = self.published.lock().expect("publication poisoned");
            if snapshot.revision() != published.snapshot.revision() {
                self.pool.replace_profiles(snapshot.custom_profiles())?;
            }
            *published = Published {
                snapshot,
                diagnostic,
            };
        } else if control.request().op != Operation::Describe {
            return control.error(&self.instance, Fault::not_started("invalid_request"));
        }
        let stats = self.pool.stats()?;
        let published = self.published.lock().expect("publication poisoned");
        let profiles: Vec<&Descriptor> = published.snapshot.descriptors().collect();
        control.reply(
            &self.instance,
            Description {
                kind: "descriptor",
                backend_version: env!("CARGO_PKG_VERSION"),
                protocol_version: PROTOCOL_VERSION,
                category_version: 1,
                assets: ASSETS,
                capability: CAPABILITY,
                service: SERVICE,
                operations: &[
                    "describe",
                    "themes.refresh",
                    "highlight",
                    "stream.open",
                    "stream.append",
                    "stream.close",
                ],
                modes: &["one_shot", "growing"],
                admission: &["try_now", "bounded_queue"],
                catalogue_revision: published.snapshot.revision(),
                profiles,
                diagnostic: published.diagnostic.map(|value| value.to_string()),
                runtime: RuntimeStatus {
                    pid: std::process::id(),
                    routes: stats.routes,
                    leases: stats.leases,
                    data_bytes: stats.credits.bytes,
                    data_jobs: stats.credits.jobs,
                    queued: stats.credits.queued,
                    control_bytes: stats.control_credits.bytes,
                    control_jobs: stats.control_credits.jobs,
                },
                limits: WireLimits {
                    request_bytes: REQUEST_BYTES,
                    reply_bytes: REPLY_BYTES,
                    control_request_bytes: CONTROL_REQUEST_BYTES,
                    control_reply_bytes: CONTROL_REPLY_BYTES,
                    source_bytes: self.limits.source_bytes,
                    line_bytes: self.limits.line_bytes,
                    batch_sources: BATCH_SOURCES,
                    queue_wait_ms: QUEUE_WAIT_MS,
                    state_pool_bytes: self.limits.state_pool_bytes,
                    leases: self.limits.leases,
                    leases_per_route: self.limits.per_scope,
                    runs: self.limits.runs,
                    styles: self.limits.styles,
                    idle_ms: self.limits.idle_ms,
                    age_ms: self.limits.age_ms,
                    quantum_ms: self.limits.quantum_ms,
                    data_per_route: 2,
                    control_per_route: 1,
                    routes: 8,
                    workers: stats.workers,
                },
            },
        )
    }
}
#[derive(Serialize)]
struct Description<'a> {
    kind: &'static str,
    backend_version: &'static str,
    protocol_version: u32,
    category_version: u32,
    assets: &'static str,
    capability: &'static str,
    service: &'static str,
    operations: &'static [&'static str],
    modes: &'static [&'static str],
    admission: &'static [&'static str],
    catalogue_revision: u64,
    profiles: Vec<&'a Descriptor>,
    diagnostic: Option<String>,
    runtime: RuntimeStatus,
    limits: WireLimits,
}
/// Current application reservations only, not process RSS or private SDK buffers.
#[derive(Serialize)]
struct RuntimeStatus {
    pid: u32,
    routes: usize,
    leases: usize,
    data_bytes: usize,
    data_jobs: usize,
    queued: usize,
    control_bytes: usize,
    control_jobs: usize,
}
#[derive(Serialize)]
struct WireLimits {
    request_bytes: usize,
    reply_bytes: usize,
    control_request_bytes: usize,
    control_reply_bytes: usize,
    source_bytes: usize,
    line_bytes: usize,
    batch_sources: usize,
    queue_wait_ms: u32,
    state_pool_bytes: usize,
    leases: usize,
    leases_per_route: usize,
    runs: usize,
    styles: usize,
    idle_ms: u64,
    age_ms: u64,
    quantum_ms: u64,
    data_per_route: usize,
    control_per_route: usize,
    routes: usize,
    workers: usize,
}
