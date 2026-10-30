//! Highlighting volume policy and separate emergency/resource guards.
//! Controlled bytes exclude SDK pre-handler buffering and private parser heaps.
pub const SOURCE_BYTES: usize = 64 << 10;
pub const SOURCE_LINES: usize = 8192;
pub const PI_SOURCE_BYTES: usize = 8 << 10;
pub const DATA_WIRE_BYTES: usize = 512 << 10;
pub const CONTEXT_WORDS: usize = 65536;
pub const DECODED_BYTES: usize = 2 << 20;

pub const RULE_SELECTORS: usize = 512;
pub const RULE_PATHS: usize = 4096;
pub const RULE_ATOMS: usize = 4096;
pub const RULE_NAME_BYTES: usize = 256 << 10;

pub const WIRE_BYTES: usize = 64 << 20;
pub const PATH_HINT_BYTES: usize = 4096;
// A positive length/style pair needs at least four JSON bytes. The exact writer
// also counts brackets, metadata, escapes and longer decimal values.
pub const RUNS: usize = DATA_WIRE_BYTES / 4;
// Admitted foregrounds + default, each with three font bits, plus neutral Plain.
pub const STYLES: usize = (RULE_SELECTORS + 1) * 8 + 1;
pub const DATA_BYTES: usize = 1 << 30;
pub const STATE_BYTES: usize = 256 << 20;
pub const ROUTES: usize = 8;
pub const DATA_PER_ROUTE: usize = 2;
pub const DATA_JOBS: usize = ROUTES * DATA_PER_ROUTE;
pub const LEASES: usize = 4096;
pub const LEASES_PER_ROUTE: usize = LEASES / ROUTES;
pub const IDLE_MS: u64 = 300_000;
pub const AGE_MS: u64 = 3_600_000;

// Existing decoded semantic policy units, not native allocation/RSS estimates.
pub(crate) const CONTEXT_ROW_UNITS: usize = 128;
pub(crate) const CONTEXT_WORD_UNITS: usize = 16;
pub(crate) const SOURCE_UNITS: usize = 512;
pub(crate) const SOURCE_BODY_UNITS: usize = 32 + 2 * 64;
pub(crate) const STYLE_UNITS: usize = 256;

/// LF terminates a logical line; a terminal LF creates no phantom empty tail.
pub(crate) fn source_lines(text: &str) -> usize {
    text.bytes().filter(|&b| b == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'))
}
