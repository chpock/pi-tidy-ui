use occipital::{
    semantic::Ink,
    style_rules::{ClientRulePlan, Error},
    vocabulary::ScopeId,
};
use serde_json::{json, value::RawValue, Value};

fn document(value: &Value) -> Box<RawValue> {
    RawValue::from_string(value.to_string()).unwrap()
}
fn base_definition(rules: Vec<Value>) -> Value {
    json!({
        "revision": 2,
        "binding_slots": 4,
        "default": {"foreground":{"kind":"binding","slot":0},"background":{"kind":"terminal-default"},"attributes":0,"attribute_mask":0},
        "rules": rules
    })
}
fn rule(path: &[&str], slot: usize) -> Value {
    json!({
        "path": path,
        "excludes": [],
        "foreground": {"kind":"binding","slot":slot},
        "background": null,
        "font": null,
        "context": null
    })
}
fn property_rule(font: Value, excludes: Value) -> Value {
    json!({
        "path": ["meta.object-literal.key", "string"],
        "excludes": excludes,
        "foreground": {"kind":"binding","slot":1},
        "background": null,
        "font": font,
        "context": {"owner":"meta.object-literal.key", "boundaries":["meta.array.literal", "meta.template.expression"]}
    })
}
fn production_property_rule() -> Value {
    json!({
        "path": ["meta.object-literal.key"],
        "excludes": [["invalid.illegal"], ["invalid.deprecated"]],
        "foreground": {"kind":"binding","slot":1},
        "background": null,
        "font": null,
        "context": {"owner":"meta.object-literal.key", "boundaries":["meta.array.literal", "meta.template.expression"]}
    })
}
fn path(names: &[&str]) -> Vec<syntect::parsing::Scope> {
    names
        .iter()
        .map(|name| ScopeId::from_name(name).unwrap().scope())
        .collect()
}
fn foreground(definition: Value, names: &[&str]) -> (Ink, occipital::resolver::Counters) {
    let raw = document(&definition);
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut cursor = resolver.cursor(names.len()).unwrap();
    let foreground = cursor.resolve(&path(names)).unwrap().expression.foreground;
    (foreground, cursor.counters())
}
fn resolution(definition: Value, names: &[&str]) -> occipital::resolver::Resolution {
    let raw = document(&definition);
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut cursor = resolver.cursor(names.len()).unwrap();
    cursor.resolve(&path(names)).unwrap()
}

#[test]
fn nearest_owner_qualifies_properties_without_changing_absolute_specificity_or_exclusions() {
    let rules = vec![
        production_property_rule(),
        rule(&["meta.template.expression", "string"], 3),
        rule(&["entity.name.function"], 2),
        rule(&["punctuation"], 3),
    ];
    let definition = base_definition(rules);

    let (simple, counters) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(simple, Ink::Binding { slot: 1 });
    assert!(counters.contextual_rules > 0);
    assert!(counters.context_scopes_tested > 0);

    let (computed, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "meta.array.literal.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(computed, Ink::Binding { slot: 0 });

    let (nested, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "meta.template.expression.ts",
            "string.quoted.double.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(nested, Ink::Binding { slot: 1 });

    let (object_in_array, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.array.literal.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(object_in_array, Ink::Binding { slot: 1 });

    let (callable, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "entity.name.function.ts",
        ],
    );
    assert_eq!(callable, Ink::Binding { slot: 2 });

    let (colon, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "punctuation.separator.key-value.ts",
        ],
    );
    assert_eq!(colon, Ink::Binding { slot: 3 });

    // The expression competitor begins before the nested owner. A window-relative
    // score would incorrectly let it win; qualification retains original depths.
    let (absolute, _) = foreground(
        definition.clone(),
        &[
            "source.ts",
            "meta.object-literal.key.ts",
            "meta.template.expression.ts",
            "string.quoted.double.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(absolute, Ink::Binding { slot: 1 });

    let (illegal, _) = foreground(
        definition,
        &[
            "invalid.illegal",
            "source.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ],
    );
    assert_eq!(illegal, Ink::Binding { slot: 0 });
}

#[test]
fn inactive_qualified_rule_contributes_nothing_and_exclusions_still_see_the_full_stack() {
    let clear = json!({"attributes":0,"attribute_mask":4});
    let mut definition = base_definition(vec![property_rule(clear.clone(), json!([]))]);
    definition["default"] = json!({"foreground":{"kind":"binding","slot":0},"background":{"kind":"terminal-default"},"attributes":4,"attribute_mask":4});
    let raw = document(&definition);
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut cursor = resolver.cursor(4).unwrap();
    let result = cursor
        .resolve(&path(&[
            "source.ts",
            "meta.object-literal.key.ts",
            "meta.template.expression.ts",
            "string.quoted.double.ts",
        ]))
        .unwrap();
    assert_eq!(result.expression.foreground, Ink::Binding { slot: 0 });
    assert_eq!(
        (
            result.expression.attributes,
            result.expression.attribute_mask
        ),
        (4, 4)
    );

    let mut definition = base_definition(vec![property_rule(
        Value::Null,
        json!([["invalid.deprecated"]]),
    )]);
    definition["rules"]
        .as_array_mut()
        .unwrap()
        .push(rule(&["string"], 2));
    let raw = document(&definition);
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut cursor = resolver.cursor(4).unwrap();
    let result = cursor
        .resolve(&path(&[
            "invalid.deprecated",
            "source.ts",
            "meta.object-literal.key.ts",
            "string.quoted.double.ts",
        ]))
        .unwrap();
    assert_eq!(result.expression.foreground, Ink::Binding { slot: 2 });
}

#[test]
fn required_context_admission_and_funded_measurement_are_strict() {
    let rule = property_rule(Value::Null, json!([]));
    let raw = document(&base_definition(vec![rule.clone()]));
    let plan = ClientRulePlan::inspect(&raw, usize::MAX).unwrap();
    let measurement = plan.measurement();
    assert_eq!(
        (
            measurement.rules,
            measurement.paths,
            measurement.names,
            measurement.atoms
        ),
        (1, 4, 5, 13)
    );
    assert_eq!((measurement.contexts, measurement.boundaries), (1, 2));
    assert!(measurement.policy_bytes > 0);
    assert_eq!(
        ClientRulePlan::inspect(&raw, measurement.policy_bytes - 1).err(),
        Some(Error::AllocationLimit)
    );
    ClientRulePlan::inspect(&raw, measurement.policy_bytes).unwrap();

    let mut missing = base_definition(vec![rule.clone()]);
    missing["rules"][0]
        .as_object_mut()
        .unwrap()
        .remove("context");
    assert_eq!(
        ClientRulePlan::inspect(&document(&missing), usize::MAX).err(),
        Some(Error::InvalidRules)
    );

    for context in [
        json!({"owner":"meta.object-literal.key", "boundaries":["meta.object-literal.key.ts"]}),
        json!({"owner":"meta.object-literal.key", "boundaries":["meta.array.literal", "meta.array.literal"]}),
        json!({"owner":"meta.object-literal.key", "boundaries":["meta.accessor", "meta.action", "meta.alias", "meta.alter", "meta.annotation", "meta.argument-type", "meta.array", "meta.arrow", "meta.assertion", "meta.assignment", "meta.assumed-macro", "meta.at-rule", "meta.atom", "meta.attribute", "meta.attribute-selector", "meta.attribute-with-value", "meta.block"]}),
    ] {
        let mut bad = base_definition(vec![rule.clone()]);
        bad["rules"][0]["context"] = context;
        assert_eq!(
            ClientRulePlan::inspect(&document(&bad), usize::MAX).err(),
            Some(Error::InvalidRules)
        );
    }
    let mut unknown = base_definition(vec![rule.clone()]);
    unknown["rules"][0]["context"]["owner"] = json!("unknown.owner.scope");
    assert_eq!(
        ClientRulePlan::inspect(&document(&unknown), usize::MAX).err(),
        Some(Error::UnknownScope)
    );

    let mut bad = base_definition(vec![rule]);
    bad["rules"][0]["path"] = json!(["string", "meta.object-literal.key"]);
    assert_eq!(
        ClientRulePlan::inspect(&document(&bad), usize::MAX).err(),
        Some(Error::InvalidRules)
    );
}

#[test]
fn equal_scores_keep_declaration_order_across_single_and_multi_partitions() {
    let qualified = property_rule(Value::Null, json!([]));
    let unqualified = rule(&["meta.object-literal.key", "string"], 2);
    let stack = [
        "source.ts",
        "meta.object-literal.key.ts",
        "string.quoted.double.ts",
    ];

    let (qualified_first, _) = foreground(
        base_definition(vec![qualified.clone(), unqualified.clone()]),
        &stack,
    );
    assert_eq!(qualified_first, Ink::Binding { slot: 1 });

    let (unqualified_first, _) = foreground(base_definition(vec![unqualified, qualified]), &stack);
    assert_eq!(unqualified_first, Ink::Binding { slot: 2 });
}

#[test]
fn equal_scores_keep_earlier_qualified_rule_against_an_unqualified_single() {
    let qualified = json!({
        "path": ["string"],
        "excludes": [],
        "foreground": {"kind":"binding","slot":1},
        "background": null,
        "font": null,
        "context": {"owner":"string","boundaries":[]}
    });
    let unqualified = rule(&["string"], 2);

    let (qualified_first, _) = foreground(
        base_definition(vec![qualified.clone(), unqualified.clone()]),
        &["string"],
    );
    assert_eq!(qualified_first, Ink::Binding { slot: 1 });

    let (unqualified_first, _) =
        foreground(base_definition(vec![unqualified, qualified]), &["string"]);
    assert_eq!(unqualified_first, Ink::Binding { slot: 2 });
}

#[test]
fn null_context_single_and_multi_ties_use_global_declaration_order_for_every_property() {
    let mut excluded_single = rule(&["string"], 1);
    excluded_single["excludes"] = json!([["comment"]]);
    excluded_single["background"] = json!({"kind":"binding","slot":1});
    excluded_single["font"] = json!({"attributes":0,"attribute_mask":31});
    let mut plain_single = rule(&["string"], 2);
    plain_single["background"] = json!({"kind":"binding","slot":2});
    plain_single["font"] = json!({"attributes":31,"attribute_mask":31});

    for (rules, expected_slot, expected_attributes) in [
        (vec![excluded_single.clone(), plain_single.clone()], 1, 0),
        (vec![plain_single, excluded_single], 2, 31),
    ] {
        let resolved = resolution(base_definition(rules), &["string"]);
        assert_eq!(
            resolved.expression.foreground,
            Ink::Binding {
                slot: expected_slot
            }
        );
        assert_eq!(
            resolved.expression.background,
            Ink::Binding {
                slot: expected_slot
            }
        );
        assert_eq!(
            (
                resolved.expression.attributes,
                resolved.expression.attribute_mask
            ),
            (expected_attributes, 31)
        );
        assert_eq!(resolved.foreground.unwrap().rule_index, 0);
        assert_eq!(resolved.background.unwrap().rule_index, 0);
        assert_eq!(
            resolved.attributes.map(|winner| winner.unwrap().rule_index),
            [0; 5]
        );
    }
}

#[test]
fn empty_selector_is_global_but_not_an_explicit_semantic_hint_and_empty_context_uses_the_default() {
    let mut global = rule(&[], 1);
    global["excludes"] = json!([]);
    let resolved = resolution(base_definition(vec![global]), &["source.rust"]);
    assert_eq!(resolved.expression.foreground, Ink::Binding { slot: 1 });
    assert!(!resolved.foreground.unwrap().explicit_path);

    let resolved = resolution(base_definition(vec![rule(&[], 1)]), &[]);
    assert_eq!(resolved.expression.foreground, Ink::Binding { slot: 0 });
    assert_eq!(resolved.foreground, None);
}

#[test]
fn generic_properties_inherit_independently_and_explicit_font_zero_clears_only_owned_bits() {
    let mut source = rule(&["source"], 1);
    source["background"] = json!({"kind":"binding","slot":3});
    source["font"] = json!({"attributes":31,"attribute_mask":31});
    let mut string = rule(&["string"], 2);
    string["foreground"] = Value::Null;
    string["background"] = json!({"kind":"binding","slot":2});
    string["font"] = json!({"attributes":0,"attribute_mask":15});

    let resolved = resolution(
        base_definition(vec![source, string]),
        &["source.rust", "string.quoted.double.rust"],
    );
    assert_eq!(resolved.expression.foreground, Ink::Binding { slot: 1 });
    assert_eq!(resolved.expression.background, Ink::Binding { slot: 2 });
    assert_eq!(
        (
            resolved.expression.attributes,
            resolved.expression.attribute_mask
        ),
        (16, 31)
    );
    assert_eq!(resolved.foreground.unwrap().rule_index, 0);
    assert_eq!(resolved.background.unwrap().rule_index, 1);
    assert_eq!(
        resolved.attributes.map(|winner| winner.unwrap().rule_index),
        [1, 1, 1, 1, 0]
    );
}

#[test]
fn cursor_keeps_its_definition_alive_after_resolver_owner_is_dropped() {
    let mut cursor = {
        let resolver = ClientRulePlan::inspect(
            &document(&base_definition(vec![rule(&["source"], 1)])),
            usize::MAX,
        )
        .unwrap()
        .compile();
        resolver.cursor(2).unwrap()
    };
    assert_eq!(
        cursor
            .resolve(&path(&["source.rust", "string.quoted.double.rust"]))
            .unwrap()
            .expression
            .foreground,
        Ink::Binding { slot: 1 }
    );
}

#[test]
fn cursors_reuse_only_their_own_prefix_workspace_and_enforce_admitted_depth() {
    use occipital::resolver::Error as ResolverError;

    let raw = document(&base_definition(vec![
        rule(&["meta.block"], 1),
        rule(&["string"], 2),
    ]));
    let resolver = ClientRulePlan::inspect(&raw, usize::MAX).unwrap().compile();
    let mut left = resolver.cursor(3).unwrap();
    let mut right = resolver.cursor(3).unwrap();
    let string_path = path(&[
        "source.rust",
        "meta.block.rust",
        "string.quoted.double.rust",
    ]);
    let comment_path = path(&[
        "source.rust",
        "meta.block.rust",
        "comment.line.double-slash.rust",
    ]);

    assert_eq!(
        left.resolve(&string_path).unwrap().expression.foreground,
        Ink::Binding { slot: 2 }
    );
    assert_eq!(left.counters().single_tests, 6);
    assert_eq!(
        right.resolve(&comment_path).unwrap().expression.foreground,
        Ink::Binding { slot: 1 }
    );
    assert_eq!(
        right.counters().single_tests,
        6,
        "a cursor owns its own scored-prefix workspace"
    );
    assert_eq!(
        left.resolve(&string_path).unwrap().expression.foreground,
        Ink::Binding { slot: 2 }
    );
    assert_eq!(
        left.counters().single_tests,
        6,
        "an unchanged adjacent path reuses its prefix scores"
    );
    assert_eq!(
        left.resolve(&comment_path).unwrap().expression.foreground,
        Ink::Binding { slot: 1 }
    );
    assert_eq!(
        left.counters().single_tests,
        8,
        "only the changed final scope is rescored"
    );
    assert_eq!(
        left.resolve(&path(&[
            "source.rust",
            "meta.block.rust",
            "comment.line.double-slash.rust",
            "string.quoted.double.rust"
        ])),
        Err(ResolverError::WorkspaceDepth)
    );
    let prior = left.counters();
    let hostile = vec![
        ScopeId::from_name("source.rust").unwrap().scope();
        occipital::resolver::MAX_CONTEXT_DEPTH + 1
    ];
    assert_eq!(left.resolve(&hostile), Err(ResolverError::ContextTooDeep));
    assert_eq!(
        left.counters(),
        prior,
        "depth admission precedes external matching"
    );
    let mut maximum = resolver
        .cursor(occipital::resolver::MAX_CONTEXT_DEPTH)
        .unwrap();
    maximum
        .resolve(&hostile[..occipital::resolver::MAX_CONTEXT_DEPTH])
        .unwrap();
}
