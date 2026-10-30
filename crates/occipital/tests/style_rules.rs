use occipital::{
    semantic::Ink,
    style_rules::{ClientRulePlan, Error},
    vocabulary::ScopeId,
};
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
#[derive(Deserialize)]
struct Vectors {
    client: Vec<Client>,
}
#[derive(Deserialize)]
struct Client {
    name: String,
    definition: Box<RawValue>,
    fingerprint: String,
}
fn document(text: impl Into<String>) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}
fn admitted(value: &Value) -> String {
    let raw = document(value.to_string());
    ClientRulePlan::inspect(&raw, usize::MAX)
        .unwrap()
        .fingerprint()
        .to_owned()
}
fn empty() -> Value {
    json!({"revision":2,"binding_slots":4,"default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[]})
}
fn declaration() -> Value {
    json!({"path":["comment"],"excludes":[],"foreground":null,"background":null,"font":null,"context":null})
}
fn definition(rule: Value) -> Value {
    let mut value = empty();
    value["rules"] = json!([rule]);
    value
}
fn rejected(value: &Value, expected: Error) {
    let raw = document(value.to_string());
    let error = ClientRulePlan::inspect(&raw, usize::MAX)
        .err()
        .unwrap_or_else(|| panic!("unexpectedly accepted: {value}"));
    assert_eq!(error, expected);
    assert!(!error.fault().started);
}
#[test]
fn shared_rule_vectors_and_independent_canonical_preimages_match() {
    let bytes = include_bytes!("../../../protocol/syntax-v4/rule-vectors.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        "4ea9e0413f99ee2692bdd7c444d079f476eaf8f6047892251241ae1c301d00fd"
    );
    let vectors: Vectors = serde_json::from_slice(bytes).unwrap();
    for vector in &vectors.client {
        let plan = ClientRulePlan::inspect(&vector.definition, usize::MAX).unwrap();
        assert_eq!(plan.fingerprint(), vector.fingerprint, "{}", vector.name);
    }
    let empty = b"occipital-client-rules/3\0\0\0\0\0\0\0\0\x07h/h/0/0\0\0\0\0";
    assert_eq!(
        format!("{:x}", Sha256::digest(empty)),
        vectors.client[0].fingerprint
    );
    let qualified = concat!(
        "occipital-client-rules/3\0",
        "\0\0\0\x2c",
        "\0\0\0\x07h/h/0/0",
        "\0\0\0\x01",
        "\0\0\0\x01",
        "\0\0\0\x17meta.object-literal.key",
        "\0\0\0\0",
        "\x01",
        "\0\0\0\x17meta.object-literal.key",
        "\0\0\0\x02",
        "\0\0\0\x12meta.array.literal",
        "\0\0\0\x18meta.template.expression",
        "\x01",
        "\0\0\0\x08b7/h/0/0"
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(qualified.as_bytes())),
        vectors.client[2].fingerprint
    );
}

#[test]
fn canonical_identity_ignores_json_order_escapes_and_number_spelling_but_not_fields() {
    let original = definition(declaration());
    let hash = admitted(&original);
    let text = original
        .to_string()
        .replace("comment", "\\u0063omment")
        .replace("\"revision\":1", "\"revi\\u0073ion\":1e0")
        .replace("\"binding_slots\":4", "\"binding_slots\":4.0");
    assert_eq!(
        ClientRulePlan::inspect(&document(text), usize::MAX)
            .unwrap()
            .fingerprint(),
        hash
    );
    let mut changed = original.clone();
    changed["default"]["foreground"] = json!({"kind":"rgb","r":1,"g":2,"b":3});
    assert_ne!(admitted(&changed), hash);
    let mut changed = original.clone();
    changed["binding_slots"] = json!(5);
    assert_ne!(admitted(&changed), hash);
    let mut changed = original.clone();
    changed["rules"][0]["path"] = json!(["comment", "markup.bold"]);
    let forward = admitted(&changed);
    changed["rules"][0]["path"] = json!(["markup.bold", "comment"]);
    assert_ne!(admitted(&changed), forward);
    let mut changed = original.clone();
    changed["rules"][0]["excludes"] = json!([["markup.bold"], ["markup.italic"]]);
    let forward = admitted(&changed);
    changed["rules"][0]["excludes"] = json!([["markup.italic"], ["markup.bold"]]);
    assert_ne!(admitted(&changed), forward);
    let mut changed = original.clone();
    let mut other = declaration();
    other["foreground"] = json!({"kind":"indexed","index":2});
    changed["rules"] = json!([declaration(), other.clone()]);
    let forward = admitted(&changed);
    changed["rules"] = json!([other, declaration()]);
    assert_ne!(admitted(&changed), forward);
    for field in ["source", "width", "kind", "pi_role", "colors"] {
        let mut value = original.clone();
        value[field] = json!("foreign");
        rejected(&value, Error::InvalidRules);
    }
}
#[test]
fn explicit_null_inherit_mask_zero_and_faint_clear_remain_distinct_when_compiled() {
    let mut seen = std::collections::HashSet::new();
    let variants = [
        (Value::Null, Value::Null),
        (json!({"kind":"inherit"}), Value::Null),
        (Value::Null, json!({"attributes":0,"attribute_mask":0})),
        (Value::Null, json!({"attributes":0,"attribute_mask":8})),
    ];
    for (fg, font) in variants {
        let mut rule = declaration();
        rule["foreground"] = fg.clone();
        rule["font"] = font.clone();
        let raw = document(definition(rule).to_string());
        let plan = ClientRulePlan::inspect(&raw, usize::MAX).unwrap();
        assert!(seen.insert(plan.fingerprint().to_owned()));
        let resolver = plan.compile();
        let mut cursor = resolver.cursor(1).unwrap();
        let value = cursor
            .resolve(&[ScopeId::from_name("comment").unwrap().scope()])
            .unwrap();
        assert_eq!(value.expression.foreground, Ink::Inherit {});
        assert_eq!(value.foreground.is_some(), !fg.is_null());
        assert_eq!(value.expression.attributes, 0);
        assert_eq!(
            value.expression.attribute_mask,
            if font.get("attribute_mask") == Some(&json!(8)) {
                8
            } else {
                0
            }
        );
    }
    assert_eq!(seen.len(), 4);
}
#[test]
fn trusted_public_selector_construction_preserves_path_exclusions_and_common_scoring() {
    let mut heading = declaration();
    heading["path"] = json!(["markup.heading"]);
    heading["foreground"] = json!({"kind":"binding","slot":2});
    heading["font"] = json!({"attributes":8,"attribute_mask":8});
    let mut bold = declaration();
    bold["path"] = json!(["markup.heading", "markup.bold"]);
    bold["excludes"] = json!([["comment"]]);
    bold["font"] = json!({"attributes":1,"attribute_mask":1});
    let mut value = empty();
    value["rules"] = json!([heading, bold]);
    let raw = document(value.to_string());
    let plan = ClientRulePlan::inspect(&raw, usize::MAX).unwrap();
    let measure = plan.measurement();
    assert_eq!(
        (measure.rules, measure.paths, measure.names, measure.atoms),
        (2, 3, 4, 7)
    );
    let resolver = plan.compile();
    let mut cursor = resolver.cursor(3).unwrap();
    let path: Vec<_> = ["markup.heading", "markup.bold"]
        .map(|n| ScopeId::from_name(n).unwrap().scope())
        .into();
    let style = cursor.resolve(&path).unwrap().expression;
    assert_eq!(style.foreground, Ink::Binding { slot: 2 });
    assert_eq!((style.attributes, style.attribute_mask), (9, 9));
    let mut excluded = path.clone();
    excluded.push(ScopeId::from_name("comment").unwrap().scope());
    let style = cursor.resolve(&excluded).unwrap().expression;
    assert_eq!((style.attributes, style.attribute_mask), (8, 8));
    assert_eq!(
        cursor.resolve(&[]).unwrap().expression,
        resolver.default_expression().clone()
    );
    let mut global = declaration();
    global["path"] = json!([]);
    global["excludes"] = json!([[]]);
    global["foreground"] = json!({"kind":"binding","slot":1});
    let raw = document(definition(global).to_string());
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut cursor = resolver.cursor(1).unwrap();
    assert_eq!(
        cursor.resolve(&path[..1]).unwrap().expression.foreground,
        Ink::Inherit {}
    );
    writeln!(std::io::stdout(), "client compile measurement: {measure:?}").unwrap();
}
#[test]
fn generic_variable_rule_matches_parameter_leaves_outside_declaration_owners() {
    let mut variable = declaration();
    variable["path"] = json!(["variable"]);
    variable["excludes"] = json!([["invalid.illegal"], ["invalid.deprecated"]]);
    variable["foreground"] = json!({"kind":"binding","slot":0});
    let mut parameter = declaration();
    parameter["path"] = json!(["meta.function.parameters", "variable.parameter"]);
    parameter["excludes"] = json!([["invalid.illegal"], ["invalid.deprecated"]]);
    parameter["foreground"] = json!({"kind":"binding","slot":1});
    parameter["context"] = json!({"owner":"meta.function.parameters","boundaries":[]});
    let mut value = empty();
    value["rules"] = json!([variable, parameter]);
    let raw = document(value.to_string());
    let plan = ClientRulePlan::inspect(&raw, usize::MAX).unwrap();
    let mut cursor = plan.compile().cursor(8).unwrap();
    let path = |names: &[&str]| {
        names
            .iter()
            .map(|name| ScopeId::from_name(name).unwrap().scope())
            .collect::<Vec<_>>()
    };
    let declaration = path(&[
        "source.python",
        "meta.function.parameters.python",
        "variable.parameter.python",
    ]);
    let call_argument = path(&[
        "source.python",
        "meta.function-call.arguments.python",
        "variable.parameter.python",
    ]);
    let annotation_argument = path(&[
        "source.java",
        "meta.annotation.java",
        "meta.annotation.parameters.java",
        "variable.parameter.java",
    ]);
    assert_eq!(
        cursor.resolve(&declaration).unwrap().expression.foreground,
        Ink::Binding { slot: 1 }
    );
    assert_eq!(
        cursor
            .resolve(&call_argument)
            .unwrap()
            .expression
            .foreground,
        Ink::Binding { slot: 0 }
    );
    assert_eq!(
        cursor
            .resolve(&annotation_argument)
            .unwrap()
            .expression
            .foreground,
        Ink::Binding { slot: 0 }
    );
}

#[test]
fn strict_objects_required_nullable_fields_and_nested_shapes_reject() {
    for field in ["revision", "binding_slots", "default", "rules"] {
        let mut value = empty();
        value.as_object_mut().unwrap().remove(field);
        rejected(&value, Error::InvalidRules);
    }
    for field in ["path", "excludes", "foreground", "background", "font"] {
        let mut rule = declaration();
        rule.as_object_mut().unwrap().remove(field);
        rejected(&definition(rule), Error::InvalidRules);
    }
    for field in ["foreground", "background", "attributes", "attribute_mask"] {
        let mut value = empty();
        value["default"].as_object_mut().unwrap().remove(field);
        rejected(&value, Error::InvalidRules);
    }
    for field in ["attributes", "attribute_mask"] {
        let mut rule = declaration();
        rule["font"] = json!({"attributes":0,"attribute_mask":0});
        rule["font"].as_object_mut().unwrap().remove(field);
        rejected(&definition(rule), Error::InvalidRules);
    }
    for (needle, replacement) in [
        ("\"revision\":2", "\"revision\":2,\"revision\":2"),
        (
            "\"path\":[\"comment\"]",
            "\"path\":[\"comment\"],\"path\":[]",
        ),
        (
            "\"kind\":\"inherit\"",
            "\"kind\":\"inherit\",\"kind\":\"inherit\"",
        ),
        ("\"attributes\":0", "\"attributes\":0,\"attributes\":0"),
    ] {
        let text = definition(declaration()).to_string();
        assert!(text.contains(needle));
        assert_eq!(
            ClientRulePlan::inspect(&document(text.replacen(needle, replacement, 1)), usize::MAX)
                .err(),
            Some(Error::InvalidRules)
        );
    }
    for value in [Value::Null, json!([]), json!(false), json!("text")] {
        let mut def = empty();
        def["default"] = value.clone();
        rejected(&def, Error::InvalidRules);
        let mut rule = declaration();
        rule["path"] = if value.is_array() {
            json!([false])
        } else {
            value
        };
        rejected(&definition(rule), Error::InvalidRules);
    }
    let inherit = json!({"kind":"inherit"});
    rejected(&json!([1, 4, empty()["default"], []]), Error::InvalidRules);
    let mut positional = empty();
    positional["default"] = json!([inherit.clone(), inherit, 0, 0]);
    rejected(&positional, Error::InvalidRules);
    let mut positional = empty();
    positional["rules"] = json!([[[], [], null, null, null]]);
    rejected(&positional, Error::InvalidRules);
    for bad in [
        json!(["inherit"]),
        json!({"kind":"inherit","r":null}),
        json!({"kind":"terminal-default","slot":null}),
        json!({"kind":"rgb","r":{"deep":[1,2]},"g":2,"b":3}),
        json!({"kind":"rgb","r":1,"g":2}),
        json!({"kind":"rgb","r":256,"g":2,"b":3}),
        json!({"kind":{"rgb":null},"r":1,"g":2,"b":3}),
        json!({"kind":"indexed","index":-1}),
        json!({"kind":"binding","slot":4}),
        json!({"kind":"binding","slot":65536}),
        json!({"kind":"inherit","extra":[]}),
    ] {
        let mut def = empty();
        def["default"]["foreground"] = bad.clone();
        rejected(&def, Error::InvalidRules);
        let mut rule = declaration();
        rule["foreground"] = bad;
        rejected(&definition(rule), Error::InvalidRules);
    }
    for bad in [
        json!([0, 0]),
        json!({"attributes":1,"attribute_mask":0}),
        json!({"attributes":0,"attribute_mask":32}),
        json!({"attributes":0,"attribute_mask":0,"extra":null}),
        json!({"attributes":[],"attribute_mask":0}),
    ] {
        let mut rule = declaration();
        rule["font"] = bad;
        rejected(&definition(rule), Error::InvalidRules);
    }
}
#[test]
fn scalar_boundaries_and_all_ink_forms_are_validated_without_enum_content() {
    for ink in [
        json!({"kind":"rgb","r":0,"g":128,"b":255}),
        json!({"kind":"indexed","index":255}),
        json!({"kind":"terminal-default"}),
        json!({"kind":"binding","slot":65535}),
        json!({"kind":"inherit"}),
    ] {
        let mut value = empty();
        value["binding_slots"] = json!(65536);
        value["default"]["foreground"] = ink.clone();
        value["default"]["background"] = ink;
        assert!(!admitted(&value).is_empty());
    }
    for slots in [
        json!(-1),
        json!(65537),
        json!(1.5),
        Value::Null,
        json!({}),
        json!(true),
    ] {
        let mut value = empty();
        value["binding_slots"] = slots;
        rejected(&value, Error::InvalidRules);
    }
    for revision in [json!(0), json!(3), Value::Null] {
        let mut value = empty();
        value["revision"] = revision;
        rejected(&value, Error::InvalidRules);
    }
    let mut value = empty();
    value["binding_slots"] = json!(0);
    value["default"]["foreground"] = json!({"kind":"binding","slot":0});
    rejected(&value, Error::InvalidRules);
}
#[test]
fn actual_native_count_guards_and_exact_available_allocation_boundary() {
    let mut value = empty();
    value["rules"] = Value::Array(vec![declaration(); 512]);
    let raw = document(value.to_string());
    let plan = ClientRulePlan::inspect(&raw, usize::MAX).unwrap();
    let charge = plan.measurement().policy_bytes;
    assert!(ClientRulePlan::inspect(&raw, charge).is_ok());
    assert_eq!(
        ClientRulePlan::inspect(&raw, charge - 1).err(),
        Some(Error::AllocationLimit)
    );
    assert_eq!(
        ClientRulePlan::inspect(&raw, 0).err(),
        Some(Error::AllocationLimit)
    );
    value["rules"].as_array_mut().unwrap().push(declaration());
    rejected(&value, Error::RuleLimit);
    let mut rule = declaration();
    rule["path"] = json!([]);
    rule["excludes"] = Value::Array(vec![json!([]); 4095]);
    let raw = document(definition(rule.clone()).to_string());
    assert_eq!(
        ClientRulePlan::inspect(&raw, usize::MAX)
            .unwrap()
            .measurement()
            .paths,
        4096
    );
    rule["excludes"].as_array_mut().unwrap().push(json!([]));
    rejected(&definition(rule), Error::RuleLimit);
    let mut rule = declaration();
    rule["path"] = json!(vec!["comment"; 4096]);
    let raw = document(definition(rule.clone()).to_string());
    assert_eq!(
        ClientRulePlan::inspect(&raw, usize::MAX)
            .unwrap()
            .measurement()
            .atoms,
        4096
    );
    rule["path"].as_array_mut().unwrap().push(json!("comment"));
    rejected(&definition(rule), Error::RuleLimit);
    let mut rule = declaration();
    rule["path"] = json!(["x".repeat(256 * 1024 + 1)]);
    rejected(&definition(rule), Error::RuleLimit);
    let mut rule = declaration();
    rule["path"] = json!(["a.b.c.d.e.f.g.h.i"]);
    rejected(&definition(rule), Error::RuleLimit);
    let mut bad = declaration();
    bad["path"] = json!(["never-shipped-rule-name"]);
    let mut value = definition(declaration());
    value["rules"].as_array_mut().unwrap().push(bad);
    rejected(&value, Error::UnknownScope);
    writeln!(std::io::stdout(),"allocation boundary: 512 admitted rules reserve {charge} controlled bytes; exact passes, one byte short rejects").unwrap();
}

#[test]
fn each_expression_scalar_has_the_exact_canonical_key_and_framing() {
    let cases = [
        (
            json!({"kind":"rgb","r":1,"g":2,"b":255}),
            json!({"kind":"indexed","index":128}),
            5,
            15,
            "r1,2,255/i128/5/15",
        ),
        (
            json!({"kind":"terminal-default"}),
            json!({"kind":"inherit"}),
            8,
            8,
            "d/h/8/8",
        ),
        (
            json!({"kind":"binding","slot":65535}),
            json!({"kind":"binding","slot":0}),
            0,
            0,
            "b65535/b0/0/0",
        ),
        (
            json!({"kind":"inherit"}),
            json!({"kind":"terminal-default"}),
            0,
            15,
            "h/d/0/15",
        ),
    ];
    for (fg, bg, attributes, mask, key) in cases {
        let mut value = empty();
        value["binding_slots"] = json!(65536);
        value["default"] =
            json!({"foreground":fg,"background":bg,"attributes":attributes,"attribute_mask":mask});
        let mut bytes = b"occipital-client-rules/3\0".to_vec();
        bytes.extend_from_slice(&65536u32.to_be_bytes());
        bytes.extend_from_slice(&(key.len() as u32).to_be_bytes());
        bytes.extend_from_slice(key.as_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            admitted(&value),
            format!("{:x}", Sha256::digest(bytes)),
            "{key}"
        );
    }
    let mut bg = declaration();
    bg["background"] = json!({"kind":"inherit"});
    let mut fg = declaration();
    fg["foreground"] = json!({"kind":"inherit"});
    assert_ne!(
        admitted(&definition(bg)),
        admitted(&definition(fg)),
        "foreground/background presence bits differ"
    );
}

#[test]
fn shared_raw_number_vectors_match_binary64_integer_admission() {
    #[derive(Deserialize)]
    struct Numbers {
        cases: Vec<NumberCase>,
    }
    #[derive(Deserialize)]
    struct NumberCase {
        name: String,
        raw: String,
        valid: bool,
    }
    let bytes = include_bytes!("../../../protocol/syntax-v4/rule-number-vectors.json");
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        "0bb8c789a2f97fd0ae642351f6f7ed8376e629fc4f0d62e2537c5378957b7802"
    );
    let vectors: Numbers = serde_json::from_slice(bytes).unwrap();
    let mut mismatches = Vec::new();
    for case in vectors.cases {
        // The fixture stores literal JSON tokens inside strings. Do not round them
        // through Value/Number or json! before exercising the production boundary.
        let raw = document(case.raw);
        let result = ClientRulePlan::inspect(&raw, usize::MAX);
        writeln!(
            std::io::stdout(),
            "raw number {}: expected_valid={}, accepted={}, outcome={:?}",
            case.name,
            case.valid,
            result.is_ok(),
            result.as_ref().map(|p| p.fingerprint())
        )
        .unwrap();
        if result.is_ok() != case.valid {
            mismatches.push(case.name);
        }
    }
    assert!(
        mismatches.is_empty(),
        "binary64 admission mismatches: {mismatches:?}"
    );
}

#[test]
fn raw_numeric_conversion_preserves_binary64_rounding_and_scalar_types() {
    const BODY: &str = r#"{"revision":2,"binding_slots":SLOT,"default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[]}"#;
    let fingerprint = |token: &str| {
        let raw = document(BODY.replace("SLOT", token));
        ClientRulePlan::inspect(&raw, usize::MAX).map(|plan| plan.fingerprint().to_owned())
    };
    let fraction = "15.9999999999999991".parse::<f64>().unwrap();
    assert_eq!(fraction.to_bits(), 16.0f64.to_bits() - 1);
    let mut accepted = 0;
    for (token, canonical) in [
        (" \t\n4.0\r ", "4"),
        ("4e0", "4"),
        ("40e-1", "4"),
        ("-0", "0"),
        ("-0.0", "0"),
        ("-0e999", "0"),
        ("1e-400", "0"),
        ("-1e-400", "0"),
        ("1e-999999999", "0"),
        ("15.9999999999999999", "16"),
        ("16.0000000000000001", "16"),
        ("65536.000000000001", "65536"),
    ] {
        assert_eq!(
            fingerprint(token).unwrap(),
            fingerprint(canonical).unwrap(),
            "{token}"
        );
        accepted += 1;
    }
    let mut rejected = 0;
    for token in [
        r#""4""#,
        r#""NaN""#,
        r#""Infinity""#,
        "{}",
        "[]",
        "true",
        "false",
        "null",
        "-1",
        "5e-324",
        "1e309",
        "15.9999999999999991",
    ] {
        assert_eq!(fingerprint(token), Err(Error::InvalidRules), "{token}");
        rejected += 1;
    }
    // The same scalar reader serves revision, RGB channels and attribute masks.
    let canonical = BODY.replace("SLOT", "0");
    let rounded_revision =
        document(canonical.replace("\"revision\":1", "\"revision\":0.99999999999999999"));
    assert_eq!(
        ClientRulePlan::inspect(&rounded_revision, usize::MAX)
            .unwrap()
            .fingerprint(),
        fingerprint("0").unwrap()
    );
    let rgb = document(canonical.replace(
        r#"{"kind":"inherit"}"#,
        r#"{"kind":"rgb","r":15.9999999999999991,"g":0,"b":0}"#,
    ));
    assert_eq!(
        ClientRulePlan::inspect(&rgb, usize::MAX).err(),
        Some(Error::InvalidRules)
    );
    let rounded_mask = document(canonical.replace(
        "\"attribute_mask\":0",
        "\"attribute_mask\":7.9999999999999999",
    ));
    let integer_mask = document(canonical.replace("\"attribute_mask\":0", "\"attribute_mask\":8"));
    assert_eq!(
        ClientRulePlan::inspect(&rounded_mask, usize::MAX)
            .unwrap()
            .fingerprint(),
        ClientRulePlan::inspect(&integer_mask, usize::MAX)
            .unwrap()
            .fingerprint()
    );
    writeln!(std::io::stdout(), "raw numeric scalars: {accepted} accepted aliases, {rejected} rejected forms; fractional token={fraction:?}, bits={:016x}", fraction.to_bits()).unwrap();
}
