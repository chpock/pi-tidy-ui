//! The transport validates this typed envelope before allocating parser work.
use occipital::request::{decode, AdmissionMode, Operation};
use serde_json::{json, Value};

fn source() -> Value {
    json!({"key":"source-1","generation":1,"source_version":2,"profile":"pi","fingerprint":"a".repeat(64),"hint":{"language":"typescript"},"text":"const x = 1;\n"})
}
fn highlight() -> Value {
    json!({"v":2,"ticket":"request-1","op":"highlight","instance":"instance-1","admission":"try_now","sources":[source()]})
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

#[test]
fn operations_preserve_source_and_distinguish_control_from_data() {
    let request = decode(&bytes(&highlight())).unwrap();
    assert_eq!(request.op, Operation::Highlight);
    assert_eq!(request.admission, Some(AdmissionMode::TryNow));
    assert_eq!(request.sources.unwrap()[0].text, "const x = 1;\n");
    for op in ["describe", "themes.refresh"] {
        let request = decode(&bytes(&json!({"v":2,"ticket":"control","op":op}))).unwrap();
        assert!(request.sources.is_none());
        assert!(decode(&bytes(
            &json!({"v":2,"ticket":"control","op":op,"sources":[source()]})
        ))
        .is_err());
    }
}

#[test]
fn append_has_explicit_lease_generation_base_and_no_open_snapshot() {
    let append = json!({"v":2,"ticket":"append","op":"stream.append","instance":"instance-1","admission":"bounded_queue","queue_wait_ms":50,"key":"source-1","lease":"opaque-lease","generation":1,"source_version":3,"base_revision":1,"base_bytes":13,"profile":"pi","fingerprint":"a".repeat(64),"append":"next()\n","final":false});
    let request = decode(&bytes(&append)).unwrap();
    assert_eq!(request.op, Operation::StreamAppend);
    assert_eq!(request.append.as_deref(), Some("next()\n"));
    for field in [
        "key",
        "lease",
        "generation",
        "source_version",
        "base_revision",
        "base_bytes",
        "profile",
        "fingerprint",
    ] {
        let mut bad = append.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(decode(&bytes(&bad)).is_err(), "missing {field}");
    }
    let mut bad = append;
    bad["sources"] = json!([source()]);
    assert!(decode(&bytes(&bad)).is_err());
}

#[test]
fn limits_precede_source_work_and_do_not_guess_operation_fields() {
    let mut bad = highlight();
    bad["v"] = json!(1);
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["extra"] = json!(true);
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["ticket"] = json!("x".repeat(65));
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["sources"] = json!((0..9).map(|_| source()).collect::<Vec<_>>());
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["sources"][0]["generation"] = json!(0);
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["sources"][0]["source_version"] = json!(1.5);
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["sources"][0]["fingerprint"] = json!("not-a-fingerprint");
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["queue_wait_ms"] = json!(1001);
    assert!(decode(&bytes(&bad)).is_err());
    bad = highlight();
    bad["sources"][0]["hint"]["path"] = json!("x\u{0}y");
    assert!(decode(&bytes(&bad)).is_err());
    assert!(decode(br#"{"v":2,"v":2,"ticket":"x","op":"describe"}"#).is_err());
}

#[test]
fn batch_source_budget_is_checked_but_long_lines_are_not_refused() {
    let mut bad = highlight();
    let long = "x".repeat(65_537);
    bad["sources"][0]["text"] = json!(long);
    assert_eq!(decode(&bytes(&bad)).unwrap().sources.unwrap()[0].text, long);
    let append = json!({"v":2,"ticket":"append-long","op":"stream.append","instance":"instance-1","admission":"try_now","key":"source-1","lease":"opaque-lease","generation":1,"source_version":3,"base_revision":1,"base_bytes":13,"profile":"pi","fingerprint":"a".repeat(64),"append":long,"final":false});
    assert_eq!(decode(&bytes(&append)).unwrap().append.unwrap(), long);
    let line = "x".repeat(8191) + "\n";
    let source_text = line.repeat(65);
    bad = highlight();
    bad["sources"][0]["text"] = json!(source_text);
    let mut second = bad["sources"][0].clone();
    second["key"] = json!("distinct-source");
    bad["sources"].as_array_mut().unwrap().push(second);
    let result = decode(&bytes(&bad));
    // Previously refused merely because these two ordinary snapshots exceeded
    // 1 MiB together. Scaled cumulative rejection is covered in request.rs units.
    let accepted = result.unwrap();
    assert_eq!(accepted.sources.unwrap().len(), 2);
    let mut duplicate = highlight();
    let item = source();
    duplicate["sources"] = json!([item.clone(), item]);
    assert!(decode(&bytes(&duplicate)).is_err());
    let unicode = "\tλ🧪\r\n";
    let mut valid = highlight();
    valid["sources"][0]["text"] = json!(unicode);
    assert_eq!(
        decode(&bytes(&valid)).unwrap().sources.unwrap()[0].text,
        unicode
    );
}
