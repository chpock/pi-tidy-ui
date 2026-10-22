//! Source-free v3 negotiation. Neither palette derivation nor scope matching runs here.
use crate::{
    actor::PoolStats,
    catalogue::{Descriptor, Diagnostic, Snapshot},
    ingress::{CONTROL_REPLY_BYTES, CONTROL_REQUEST_BYTES},
    limits,
    request::{BATCH_SOURCES, QUEUE_WAIT_MS},
    semantic::{CAPABILITY, PROTOCOL_VERSION},
    semantic_engine::Limits,
    vocabulary,
};
use serde::Serialize;

pub const OPERATIONS: &[&str] = &[
    "describe",
    "themes.refresh",
    "highlight",
    "stream.open",
    "stream.append",
    "stream.close",
    "styles.resolve",
];

#[derive(Serialize)]
pub struct Description<'a> {
    kind: &'static str,
    protocol_version: u32,
    contexts_revision: u32,
    resolver_revision: u32,
    palette_revision: u32,
    vocabulary: Vocabulary,
    assets: &'static str,
    backend_version: &'static str,
    catalogue_revision: u64,
    capability: &'static str,
    service: &'static str,
    operations: &'static [&'static str],
    modes: &'static [&'static str],
    admission: &'static [&'static str],
    profiles: Vec<&'a Descriptor>,
    diagnostic: Option<String>,
    limits: WireLimits,
    runtime: RuntimeStatus,
}
#[derive(Serialize)]
struct Vocabulary {
    fingerprint: &'static str,
    count: usize,
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
    idle_ms: u64,
    age_ms: u64,
    quantum_ms: u64,
    data_per_route: usize,
    control_per_route: usize,
    routes: usize,
    workers: usize,
}
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

pub fn describe<'a>(
    snapshot: &'a Snapshot,
    diagnostic: Option<Diagnostic>,
    limits: &Limits,
    stats: PoolStats,
) -> Description<'a> {
    Description {
        kind: "descriptor",
        protocol_version: PROTOCOL_VERSION,
        contexts_revision: 1,
        resolver_revision: 2,
        palette_revision: 1,
        vocabulary: Vocabulary {
            fingerprint: vocabulary::FINGERPRINT,
            count: vocabulary::SCOPE_COUNT,
        },
        assets: vocabulary::ASSET_FINGERPRINT,
        backend_version: env!("CARGO_PKG_VERSION"),
        catalogue_revision: snapshot.revision(),
        capability: CAPABILITY,
        service: "syntax",
        operations: OPERATIONS,
        modes: &["one_shot", "growing"],
        admission: &["try_now", "bounded_queue"],
        profiles: snapshot.descriptors().collect(),
        diagnostic: diagnostic.map(|diagnostic| diagnostic.to_string()),
        limits: WireLimits {
            request_bytes: limits::DATA_WIRE_BYTES,
            reply_bytes: limits::DATA_WIRE_BYTES,
            control_request_bytes: CONTROL_REQUEST_BYTES,
            control_reply_bytes: CONTROL_REPLY_BYTES,
            source_bytes: limits.source_bytes.min(limits::SOURCE_BYTES),
            line_bytes: limits.line_bytes,
            batch_sources: BATCH_SOURCES,
            queue_wait_ms: QUEUE_WAIT_MS,
            state_pool_bytes: limits.state_pool_bytes,
            leases: limits.leases,
            leases_per_route: limits.per_scope,
            runs: limits.runs,
            idle_ms: limits.idle_ms,
            age_ms: limits.age_ms,
            quantum_ms: limits.quantum_ms,
            data_per_route: limits::DATA_PER_ROUTE,
            control_per_route: 1,
            routes: limits::ROUTES,
            workers: stats.workers,
        },
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
    }
}
