//! Deterministic owning-worker controls; real transports are a separate gate.
use occipital::{credit::Budget, engine::Limits, profile::Profile, scheduler::Scheduler};
use serde_json::{json, Value};
trait InspectDelivery {
    fn json(&self) -> Value;
}
impl InspectDelivery for occipital::scheduler::Delivery {
    fn json(&self) -> Value {
        serde_json::from_slice(self.bytes()).unwrap()
    }
}
fn source(ticket: &str, text: &str, queue: bool) -> Vec<u8> {
    let mut value = json!({"v":2,"ticket":ticket,"op":"stream.open","instance":"boot","admission":if queue {"bounded_queue"} else {"try_now"},"sources":[{"key":ticket,"generation":1,"source_version":1,"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"hint":{"language":"bash"},"text":text}]});
    if queue {
        value["queue_wait_ms"] = json!(10);
    }
    serde_json::to_vec(&value).unwrap()
}
fn scheduler() -> Scheduler {
    Scheduler::new(
        "boot".into(),
        Limits::default(),
        Budget::new(8 << 20, 10, 2),
    )
}
#[test]
fn fair_quanta_and_try_now_never_jump_an_admitted_peer() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let mut large = worker
        .submit("a", source("large", &"echo x\n".repeat(500), true), 0)
        .unwrap();
    worker.tick(0);
    let mut peer = worker
        .submit("b", source("peer", "echo small", true), 0)
        .unwrap();
    let mut late = worker
        .submit("b", source("late", "echo late", false), 0)
        .unwrap();
    assert_eq!(
        late.try_take().unwrap().unwrap().json()["error"]["code"],
        "busy"
    );
    for _ in 0..4 {
        worker.tick(0);
    }
    let delivery = peer.try_take().unwrap().unwrap();
    assert_eq!(delivery.json()["status"], "ok");
    delivery.commit();
    assert!(large.try_take().unwrap().is_none());
    // A quantum guarantees progress, not 64 lines: the elapsed-time boundary
    // may yield earlier under cold compilation or concurrent test load.
    for _ in 0..500 {
        worker.tick(0);
    }
    let completed = large.try_take().unwrap().unwrap();
    assert_eq!(
        completed.json()["body"]["sources"][0]["counters"]["committed_line_calls"],
        500
    );
    completed.commit();
    worker.tick(0);
    assert_eq!(worker.leases(), 2);
    assert_eq!(worker.stats().jobs, 0);
}
#[test]
fn queued_expiry_and_cancellation_are_no_start_and_release_reservations() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let mut active = worker
        .submit("a", source("active", &"echo x\n".repeat(500), true), 0)
        .unwrap();
    worker.tick(0);
    let mut waiting = worker
        .submit("b", source("waiting", "echo small", true), 0)
        .unwrap();
    worker.tick(11);
    let expired = waiting.try_take().unwrap().unwrap();
    assert_eq!(expired.json()["error"]["code"], "queue_expired");
    assert_eq!(expired.json()["error"]["execution"], "not_started");
    expired.commit();
    active.cancel();
    for _ in 0..3 {
        worker.tick(11);
    }
    let cancelled = active.try_take().unwrap().unwrap();
    assert_eq!(cancelled.json()["error"]["execution"], "started");
    cancelled.commit();
    worker.tick(11);
    assert_eq!(worker.leases(), 0);
    assert_eq!(worker.stats().jobs, 0);
    assert_eq!(worker.stats().bytes, 0);
}
#[test]
fn ready_delivery_drop_and_route_loss_close_only_affected_authority() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let mut first = worker
        .submit("a", source("first", "echo a", true), 0)
        .unwrap();
    worker.tick(0);
    drop(first.try_take().unwrap().unwrap());
    worker.tick(0);
    assert_eq!(worker.leases(), 0);
    let mut peer = worker
        .submit("b", source("peer", "echo b", true), 0)
        .unwrap();
    worker.tick(0);
    peer.try_take().unwrap().unwrap().commit();
    worker.tick(0);
    let pending = worker
        .submit("a", source("lost", &"echo a\n".repeat(500), true), 0)
        .unwrap();
    worker.tick(0);
    worker.close("a");
    drop(pending);
    worker.tick(0);
    assert_eq!(worker.leases(), 1);
    assert_eq!(worker.stats().jobs, 0);
    worker.close("b");
    worker.tick(0);
    assert_eq!(worker.leases(), 0);
    assert_eq!(worker.stats().bytes, 0);
}
#[test]
fn idle_expiry_needs_no_request_and_held_replies_keep_credits() {
    let mut worker = Scheduler::new(
        "boot".into(),
        Limits {
            idle_ms: 5,
            ..Limits::default()
        },
        Budget::new(8 << 20, 10, 2),
    );
    worker.bind("a").unwrap();
    let mut ticket = worker
        .submit("a", source("tail", "echo a", true), 0)
        .unwrap();
    worker.tick(0);
    let reply = ticket.try_take().unwrap().unwrap();
    assert!(worker.stats().bytes > reply.bytes().len());
    assert_eq!(worker.stats().jobs, 1);
    reply.commit();
    worker.tick(0);
    assert_eq!(worker.leases(), 1);
    assert_eq!(worker.next_expiry(), Some(5));
    worker.tick(5);
    assert_eq!(worker.leases(), 0);
    assert_eq!(worker.stats().bytes, 0);
}
#[test]
fn shared_budget_bounds_unsettled_jobs_across_workers_before_parsing() {
    let budget = Budget::new(8 << 20, 2, 1);
    let mut first = Scheduler::new("boot".into(), Limits::default(), budget.clone());
    let mut second = Scheduler::new("boot".into(), Limits::default(), budget.clone());
    first.bind("a").unwrap();
    second.bind("b").unwrap();
    second.bind("c").unwrap();
    let a = first.submit("a", source("a", "echo a", true), 0).unwrap();
    let b = second.submit("b", source("b", "echo b", true), 0).unwrap();
    assert_eq!(
        first
            .submit("a", source("again", "echo a", true), 0)
            .err()
            .unwrap()
            .code,
        "busy"
    );
    assert_eq!(
        second
            .submit("c", source("third", "echo c", true), 0)
            .err()
            .unwrap()
            .code,
        "busy"
    );
    assert_eq!(budget.snapshot().jobs, 2);
    drop(a);
    drop(b);
    first.tick(0);
    second.tick(0);
    assert_eq!(budget.snapshot().jobs, 0);
    assert_eq!(budget.snapshot().bytes, 0);
}
#[test]
fn malformed_requests_do_not_acquire_work_or_create_authority() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    assert_eq!(
        worker.submit("a", b"{bad".to_vec(), 0).err().unwrap().code,
        "invalid_request"
    );
    assert_eq!(worker.stats().jobs, 0);
    assert_eq!(worker.leases(), 0);
}

#[test]
fn an_unhanded_reply_keeps_its_lease_serialized_until_commit_or_discard() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    let mut open = worker.submit("a", source("s", "echo a", true), 0).unwrap();
    worker.tick(0);
    let first = open.try_take().unwrap().unwrap();
    let saved = first.json()["body"]["sources"][0].clone();
    let append = json!({"v":2,"ticket":"append","instance":"boot","op":"stream.append","admission":"bounded_queue","queue_wait_ms":10,"key":saved["key"],"generation":saved["generation"],"source_version":2,"lease":saved["lease"],"base_revision":saved["revision"],"base_bytes":saved["source_bytes"],"profile":saved["profile"],"fingerprint":saved["fingerprint"],"append":"\nnext\n","final":false});
    let mut second = worker
        .submit("a", serde_json::to_vec(&append).unwrap(), 0)
        .unwrap();
    worker.tick(0);
    assert!(second.try_take().unwrap().is_none());
    assert!(!worker.has_work());
    assert_eq!(worker.next_expiry(), Some(10));
    drop(first);
    worker.tick(0);
    let failed = second.try_take().unwrap().unwrap();
    assert_eq!(failed.json()["error"]["code"], "restart_required");
    assert_eq!(failed.json()["error"]["execution"], "not_started");
    failed.commit();
    worker.tick(0);
    assert_eq!(worker.leases(), 0);
    assert_eq!(worker.stats().bytes, 0);
}

#[test]
fn a_moderate_two_sided_file_batch_fits_the_existing_aggregate_payload_pool() {
    let mut worker = Scheduler::new(
        "boot".into(),
        Limits::default(),
        Budget::new(
            occipital::limits::DATA_BYTES,
            occipital::limits::DATA_JOBS,
            occipital::limits::DATA_PER_ROUTE,
        ),
    );
    worker.bind("a").unwrap();
    let mut value: Value = serde_json::from_slice(&source(
        "diff",
        &"const x: number = 1234;\n".repeat(9000),
        true,
    ))
    .unwrap();
    value["op"] = json!("highlight");
    value["queue_wait_ms"] = json!(1000);
    value["sources"][0]["hint"]["language"] = json!("typescript");
    let mut second = value["sources"][0].clone();
    second["key"] = json!("other");
    value["sources"].as_array_mut().unwrap().push(second);
    assert_eq!(value["sources"][0]["text"].as_str().unwrap().len(), 216000);
    let mut ticket = worker
        .submit("a", serde_json::to_vec(&value).unwrap(), 0)
        .unwrap();
    for _ in 0..18000 {
        worker.tick(0);
    }
    let reply = ticket.try_take().unwrap().unwrap();
    let body = reply.json();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["body"]["sources"].as_array().unwrap().len(), 2);
    for source in body["body"]["sources"].as_array().unwrap() {
        assert_eq!(source["counters"]["committed_line_calls"], 9000);
        assert_eq!(source["source_bytes"], 216000);
    }
    assert!(worker.stats().peak_bytes <= occipital::limits::DATA_BYTES);
    reply.commit();
    worker.tick(0);
    assert_eq!(worker.stats().bytes, 0);
    assert_eq!(worker.leases(), 0);
}

// Fill a byte pool exactly using the public charged-byte counter. This is a
// credit-transfer control, not a throughput test or an input-size nomination.
fn full_pool_scheduler() -> (Scheduler, usize) {
    let mut probe = scheduler();
    probe.bind("probe").unwrap();
    let mut request = occipital::request::decode(&source("probe", "", true)).unwrap();
    request.sources.as_mut().unwrap()[0].text = "x\n".repeat(65);
    let ticket = probe.submit_request("probe", request, 0).unwrap();
    let charge = probe.stats().bytes;
    drop(ticket);
    probe.tick(0);
    probe.close("probe");
    assert_eq!(probe.stats().bytes, 0);
    let full = 2 * charge;
    (
        Scheduler::new("boot".into(), Limits::default(), Budget::new(full, 10, 2)),
        full,
    )
}
#[test]
fn exact_full_pool_open_jobs_never_charge_busy_state_twice_or_panic() {
    use occipital::request::decode;
    let (mut worker, full) = full_pool_scheduler();
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let mut tickets = Vec::new();
    for scope in ["a", "b"] {
        let mut request = decode(&source(scope, "", true)).unwrap();
        request.sources.as_mut().unwrap()[0].text = "x\n".repeat(65);
        assert_eq!(request.sources.as_ref().unwrap()[0].text.capacity(), 130);
        tickets.push(worker.submit_request(scope, request, 0).unwrap());
    }
    assert_eq!(worker.stats().bytes, full);
    worker.tick(0);
    assert_eq!(worker.stats().bytes, full);
    drop(tickets);
    worker.tick(0);
    worker.tick(0);
    worker.close("a");
    worker.close("b");
    assert_eq!(worker.stats().bytes, 0);
}
#[test]
fn try_now_blocked_by_a_delivery_is_refused_without_waiting_or_advancing() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    let mut open = worker.submit("a", source("s", "echo a", true), 0).unwrap();
    worker.tick(0);
    let first = open.try_take().unwrap().unwrap();
    let saved = first.json()["body"]["sources"][0].clone();
    let append = json!({"v":2,"ticket":"append","instance":"boot","op":"stream.append","admission":"try_now","key":saved["key"],"generation":saved["generation"],"source_version":2,"lease":saved["lease"],"base_revision":saved["revision"],"base_bytes":saved["source_bytes"],"profile":saved["profile"],"fingerprint":saved["fingerprint"],"append":"\nnext\n","final":false});
    let mut ticket = worker
        .submit("a", serde_json::to_vec(&append).unwrap(), 0)
        .unwrap();
    let refused = ticket
        .try_take()
        .unwrap()
        .expect("try_now must return a no-start refusal immediately");
    assert_eq!(refused.json()["error"]["code"], "busy");
    assert_eq!(refused.json()["error"]["execution"], "not_started");
    refused.commit();
    first.commit();
    worker.tick(0);
    assert_eq!(worker.leases(), 1);
    worker.close("a");
    assert_eq!(worker.stats().bytes, 0);
}
#[test]
fn taking_a_delivery_transfers_drop_cancellation_from_its_local_ticket() {
    let mut worker = scheduler();
    worker.bind("a").unwrap();
    let delivery = {
        let mut ticket = worker.submit("a", source("s", "echo a", true), 0).unwrap();
        worker.tick(0);
        ticket.try_take().unwrap().unwrap()
    };
    delivery.commit();
    worker.tick(0);
    assert_eq!(worker.leases(), 1);
    assert_eq!(worker.stats().jobs, 0);
    worker.close("a");
    assert_eq!(worker.stats().bytes, 0);
}

#[test]
fn exact_full_pool_checkpoint_and_handoff_credits_transfer_without_peak_growth() {
    use occipital::request::decode;
    let (mut worker, full) = full_pool_scheduler();
    worker.bind("a").unwrap();
    worker.bind("b").unwrap();
    let mut tickets = Vec::new();
    for scope in ["a", "b"] {
        let mut request = decode(&source(scope, "", true)).unwrap();
        let source = &mut request.sources.as_mut().unwrap()[0];
        source.text = "x\n".repeat(65);
        source.hint.language = Some("Plain Text".into());
        tickets.push(worker.submit_request(scope, request, 0).unwrap());
    }
    assert_eq!(worker.stats().bytes, full);
    for _ in 0..(2 * 65) {
        worker.tick(0);
    }
    for ticket in &mut tickets {
        let delivery = ticket.try_take().unwrap().unwrap();
        let body = delivery.json();
        assert_eq!(body["status"], "ok");
        assert_eq!(
            body["body"]["sources"][0]["counters"]["committed_line_calls"],
            65
        );
        delivery.commit();
    }
    worker.tick(0);
    assert_eq!(worker.stats().peak_bytes, full);
    assert_eq!(worker.leases(), 2);
    assert_eq!(worker.stats().jobs, 0);
    worker.close("a");
    worker.close("b");
    assert_eq!(worker.stats().bytes, 0);
}
