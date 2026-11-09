//! Admission, route/thread authority, worker-local scheduling and guarded delivery.
mod control;
pub mod encoding;
mod ingress;
mod pool;
mod request;
mod scheduler;
mod worker;

pub use control::Authority;
pub use ingress::{Control, ControlDelivery, Incoming, Rejection};
pub use pool::{ActorPool, PoolHandle, Route};
pub use scheduler::{Delivery, Scheduler, Ticket};

fn elapsed(born: std::time::Instant) -> u64 {
    born.elapsed().as_millis().min(u64::MAX as u128) as u64
}
