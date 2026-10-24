use occipital::{
    actor::PoolStats,
    catalogue::Catalogue,
    credit::{Budget, Snapshot},
    ingress::CONTROL_REPLY_BYTES,
    limits,
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
fn descriptor_exposes_only_native_metadata_and_exact_generated_identities() {
    // Explicitly absent platform root: never consult the test operator's files.
    let catalogue = Catalogue::from_os_root(None);
    let snapshot = catalogue.snapshot();
    let body = semantic_description::describe(
        &snapshot,
        catalogue.diagnostic(),
        &Limits::default(),
        stats(),
    );
    let value = serde_json::to_value(body).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 19);
    assert_eq!(value["kind"], "descriptor");
    assert_eq!(value["protocol_version"], 3);
    for field in ["contexts_revision", "palette_revision"] {
        assert_eq!(value[field], 1);
    }
    assert_eq!(value["source_hint_revision"], 2);
    assert_eq!(
        value["vocabulary"],
        json!({"fingerprint":vocabulary::FINGERPRINT,"count":vocabulary::SCOPE_COUNT})
    );
    assert_eq!(value["resolver_revision"], 2);
    assert_eq!(value["assets"], vocabulary::ASSET_FINGERPRINT);
    assert_eq!(value["backend_version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(value["catalogue_revision"], snapshot.revision());
    assert_eq!(value["capability"], "syntax-highlight/v3");
    assert_eq!(value["service"], "syntax");
    assert_eq!(value["operations"], json!(OPERATIONS));
    assert!(value["operations"]
        .as_array()
        .unwrap()
        .contains(&json!("styles.resolve")));
    assert_eq!(value["modes"], json!(["one_shot", "growing"]));
    assert_eq!(value["admission"], json!(["try_now", "bounded_queue"]));
    let profiles = value["profiles"].as_array().unwrap();
    assert_eq!(profiles.len(), 32);
    for profile in profiles {
        assert_eq!(profile.as_object().unwrap().len(), 3);
        assert_ne!(profile["id"], "pi");
        assert!(profile["id"].is_string() && profile["label"].is_string());
        assert_eq!(profile["fingerprint"].as_str().unwrap().len(), 64);
    }
    assert!(!value.as_object().unwrap().contains_key("category_version"));
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
}

#[test]
fn descriptor_keeps_control_credit_through_bounded_serialization_and_honors_active_source_cap() {
    let catalogue = Catalogue::from_os_root(None);
    let snapshot = catalogue.snapshot();
    for source_bytes in [127, limits::SOURCE_BYTES + 1] {
        let limits = Limits {
            source_bytes,
            ..Limits::default()
        };
        let body =
            semantic_description::describe(&snapshot, catalogue.diagnostic(), &limits, stats());
        let budget = Budget::new(1 << 20, 1, 1);
        let mut credit = budget.reserve(Some("control"), 0).unwrap();
        credit.started();
        let bytes = semantic_reply::ok("ticket", "instance", body)
            .encode_with_credit(&mut credit, CONTROL_REPLY_BYTES)
            .unwrap();
        assert!(bytes.len() <= CONTROL_REPLY_BYTES);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["v"], 3);
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
