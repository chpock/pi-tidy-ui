//! Owning-thread scheduler lifecycle, message waits and final route/mailbox cleanup.
use super::{
    elapsed,
    scheduler::{Scheduler, Submission},
};
use crate::{credit::Budget, fault::Fault, limits::Limits};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

pub(super) enum Message {
    Bind {
        scope: String,
        alive: Arc<AtomicBool>,
        ack: oneshot::Sender<Result<(), Fault>>,
    },
    Submit {
        scope: String,
        alive: Arc<AtomicBool>,
        submission: Box<Submission>,
    },
    Barrier(oneshot::Sender<()>),
    Wake,
}
pub(super) struct Worker {
    pub(super) instance: String,
    pub(super) limits: Limits,
    pub(super) budget: Budget,
    pub(super) born: Instant,
    pub(super) stopped: Arc<AtomicBool>,
    pub(super) receiver: Receiver<Message>,
    pub(super) leases: Arc<AtomicUsize>,
}
fn prune(scopes: &mut HashMap<String, Arc<AtomicBool>>, scheduler: &mut Scheduler) {
    scopes.retain(|scope, alive| {
        if alive.load(Ordering::Acquire) {
            true
        } else {
            scheduler.close(scope);
            false
        }
    });
}
fn receive_message(
    receiver: &Receiver<Message>,
    scheduler: &Scheduler,
    born: Instant,
) -> Result<Option<Message>, mpsc::RecvError> {
    if scheduler.has_work() {
        match receiver.try_recv() {
            Ok(message) => Ok(Some(message)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(mpsc::RecvError),
        }
    } else if let Some(deadline) = scheduler.next_expiry() {
        match receiver.recv_timeout(Duration::from_millis(
            deadline.saturating_sub(elapsed(born)),
        )) {
            Ok(message) => Ok(Some(message)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(mpsc::RecvError),
        }
    } else {
        receiver.recv().map(Some)
    }
}
pub(super) fn run(worker: Worker) {
    let Worker {
        instance,
        limits,
        budget,
        born,
        stopped,
        receiver,
        leases,
    } = worker;

    // Construction, mutation and destruction of every !Send Work occur here.
    let mut scheduler = Scheduler::new(instance.clone(), limits, budget);
    let mut scopes: HashMap<String, Arc<AtomicBool>> = HashMap::new();
    loop {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        prune(&mut scopes, &mut scheduler);
        if stopped.load(Ordering::Acquire) {
            break;
        }
        scheduler.tick(elapsed(born));
        leases.store(scheduler.leases(), Ordering::Release);
        let Ok(message) = receive_message(&receiver, &scheduler, born) else {
            break;
        };
        match message {
            Some(Message::Bind { scope, alive, ack }) => {
                let result = if alive.load(Ordering::Acquire) {
                    scheduler.bind(&scope)
                } else {
                    Err(Fault::not_started("scope_gone"))
                };
                if result.is_ok() {
                    scopes.insert(scope, alive);
                }
                let _ = ack.send(result);
            }
            Some(Message::Submit {
                scope,
                alive,
                submission,
            }) => {
                if alive.load(Ordering::Acquire) && scopes.contains_key(&scope) {
                    scheduler.accept(&scope, *submission);
                } else {
                    submission.reject(&instance, Fault::not_started("scope_gone"));
                }
            }
            Some(Message::Barrier(ack)) => {
                prune(&mut scopes, &mut scheduler);
                scheduler.tick(elapsed(born));
                leases.store(scheduler.leases(), Ordering::Release);
                let _ = ack.send(());
            }
            Some(Message::Wake) | None => {}
        }
    }
    for scope in scopes.keys() {
        scheduler.close(scope);
    }
    // Reject already-credited requests instead of retaining them in a dead mailbox.
    while let Ok(message) = receiver.try_recv() {
        if let Message::Submit { submission, .. } = message {
            submission.reject(&instance, Fault::not_started("scope_gone"));
        }
    }
    leases.store(0, Ordering::Release);
}

#[cfg(test)]
mod receive_tests {
    use super::*;

    const OPEN: &[u8] = br#"{"v":4,"op":"stream.open","ticket":"t","instance":"boot","admission":"try_now","sources":[{"key":"k","generation":1,"source_version":1,"hint":{"language":"bash"},"text":"echo x"}]}"#;

    fn scheduler() -> Scheduler {
        let mut scheduler = Scheduler::new(
            "boot".into(),
            Limits {
                idle_ms: 1,
                ..Default::default()
            },
            Budget::new(crate::limits::DATA_BYTES, 2, 2),
        );
        scheduler.bind("r").unwrap();
        scheduler
    }

    #[test]
    fn runnable_receive_distinguishes_empty_message_and_disconnect() {
        let mut scheduler = scheduler();
        let _ticket = scheduler.submit("r", OPEN.to_vec(), 0).unwrap();
        assert!(scheduler.has_work());
        let (sender, receiver) = mpsc::sync_channel(1);
        assert!(matches!(
            receive_message(&receiver, &scheduler, Instant::now()),
            Ok(None)
        ));
        sender.send(Message::Wake).unwrap();
        assert!(matches!(
            receive_message(&receiver, &scheduler, Instant::now()),
            Ok(Some(Message::Wake))
        ));
        drop(sender);
        assert!(receive_message(&receiver, &scheduler, Instant::now()).is_err());
    }

    #[test]
    fn idle_receive_preserves_messages_and_disconnect() {
        let scheduler = scheduler();
        assert!(!scheduler.has_work());
        assert!(scheduler.next_expiry().is_none());
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(Message::Wake).unwrap();
        assert!(matches!(
            receive_message(&receiver, &scheduler, Instant::now()),
            Ok(Some(Message::Wake))
        ));
        drop(sender);
        assert!(receive_message(&receiver, &scheduler, Instant::now()).is_err());
    }

    #[test]
    fn expiry_receive_distinguishes_elapsed_deadline_message_and_disconnect() {
        let mut scheduler = scheduler();
        let mut ticket = scheduler.submit("r", OPEN.to_vec(), 0).unwrap();
        loop {
            scheduler.tick(0);
            if let Some(reply) = ticket.try_take().unwrap() {
                reply.flushed();
                break;
            }
        }
        scheduler.tick(0);
        assert!(!scheduler.has_work());
        assert_eq!(scheduler.next_expiry(), Some(1));
        let born = Instant::now() - Duration::from_millis(2);
        let (sender, receiver) = mpsc::sync_channel(1);
        assert!(matches!(
            receive_message(&receiver, &scheduler, born),
            Ok(None)
        ));
        sender.send(Message::Wake).unwrap();
        assert!(matches!(
            receive_message(&receiver, &scheduler, born),
            Ok(Some(Message::Wake))
        ));
        drop(sender);
        assert!(receive_message(&receiver, &scheduler, born).is_err());
    }
}
