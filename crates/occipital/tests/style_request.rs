use occipital::{
    style_request::{Admission, StyleRequestPlan},
    vocabulary::{self, ScopeId},
};
use serde_json::{json, value::RawValue, Value};

fn definition() -> Value {
    json!({"revision":2,"binding_slots":0,
        "default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[]})
}
fn request() -> Value {
    json!({"v":4,"op":"styles.resolve","ticket":"ticket","instance":"instance","admission":"try_now",
        "vocabulary":vocabulary::FINGERPRINT,"contexts":[[0,ScopeId::from_name("source.rust").unwrap().get()]],
        "rules":definition()})
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
fn common_rules_and_contexts_share_one_admitted_v4_style_plan() {
    let input = raw(request());
    let plan = StyleRequestPlan::inspect(&input, "instance", 1 << 20).unwrap();
    assert_eq!(plan.ticket, "ticket");
    assert_eq!(plan.admission, Admission::TryNow);
    assert_eq!(
        plan.policy_bytes,
        plan.rules.measurement().policy_bytes + plan.contexts.measurement().policy_bytes
    );
    assert_eq!(
        plan.contexts.materialize()[0][0],
        vec![ScopeId::from_name("source.rust").unwrap().get()]
    );

    let mut qualified = definition();
    qualified["binding_slots"] = json!(44);
    qualified["rules"] = json!([{"path":["string"],"excludes":[],"foreground":{"kind":"binding","slot":7},
        "background":null,"font":null,"context":{"owner":"string","boundaries":[]}}]);
    let mut value = request();
    value["rules"] = qualified;
    assert!(
        StyleRequestPlan::inspect(&raw(value), "instance", 1 << 20)
            .unwrap()
            .rules
            .measurement()
            .contexts
            > 0
    );
}

#[test]
fn exact_shape_identity_and_queue_guards_reject_before_any_data_execution() {
    for (field, value, code) in [
        ("v", json!(3), "protocol_mismatch"),
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
    let mut missing_context = request();
    missing_context["rules"]["rules"] =
        json!([{"path":["string"],"excludes":[],"foreground":null,"background":null,"font":null}]);
    assert_eq!(fault(missing_context), "invalid_rules");
    let mut bad_qualifier = request();
    bad_qualifier["rules"]["rules"] = json!([{"path":["string"],"excludes":[],"foreground":null,"background":null,"font":null,
        "context":{"owner":"string","boundaries":["invalid.owner"]}}]);
    assert_eq!(fault(bad_qualifier), "unknown_scope");
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
fn rule_names_and_expanded_context_are_funded_before_compilation() {
    let input = raw(request());
    let measured = StyleRequestPlan::inspect(&input, "instance", occipital::limits::DATA_BYTES)
        .unwrap()
        .policy_bytes;
    assert!(measured > 0);
    assert_eq!(
        StyleRequestPlan::inspect(&input, "instance", measured)
            .unwrap()
            .policy_bytes,
        measured
    );
    let fault = StyleRequestPlan::inspect(&input, "instance", measured - 1)
        .err()
        .unwrap();
    assert!(!fault.started);
    assert!(matches!(
        fault.code,
        "allocation_limit" | "context_limit" | "data_limit"
    ));

    let mut value = request();
    value["contexts"] = json!([]);
    let input = raw(value);
    let empty_contexts =
        StyleRequestPlan::inspect(&input, "instance", occipital::limits::DATA_BYTES).unwrap();
    assert_eq!(empty_contexts.contexts.measurement().policy_bytes, 0);
    assert!(empty_contexts.policy_bytes >= empty_contexts.rules.measurement().policy_bytes);
}

#[test]
fn positional_objects_duplicates_and_fractional_tokens_are_not_coerced() {
    let value = request().to_string();
    let duplicate = value.replacen("\"v\":4", "\"v\":4,\"v\":4", 1);
    for value in [
        duplicate,
        "[]".to_owned(),
        value.replace("\"contexts\":[[0,", "\"contexts\":[[0,15.9999999999999991,"),
    ] {
        let raw: Box<RawValue> = serde_json::from_str(&value).unwrap();
        assert!(StyleRequestPlan::inspect(&raw, "instance", 1 << 20).is_err());
    }
}
