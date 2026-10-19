//! Persistent owned pipe frontend. Blocking fd operations live on two fixed IO
//! threads; bounded channels, native guards and receipts survive actual write/flush.
use crate::{
    actor::Route,
    control::Authority,
    frame,
    ingress::{self, ControlDelivery, Incoming, CONTROL_REQUEST_BYTES},
    protocol::Fault,
    reply::REPLY_BYTES,
    request::REQUEST_BYTES,
    scheduler::{Delivery, Ticket},
    semantic::PROTOCOL_VERSION,
    semantic_reply,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

const MAX_TASKS: usize = 16;
type Registry = Arc<Mutex<HashMap<String, CancellationToken>>>;
enum Payload {
    Data(Delivery),
    Control(ControlDelivery),
    Error(Vec<u8>),
}
impl Payload {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Data(value) => value.bytes(),
            Self::Control(value) => value.bytes(),
            Self::Error(value) => value,
        }
    }
    fn flushed(self) {
        match self {
            Self::Data(value) => value.flushed(),
            Self::Control(value) => value.commit(),
            Self::Error(_) => {}
        }
    }
}
struct Outgoing {
    payload: Payload,
    written: oneshot::Sender<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    v: u32,
    cancel: String,
}
fn cancellation(bytes: &[u8]) -> Option<String> {
    if bytes.len() > CONTROL_REQUEST_BYTES {
        return None;
    }
    let value: Cancel = serde_json::from_slice(bytes).ok()?;
    (value.v == PROTOCOL_VERSION
        && !value.cancel.is_empty()
        && value.cancel.len() <= 64
        && !value.cancel.chars().any(char::is_control))
    .then_some(value.cancel)
}
fn error(authority: &Authority, ticket: &str, fault: Fault) -> Result<Payload, Fault> {
    semantic_reply::error::<()>(ticket, authority.instance(), fault)
        .encode()
        .map(Payload::Error)
}
async fn take(
    ticket: &mut Ticket,
    cancel: &CancellationToken,
    cancelled: &mut bool,
) -> Result<Delivery, Fault> {
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled(), if !*cancelled => { ticket.cancel(); *cancelled = true; },
            result = ticket.take() => return result,
        }
    }
}
async fn dispatch(
    authority: Arc<Authority>,
    incoming: Incoming,
    correlation: String,
    cancel: CancellationToken,
    sender: mpsc::Sender<Outgoing>,
) -> Result<(), Fault> {
    let mut cancelled = false;
    let (payload, mut ticket) = match incoming {
        Incoming::Data(mut ticket) => {
            let payload = match take(&mut ticket, &cancel, &mut cancelled).await {
                Ok(value) => Payload::Data(value),
                Err(fault) => error(&authority, &correlation, fault)?,
            };
            (payload, Some(ticket))
        }
        // Metadata cancellation is best effort; don't free its slot while a
        // blocking refresh still owns work. EOF retires the whole incarnation.
        Incoming::Control(control) => {
            let payload = match authority.control(control).await {
                Ok(value) => Payload::Control(value),
                Err(fault) => error(&authority, &correlation, fault)?,
            };
            (payload, None)
        }
    };
    let (written, mut receipt) = oneshot::channel();
    let send = sender.send(Outgoing { payload, written });
    tokio::pin!(send);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled(), if !cancelled => {
                if let Some(ticket) = &ticket { ticket.cancel(); }
                cancelled = true;
            },
            result = &mut send => { result.map_err(|_| Fault::started("pipe_error"))?; break; }
        }
    }
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled(), if !cancelled => {
                if let Some(ticket) = &ticket { ticket.cancel(); }
                cancelled = true;
            },
            result = &mut receipt => {
                drop(ticket.take());
                return if result.unwrap_or(false) { Ok(()) } else { Err(Fault::started("pipe_error")) };
            }
        }
    }
}

pub async fn run(authority: Arc<Authority>, route: Route) -> Result<(), Fault> {
    let alive = Arc::new(AtomicBool::new(true));
    // At most one queued + one reader-owned raw frame, independent from the
    // credited decoded native jobs. One writer-owned + one queued reply stays credited.
    let (input, mut inputs) = mpsc::channel(1);
    let (read_done, mut read_end) = oneshot::channel();
    std::thread::Builder::new()
        .name("occipital-pipe-read".into())
        .spawn(move || {
            let result = (|| {
                let input_fd = std::io::stdin();
                let mut reader = input_fd.lock();
                while let Some(bytes) = frame::read_frame(&mut reader, REQUEST_BYTES)
                    .map_err(|_| Fault::not_started("pipe_frame"))?
                {
                    if input.blocking_send(bytes).is_err() {
                        break;
                    }
                }
                Ok(())
            })();
            let _ = read_done.send(result);
        })
        .map_err(|_| Fault::not_started("pipe_start"))?;
    let (output, mut outputs) = mpsc::channel::<Outgoing>(1);
    let (write_done, mut write_end) = oneshot::channel();
    let writer_alive = Arc::clone(&alive);
    std::thread::Builder::new()
        .name("occipital-pipe-write".into())
        .spawn(move || {
            let result = (|| {
                let output_fd = std::io::stdout();
                let mut writer = output_fd.lock();
                while let Some(Outgoing { payload, written }) = outputs.blocking_recv() {
                    if !writer_alive.load(Ordering::Acquire) {
                        let _ = written.send(false);
                        break;
                    }
                    if frame::write_frame(&mut writer, payload.bytes(), REPLY_BYTES).is_err() {
                        let _ = written.send(false);
                        return Err(Fault::started("pipe_error"));
                    }
                    payload.flushed();
                    let _ = written.send(true);
                }
                Ok(())
            })();
            let _ = write_done.send(result);
        })
        .map_err(|_| Fault::not_started("pipe_start"))?;
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    let mut tasks = JoinSet::new();
    let result = loop {
        tokio::select! {
            biased;
            result = &mut read_end => break result.unwrap_or(Err(Fault::not_started("pipe_error"))),
            result = &mut write_end => break result.unwrap_or(Err(Fault::started("pipe_error"))),
            result = tasks.join_next(), if !tasks.is_empty() => {
                match result { Some(Ok(Ok(()))) => {}, _ => break Err(Fault::started("pipe_error")) }
            },
            bytes = inputs.recv() => {
                let Some(bytes) = bytes else {
                    // Channel closure can win after read_end was polled Pending.
                    // Only the reader result distinguishes clean EOF from a bad frame.
                    break (&mut read_end).await.unwrap_or(Err(Fault::not_started("pipe_error")));
                };
                if let Some(ticket) = cancellation(&bytes) {
                    if let Some(cancel) = registry.lock().expect("pipe registry poisoned").get(&ticket) { cancel.cancel(); }
                    continue;
                }
                let Some(correlation) = ingress::routing_ticket(&bytes) else { break Err(Fault::not_started("invalid_request")); };
                if registry.lock().expect("pipe registry poisoned").contains_key(&correlation) {
                    break Err(Fault::not_started("invalid_request"));
                }
                if tasks.len() >= MAX_TASKS { break Err(Fault::not_started("pipe_window")); }
                match route.receive(bytes) {
                    Ok(incoming) => {
                        let cancel = CancellationToken::new();
                        registry.lock().expect("pipe registry poisoned").insert(correlation.clone(), cancel.clone());
                        let registry = Arc::clone(&registry);
                        let authority = Arc::clone(&authority);
                        let sender = output.clone();
                        tasks.spawn(async move {
                            let result = dispatch(authority, incoming, correlation.clone(), cancel, sender).await;
                            registry.lock().expect("pipe registry poisoned").remove(&correlation);
                            result
                        });
                    },
                    Err(rejection) => {
                        let Some(ticket) = rejection.ticket else { break Err(rejection.fault); };
                        let payload = error(&authority, &ticket, rejection.fault)?;
                        let sender = output.clone();
                        tasks.spawn(async move {
                            let (written, receipt) = oneshot::channel();
                            sender.send(Outgoing { payload, written }).await.map_err(|_| Fault::started("pipe_error"))?;
                            if receipt.await.unwrap_or(false) { Ok(()) } else { Err(Fault::started("pipe_error")) }
                        });
                    }
                }
            }
        }
    };
    alive.store(false, Ordering::Release);
    authority.retire();
    route.close();
    for cancel in registry.lock().expect("pipe registry poisoned").values() {
        cancel.cancel();
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    drop(output);
    // IO threads may be blocked in OS fd calls; returning from the owned helper
    // terminates them. Never join such a thread on the actor/UI shutdown path.
    result
}
