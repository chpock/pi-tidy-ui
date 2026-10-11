//! The approved window bounds classification, never source or range coverage.
use occipital::{
    engine::{Engine, Limits},
    protocol::{Chunk, Role, SyntaxHint, WireStyle},
};

fn hint() -> SyntaxHint {
    SyntaxHint {
        language: Some("typescript".into()),
        path: None,
    }
}
fn engine(window: usize) -> Engine {
    Engine::new(Limits {
        line_bytes: window,
        ..Limits::default()
    })
}
fn styles(chunk: &Chunk) -> Vec<(u32, u32, WireStyle)> {
    chunk
        .runs
        .iter()
        .map(|r| (r[0], r[1], chunk.styles[r[2] as usize].clone()))
        .collect()
}
fn at(chunk: &Chunk, byte: usize) -> WireStyle {
    let run = chunk
        .runs
        .iter()
        .find(|r| r[0] as usize <= byte && byte < (r[0] + r[1]) as usize)
        .unwrap();
    chunk.styles[run[2] as usize].clone()
}
fn coverage(source: &str, chunk: &Chunk) {
    assert_eq!(chunk.source_bytes as usize, source.len());
    let mut byte = chunk.replace_from;
    for run in &chunk.runs {
        assert_eq!(run[0], byte);
        assert!(run[1] > 0);
        assert!(source.is_char_boundary(byte as usize));
        byte += run[1];
        assert!(source.is_char_boundary(byte as usize));
    }
    assert_eq!(byte as usize, source.len());
}
fn patch(old: &mut Vec<(u32, u32, WireStyle)>, chunk: &Chunk) {
    old.retain(|r| r.0 < chunk.replace_from);
    if let Some(last) = old.last_mut() {
        last.1 = last.1.min(chunk.replace_from - last.0);
    }
    for run in styles(chunk) {
        if let Some(last) = old.last_mut() {
            if last.0 + last.1 == run.0 && last.2 == run.2 {
                last.1 += run.1;
                continue;
            }
        }
        old.push(run);
    }
}

#[test]
fn default_window_is_64_kib_and_long_source_is_not_refused() {
    assert_eq!(Limits::default().line_bytes, 65_536);
    let source = format!("/*{}*/\nconst later = 1;\n", "a".repeat(65_540));
    let result = Engine::new(Limits::default())
        .one_shot(&source, &hint(), "pi")
        .unwrap();
    coverage(&source, &result);
    assert_eq!(
        at(&result, 65_535),
        WireStyle::Pi {
            role: Role::SyntaxComment
        }
    );
    assert_eq!(at(&result, 65_536), WireStyle::Pi { role: Role::Plain });
    assert_eq!(
        at(&result, source.find("const").unwrap()),
        WireStyle::Pi {
            role: Role::SyntaxComment
        }
    );
    assert_eq!(
        result.counters.committed_line_bytes,
        65_536 + "const later = 1;\n".len() as u64
    );
}

#[test]
fn skipped_closer_is_plain_and_prefix_context_is_carried_without_reset() {
    let source = "/*abcdefghij*/\nconst next = 1;\n";
    let result = engine(8).one_shot(source, &hint(), "pi").unwrap();
    coverage(source, &result);
    assert_eq!(
        at(&result, 7),
        WireStyle::Pi {
            role: Role::SyntaxComment
        }
    );
    assert_eq!(at(&result, 8), WireStyle::Pi { role: Role::Plain });
    assert_eq!(
        at(&result, source.find("const").unwrap()),
        WireStyle::Pi {
            role: Role::SyntaxComment
        }
    );
    assert_eq!(
        at(&result, source.find("next").unwrap() + 2),
        WireStyle::Pi { role: Role::Plain }
    );
    // The fixture really differs from full parsing: the skipped closer would end the comment.
    let uncapped = engine(128).one_shot(source, &hint(), "pi").unwrap();
    assert_eq!(
        at(&uncapped, source.find("const").unwrap()),
        WireStyle::Pi {
            role: Role::SyntaxKeyword
        }
    );
    assert_eq!(result.counters.committed_line_bytes, 16);
}

#[test]
fn utf8_cut_never_splits_a_character_or_synthesizes_a_line_ending() {
    let source = "//界🙂tail\r\nconst next = 1;\n";
    let result = engine(6).one_shot(source, &hint(), "pi").unwrap();
    coverage(source, &result);
    assert_eq!(
        at(&result, 4),
        WireStyle::Pi {
            role: Role::SyntaxComment
        }
    );
    assert_eq!(at(&result, 5), WireStyle::Pi { role: Role::Plain });
    assert_eq!(result.counters.committed_line_bytes, 5 + 6);
    let prefix = engine(6).one_shot("//界", &hint(), "pi").unwrap();
    assert_eq!(at(&result, 0), at(&prefix, 0));
}

#[test]
fn native_theme_skipped_tail_uses_plain_not_comment_color_or_font_flags() {
    for profile in ["syntect:Nord", "syntect:ansi"] {
        let source = "/*abcdefghij*/\nconst next = 1;\n";
        let result = engine(8).one_shot(source, &hint(), profile).unwrap();
        coverage(source, &result);
        assert_eq!(at(&result, 8), WireStyle::Pi { role: Role::Plain });
        assert_ne!(at(&result, 0), WireStyle::Pi { role: Role::Plain });
    }
}

#[test]
fn ignored_tail_growth_reuses_prefix_and_commits_its_context_on_real_newline() {
    for profile in ["pi", "syntect:Nord"] {
        let mut growing = engine(8);
        let mut oracle = engine(8);
        let mut source = "/*abcdef".to_owned(); // Exactly saturated, not yet over the window.
        let mut latest = growing
            .open("route", "lease", &source, &hint(), profile)
            .unwrap();
        let mut accumulated = styles(&latest);
        assert_eq!(latest.counters.tail_calls, 1);
        for delta in ["g", "h", "界", "*/", "\r", "\n", "const next = 1;\n"] {
            source.push_str(delta);
            latest = growing
                .append(
                    "route",
                    "lease",
                    latest.revision,
                    latest.source_bytes,
                    delta,
                    false,
                )
                .unwrap();
            coverage(&source, &latest);
            patch(&mut accumulated, &latest);
            let expected = oracle.one_shot(&source, &hint(), profile).unwrap();
            assert_eq!(accumulated, styles(&expected), "{profile}: {delta:?}");
            if delta != "const next = 1;\n" {
                assert_eq!(
                    latest.counters.tail_calls + latest.counters.committed_line_calls,
                    0,
                    "ignored tail {delta:?}"
                );
                assert_eq!(
                    latest.counters.tail_bytes + latest.counters.committed_line_bytes,
                    0
                );
            }
            assert!(growing.retained_tail_bytes() <= 8);
        }
        let final_chunk = growing
            .append(
                "route",
                "lease",
                latest.revision,
                latest.source_bytes,
                "",
                true,
            )
            .unwrap();
        assert_eq!(final_chunk.committed_bytes as usize, source.len());
        assert_eq!(
            final_chunk.counters.tail_calls + final_chunk.counters.committed_line_calls,
            0
        );
        assert_eq!(growing.retained_tail_bytes(), 0);
        assert!(!growing.contains("route", "lease"));
    }
}

#[test]
fn utf8_underfilled_cut_stays_frozen_while_ignored_tail_grows() {
    let mut growing = engine(6);
    let mut latest = growing
        .open("route", "lease", "/*界🙂", &hint(), "pi")
        .unwrap();
    assert_eq!(growing.retained_tail_bytes(), 5);
    for delta in ["x", "y", "*/", "\n"] {
        latest = growing
            .append(
                "route",
                "lease",
                latest.revision,
                latest.source_bytes,
                delta,
                false,
            )
            .unwrap();
        assert_eq!(
            latest.counters.tail_calls + latest.counters.committed_line_calls,
            0
        );
        assert!(growing.retained_tail_bytes() <= 5);
    }
}

#[test]
fn growing_all_small_prefixes_matches_capped_batch_including_finalize_with_data() {
    for profile in ["pi", "syntect:Nord"] {
        let mut growing = engine(8);
        let mut oracle = engine(8);
        let mut latest = growing
            .open("route", "lease", "", &hint(), profile)
            .unwrap();
        let mut source = String::new();
        let mut accumulated = Vec::new();
        for character in "/*abc界🙂def*/\r\nconst x = 1;\n\"long string".chars() {
            let delta = character.to_string();
            source.push(character);
            latest = growing
                .append(
                    "route",
                    "lease",
                    latest.revision,
                    latest.source_bytes,
                    &delta,
                    false,
                )
                .unwrap();
            coverage(&source, &latest);
            patch(&mut accumulated, &latest);
            let expected = oracle.one_shot(&source, &hint(), profile).unwrap();
            assert_eq!(accumulated, styles(&expected), "{profile}: {source:?}");
        }
        source.push_str(" ending");
        let final_chunk = growing
            .append(
                "route",
                "lease",
                latest.revision,
                latest.source_bytes,
                " ending",
                true,
            )
            .unwrap();
        coverage(&source, &final_chunk);
        patch(&mut accumulated, &final_chunk);
        let expected = oracle.one_shot(&source, &hint(), profile).unwrap();
        assert_eq!(accumulated, styles(&expected));
        assert_eq!(
            final_chunk.counters.tail_calls + final_chunk.counters.committed_line_calls,
            0
        );
        assert_eq!(growing.leases(), 0);
    }
}

#[test]
fn ignored_tail_work_is_started_and_cannot_be_reported_as_prework_refusal() {
    let mut engine = engine(8);
    let opened = engine
        .open("route", "lease", "/*abcdef", &hint(), "pi")
        .unwrap();
    let mut work = engine
        .begin_append(
            "route",
            "lease",
            opened.revision,
            opened.source_bytes,
            "ignored".into(),
            false,
        )
        .unwrap();
    assert!(!work.started());
    assert!(engine.step(&mut work).unwrap());
    assert!(work.started());
    engine.close_scope("route");
    let fault = engine.step(&mut work).unwrap_err();
    assert!(fault.started);
    assert_eq!(fault.code, "scope_gone");
    engine.discard(work);
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn frozen_tail_retention_is_constant_and_released_with_its_lease() {
    for profile in ["pi", "syntect:Nord"] {
        let mut engine = engine(8);
        let mut latest = engine
            .open("route", "lease", "/*abcdef", &hint(), profile)
            .unwrap();
        latest = engine
            .append(
                "route",
                "lease",
                latest.revision,
                latest.source_bytes,
                "ignored",
                false,
            )
            .unwrap();
        let retained = engine.retained_state_bytes();
        for delta in ["another ignored suffix", "*/", "ignored again"] {
            latest = engine
                .append(
                    "route",
                    "lease",
                    latest.revision,
                    latest.source_bytes,
                    delta,
                    false,
                )
                .unwrap();
            assert_eq!(engine.retained_state_bytes(), retained);
            assert_eq!(engine.retained_tail_bytes(), 8);
            assert_eq!(latest.counters.tail_calls, 0);
        }
        engine.close_scope("route");
        assert_eq!(engine.retained_state_bytes(), 0);
        assert_eq!(engine.retained_tail_bytes(), 0);
    }
}

#[test]
fn clipped_coverage_still_obeys_result_limits_and_retires_failed_state() {
    let mut engine = Engine::new(Limits {
        line_bytes: 8,
        runs: 1,
        ..Limits::default()
    });
    let fault = engine
        .open("route", "lease", "/*abcdefghijk", &hint(), "pi")
        .unwrap_err();
    assert_eq!(fault.code, "result_limit");
    assert!(fault.started);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}
