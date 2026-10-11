use occipital::{
    engine::{Engine, Limits},
    protocol::{Fault, SyntaxHint},
    reply::{Reply, SourceReply},
};
use serde_json::{json, Value};

#[test]
fn complete_source_reply_contains_negotiated_identity_and_compact_ranges() {
    let chunk = Engine::new(Limits::default())
        .one_shot(
            "const x=1;\n",
            &SyntaxHint {
                language: Some("typescript".into()),
                path: None,
            },
            "pi",
        )
        .unwrap();
    let expected = chunk.runs.clone();
    let bytes=Reply::ok("ticket","incarnation",json!({"kind":"source","sources":[SourceReply {key:"key".into(),generation:1,source_version:7,lease:None,complete:true,chunk}]})).encode().unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["v"], 2);
    assert_eq!(value["ticket"], "ticket");
    assert_eq!(value["instance"], "incarnation");
    assert_eq!(value["assets"], occipital::protocol::ASSETS);
    assert_eq!(value["status"], "ok");
    let source = &value["body"]["sources"][0];
    assert_eq!(source["key"], "key");
    assert_eq!(source["source_version"], 7);
    assert_eq!(source["profile"], "pi");
    assert!(source.get("lease").is_none());
    let runs = source["runs"].as_array().unwrap();
    assert!(!runs.is_empty());
    assert_eq!(runs.len() % 2, 0);
    assert_eq!(
        runs.as_chunks::<2>()
            .0
            .iter()
            .map(|pair| pair[0].as_u64().unwrap())
            .sum::<u64>(),
        "const x=1;\n".len() as u64
    );
    for (pair, canonical) in runs.as_chunks::<2>().0.iter().zip(&expected) {
        assert_eq!(pair[0].as_u64().unwrap(), u64::from(canonical[1]));
        assert_eq!(pair[1].as_u64().unwrap(), u64::from(canonical[2]));
    }
    assert!(runs.iter().all(Value::is_number));
}
#[test]
fn application_errors_do_not_fabricate_source_or_profile_acknowledgements() {
    for (fault, execution) in [
        (Fault::not_started("busy"), "not_started"),
        (Fault::started("cancelled"), "started"),
    ] {
        let bytes = Reply::<()>::error("ticket", "instance", fault)
            .encode()
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["error"]["execution"], execution);
        assert!(value.get("body").is_none());
        assert!(value.get("profile").is_none());
    }
}
#[test]
fn json_range_lengths_reconstruct_the_exact_canonical_utf8_suffix() {
    use occipital::protocol::{Chunk, Counters, Role, WireStyle};
    // The preceding four bytes are caller-owned; this patch starts mid-source.
    // Positive lengths, not repeated absolute endpoints, remain small as sources grow.
    let chunk = Chunk {
        revision: 2,
        source_bytes: 11,
        committed_bytes: 11,
        replace_from: 4,
        profile: "pi".into(),
        fingerprint: "a".repeat(64),
        styles: vec![
            WireStyle::Pi { role: Role::Plain },
            WireStyle::Pi {
                role: Role::SyntaxString,
            },
        ],
        runs: vec![[4, 2, 0], [6, 4, 1], [10, 1, 0]],
        counters: Counters::default(),
    };
    let bytes = Reply::ok("lengths", "instance", &chunk).encode().unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["body"]["runs"], json!([2, 0, 4, 1, 1, 0]));
    let mut offset = chunk.replace_from;
    for (pair, canonical) in value["body"]["runs"]
        .as_array()
        .unwrap()
        .as_chunks::<2>()
        .0
        .iter()
        .zip(&chunk.runs)
    {
        assert_eq!(canonical[0], offset);
        assert_eq!(pair[0].as_u64().unwrap(), u64::from(canonical[1]));
        assert_eq!(pair[1].as_u64().unwrap(), u64::from(canonical[2]));
        offset += pair[0].as_u64().unwrap() as u32;
    }
    assert_eq!(offset, chunk.source_bytes);
}

#[test]
fn changed_range_semantics_have_a_distinct_negotiated_protocol_version() {
    assert_eq!(occipital::protocol::PROTOCOL_VERSION, 2);
    assert_eq!(occipital::protocol::CAPABILITY, "syntax-highlight/v2");
    let value: Value = serde_json::from_slice(
        &Reply::<()>::error("t", "i", Fault::not_started("busy"))
            .encode()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["v"], 2);
}
