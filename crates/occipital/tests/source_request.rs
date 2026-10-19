use occipital::{
    limits,
    source_request::{Admission, SourceOperation, SourceRequest},
};
use serde_json::{json, value::RawValue, Value};
fn frame(sources: Value) -> Value {
    json!({"v":3,"op":"highlight","ticket":"ticket","instance":"instance","admission":"try_now","sources":sources})
}
fn source(key: &str) -> Value {
    json!({"key":key,"generation":2,"source_version":5,"hint":{"language":"rust"},"text":"let x = \"界\";\n"})
}
fn raw(value: &Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).unwrap()
}

#[test]
fn the_whole_batch_is_validated_before_the_owned_payload_reservation() {
    let valid = frame(json!([source("a"), source("b")]));
    let mut grants = Vec::new();
    let input = raw(&valid);
    let request = SourceRequest::decode(&input, "instance", limits::SOURCE_BYTES, &mut |n| {
        grants.push(n);
        true
    })
    .unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(request.ticket, "ticket");
    assert_eq!(request.admission, Some(Admission::TryNow));
    let SourceOperation::Finite { sources, open } = request.operation else {
        panic!("wrong operation")
    };
    assert!(!open);
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].key, "a");
    assert_eq!(sources[0].generation, 2);
    assert_eq!(sources[0].source_version, 5);
    assert_eq!(sources[0].text, "let x = \"界\";\n");
    assert_eq!(sources[0].hint.language.as_deref(), Some("rust"));
    assert!(grants[0] >= sources.iter().map(|s| s.text.len()).sum::<usize>());
    let mut calls = 0;
    let error = SourceRequest::decode(&input, "instance", limits::SOURCE_BYTES, &mut |_| {
        calls += 1;
        false
    })
    .err()
    .unwrap();
    assert_eq!(error.code, "data_limit");
    assert!(!error.started);
    assert_eq!(calls, 1);
    let mut cases = Vec::new();
    let mut missing = valid.clone();
    missing["sources"][1]
        .as_object_mut()
        .unwrap()
        .remove("text");
    cases.push(missing);
    let mut profile = valid.clone();
    profile["sources"][1]["profile"] = json!("pi");
    cases.push(profile);
    let mut duplicate = valid.clone();
    duplicate["sources"][1]["key"] = json!("a");
    cases.push(duplicate);
    let mut malformed = valid.clone();
    malformed["sources"][1]["text"] = json!(["not a string"]);
    cases.push(malformed);
    let mut path = valid.clone();
    path["sources"][1]["hint"]["path"] = json!("x".repeat(4097));
    cases.push(path);
    for value in cases {
        let mut calls = 0;
        let error =
            SourceRequest::decode(&raw(&value), "instance", limits::SOURCE_BYTES, &mut |_| {
                calls += 1;
                true
            })
            .err()
            .unwrap();
        assert!(!error.started);
        assert_eq!(calls, 0, "{value}");
    }
}
#[test]
fn source_count_and_open_shape_keep_existing_bounds_without_source_theme_fields() {
    for count in [0, 9] {
        let input = raw(&frame(json!((0..count)
            .map(|i| source(&i.to_string()))
            .collect::<Vec<_>>())));
        assert!(
            SourceRequest::decode(&input, "instance", limits::SOURCE_BYTES, &mut |_| panic!(
                "materialization before shape check"
            ))
            .is_err()
        );
    }
    let mut value = frame(json!([source("a"), source("b")]));
    value["op"] = json!("stream.open");
    assert!(SourceRequest::decode(
        &raw(&value),
        "instance",
        limits::SOURCE_BYTES,
        &mut |_| panic!("two-source open")
    )
    .is_err());
    value["sources"] = json!([source("a")]);
    let request =
        SourceRequest::decode(&raw(&value), "instance", limits::SOURCE_BYTES, &mut |_| {
            true
        })
        .unwrap();
    assert!(matches!(
        request.operation,
        SourceOperation::Finite { open: true, .. }
    ));
    value["key"] = Value::Null;
    assert!(SourceRequest::decode(
        &raw(&value),
        "instance",
        limits::SOURCE_BYTES,
        &mut |_| panic!("irrelevant null field")
    )
    .is_err());
}
fn append() -> Value {
    json!({"v":3,"op":"stream.append","ticket":"ticket","instance":"instance","admission":"bounded_queue","queue_wait_ms":1000,
    "key":"source","lease":"lease","generation":2,"source_version":5,"base_revision":1,"base_bytes":12,"append":"界","final":true})
}
#[test]
fn append_and_close_keep_exact_lease_metadata_and_share_admission_policy() {
    let request = SourceRequest::decode(
        &raw(&append()),
        "instance",
        limits::SOURCE_BYTES,
        &mut |_| true,
    )
    .unwrap();
    assert_eq!(request.admission, Some(Admission::BoundedQueue(1000)));
    let SourceOperation::Append {
        key,
        lease,
        generation,
        source_version,
        base_revision,
        base_bytes,
        append,
        finalize,
    } = request.operation
    else {
        panic!("not append")
    };
    assert_eq!(
        (
            key.as_str(),
            lease.as_str(),
            generation,
            source_version,
            base_revision,
            base_bytes,
            append.as_str(),
            finalize
        ),
        ("source", "lease", 2, 5, 1, 12, "界", true)
    );
    let value = json!({"v":3,"op":"stream.close","ticket":"ticket","instance":"instance","key":"source","lease":"lease","generation":2});
    let request =
        SourceRequest::decode(&raw(&value), "instance", limits::SOURCE_BYTES, &mut |_| {
            true
        })
        .unwrap();
    assert!(request.admission.is_none());
    assert!(matches!(
        request.operation,
        SourceOperation::Close { generation: 2, .. }
    ));
    for field in [
        "admission",
        "append",
        "queue_wait_ms",
        "base_bytes",
        "final",
        "source_version",
    ] {
        let mut value = value.clone();
        value[field] = Value::Null;
        assert!(SourceRequest::decode(
            &raw(&value),
            "instance",
            limits::SOURCE_BYTES,
            &mut |_| panic!("irrelevant close field")
        )
        .is_err());
    }
}
#[test]
fn total_append_bytes_bad_queue_and_stale_instances_reject_before_payload_allocation() {
    let mut cases = Vec::new();
    let mut value = append();
    value["base_bytes"] = json!(limits::SOURCE_BYTES - 1);
    cases.push(value);
    let mut value = append();
    value["queue_wait_ms"] = json!(1001);
    cases.push(value);
    let mut value = append();
    value["generation"] = json!(0);
    cases.push(value);
    let mut value = append();
    value["instance"] = json!("old-instance");
    cases.push(value);
    let mut value = append();
    value["final"] = json!("true");
    cases.push(value);
    let mut value = append();
    value["base_revision"] = json!(0);
    cases.push(value);
    let mut value = append();
    value["fingerprint"] = json!("a".repeat(64));
    cases.push(value);
    for value in cases {
        assert!(
            !SourceRequest::decode(
                &raw(&value),
                "instance",
                limits::SOURCE_BYTES,
                &mut |_| panic!("invalid data materialized")
            )
            .err()
            .unwrap()
            .started
        );
    }
}
#[test]
fn raw_numeric_spellings_and_duplicate_fields_have_the_same_integer_boundary() {
    let text = append()
        .to_string()
        .replace("\"generation\":2", "\"generation\":2e0")
        .replace("\"source_version\":5", "\"source_version\":5.0");
    let input = RawValue::from_string(text.clone()).unwrap();
    assert!(SourceRequest::decode(&input, "instance", limits::SOURCE_BYTES, &mut |_| true).is_ok());
    for text in [
        text.replace("\"generation\":2e0", "\"generation\":15.9999999999999991"),
        text.replace("\"generation\":2e0", "\"generation\":2,\"generation\":2"),
    ] {
        assert!(SourceRequest::decode(
            &RawValue::from_string(text).unwrap(),
            "instance",
            limits::SOURCE_BYTES,
            &mut |_| panic!("bad numeric/duplicate input")
        )
        .is_err());
    }
}

#[test]
fn active_source_limit_applies_to_the_entire_batch_and_append_base_before_reservation() {
    let input = raw(&frame(json!([source("a"), source("b")])));
    let bytes = 2 * "let x = \"界\";\n".len();
    assert!(SourceRequest::decode(&input, "instance", bytes, &mut |_| true).is_ok());
    let error = SourceRequest::decode(&input, "instance", bytes - 1, &mut |_| {
        panic!("over-limit batch allocated")
    })
    .err()
    .unwrap();
    assert_eq!(error.code, "source_limit");
    let input = raw(&append());
    assert!(SourceRequest::decode(&input, "instance", 15, &mut |_| true).is_ok());
    let error = SourceRequest::decode(&input, "instance", 14, &mut |_| {
        panic!("over-limit append allocated")
    })
    .err()
    .unwrap();
    assert_eq!(error.code, "source_limit");
}

#[test]
fn a_batch_has_one_current_incarnation_per_key_before_any_payload_reservation() {
    for generation in [2, 3] {
        let mut other = source("a");
        other["generation"] = json!(generation);
        let input = raw(&frame(json!([source("a"), other])));
        let mut grants = 0;
        let result = SourceRequest::decode(&input, "instance", limits::SOURCE_BYTES, &mut |_| {
            grants += 1;
            true
        });
        assert_eq!(grants, 0, "same key, generation {generation}");
        let fault = result.err().expect("duplicate source key was admitted");
        assert_eq!(fault.code, "invalid_request");
        assert!(!fault.started);
    }
}

#[test]
fn admitted_batch_line_append_and_unicode_keep_exact_source_bytes() {
    for text in [
        "x".repeat(32768),
        ("x".repeat(8191) + "\n").repeat(4),
        "\tλ🧪\r\n".to_owned(),
    ] {
        let mut input = source("left");
        input["text"] = json!(text);
        let mut other = input.clone();
        other["key"] = json!("right");
        let request = SourceRequest::decode(
            &raw(&frame(json!([input, other]))),
            "instance",
            limits::SOURCE_BYTES,
            &mut |_| true,
        )
        .unwrap();
        let SourceOperation::Finite { sources, .. } = request.operation else {
            panic!()
        };
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].text, text);
        assert_eq!(sources[1].text, text);
        let mut input = append();
        input["append"] = json!(text);
        let request =
            SourceRequest::decode(&raw(&input), "instance", limits::SOURCE_BYTES, &mut |_| {
                true
            })
            .unwrap();
        let SourceOperation::Append { append, .. } = request.operation else {
            panic!()
        };
        assert_eq!(append, text);
    }
}
