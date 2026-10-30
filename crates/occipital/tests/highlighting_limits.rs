//! Approved volume policy: admission and actual producer controls, not grammar timing tests.
use occipital::{
    actor::ActorPool,
    credit::Budget,
    ingress::Incoming,
    limits,
    protocol::{Fault, SyntaxHint},
    semantic::{Bounds, ContextPlan},
    semantic_engine::{Engine, Limits, SourceChunk, Work},
    semantic_reply,
    source_request::SourceRequest,
    vocabulary,
};
use serde_json::{json, value::RawValue, Value};

fn raw(value: Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).unwrap()
}
fn source(key: usize, text: &str) -> Value {
    json!({"key":key.to_string(),"generation":1,"source_version":0,"hint":{"language":"text"},"text":text})
}
fn request(sources: Value) -> Box<RawValue> {
    raw(
        json!({"v":4,"op":"highlight","ticket":"t","instance":"limits","admission":"try_now","sources":sources}),
    )
}
fn execute(engine: &mut Engine, mut work: Work) -> SourceChunk {
    while !engine.step(&mut work, &mut |_| true).unwrap() {}
    engine.finish(work, &mut |_| true).unwrap()
}
fn hint() -> SyntaxHint {
    SyntaxHint {
        language: Some("text".into()),
        path: None,
    }
}

#[test]
fn source_batch_shares_bytes_and_logical_lines_before_owned_payload_admission() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/syntax-v3/highlighting-limits.json"
    ))
    .unwrap();
    let bytes = fixture["sourceBytes"].as_u64().unwrap() as usize;
    let lines = fixture["sourceLines"].as_u64().unwrap() as usize;
    for texts in [
        vec!["界".repeat(bytes / 3 + 1)],
        vec!["x".repeat(bytes / 2), "x".repeat(bytes / 2 + 1)],
        vec!["\n".repeat(lines), "x".into()],
        vec!["\n".repeat(lines / 2), "\n".repeat(lines / 2 + 1)],
    ] {
        let input = request(json!(texts
            .iter()
            .enumerate()
            .map(|(i, t)| source(i, t))
            .collect::<Vec<_>>()));
        let mut grants = 0;
        let result = SourceRequest::decode(&input, "limits", usize::MAX, &mut |_| {
            grants += 1;
            true
        });
        assert_eq!(result.err(), Some(Fault::not_started("source_limit")));
        assert_eq!(grants, 0);
    }
    for text in [
        "\n".repeat(lines),
        format!("{}x", "\n".repeat(lines - 1)),
        "\0".repeat(bytes),
    ] {
        let input = request(json!([source(0, &text)]));
        assert!(SourceRequest::decode(&input, "limits", usize::MAX, &mut |_| true).is_ok());
    }
}

#[test]
fn append_cannot_reset_line_or_byte_coverage_and_refusal_keeps_prior_lease_valid() {
    for (initial, accepted, refused) in [
        ("\n".repeat(8191) + "x", "\n", "x"),
        ("x".repeat(65535), "x", "界"),
    ] {
        let mut engine = Engine::new(Limits::default());
        let work = engine
            .begin_open("r", "k", initial, &hint(), &mut |_| true)
            .unwrap();
        let lease = work.lease().unwrap();
        let first = execute(&mut engine, work);
        let work = engine
            .begin_append(
                "r",
                "k",
                lease,
                first.revision,
                first.source_bytes,
                accepted.into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        let second = execute(&mut engine, work);
        let result = engine.begin_append(
            "r",
            "k",
            lease,
            second.revision,
            second.source_bytes,
            refused.into(),
            false,
            &mut |_| panic!("over-policy append reserves no work"),
        );
        assert_eq!(result.err(), Some(Fault::not_started("source_limit")));
        assert!(engine.contains("r", "k", lease));
        let work = engine
            .begin_append(
                "r",
                "k",
                lease,
                second.revision,
                second.source_bytes,
                String::new(),
                true,
                &mut |_| true,
            )
            .unwrap();
        execute(&mut engine, work);
        assert_eq!(engine.leases(), 0);
        assert_eq!(engine.retained_state_bytes(), 0);
    }
}

#[test]
fn expanded_context_words_are_aggregate_not_front_coded_wire_length() {
    let id = 1;
    let mut rows = vec![vec![0, id]];
    rows.extend((0..65535).map(|_| vec![1]));
    let input = raw(json!(rows));
    let bounds = Bounds {
        vocabulary_size: vocabulary::SCOPE_COUNT as u32,
        max_bytes: limits::DATA_BYTES,
    };
    // Empty records also consume decoded policy units, independently of word count.
    assert!(ContextPlan::inspect(&[&input], bounds).is_err());
    let deep = raw(json!([vec![0]
        .into_iter()
        .chain(std::iter::repeat_n(id, 256))
        .collect::<Vec<_>>()]
    .into_iter()
    .chain(std::iter::repeat_n(vec![256], 255))
    .collect::<Vec<_>>()));
    let extra = raw(json!([[0, id]]));
    assert_eq!(
        ContextPlan::inspect(&[&deep], bounds)
            .unwrap()
            .measurement()
            .words,
        65536
    );
    assert!(ContextPlan::inspect(&[&deep, &extra], bounds).is_err());
}

#[tokio::test]
async fn data_frame_refusal_recovers_ticket_without_spending_physical_credit() {
    let pool = ActorPool::new("limits".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let before = pool.stats().credits.bytes;
    let mut input = request(json!([source(0, "x")])).get().as_bytes().to_vec();
    input.extend(std::iter::repeat_n(b' ', 524289 - input.len()));
    let rejection = route.receive(input).err().unwrap();
    assert_eq!(rejection.ticket.as_deref(), Some("t"));
    assert_eq!(rejection.fault, Fault::not_started("frame_limit"));
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().credits.bytes, before);
    let Incoming::Control(control) = route
        .receive(br#"{"v":4,"op":"describe","ticket":"metadata"}"#.to_vec())
        .unwrap()
    else {
        panic!("metadata")
    };
    drop(control);
    route.close();
    pool.shutdown().await.unwrap();
}

#[test]
fn data_reply_writer_stops_at_policy_cap_while_control_encoding_keeps_emergency_guard() {
    let budget = Budget::new(limits::DATA_BYTES, 1, 1);
    let mut credit = budget.reserve(Some("r"), 0).unwrap();
    let reply = semantic_reply::ok("t", "limits", json!({"text":"x".repeat(524288)}));
    assert!(
        reply.encode().is_ok(),
        "generic source-free writer retains emergency cap"
    );
    let result = reply.encode_with_credit(&mut credit, 524288);
    assert_eq!(result.unwrap_err(), Fault::started("reply_limit"));
    assert!(budget.snapshot().bytes <= 524288);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(credit);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn exported_native_defaults_match_shared_numeric_policy() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/syntax-v3/highlighting-limits.json"
    ))
    .unwrap();
    assert_eq!(
        json!({
            "sourceBytes": limits::SOURCE_BYTES,
            "sourceLines": limits::SOURCE_LINES,
            "piSourceBytes": limits::PI_SOURCE_BYTES,
            "dataWireBytes": limits::DATA_WIRE_BYTES,
            "contextWords": limits::CONTEXT_WORDS,
            "decodedBytes": limits::DECODED_BYTES,
        }),
        expected
    );
    let engine = Limits::default();
    assert_eq!(engine.source_bytes, limits::SOURCE_BYTES);
    assert_eq!(engine.line_bytes, 65536);
    assert_eq!(limits::DATA_BYTES, 1 << 30);
    assert_eq!(limits::DATA_PER_ROUTE, 2);
}

#[tokio::test]
async fn source_producer_enforces_aggregate_expanded_result_across_batch_members() {
    let pool = ActorPool::new("limits".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let nested = "[".repeat(100) + "0" + &"]".repeat(100) + "\n";
    let mut one = source(0, &nested);
    one["hint"]["language"] = json!("json");
    let Incoming::Data(mut ticket) = route
        .receive(request(json!([one.clone()])).get().as_bytes().to_vec())
        .unwrap()
    else {
        panic!("data")
    };
    let delivery = ticket.take().await.unwrap();
    let first: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(first["status"], "ok", "{first}");
    let words: usize = first["body"]["sources"][0]["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row[0].as_u64().unwrap() as usize + row.as_array().unwrap().len() - 1)
        .sum();
    assert!(
        words <= limits::CONTEXT_WORDS && words * 8 > limits::CONTEXT_WORDS,
        "{words}"
    );
    delivery.flushed();
    drop(ticket);
    pool.barrier().await.unwrap();
    let batch: Vec<_> = (0..8)
        .map(|i| {
            let mut value = one.clone();
            value["key"] = json!(i.to_string());
            value
        })
        .collect();
    let Incoming::Data(mut ticket) = route
        .receive(request(json!(batch)).get().as_bytes().to_vec())
        .unwrap()
    else {
        panic!("data")
    };
    let delivery = ticket.take().await.unwrap();
    let result: Value = serde_json::from_slice(delivery.bytes()).unwrap();
    assert_eq!(
        result["error"],
        json!({"code":"context_limit","execution":"started"}),
        "{result}"
    );
    assert_eq!(pool.stats().credits.jobs, 1);
    assert_eq!(pool.stats().leases, 0);
    delivery.flushed();
    drop(ticket);
    route.close();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().credits.bytes, 0);
    pool.shutdown().await.unwrap();
}

#[test]
fn style_input_caps_frame_and_expansion_before_owned_work_while_retaining_failure_credit() {
    use occipital::{
        resolver::Resolver,
        semantic::{Expression, Ink},
        style_request::StyleRequestPlan,
        style_work::StyleWork,
    };
    let valid = json!({"v":4,"op":"styles.resolve","ticket":"style","instance":"limits","admission":"try_now",
        "vocabulary":vocabulary::FINGERPRINT,"contexts":[],"rules":{"kind":"native","id":"syntect:Theme","fingerprint":"a".repeat(64)}});
    let text = valid.to_string();
    let padded = text.replacen(
        '{',
        &format!("{{{}", " ".repeat(limits::DATA_WIRE_BYTES + 1 - text.len())),
        1,
    );
    let padded = RawValue::from_string(padded).unwrap();
    assert_eq!(
        StyleRequestPlan::inspect(&padded, "limits", limits::DATA_BYTES)
            .err()
            .unwrap(),
        Fault::not_started("frame_limit")
    );
    let resolver = Resolver::compile(
        Expression {
            foreground: Ink::Inherit {},
            background: Ink::Inherit {},
            attributes: 0,
            attribute_mask: 0,
        },
        vec![],
    );
    for contexts in [
        vec![vec![1; 257]; 256],
        vec![vec![]; limits::DECODED_BYTES / 128 + 1],
    ] {
        let budget = Budget::new(limits::DATA_BYTES, 1, 1);
        let failure = StyleWork::new(
            contexts,
            &resolver,
            "a".repeat(64),
            budget.reserve(Some("r"), 1024).unwrap(),
        )
        .err()
        .unwrap();
        assert_eq!(failure.fault, Fault::not_started("context_limit"));
        assert_eq!(budget.snapshot().bytes, 1024);
        assert_eq!(budget.snapshot().jobs, 1);
        drop(failure);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}

#[test]
fn decoded_context_policy_counts_empty_records_at_the_exact_boundary() {
    let bounds = Bounds {
        vocabulary_size: vocabulary::SCOPE_COUNT as u32,
        max_bytes: limits::DATA_BYTES,
    };
    let rows = vec![vec![0]; limits::DECODED_BYTES / 128];
    let exact = raw(json!(rows));
    let plan = ContextPlan::inspect(&[&exact], bounds).unwrap();
    assert_eq!(plan.measurement().words, 0);
    assert_eq!(plan.measurement().policy_bytes, limits::DECODED_BYTES);
    let extra = raw(json!([[0]]));
    assert!(ContextPlan::inspect(&[&exact, &extra], bounds).is_err());
}
