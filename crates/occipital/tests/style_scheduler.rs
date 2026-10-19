//! Actual shared data authority: the reviewed parser, resolver and native cache.
use occipital::{
    catalogue::Catalogue,
    credit::Budget,
    scheduler::{Delivery, Scheduler, Ticket},
    semantic_engine::Limits,
    vocabulary,
};
use serde_json::{json, Value};
fn source(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":3,"op":"stream.open","ticket":ticket,"instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":ticket,"generation":1,"source_version":0,"hint":{"language":"rust"},"text":"fn f(){}\n"}]})).unwrap()
}
fn native(contexts: Value, ticket: &str) -> Value {
    let catalogue = Catalogue::from_os_root(None);
    let snapshot = catalogue.snapshot();
    let d = snapshot
        .descriptors()
        .find(|d| d.id == "syntect:Nord")
        .unwrap();
    json!({"v":3,"op":"styles.resolve","ticket":ticket,"instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"vocabulary":vocabulary::FINGERPRINT,"contexts":contexts,"rules":{"kind":"native","id":d.id,"fingerprint":d.fingerprint}})
}
fn worker(budget: Budget) -> Scheduler {
    let mut w = Scheduler::new("boot".into(), Limits::default(), budget);
    w.bind("a").unwrap();
    w.bind("b").unwrap();
    w
}
fn body(delivery: &Delivery) -> Value {
    let result: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(result["v"], 3);
    assert_eq!(result["assets"], vocabulary::ASSET_FINGERPRINT);
    result
}
fn take(w: &mut Scheduler, t: &mut Ticket) -> Delivery {
    for _ in 0..10000 {
        if let Some(d) = t.try_take().unwrap() {
            return d;
        }
        w.tick(0);
    }
    panic!("bounded source/style result");
}
#[test]
fn native_palette_is_lazy_cached_and_shares_physical_slots_with_source_work() {
    let budget = Budget::new(32 << 20, 4, 2);
    let mut w = worker(budget.clone());
    let baseline = w.stats().bytes;
    let request = native(json!([]), "empty-palette");
    let mut styles = w
        .submit("a", serde_json::to_vec(&request).unwrap(), 0)
        .unwrap();
    assert_eq!(w.native_counters().compilations, 0);
    assert_eq!(w.native_counters().palette_derivations, 0);
    assert_eq!(w.stats().jobs, 1);
    let reply = take(&mut w, &mut styles);
    let value = body(&reply);
    assert_eq!(value["status"], "ok");
    assert_eq!(value["body"]["indices"], json!([]));
    assert_eq!(
        value["body"]["palette"]["slots"].as_array().unwrap().len(),
        26
    );
    assert_eq!(w.native_counters().compilations, 1);
    assert_eq!(w.native_counters().palette_derivations, 1);
    assert_eq!(w.leases(), 0);
    assert_eq!(w.stats().jobs, 1);
    let mut source = w.submit("a", source("source"), 0).unwrap();
    assert_eq!(w.stats().jobs, 2);
    assert_eq!(
        w.submit(
            "a",
            serde_json::to_vec(&native(json!([]), "third")).unwrap(),
            0
        )
        .err()
        .unwrap()
        .code,
        "busy"
    );
    let parsed = take(&mut w, &mut source);
    let parsed_body = body(&parsed);
    let saved = &parsed_body["body"]["sources"][0];
    assert_eq!(saved["revision"], 1);
    parsed.flushed();
    reply.flushed();
    w.tick(0);
    assert_eq!(w.stats().jobs, 0);
    let mut again = w
        .submit(
            "a",
            serde_json::to_vec(&native(saved["contexts"].clone(), "cached")).unwrap(),
            0,
        )
        .unwrap();
    let reply = take(&mut w, &mut again);
    assert_eq!(
        body(&reply)["body"]["indices"].as_array().unwrap().len(),
        saved["contexts"].as_array().unwrap().len()
    );
    assert_eq!(w.native_counters().hits, 1);
    assert_eq!(w.native_counters().compilations, 1);
    assert_eq!(w.leases(), 1);
    reply.flushed();
    w.tick(0);
    w.close("a");
    w.close("b");
    assert_eq!(w.leases(), 0);
    assert!(
        w.stats().bytes > baseline,
        "immutable cached definition stays funded"
    );
    assert_eq!(w.stats().jobs, 0);
    drop(w);
    assert_eq!(budget.snapshot().bytes, 0);
}
#[test]
fn style_backlog_yields_to_peer_and_generic_rules_preserve_binding_reset_semantics() {
    let mut w = worker(Budget::new(32 << 20, 4, 2));
    let mut long = w
        .submit(
            "a",
            serde_json::to_vec(&native(json!(vec![vec![0]; 1000]), "long")).unwrap(),
            0,
        )
        .unwrap();
    w.tick(0);
    assert!(long.try_take().unwrap().is_none());
    let mut peer = w.submit("b", source("peer"), 0).unwrap();
    w.tick(0);
    w.tick(0);
    let peer_reply = peer
        .try_take()
        .unwrap()
        .expect("other route progresses within its fair turn");
    assert_eq!(body(&peer_reply)["status"], "ok");
    peer_reply.flushed();
    assert!(long.try_take().unwrap().is_none());
    long.cancel();
    w.tick(0);
    let cancelled = take(&mut w, &mut long);
    assert_eq!(body(&cancelled)["error"]["execution"], "started");
    assert_eq!(
        w.stats().jobs,
        1,
        "cancel error retains the same physical slot"
    );
    cancelled.flushed();
    w.tick(0);
    let id = vocabulary::ScopeId::from_name("source.rust").unwrap().get();
    let definition = json!({"revision":1,"binding_slots":1,"default":{"foreground":{"kind":"binding","slot":0},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[{"path":["source.rust"],"excludes":[],"foreground":{"kind":"rgb","r":1,"g":2,"b":3},"background":null,"font":{"attributes":0,"attribute_mask":15}}]});
    let mut request = native(json!([[0], [0, id]]), "generic");
    request["rules"] = json!({"kind":"client","definition":definition});
    let mut ticket = w
        .submit("b", serde_json::to_vec(&request).unwrap(), 0)
        .unwrap();
    let reply = take(&mut w, &mut ticket);
    let value = body(&reply);
    assert_eq!(value["status"], "ok");
    let styles = &value["body"];
    assert!(styles["palette"].is_null());
    assert_eq!(styles["indices"], json!([1, 2]));
    assert_eq!(
        styles["styles"][0]["foreground"],
        json!({"kind":"binding","slot":0})
    );
    assert_eq!(
        styles["styles"][1]["foreground"],
        json!({"kind":"rgb","r":1,"g":2,"b":3})
    );
    assert_eq!(styles["styles"][1]["attributes"], 0);
    assert_eq!(styles["styles"][1]["attribute_mask"], 15);
    assert_eq!(w.native_counters().compilations, 1);
    assert_eq!(w.leases(), 1);
    drop(reply);
    w.tick(0);
    assert_eq!(
        w.leases(),
        1,
        "style cancellation cannot retire source authority"
    );
}
#[test]
fn style_preflight_failure_and_late_source_errors_keep_exact_execution_and_credit_authority() {
    let mut w = worker(Budget::new(32 << 20, 4, 2));
    let base = w.stats().bytes;
    let mut request = native(json!([[0], [0, vocabulary::SCOPE_COUNT + 1]]), "bad");
    assert_eq!(
        w.submit("a", serde_json::to_vec(&request).unwrap(), 0)
            .err()
            .unwrap()
            .code,
        "unknown_scope"
    );
    assert_eq!(w.native_counters().compilations, 0);
    assert_eq!(w.stats().jobs, 0);
    assert_eq!(w.stats().bytes, base);
    request["v"] = json!(2);
    assert_eq!(
        w.submit("a", serde_json::to_vec(&request).unwrap(), 0)
            .err()
            .unwrap()
            .code,
        "protocol_mismatch"
    );
    let mut pending = w
        .submit(
            "a",
            serde_json::to_vec(&native(json!([[0]]), "before-start")).unwrap(),
            0,
        )
        .unwrap();
    pending.cancel();
    w.tick(0);
    let reply = take(&mut w, &mut pending);
    assert_eq!(body(&reply)["error"]["execution"], "not_started");
    assert_eq!(w.native_counters().compilations, 0);
    assert_eq!(w.stats().jobs, 1);
    reply.flushed();
    w.tick(0);
    assert_eq!(w.stats().jobs, 0);
}

#[test]
fn denied_native_preparation_returns_error_under_original_credit_and_peer_recovers() {
    let budget = Budget::new(32 << 10, 4, 2);
    let mut w = worker(budget.clone());
    let mut ticket = w
        .submit(
            "a",
            serde_json::to_vec(&native(json!([]), "denied-native")).unwrap(),
            0,
        )
        .unwrap();
    let reply = take(&mut w, &mut ticket);
    let value = body(&reply);
    assert_eq!(value["error"]["code"], "busy");
    assert_eq!(value["error"]["execution"], "not_started");
    assert_eq!(
        w.stats().jobs,
        1,
        "failed preparation did not drop/re-reserve its slot"
    );
    assert_eq!(w.native_counters().compilations, 0);
    let mut peer = w.submit("b", source("peer").to_vec(), 0).unwrap();
    let parsed = take(&mut w, &mut peer);
    assert_eq!(body(&parsed)["status"], "ok");
    parsed.flushed();
    reply.flushed();
    w.tick(0);
    assert_eq!(w.stats().jobs, 0);
    w.close("a");
    w.close("b");
    drop(w);
    assert_eq!(budget.snapshot().bytes, 0);
}
