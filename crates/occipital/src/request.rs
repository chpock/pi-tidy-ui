//! Shared transport and source admission bounds.
pub const REQUEST_BYTES: usize = crate::limits::WIRE_BYTES;
pub const SOURCE_BYTES: usize = crate::limits::SOURCE_BYTES;
/// Classified prefix of each line; longer source text is still admitted.
pub const LINE_BYTES: usize = 64 * 1024;
pub const BATCH_SOURCES: usize = 8;
pub const QUEUE_WAIT_MS: u32 = 1000;
