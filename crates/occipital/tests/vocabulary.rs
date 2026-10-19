use occipital::vocabulary::{self, ScopeId};
use serde_json::{json, Value};
use std::io::Write;
use std::process::Command;
use std::time::Instant;
use syntect::parsing::{Scope, ScopeStack, ScopeStackOp};

fn receipt(label: &str, value: Value) {
    writeln!(std::io::stderr().lock(), "{label}: {value}").unwrap();
}

#[path = "../vocabulary_build.rs"]
mod vocabulary_build;
#[path = "support/vocabulary_e1_oracle.rs"]
mod vocabulary_e1_oracle;

#[test]
fn generated_vocabulary_matches_public_assets_and_all_prefixes() {
    let names = vocabulary::names();
    assert_eq!(names.len(), vocabulary::SCOPE_COUNT);
    assert_eq!(
        names,
        vocabulary_build::extract(&two_face::syntax::extra_newlines())
    );
    for (index, name) in names.iter().enumerate() {
        let id = ScopeId::from_name(name).unwrap();
        assert_eq!(id.get() as usize, index + 1);
        assert_eq!(ScopeId::from_raw(id.get()), Some(id));
        assert_eq!(id.name(), *name);
        assert_eq!(id.scope().build_string(), *name);
        for (end, _) in name.match_indices('.') {
            let prefix = ScopeId::from_name(&name[..end]).unwrap();
            assert!(prefix.scope().is_prefix_of(id.scope()));
        }
    }
    assert_eq!(vocabulary::ASSET_REVISION, vocabulary_build::ASSET_REVISION);
    assert_eq!(
        vocabulary::ASSET_FINGERPRINT,
        vocabulary_build::asset_fingerprint(vocabulary::ASSET_REVISION)
    );
    let owned: Vec<_> = names.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        vocabulary::FINGERPRINT,
        vocabulary_build::fingerprint(vocabulary::ASSET_REVISION, &owned)
    );
    // An asset-only change must invalidate IDs' authority even with identical scope names.
    let different_asset = format!("{};changed-grammar-same-names", vocabulary::ASSET_REVISION);
    assert_ne!(
        vocabulary::ASSET_FINGERPRINT,
        vocabulary_build::asset_fingerprint(&different_asset)
    );
    assert_ne!(
        vocabulary::FINGERPRINT,
        vocabulary_build::fingerprint(&different_asset, &owned)
    );
    assert_ne!(vocabulary::ASSET_FINGERPRINT, vocabulary::FINGERPRINT);
}

#[test]
fn frozen_e1_oracle_matches_every_generated_name_and_static_field() {
    let (names, extraction) = vocabulary_e1_oracle::extract(&two_face::syntax::extra_newlines());
    assert_eq!(names, vocabulary::names());
    assert_eq!(extraction["linked_only_scopes"], json!([]));
    for field in [
        "root_scope",
        "meta_scope",
        "meta_content_scope",
        "capture_scope",
        "match_scope",
        "with_prototype",
        "named_prototypes",
        "prototype_links",
        "anonymous_contexts",
        "include_patterns",
        "push_or_set",
        "clear_scopes",
    ] {
        assert!(
            extraction["seed_fields"][field].as_u64().unwrap() > 0,
            "unexercised {field}"
        );
    }
}

#[test]
fn portable_ids_and_unknown_rejection_in_independent_processes() {
    if let Ok(mode) = std::env::var("VOCABULARY_SNAPSHOT_MODE") {
        let before = Scope::new("vocabulary-test-before-marker")
            .unwrap()
            .atom_at(0);
        for name in [
            "",
            ".",
            "source..unknown",
            "source. unknown",
            "source\0unknown",
            "gate-never-shipped.scope",
        ] {
            assert!(ScopeId::from_name(name).is_none());
        }
        for n in 0..256 {
            assert!(ScopeId::from_name(&format!("untrusted-vocabulary-test-{n}")).is_none());
        }
        for id in [0, vocabulary::SCOPE_COUNT as u32 + 1, u32::MAX] {
            assert!(ScopeId::from_raw(id).is_none());
        }
        assert!(ScopeId::from_name("source.ts").is_some());
        let after = Scope::new("vocabulary-test-after-marker")
            .unwrap()
            .atom_at(0);
        assert_eq!(after, before + 1, "caller lookup interned unknown atoms");
        // Nonvacuous positive control: this public atom probe detects real interning.
        Scope::new("vocabulary-test-positive-marker").unwrap();
        let control = Scope::new("vocabulary-test-last-marker")
            .unwrap()
            .atom_at(0);
        assert_eq!(control, after + 2);
        if mode == "perturbed" {
            Scope::new("source.ts").unwrap();
        } else {
            assert_eq!(mode, "clean");
        }
        let id = ScopeId::from_name("source.ts").unwrap();
        let start = Instant::now();
        let scope = id.scope();
        let first_scope_us = start.elapsed().as_micros();
        let start = Instant::now();
        for _ in 0..1000 {
            assert_eq!(ScopeId::from_name("source.ts").unwrap().scope(), scope);
        }
        let warm_1000_us = start.elapsed().as_micros();
        let ids: Vec<_> = vocabulary::names()
            .iter()
            .map(|name| json!([ScopeId::from_name(name).unwrap().get(), name]))
            .collect();
        println!(
            "VOCABULARY_SNAPSHOT={}",
            json!({"fingerprint":vocabulary::FINGERPRINT,"assetFingerprint":vocabulary::ASSET_FINGERPRINT,"scopeIds":ids,"nativeSourceAtom":scope.atom_at(0),"firstScopeUs":first_scope_us,"warm1000Us":warm_1000_us,"handlePayloadBytes":vocabulary::SCOPE_COUNT*std::mem::size_of::<Scope>(),"nameUtf8Bytes":vocabulary::names().iter().map(|name|name.len()).sum::<usize>(),"generatedSourceBytes":include_bytes!(concat!(env!("OUT_DIR"),"/vocabulary.rs")).len(),"unknownAtomGrowth":0})
        );
        return;
    }
    let mut snapshots = Vec::new();
    for mode in ["clean", "perturbed"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "portable_ids_and_unknown_rejection_in_independent_processes",
                "--nocapture",
            ])
            .env("VOCABULARY_SNAPSHOT_MODE", mode)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let line = stdout
            .split("VOCABULARY_SNAPSHOT=")
            .nth(1)
            .unwrap()
            .lines()
            .next()
            .unwrap();
        let mut snapshot: Value = serde_json::from_str(line).unwrap();
        let expected: Vec<_> = vocabulary::names()
            .iter()
            .map(|name| json!([ScopeId::from_name(name).unwrap().get(), name]))
            .collect();
        assert_eq!(snapshot["scopeIds"], json!(expected));
        snapshot.as_object_mut().unwrap().remove("scopeIds");
        snapshots.push(snapshot);
    }
    assert_eq!(snapshots[0]["fingerprint"], snapshots[1]["fingerprint"]);
    assert_eq!(
        snapshots[0]["assetFingerprint"],
        snapshots[1]["assetFingerprint"]
    );
    assert_ne!(
        snapshots[0]["nativeSourceAtom"],
        snapshots[1]["nativeSourceAtom"]
    );
    receipt("vocabulary process receipts", json!(snapshots));
}

#[test]
fn emitted_zero_width_clear_restore_and_embedded_operations_use_portable_ids() {
    let set = two_face::syntax::extra_newlines();
    let samples=[
        ("sh","#!/bin/bash\nx=world\necho \"${x} $(printf '%s' hi)\"\ncat <<'EOF'\nhi\nEOF\n"),
        ("ts","interface Box<T> { value:T }\nconst f = (x:number) => `hello ${x+1}`;\n"),
        ("md","# Heading **bold**\n\n```typescript\nconst x:number=1;\n```\n<div><script>const s='js';</script><style>a { color:red; }</style></div>\n"),
        ("html","<style>body { color:red; }</style>\n<script>const s=`x${1}`;</script><div title='x'>&amp;</div>\n"),
        ("diff","diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n"),
    ];
    let mut kinds = std::collections::BTreeSet::new();
    let mut operation_count = 0;
    let mut same_offset = 0;
    let mut covered = 0;
    for (extension, text) in samples {
        let mut parser =
            syntect::parsing::ParseState::new(set.find_syntax_by_extension(extension).unwrap());
        let mut native = ScopeStack::new();
        let mut decoded = ScopeStack::new();
        let mut emitted = std::collections::BTreeSet::new();
        for line in syntect::util::LinesWithEndings::from(text) {
            let mut previous = 0;
            for (offset, op) in parser.parse_line(line, &set).unwrap() {
                assert!(
                    offset >= previous && offset <= line.len() && line.is_char_boundary(offset)
                );
                if offset == previous {
                    same_offset += 1;
                }
                let portable = match op {
                    ScopeStackOp::Push(scope) => {
                        kinds.insert("push");
                        emitted.insert(scope.build_string());
                        let id = ScopeId::from_name(&scope.build_string()).unwrap();
                        ScopeStackOp::Push(ScopeId::from_raw(id.get()).unwrap().scope())
                    }
                    ScopeStackOp::Pop(_) => {
                        kinds.insert("pop");
                        op.clone()
                    }
                    ScopeStackOp::Clear(_) => {
                        kinds.insert("clear");
                        op.clone()
                    }
                    ScopeStackOp::Restore => {
                        kinds.insert("restore");
                        op.clone()
                    }
                    ScopeStackOp::Noop => {
                        kinds.insert("noop");
                        op.clone()
                    }
                };
                native.apply(&op).unwrap();
                decoded.apply(&portable).unwrap();
                assert_eq!(native, decoded, "lost operation at {offset}");
                previous = offset;
                operation_count += 1;
            }
            covered += line.len();
        }
        if extension == "md" || extension == "html" {
            for embedded in ["source.js", "source.css"] {
                assert!(emitted.contains(embedded));
            }
        }
        if extension == "md" {
            assert!(emitted.contains("source.ts"));
        }
    }
    for kind in ["push", "pop", "clear", "restore"] {
        assert!(kinds.contains(kind));
    }
    assert!(same_offset > 0);
    receipt(
        "vocabulary parser receipts",
        json!({"bytes":covered,"operations":operation_count,"sameOffset":same_offset}),
    );
}
