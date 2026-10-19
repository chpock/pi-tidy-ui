use occipital::{
    style_request::{Admission, RuleInput, StyleRequestPlan},
    vocabulary::{self, ScopeId},
};
use serde_json::{json, value::RawValue, Value};

fn request() -> Value {
    json!({"v":3,"op":"styles.resolve","ticket":"ticket","instance":"instance","admission":"try_now",
        "vocabulary":vocabulary::FINGERPRINT,"contexts":[[0,ScopeId::from_name("source.rust").unwrap().get()]],
        "rules":{"kind":"native","id":"syntect:Theme","fingerprint":"a".repeat(64)}})
}
fn raw(value: Value) -> Box<RawValue> {
    serde_json::from_str(&value.to_string()).unwrap()
}
fn fault(value: Value) -> &'static str {
    StyleRequestPlan::inspect(&raw(value), "instance", 1 << 20)
        .err()
        .unwrap()
        .code
}

#[test]
fn native_and_client_inputs_share_the_same_admitted_context_plan() {
    let input = raw(request());
    let plan = StyleRequestPlan::inspect(&input, "instance", 1 << 20).unwrap();
    assert_eq!(plan.ticket, "ticket");
    assert_eq!(plan.admission, Admission::TryNow);
    assert_eq!(plan.policy_bytes, 128 + 16);
    assert!(matches!(plan.rules, RuleInput::Native { .. }));
    assert_eq!(
        plan.contexts.materialize()[0][0],
        vec![ScopeId::from_name("source.rust").unwrap().get()]
    );

    let mut client = request();
    client["rules"] = json!({"kind":"client","definition":{"revision":1,"binding_slots":0,
        "default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[]}});
    let input = raw(client);
    let plan = StyleRequestPlan::inspect(&input, "instance", 1 << 20).unwrap();
    assert!(plan.policy_bytes > 144);
    let RuleInput::Client(rules) = plan.rules else {
        panic!("expected generic rules")
    };
    assert_eq!(
        rules.fingerprint(),
        "f0faec99a62e1c36d8650d50fc00c19ec7107a78b9a97bb619dc1cf87dfd94ab"
    );
}

#[test]
fn exact_shape_identity_and_queue_guards_reject_before_any_data_execution() {
    for (field, value, code) in [
        ("v", json!(2), "protocol_mismatch"),
        ("vocabulary", json!("b".repeat(64)), "vocabulary_changed"),
        ("instance", json!("old"), "invalid_request"),
        ("op", json!("highlight"), "invalid_request"),
        ("profile", json!("pi"), "invalid_request"),
        ("queue_wait_ms", json!(null), "invalid_request"),
        ("contexts", json!([[0, 0]]), "unknown_scope"),
    ] {
        let mut value_copy = request();
        value_copy[field] = value;
        assert_eq!(fault(value_copy), code, "{field}");
    }
    for input in [
        json!({"kind":"native","id":"syntect:Theme","fingerprint":"a".repeat(64),"definition":null}),
        json!({"kind":"native","id":null,"fingerprint":"a".repeat(64)}),
        json!({"kind":"client","definition":{},"id":null}),
        json!({"kind":"client","definition":{},"extra":1}),
    ] {
        let mut value = request();
        value["rules"] = input;
        assert_eq!(fault(value), "invalid_request");
    }
    let mut value = request();
    value["admission"] = json!("bounded_queue");
    value["queue_wait_ms"] = json!(1);
    let input = raw(value);
    assert_eq!(
        StyleRequestPlan::inspect(&input, "instance", 1 << 20)
            .unwrap()
            .admission,
        Admission::BoundedQueue(1)
    );
}

#[test]
fn exact_context_credit_and_empty_native_palettes_do_not_need_source_text() {
    let input = raw(request());
    assert_eq!(
        StyleRequestPlan::inspect(&input, "instance", 144)
            .unwrap()
            .policy_bytes,
        144
    );
    let fault = StyleRequestPlan::inspect(&input, "instance", 143)
        .err()
        .unwrap();
    assert!(!fault.started);
    assert_eq!(fault.code, "context_limit");
    let mut value = request();
    value["contexts"] = json!([]);
    let input = raw(value);
    assert_eq!(
        StyleRequestPlan::inspect(&input, "instance", 0)
            .unwrap()
            .policy_bytes,
        0
    );
}

#[test]
fn positional_objects_duplicates_and_fractional_tokens_are_not_coerced() {
    let value = request().to_string();
    let duplicate = value.replacen("\"v\":3", "\"v\":3,\"v\":3", 1);
    for value in [
        duplicate,
        "[]".to_owned(),
        value.replace("\"contexts\":[[0,", "\"contexts\":[[0,15.9999999999999991,"),
    ] {
        let raw: Box<RawValue> = serde_json::from_str(&value).unwrap();
        assert!(StyleRequestPlan::inspect(&raw, "instance", 1 << 20).is_err());
    }
}
