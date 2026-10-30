//! Generic STYLE jobs share physical data authority with source work.
use occipital::{
    credit::Budget,
    scheduler::{Delivery, Scheduler, Ticket},
    semantic_engine::Limits,
    vocabulary::{self, ScopeId},
};
use serde_json::{json, Value};

fn definition(rules: Value, binding_slots: usize) -> Value {
    json!({"revision":2,"binding_slots":binding_slots,
        "default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":rules})
}
fn style(contexts: Value, ticket: &str, rules: Value, slots: usize) -> Value {
    json!({"v":4,"op":"styles.resolve","ticket":ticket,"instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,
        "vocabulary":vocabulary::FINGERPRINT,"contexts":contexts,"rules":definition(rules,slots)})
}
fn source(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":4,"op":"stream.open","ticket":ticket,"instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,
        "sources":[{"key":ticket,"generation":1,"source_version":0,"hint":{"language":"rust"},"text":"fn f(){}\n"}]})).unwrap()
}
fn worker(budget: Budget) -> Scheduler {
    let mut scheduler = Scheduler::new("boot".into(), Limits::default(), budget);
    scheduler.bind("a").unwrap();
    scheduler.bind("b").unwrap();
    scheduler
}
fn body(delivery: &Delivery) -> Value {
    let result: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(result["v"], 4);
    assert_eq!(result["assets"], vocabulary::ASSET_FINGERPRINT);
    result
}
fn take(scheduler: &mut Scheduler, ticket: &mut Ticket) -> Delivery {
    for _ in 0..10000 {
        if let Some(delivery) = ticket.try_take().unwrap() {
            return delivery;
        }
        scheduler.tick(0);
    }
    panic!("bounded source/style result")
}

#[test]
fn generic_style_uses_one_data_slot_until_delivery_settlement() {
    let budget = Budget::new(1 << 20, 1, 1);
    let mut scheduler = worker(budget.clone());
    let mut ticket = scheduler
        .submit(
            "a",
            serde_json::to_vec(&style(json!([]), "empty", json!([]), 0)).unwrap(),
            0,
        )
        .unwrap();
    assert_eq!(scheduler.stats().jobs, 1);
    assert_eq!(
        scheduler
            .submit("a", source("source"), 0)
            .err()
            .unwrap()
            .code,
        "busy"
    );
    let reply = take(&mut scheduler, &mut ticket);
    let value = body(&reply);
    assert_eq!(value["status"], "ok");
    assert_eq!(value["body"]["indices"], json!([]));
    assert_eq!(value["body"]["kind"], "styles");
    for field in ["palette", "mode"] {
        assert!(value["body"].get(field).is_none());
    }
    assert_eq!(scheduler.stats().jobs, 1);
    reply.flushed();
    scheduler.tick(0);
    assert_eq!(scheduler.stats().jobs, 0);
    drop(scheduler);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn style_backlog_yields_to_peer_and_binding_rules_preserve_independent_properties() {
    let mut scheduler = worker(Budget::new(32 << 20, 4, 2));
    let mut long = scheduler
        .submit(
            "a",
            serde_json::to_vec(&style(json!(vec![vec![0]; 1000]), "long", json!([]), 0)).unwrap(),
            0,
        )
        .unwrap();
    scheduler.tick(0);
    assert!(long.try_take().unwrap().is_none());
    let mut peer = scheduler.submit("b", source("peer"), 0).unwrap();
    scheduler.tick(0);
    scheduler.tick(0);
    let peer_reply = peer
        .try_take()
        .unwrap()
        .expect("other route progresses within its fair turn");
    assert_eq!(body(&peer_reply)["status"], "ok");
    peer_reply.flushed();
    assert!(long.try_take().unwrap().is_none());
    long.cancel();
    scheduler.tick(0);
    let cancelled = take(&mut scheduler, &mut long);
    assert_eq!(body(&cancelled)["error"]["execution"], "started");
    assert_eq!(
        scheduler.stats().jobs,
        1,
        "cancel error retains the same physical slot"
    );
    cancelled.flushed();
    scheduler.tick(0);

    let id = ScopeId::from_name("source.rust").unwrap().get();
    let rules = json!([{"path":["source.rust"],"excludes":[],"foreground":{"kind":"rgb","r":1,"g":2,"b":3},
        "background":null,"font":{"attributes":0,"attribute_mask":15},"context":null}]);
    let mut ticket = scheduler
        .submit(
            "b",
            serde_json::to_vec(&style(json!([[0], [0, id]]), "generic", rules, 0)).unwrap(),
            0,
        )
        .unwrap();
    let reply = take(&mut scheduler, &mut ticket);
    let value = body(&reply);
    assert_eq!(value["status"], "ok");
    let styles = &value["body"];
    assert_eq!(styles["indices"], json!([1, 2]));
    assert_eq!(styles["styles"][0]["foreground"], json!({"kind":"inherit"}));
    assert_eq!(
        styles["styles"][1]["foreground"],
        json!({"kind":"rgb","r":1,"g":2,"b":3})
    );
    assert_eq!(styles["styles"][1]["attributes"], 0);
    assert_eq!(styles["styles"][1]["attribute_mask"], 15);
    reply.flushed();
    scheduler.tick(0);
    assert_eq!(
        scheduler.leases(),
        1,
        "STYLE work cannot retire SOURCE authority"
    );
}

#[test]
fn style_preflight_rejects_unknown_contexts_and_old_versions_before_work() {
    let mut scheduler = worker(Budget::new(32 << 20, 4, 2));
    let base = scheduler.stats().bytes;
    let mut request = style(
        json!([[0], [0, vocabulary::SCOPE_COUNT + 1]]),
        "bad",
        json!([]),
        0,
    );
    assert_eq!(
        scheduler
            .submit("a", serde_json::to_vec(&request).unwrap(), 0)
            .err()
            .unwrap()
            .code,
        "unknown_scope"
    );
    assert_eq!(scheduler.stats().jobs, 0);
    assert_eq!(scheduler.stats().bytes, base);
    request["v"] = json!(3);
    assert_eq!(
        scheduler
            .submit("a", serde_json::to_vec(&request).unwrap(), 0)
            .err()
            .unwrap()
            .code,
        "protocol_mismatch"
    );
    let mut pending = scheduler
        .submit(
            "a",
            serde_json::to_vec(&style(json!([[0]]), "before-start", json!([]), 0)).unwrap(),
            0,
        )
        .unwrap();
    pending.cancel();
    scheduler.tick(0);
    let reply = take(&mut scheduler, &mut pending);
    assert_eq!(body(&reply)["error"]["execution"], "not_started");
    assert_eq!(scheduler.stats().jobs, 1);
    reply.flushed();
    scheduler.tick(0);
    assert_eq!(scheduler.stats().jobs, 0);
}
