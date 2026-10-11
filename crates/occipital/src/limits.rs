//! Coupled emergency guards, not ordinary-use ceilings inferred from examples.
//! Controlled bytes exclude SDK pre-handler buffering and private parser heaps.
pub const WIRE_BYTES: usize = 64 << 20;
pub const SOURCE_BYTES: usize = WIRE_BYTES;
pub const PATH_HINT_BYTES: usize = 4096;
// A positive length/style pair needs at least four JSON bytes. The exact writer
// also counts brackets, metadata, escapes and longer decimal values.
pub const RUNS: usize = WIRE_BYTES / 4;
// Admitted foregrounds + default, each with three font bits, plus neutral Plain.
pub const STYLES: usize = (crate::profile::THEME_SELECTORS + 1) * 8 + 1;
pub const DATA_BYTES: usize = 1 << 30;
pub const STATE_BYTES: usize = 256 << 20;
pub const ROUTES: usize = 8;
pub const DATA_PER_ROUTE: usize = 2;
pub const DATA_JOBS: usize = ROUTES * DATA_PER_ROUTE;
pub const LEASES: usize = 4096;
pub const LEASES_PER_ROUTE: usize = LEASES / ROUTES;
pub const IDLE_MS: u64 = 300_000;
pub const AGE_MS: u64 = 3_600_000;
