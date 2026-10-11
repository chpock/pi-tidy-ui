//! Worker-local highlighting engine. Transports never move parser state between threads.
pub mod actor;
pub mod admission;
pub mod catalogue;
pub mod control;
pub mod credit;
pub mod engine;
pub mod frame;
pub mod ingress;
pub mod limits;
pub mod profile;
pub mod protocol;
pub mod reply;
pub mod request;
pub mod scheduler;
pub mod service;
pub mod shared;
pub mod stdio;
