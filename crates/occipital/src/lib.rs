//! Worker-local highlighting engine. Transports never move parser state between threads.
pub mod credit;
pub mod fault;
pub mod limits;
pub mod protocol;
pub mod runtime;
pub mod source;
pub mod stats;
pub mod style;
pub mod transport;
pub mod vocabulary;
