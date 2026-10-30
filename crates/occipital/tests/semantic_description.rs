use occipital::{
    actor::PoolStats,
    credit::Snapshot,
    ingress::CONTROL_REPLY_BYTES,
    limits,
    semantic::CAPABILITY,
    semantic_description::{self, OPERATIONS},
    semantic_engine::Limits,
    semantic_reply, vocabulary,
};
use serde_json::{json, Value};

fn stats() -> PoolStats {
    PoolStats {
        credits: Snapshot {
            bytes: 2048,
            jobs: 2,
            queued: 1,
            ..Default::default()
        },
        control_credits: Snapshot {
            bytes: 512,
            jobs: 1,
            ..Default::default()
        },
        workers: 2,
        routes: 1,
        leases: 3,
    }
}

#[test]
fn descriptor_exposes_only_protocol_v4_source_capabilities_and_generated_identities() {
    let value =
        serde_json::to_value(semantic_description::describe(&Limits::default(), stats())).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 15);
    assert_eq!(value["kind"], "descriptor");
    assert_eq!(value["protocol_version"], 4);
    assert_eq!(value["contexts_revision"], 1);
    assert_eq!(value["resolver_revision"], 3);
    assert_eq!(value["source_hint_revision"], 2);
    assert_eq!(
        value["vocabulary"],
        json!({"fingerprint":vocabulary::FINGERPRINT,"count":vocabulary::SCOPE_COUNT})
    );
    assert_eq!(value["assets"], vocabulary::ASSET_FINGERPRINT);
    assert_eq!(value["backend_version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["capability"], CAPABILITY);
    assert_eq!(value["service"], "syntax");
    assert_eq!(value["operations"], json!(OPERATIONS));
    assert_eq!(value["operations"].as_array().unwrap().len(), 6);
    assert_eq!(value["modes"], json!(["one_shot", "growing"]));
    assert_eq!(value["admission"], json!(["try_now", "bounded_queue"]));
    assert_eq!(value["limits"].as_object().unwrap().len(), 19);
    assert!(value["limits"].get("styles").is_none());
    assert_eq!(value["limits"]["request_bytes"], limits::DATA_WIRE_BYTES);
    assert_eq!(value["limits"]["reply_bytes"], limits::DATA_WIRE_BYTES);
    assert_eq!(value["limits"]["source_bytes"], limits::SOURCE_BYTES);
    assert_eq!(value["limits"]["line_bytes"], 65536);
    assert_eq!(
        value["runtime"],
        json!({"pid":std::process::id(),"routes":1,"leases":3,"data_bytes":2048,
        "data_jobs":2,"queued":1,"control_bytes":512,"control_jobs":1})
    );
    for field in [
        "profiles",
        "catalogue_revision",
        "palette_revision",
        "diagnostic",
    ] {
        assert!(!value.as_object().unwrap().contains_key(field), "{field}");
    }
}

#[test]
fn descriptor_keeps_control_credit_through_bounded_serialization_and_honors_active_source_cap() {
    for source_bytes in [127, limits::SOURCE_BYTES + 1] {
        let configured = Limits {
            source_bytes,
            ..Limits::default()
        };
        let body = semantic_description::describe(&configured, stats());
        let budget = occipital::credit::Budget::new(1 << 20, 1, 1);
        let mut credit = budget.reserve(Some("control"), 0).unwrap();
        credit.started();
        let bytes = semantic_reply::ok("ticket", "instance", body)
            .encode_with_credit(&mut credit, CONTROL_REPLY_BYTES)
            .unwrap();
        assert!(bytes.len() <= CONTROL_REPLY_BYTES);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["v"], 4);
        assert_eq!(value["body"]["assets"], value["assets"]);
        assert_eq!(
            value["body"]["limits"]["source_bytes"],
            source_bytes.min(limits::SOURCE_BYTES)
        );
        assert_eq!(
            value["body"]["limits"]["data_per_route"],
            limits::DATA_PER_ROUTE
        );
        assert_eq!(value["body"]["limits"]["routes"], limits::ROUTES);
        assert_eq!(value["body"]["limits"]["workers"], 2);
        assert_eq!(budget.snapshot().jobs, 1);
        assert!(budget.snapshot().bytes >= bytes.capacity());
        drop(bytes);
        assert_eq!(budget.snapshot().jobs, 1);
        drop(credit);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}
