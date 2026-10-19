use occipital::{
    credit::Budget,
    native_palette::{HintPaths, NativeTheme},
    resolver::Resolver,
    semantic::{Expression, Ink},
    semantic_reply,
    style_work::{native_fingerprint, StyleFailure, StyleWork},
    vocabulary::ScopeId,
};
use syntect::highlighting::Theme;

fn resolver() -> Resolver {
    Resolver::compile(
        Expression {
            foreground: Ink::Inherit {},
            background: Ink::Inherit {},
            attributes: 0,
            attribute_mask: 0,
        },
        vec![],
    )
}

#[test]
fn queued_work_survives_definition_release_deduplicates_and_keeps_credit_through_reply_handoff() {
    let budget = Budget::new(1 << 20, 2, 2);
    let id = ScopeId::from_name("source.rust").unwrap().get();
    let mut work = StyleWork::new(
        vec![vec![], vec![id], vec![id]],
        &resolver(),
        "b".repeat(64),
        None,
        budget.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    assert_eq!(budget.snapshot().jobs, 1);
    assert_eq!(budget.snapshot().queued, 0);
    assert!(!work.step().unwrap());
    assert!(!work.step().unwrap());
    assert!(work.step().unwrap());
    assert_eq!(work.counters().contexts, 3);
    assert_eq!(work.counters().scored_scopes, 1);
    let (result, credit) = work.finish().unwrap();
    assert_eq!(result.indices, vec![1, 1, 1]);
    assert_eq!(result.styles.len(), 1);
    result.validate(false, 0, 3).unwrap();
    assert_eq!(budget.snapshot().jobs, 1);
    drop(result);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(credit);
    assert_eq!(budget.snapshot().jobs, 0);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn controlled_workspace_and_result_growth_fail_without_freeing_live_physical_work_early() {
    let probe = Budget::new(1 << 20, 2, 2);
    let work = StyleWork::new(
        vec![vec![]],
        &resolver(),
        "b".repeat(64),
        None,
        probe.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    let before_style = probe.snapshot().bytes;
    drop(work);
    let budget = Budget::new(before_style + 255, 1, 1);
    let mut work = StyleWork::new(
        vec![vec![]],
        &resolver(),
        "b".repeat(64),
        None,
        budget.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    let error = work.step().unwrap_err();
    assert_eq!(error.code, "data_limit");
    assert!(error.started);
    assert_eq!(budget.snapshot().bytes, before_style);
    assert_eq!(budget.snapshot().jobs, 1);
    settle_error(work.fail(error), &budget);
}

#[test]
fn native_palette_without_source_shares_the_same_expression_table_and_needs_no_context_matching() {
    let native = NativeTheme::compile(
        &Theme::default(),
        HintPaths {
            comment: &[],
            invalid: &[],
            changed: &[],
            inserted: &[],
            deleted: &[],
        },
    )
    .unwrap();
    let budget = Budget::new(1 << 20, 2, 2);
    let fingerprint = native_fingerprint(&"a".repeat(64), true).unwrap();
    let mut work = StyleWork::new(
        vec![],
        &native.resolver,
        native_fingerprint(&"a".repeat(64), false).unwrap(),
        Some((&native.palette, fingerprint.clone())),
        budget.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    assert!(work.step().unwrap());
    assert_eq!(work.counters().contexts, 0);
    let (result, credit) = work.finish().unwrap();
    result.validate(true, 0, 0).unwrap();
    assert_eq!(result.palette.unwrap().fingerprint, fingerprint);
    assert!(result.styles.len() < 26);
    drop(credit);
    assert_eq!(budget.snapshot().jobs, 0);
}

#[test]
fn native_interpretation_fingerprints_match_the_same_cross_language_vectors() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/syntax-v3/rule-vectors.json"
    ))
    .unwrap();
    let definition = vectors["native"]["definition"].as_str().unwrap();
    assert_eq!(
        native_fingerprint(definition, false).unwrap(),
        vectors["native"]["rules"]
    );
    assert_eq!(
        native_fingerprint(definition, true).unwrap(),
        vectors["native"]["palette"]
    );
    assert!(native_fingerprint("a", false).is_err());
}

#[test]
fn constructor_failure_keeps_the_admitted_slot_until_error_settlement() {
    let budget = Budget::new(1024, 1, 1);
    let outcome = StyleWork::new(
        vec![vec![]],
        &resolver(),
        "b".repeat(64),
        None,
        budget.reserve(Some("route"), 1024).unwrap(),
    );
    assert!(outcome.is_err());
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("route"), 0).is_err());
    settle_error(outcome.err().unwrap(), &budget);
}

fn settle_error(mut failure: StyleFailure, budget: &Budget) {
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("route"), 0).is_err());
    // Partial context/cursor/result payloads were destroyed by error handoff.
    // Keep the physical slot, and replace their allowance with encoded bytes.
    failure.credit.resize(0).unwrap();
    let bytes = semantic_reply::error::<()>("ticket", "instance", failure.fault)
        .encode_with_credit(&mut failure.credit, 4096)
        .unwrap();
    assert_eq!(budget.snapshot().bytes, bytes.capacity());
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("route"), 0).is_err());
    drop(bytes);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(failure);
    assert_eq!(budget.snapshot().jobs, 0);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn native_palette_growth_failure_preserves_the_original_error_slot() {
    let native = NativeTheme::compile(
        &Theme::default(),
        HintPaths {
            comment: &[],
            invalid: &[],
            changed: &[],
            inserted: &[],
            deleted: &[],
        },
    )
    .unwrap();
    let probe = Budget::new(1 << 20, 1, 1);
    let work = StyleWork::new(
        vec![],
        &native.resolver,
        "b".repeat(64),
        None,
        probe.reserve(Some("route"), 64).unwrap(),
    )
    .unwrap();
    let base = probe.snapshot().bytes;
    drop(work);
    let budget = Budget::new(base + 128 + 5 * 26 + 255, 1, 1);
    let failure = StyleWork::new(
        vec![],
        &native.resolver,
        "b".repeat(64),
        Some((&native.palette, "c".repeat(64))),
        budget.reserve(Some("route"), 64).unwrap(),
    )
    .err()
    .unwrap();
    assert_eq!(failure.fault.code, "data_limit");
    settle_error(failure, &budget);
}

#[test]
fn incomplete_finish_and_authoritative_cancellation_both_transfer_the_same_live_credit() {
    let budget = Budget::new(1 << 20, 1, 1);
    let mut work = StyleWork::new(
        vec![vec![], vec![]],
        &resolver(),
        "b".repeat(64),
        None,
        budget.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    assert!(!work.step().unwrap());
    let failure = work.finish().err().unwrap();
    assert_eq!(failure.fault.code, "style_pending");
    settle_error(failure, &budget);
    let work = StyleWork::new(
        vec![vec![]],
        &resolver(),
        "b".repeat(64),
        None,
        budget.reserve(Some("route"), 1024).unwrap(),
    )
    .unwrap();
    let credit = work.into_credit();
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("route"), 0).is_err());
    drop(credit);
    assert_eq!(budget.snapshot().jobs, 0);
}
