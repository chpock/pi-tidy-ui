//! Focused admission controls, not a new large-source benchmark matrix.
use occipital::{
    actor::ActorPool,
    ingress::Incoming,
    protocol::SyntaxHint,
    reply::REPLY_BYTES,
    request::{REQUEST_BYTES, SOURCE_BYTES},
    semantic_engine::{Engine, Limits, SourceChunk, Work},
};
use serde_json::{json, Value};

#[test]
fn data_family_and_interval_palette_bounds_are_derived_not_example_sized() {
    let limits = Limits::default();
    assert_eq!(REQUEST_BYTES, 64 << 20);
    assert_eq!(REPLY_BYTES, REQUEST_BYTES);
    assert_eq!(SOURCE_BYTES, 64 << 10);
    assert_eq!(limits.source_bytes, SOURCE_BYTES);
    // Positive length + style + two separators consume at least four JSON bytes.
    assert_eq!(limits.runs, occipital::limits::DATA_WIRE_BYTES / 4);
    assert_eq!(limits.state_pool_bytes, 256 << 20);
    assert_eq!(limits.leases, 4096);
    assert_eq!(limits.per_scope, 512);
    assert_eq!(limits.idle_ms, 300_000);
    assert_eq!(limits.age_ms, 3_600_000);
}

#[test]
fn saturated_source_preserves_exact_prefix_and_empty_finalize_does_not_reparse() {
    let text = "a".repeat(SOURCE_BYTES);
    let hint = SyntaxHint {
        language: Some("text".into()),
        path: None,
    };
    let mut engine = Engine::new(Limits::default());
    let batch = run(&mut engine, |engine| {
        engine
            .begin_one_shot(text.clone(), &hint, &mut |_| true)
            .unwrap()
    });
    assert_eq!(batch.source_bytes as usize, text.len());
    assert_eq!(batch.counters.tail_bytes, 64 << 10);
    assert_eq!(
        batch.runs.iter().map(|run| run[0] as usize).sum::<usize>(),
        text.len()
    );
    let work = engine
        .begin_open("route", "large", text.clone(), &hint, &mut |_| true)
        .unwrap();
    let lease = work.lease().unwrap();
    let opened = execute(&mut engine, work);
    let work = engine
        .begin_append(
            "route",
            "large",
            lease,
            opened.revision,
            opened.source_bytes,
            String::new(),
            true,
            &mut |_| true,
        )
        .unwrap();
    let appended = execute(&mut engine, work);
    assert_eq!(appended.source_bytes as usize, text.len());
    assert_eq!(appended.counters.tail_calls, 0);
    assert_eq!(appended.counters.committed_line_calls, 0);
    assert_eq!(
        appended
            .runs
            .iter()
            .map(|run| run[0] as usize)
            .sum::<usize>(),
        text.len()
    );
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}

fn source(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"v":4,"ticket":ticket,"op":"stream.open","instance":"policy",
        "admission":"try_now","sources":[{"key":ticket,"generation":1,"source_version":0,
        "hint":{"language":"text"},"text":"a"}]}),
    )
    .unwrap()
}

#[tokio::test]
async fn all_eight_routes_can_hold_two_calls_without_a_separate_queue_count_refusal() {
    let pool = ActorPool::new("policy".into(), 2).unwrap();
    let mut routes = Vec::new();
    let mut tickets = Vec::new();
    for index in 0..8 {
        let route = pool.bind().await.unwrap();
        for part in 0..2 {
            let Incoming::Data(ticket) =
                route.receive(source(&format!("r{index}-{part}"))).unwrap()
            else {
                panic!("data")
            };
            tickets.push(ticket);
        }
        routes.push(route);
    }
    assert_eq!(pool.stats().credits.jobs, 16);
    let rejected = routes[0].receive(source("seventeenth")).err().unwrap();
    assert_eq!(rejected.fault.code, "busy");
    assert!(!rejected.fault.started);
    let mut deliveries = Vec::new();
    for ticket in &mut tickets {
        let delivery = ticket.take().await.unwrap();
        let value: Value = serde_json::from_slice(delivery.bytes()).unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["body"]["sources"][0]["source_bytes"], 1);
        assert_eq!(value["body"]["sources"][0]["counters"]["tail_calls"], 1);
        deliveries.push(delivery);
    }
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.jobs, 16);
    assert_eq!(pool.stats().leases, 16);
    // Metadata remains available while every advertised data slot is occupied.
    let Incoming::Control(control) = routes[0]
        .receive(br#"{"v":4,"ticket":"metadata","op":"describe"}"#.to_vec())
        .unwrap()
    else {
        panic!("control")
    };
    let report = control
        .reply("policy", json!({"kind":"descriptor"}))
        .unwrap();
    assert_eq!(pool.stats().control_credits.jobs, 1);
    drop(report);
    assert_eq!(pool.stats().control_credits.bytes, 0);
    drop(deliveries);
    drop(tickets);
    for route in routes {
        route.close();
    }
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().credits.bytes, 0);
    assert_eq!(pool.stats().routes, 0);
    pool.shutdown().await.unwrap();
}

fn execute(engine: &mut Engine, mut work: Work) -> SourceChunk {
    while !engine.step(&mut work, &mut |_| true).unwrap() {}
    engine.finish(work, &mut |_| true).unwrap()
}
fn run(engine: &mut Engine, begin: impl FnOnce(&mut Engine) -> Work) -> SourceChunk {
    let work = begin(engine);
    execute(engine, work)
}
