//! Shared runtime observations without pool or reservation ownership.
#[derive(Clone, Copy, Debug, Default)]
pub struct Snapshot {
    pub bytes: usize,
    pub jobs: usize,
    pub peak_bytes: usize,
    pub peak_jobs: usize,
    pub queued: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct PoolStats {
    pub credits: Snapshot,
    pub control_credits: Snapshot,
    pub workers: usize,
    pub routes: usize,
    pub leases: usize,
}
