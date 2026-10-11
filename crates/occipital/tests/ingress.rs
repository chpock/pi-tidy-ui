//! Real actor admission and a separate bounded control lane, before transport adapters.
use occipital::{actor::ActorPool, ingress::Incoming, profile::Profile};
use serde_json::{json, Value};
fn source(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":2,"ticket":ticket,"op":"stream.open","instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":ticket,"generation":1,"source_version":1,"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"hint":{"language":"bash"},"text":"echo x"}]})).unwrap()
}
#[tokio::test]
async fn control_has_its_own_credit_while_two_data_deliveries_are_held() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let mut a = match route.receive(source("a")).unwrap() {
        Incoming::Data(t) => t,
        _ => panic!("data"),
    };
    let ready_a = a.take().await.unwrap();
    let mut b = match route.receive(source("b")).unwrap() {
        Incoming::Data(t) => t,
        _ => panic!("data"),
    };
    let ready_b = b.take().await.unwrap();
    let rejected = route.receive(source("third")).err().unwrap();
    assert_eq!(rejected.ticket.as_deref(), Some("third"));
    assert_eq!(rejected.fault.code, "busy");
    assert!(!rejected.fault.started);
    let control = match route
        .receive(br#"{"v":2,"ticket":"meta","op":"describe"}"#.to_vec())
        .unwrap()
    {
        Incoming::Control(c) => c,
        _ => panic!("control"),
    };
    assert_eq!(control.request().ticket, "meta");
    assert_eq!(pool.stats().credits.jobs, 2);
    let busy = route
        .receive(br#"{"v":2,"ticket":"meta2","op":"describe"}"#.to_vec())
        .err()
        .unwrap();
    assert_eq!(busy.ticket.as_deref(), Some("meta2"));
    assert_eq!(busy.fault.code, "busy");
    drop(control);
    drop(ready_a);
    drop(ready_b);
    drop(a);
    drop(b);
    route.close();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.bytes, 0);
    assert_eq!(pool.stats().leases, 0);
    pool.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_large_and_escaped_ticket_frames_reject_before_source_work() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let bad = br#"{"v":2,"ticket":"a\"b","op":"highlight","sources":[]}"#.to_vec();
    let rejection = route.receive(bad).err().unwrap();
    assert_eq!(rejection.ticket.as_deref(), Some("a\"b"));
    assert_eq!(rejection.fault.code, "invalid_request");
    let too_long =
        serde_json::to_vec(&json!({"v":2,"ticket":"x".repeat(10000),"op":"describe"})).unwrap();
    assert!(route.receive(too_long).err().unwrap().ticket.is_none());
    let mut extra: Value = serde_json::from_slice(&source("padding")).unwrap();
    extra["unexpected"] = json!("z".repeat(4096));
    assert_eq!(
        route
            .receive(serde_json::to_vec(&extra).unwrap())
            .err()
            .unwrap()
            .fault
            .code,
        "invalid_request"
    );
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.bytes, 0);
    assert_eq!(pool.stats().leases, 0);
    drop(route);
    pool.shutdown().await.unwrap();
}
#[tokio::test]
async fn closing_a_transport_route_retires_all_facades_not_just_the_last_clone() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let handler_clone = route.clone();
    let mut ticket = route.submit(source("lease")).unwrap();
    ticket.take().await.unwrap().commit();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    route.close();
    route.close();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().routes, 0);
    assert_eq!(
        handler_clone.submit(source("late")).err().unwrap().code,
        "scope_gone"
    );
    drop(route);
    drop(handler_clone);
    drop(ticket);
    pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn escaped_header_keys_and_reverse_control_data_overlap_remain_valid() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let control = match route
        .receive(br#"{"v":2,"ti\u0063ket":"escaped","\u006fp":"describe"}"#.to_vec())
        .unwrap()
    {
        Incoming::Control(control) => control,
        _ => panic!("control"),
    };
    let mut ticket = match route.receive(source("data-with-control")).unwrap() {
        Incoming::Data(ticket) => ticket,
        _ => panic!("data"),
    };
    ticket.take().await.unwrap().commit();
    let delivery = control.reply("boot", json!({"kind":"descriptor"})).unwrap();
    assert!(pool.stats().control_credits.bytes > 0);
    assert_eq!(pool.stats().control_credits.jobs, 1);
    let body: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(body["ticket"], "escaped");
    drop(delivery);
    assert_eq!(pool.stats().control_credits.bytes, 0);
    route.close();
    pool.barrier().await.unwrap();
    pool.shutdown().await.unwrap();
}

#[test]
fn routing_probe_bounds_ignored_nesting_without_confusing_source_quotes_or_braces() {
    use occipital::ingress::routing_ticket;
    let deep = format!(
        "{{\"ticket\":\"depth\",\"op\":\"highlight\",\"future\":{}null{}}}",
        "[".repeat(64),
        "]".repeat(64)
    );
    assert_eq!(routing_ticket(deep.as_bytes()), None);
    let shallow = format!(
        "{{\"ticket\":\"depth\",\"op\":\"highlight\",\"future\":{}null{}}}",
        "[".repeat(63),
        "]".repeat(63)
    );
    assert_eq!(routing_ticket(shallow.as_bytes()).as_deref(), Some("depth"));
    let literal = serde_json::to_vec(
        &json!({"ticket":"literal", "op":"highlight", "future": "[\\\"{}]".repeat(1000)}),
    )
    .unwrap();
    assert_eq!(routing_ticket(&literal).as_deref(), Some("literal"));
}

#[tokio::test]
async fn metadata_encoding_failure_and_explicit_commit_release_reserved_credit() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let acquire = || match route
        .receive(br#"{"v":2,"ticket":"control","op":"describe"}"#.to_vec())
        .unwrap()
    {
        Incoming::Control(control) => control,
        _ => panic!("control"),
    };
    assert_eq!(
        acquire()
            .reply("boot", "x".repeat(32 * 1024))
            .err()
            .unwrap()
            .code,
        "reply_limit"
    );
    assert_eq!(pool.stats().control_credits.bytes, 0);
    let delivery = acquire()
        .error(
            "boot",
            occipital::protocol::Fault::not_started("theme_unavailable"),
        )
        .unwrap();
    assert!(pool.stats().control_credits.bytes > 0);
    delivery.commit();
    assert_eq!(pool.stats().control_credits.bytes, 0);
    drop(route);
    pool.shutdown().await.unwrap();
}
