use occipital::{
    credit::Budget,
    protocol::{Fault, SyntaxHint},
    semantic::{Expression, Ink, StyleKind, Styles},
    semantic_engine::{Engine, Limits},
    semantic_reply::{self, DataBody},
    semantic_reply::{SourceBody, SourceResult},
    vocabulary,
};
use serde_json::{json, Value};

fn hint() -> SyntaxHint {
    SyntaxHint {
        language: Some("rust".into()),
        path: None,
    }
}
fn record(
    chunk: occipital::semantic_engine::SourceChunk,
    complete: bool,
    lease: Option<String>,
) -> SourceBody {
    SourceBody::sources(vec![SourceResult {
        key: "source".into(),
        generation: 2,
        source_version: 5,
        complete,
        lease,
        chunk,
    }])
}

#[test]
fn a_real_finite_parse_encodes_flat_byte_pairs_and_full_contexts_without_theme_fields() {
    let mut engine = Engine::new(Limits::default());
    let text = "let x = \"界\";\n";
    let mut work = engine
        .begin_one_shot(text.into(), &hint(), &mut |_| true)
        .unwrap();
    while !engine.step(&mut work, &mut |_| true).unwrap() {}
    let chunk = engine.finish(work, &mut |_| true).unwrap();
    let counters = chunk.counters.clone();
    let pairs: Vec<u32> = chunk.runs.iter().flatten().copied().collect();
    let contexts = chunk.contexts.clone();
    let value = serde_json::to_value(record(chunk, true, None)).unwrap();
    assert_eq!(value["kind"], "source");
    assert_eq!(value["vocabulary"], vocabulary::FINGERPRINT);
    assert_eq!(value.as_object().unwrap().len(), 3);
    let source = &value["sources"][0];
    assert_eq!(source.as_object().unwrap().len(), 11);
    assert_eq!(source["key"], "source");
    assert_eq!(source["generation"], 2);
    assert_eq!(source["source_version"], 5);
    assert_eq!(source["revision"], 1);
    assert_eq!(source["source_bytes"], text.len());
    assert_eq!(source["replace_from"], 0);
    assert_eq!(source["committed_bytes"], text.len());
    assert_eq!(source["complete"], true);
    assert_eq!(source["contexts"], json!(contexts));
    assert_eq!(source["runs"], json!(pairs));
    assert_eq!(source["counters"], serde_json::to_value(counters).unwrap());
    assert!(source.get("lease").is_none());
    for forbidden in ["profile", "fingerprint", "styles", "chunk"] {
        assert!(source.get(forbidden).is_none());
    }
}

#[test]
fn retained_source_metadata_and_contexts_encode_after_exact_parser_lease_close() {
    let mut engine = Engine::new(Limits::default());
    let mut work = engine
        .begin_open("owner", "source", "let x = 1;".into(), &hint(), &mut |_| {
            true
        })
        .unwrap();
    let lease = work.lease().unwrap();
    while !engine.step(&mut work, &mut |_| true).unwrap() {}
    let chunk = engine.finish(work, &mut |_| true).unwrap();
    assert_eq!(engine.leases(), 1);
    let body = record(chunk, false, Some("wire-lease".into()));
    let before = serde_json::to_vec(&body).unwrap();
    assert!(engine.close("owner", "source", lease));
    assert_eq!(engine.retained_state_bytes(), 0);
    assert_eq!(serde_json::to_vec(&body).unwrap(), before);
    let source: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(source["sources"][0]["lease"], "wire-lease");
    assert_eq!(source["sources"][0]["complete"], false);
    assert_eq!(source["sources"][0].as_object().unwrap().len(), 12);
    assert_eq!(
        serde_json::to_value(SourceBody::Closed).unwrap(),
        json!({"kind":"closed"})
    );
}

#[test]
fn v4_source_and_style_replies_share_the_existing_bounded_envelope_and_drain_credit() {
    let style = Expression {
        foreground: Ink::Binding { slot: 0 },
        background: Ink::Inherit {},
        attributes: 0,
        attribute_mask: 31,
    };
    let bodies = [
        DataBody::Source(SourceBody::Closed),
        DataBody::Styles(Styles {
            kind: StyleKind::Styles,
            vocabulary: vocabulary::FINGERPRINT.into(),
            rules: "b".repeat(64),
            styles: vec![style],
            indices: vec![1],
        }),
    ];
    for (body, kind) in bodies.into_iter().zip(["closed", "styles"]) {
        let budget = Budget::new(1 << 20, 1, 1);
        let mut credit = budget.reserve(Some("route"), 0).unwrap();
        credit.started();
        let bytes = semantic_reply::ok("ticket", "instance", body)
            .encode_with_credit(&mut credit, 4096)
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["v"], 4);
        assert_eq!(value["assets"], vocabulary::ASSET_FINGERPRINT);
        assert_eq!(value["instance"], "instance");
        assert_eq!(value["ticket"], "ticket");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["body"]["kind"], kind);
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert!(budget.snapshot().bytes >= bytes.capacity());
        assert_eq!(budget.snapshot().jobs, 1);
        assert!(budget.reserve(Some("route"), 0).is_err());
        drop(bytes);
        assert_eq!(budget.snapshot().jobs, 1);
        drop(credit);
        assert_eq!(budget.snapshot().bytes, 0);
        assert_eq!(budget.snapshot().jobs, 0);
    }
}

#[test]
fn v4_errors_keep_exact_execution_evidence_and_do_not_release_the_callers_slot() {
    for fault in [
        Fault::not_started("invalid_request"),
        Fault::started("data_limit"),
    ] {
        let budget = Budget::new(4096, 1, 1);
        let mut credit = budget.reserve(Some("route"), 0).unwrap();
        credit.started();
        let bytes = semantic_reply::error::<()>("ticket", "instance", fault)
            .encode_with_credit(&mut credit, 4096)
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["v"], 4);
        assert_eq!(value["assets"], vocabulary::ASSET_FINGERPRINT);
        assert_eq!(value["status"], "error");
        assert_eq!(
            value["error"],
            json!({"code":fault.code,"execution":if fault.started{"started"}else{"not_started"}})
        );
        assert!(value.get("body").is_none());
        assert_eq!(budget.snapshot().jobs, 1);
        drop(bytes);
        drop(credit);
        assert_eq!(budget.snapshot().jobs, 0);
    }
}

#[test]
fn a_v4_limit_failure_keeps_admitted_credit_for_its_small_error_reply() {
    let budget = Budget::new(4096, 1, 1);
    let mut credit = budget.reserve(Some("route"), 0).unwrap();
    credit.started();
    let too_large = semantic_reply::ok("ticket", "instance", json!({"text":"x".repeat(4096)}));
    let fault = too_large.encode_with_credit(&mut credit, 512).unwrap_err();
    assert_eq!(fault.code, "reply_limit");
    assert_eq!(budget.snapshot().jobs, 1);
    drop(too_large);
    // The failed writer already dropped its buffer; reuse the same slot/credit.
    credit.resize(0).unwrap();
    let bytes = semantic_reply::error::<()>("ticket", "instance", fault)
        .encode_with_credit(&mut credit, 512)
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["error"]["code"],
        "reply_limit"
    );
    assert_eq!(budget.snapshot().jobs, 1);
    drop(bytes);
    drop(credit);
    assert_eq!(budget.snapshot().jobs, 0);
}
