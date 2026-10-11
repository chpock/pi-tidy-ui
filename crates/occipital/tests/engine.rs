use occipital::{
    engine::{Engine, Limits},
    protocol::{Chunk, Role, SyntaxHint, WireStyle},
};

fn hint(language: &str) -> SyntaxHint {
    SyntaxHint {
        language: Some(language.into()),
        path: None,
    }
}
fn role_at(source: &str, chunk: &Chunk, text: &str) -> Role {
    let index = source.find(text).unwrap() as u32;
    let run = chunk
        .runs
        .iter()
        .find(|run| run[0] <= index && index < run[0] + run[1])
        .unwrap();
    match chunk.styles[run[2] as usize] {
        WireStyle::Pi { role } => role,
        _ => panic!("not Pi palette"),
    }
}
fn check_cover(source: &str, chunk: &Chunk) {
    let mut next = chunk.replace_from;
    for run in &chunk.runs {
        assert_eq!(run[0], next);
        assert!(run[1] > 0);
        next += run[1];
        assert!((run[2] as usize) < chunk.styles.len());
        assert!(source.is_char_boundary(run[0] as usize));
        assert!(source.is_char_boundary(next as usize));
    }
    assert_eq!(next, chunk.source_bytes);
    assert_eq!(chunk.source_bytes as usize, source.len());
    assert!(chunk.committed_bytes <= chunk.source_bytes);
}
fn normalized(runs: &[[u32; 3]], styles: &[WireStyle]) -> Vec<(u32, u32, WireStyle)> {
    let mut result: Vec<(u32, u32, WireStyle)> = Vec::new();
    for run in runs {
        let style = styles[run[2] as usize].clone();
        if let Some(last) = result.last_mut() {
            if last.0 + last.1 == run[0] && last.2 == style {
                last.1 += run[1];
                continue;
            }
        }
        result.push((run[0], run[1], style));
    }
    result
}
fn apply(runs: &mut Vec<[u32; 3]>, chunk: &Chunk) {
    runs.retain(|run| run[0] < chunk.replace_from);
    if let Some(last) = runs.last_mut() {
        last[1] = last[1].min(chunk.replace_from - last[0]);
    }
    runs.extend_from_slice(&chunk.runs);
}

#[test]
fn default_palette_classifies_and_preserves_utf8_tabs_crlf() {
    let mut engine = Engine::new(Limits::default());
    let source = "const café = \"界🙂\";\r\nfunction greet(name: string) {\n\treturn name;\n}\n";
    let result = engine.one_shot(source, &hint("typescript"), "pi").unwrap();
    check_cover(source, &result);
    assert_eq!(role_at(source, &result, "const"), Role::SyntaxKeyword);
    assert_eq!(role_at(source, &result, "界🙂"), Role::SyntaxString);
    assert_eq!(role_at(source, &result, "greet"), Role::SyntaxFunction);
    assert_eq!(role_at(source, &result, "name:"), Role::SyntaxVariable);
    assert_eq!(role_at(source, &result, "string"), Role::SyntaxType);
    assert_eq!(role_at(source, &result, "return"), Role::SyntaxKeyword);
}

#[test]
fn every_source_prefix_matches_independent_whole_source_parse() {
    for profile in [
        "pi",
        "syntect:Catppuccin Mocha",
        "syntect:Nord",
        "syntect:ansi",
    ] {
        for (language, source) in [
            (
                "typescript",
                "/* two\r\nlines */\r\nconst café = `界🙂\n${name}`;\nlet last=1;",
            ),
            (
                "bash",
                "cat <<'EOF'\nhello $USER\nEOF\nprintf '%s' \"$USER\"",
            ),
            ("makefile", "target:\n\techo \"hi\" # comment\n"),
            (
                "HTML",
                "<script>const x = `界 ${name}`;</script>\n<div class=\"a\">x</div>",
            ),
            ("python", "text = '''two\nlines é'''\nprint(text)\n"),
        ] {
            let mut incremental = Engine::new(Limits::default());
            let mut oracle = Engine::new(Limits::default());
            let mut latest = incremental
                .open("client-a", "stream", "", &hint(language), profile)
                .unwrap();
            let mut snapshot = String::new();
            let mut runs = Vec::new();
            let mut previous_styles = latest.styles.clone();
            let (mut line_calls, mut line_bytes) = (0, 0);
            for character in source.chars() {
                let delta = character.to_string();
                snapshot.push(character);
                latest = incremental
                    .append(
                        "client-a",
                        "stream",
                        latest.revision,
                        latest.source_bytes,
                        &delta,
                        false,
                    )
                    .unwrap();
                assert!(latest.styles.starts_with(&previous_styles));
                previous_styles = latest.styles.clone();
                check_cover(&snapshot, &latest);
                apply(&mut runs, &latest);
                let expected = oracle
                    .one_shot(&snapshot, &hint(language), profile)
                    .unwrap();
                assert_eq!(
                    normalized(&runs, &latest.styles),
                    normalized(&expected.runs, &expected.styles),
                    "{language} {snapshot:?}"
                );
                line_calls += latest.counters.committed_line_calls;
                line_bytes += latest.counters.committed_line_bytes;
                assert_eq!(
                    line_calls,
                    snapshot.bytes().filter(|byte| *byte == b'\n').count() as u64
                );
                assert_eq!(line_bytes, latest.committed_bytes as u64);
                assert_eq!(
                    incremental.retained_tail_bytes(),
                    snapshot.len() - latest.committed_bytes as usize
                );
            }
            let finished = incremental
                .append(
                    "client-a",
                    "stream",
                    latest.revision,
                    latest.source_bytes,
                    "",
                    true,
                )
                .unwrap();
            assert_eq!(finished.replace_from, latest.committed_bytes);
            check_cover(&snapshot, &finished);
            assert_eq!(
                finished.counters.committed_line_calls + finished.counters.tail_calls,
                0
            );
            assert!(!incremental.contains("client-a", "stream"));
            assert_eq!(incremental.retained_tail_bytes(), 0);
        }
    }
}

#[test]
fn native_theme_profiles_are_distinct_and_client_scoped() {
    let mut engine = Engine::new(Limits::default());
    let source = "const value = \"hi\";\n";
    let first = engine
        .open(
            "a",
            "same-key",
            source,
            &hint("typescript"),
            "syntect:Catppuccin Mocha",
        )
        .unwrap();
    let second = engine
        .open("b", "same-key", source, &hint("typescript"), "syntect:Nord")
        .unwrap();
    check_cover(source, &first);
    check_cover(source, &second);
    assert_ne!(first.fingerprint, second.fingerprint);
    assert_ne!(first.styles, second.styles);
    assert!(first
        .styles
        .iter()
        .all(|style| matches!(style,WireStyle::Rgb{attributes,..}if *attributes<=7)));
    engine.close_scope("a");
    assert!(!engine.contains("a", "same-key"));
    assert!(engine.contains("b", "same-key"));
}

#[test]
fn completed_sides_never_share_parser_state() {
    let mut engine = Engine::new(Limits::default());
    engine
        .one_shot("/* unclosed\n", &hint("typescript"), "pi")
        .unwrap();
    let next = engine
        .one_shot("const value = 1;\n", &hint("typescript"), "pi")
        .unwrap();
    assert_eq!(
        role_at("const value = 1;\n", &next, "const"),
        Role::SyntaxKeyword
    );
    assert_eq!(engine.retained_tail_bytes(), 0);
}

#[test]
fn malformed_revision_and_oversize_source_are_not_admitted() {
    let mut engine = Engine::new(Limits {
        source_bytes: 64,
        line_bytes: 32,
        ..Limits::default()
    });
    assert_eq!(
        engine
            .one_shot(&"x".repeat(65), &hint("bash"), "pi")
            .unwrap_err()
            .code,
        "source_limit"
    );
    let long = "x".repeat(33);
    let colored = engine.one_shot(&long, &hint("bash"), "pi").unwrap();
    check_cover(&long, &colored);
    assert_eq!(colored.counters.tail_bytes, 32);
    let first = engine
        .open("a", "s", "echo ok", &hint("bash"), "pi")
        .unwrap();
    assert_eq!(
        engine
            .append("a", "s", 0, first.source_bytes, "x", false)
            .unwrap_err()
            .code,
        "restart_required"
    );
    assert_eq!(
        engine
            .append("a", "s", first.revision, 0, "x", false)
            .unwrap_err()
            .code,
        "restart_required"
    );
}

#[test]
fn terminal_color_sentinels_and_font_flags_follow_bundled_asset_contract() {
    use occipital::profile::native_style;
    use syntect::highlighting::{Color, FontStyle, Style};
    let style = Style {
        foreground: Color {
            r: 9,
            g: 0,
            b: 0,
            a: 0,
        },
        background: Color::BLACK,
        font_style: FontStyle::BOLD | FontStyle::UNDERLINE | FontStyle::ITALIC,
    };
    assert_eq!(
        native_style(style).unwrap(),
        WireStyle::Indexed {
            index: 9,
            attributes: 7
        }
    );
    assert_eq!(
        native_style(Style {
            foreground: Color {
                a: 1,
                ..style.foreground
            },
            ..style
        })
        .unwrap(),
        WireStyle::TerminalDefault {
            terminal_default: true,
            attributes: 7
        }
    );
    assert_eq!(
        native_style(Style {
            foreground: Color {
                r: 10,
                g: 20,
                b: 30,
                a: 128
            },
            ..style
        })
        .unwrap(),
        WireStyle::Rgb {
            rgb: [10, 20, 30],
            attributes: 7
        }
    );
    assert_eq!(
        native_style(Style {
            background: Color::WHITE,
            ..style
        })
        .unwrap(),
        native_style(style).unwrap()
    );
}

#[test]
fn cooperative_jobs_yield_and_late_results_cannot_recreate_a_closed_scope() {
    let mut engine = Engine::new(Limits::default());
    let source = "let value = 1;\n".repeat(129);
    let mut work = engine
        .begin_open("a", "s", source.clone(), &hint("typescript"), "pi")
        .unwrap();
    assert!(!engine.step(&mut work).unwrap());
    assert!(work.started());
    engine.close_scope("a");
    assert_eq!(engine.step(&mut work).unwrap_err().code, "scope_gone");
    engine.discard(work);
    assert_eq!(engine.leases(), 0);
    let final_result = engine.one_shot(&source, &hint("typescript"), "pi").unwrap();
    assert_eq!(final_result.counters.committed_line_calls, 129);
}

#[test]
fn idle_and_absolute_expiry_do_not_renew_on_noop_requests() {
    let mut engine = Engine::new(Limits {
        idle_ms: 10,
        age_ms: 25,
        ..Limits::default()
    });
    let first = engine
        .open("a", "idle", "echo", &hint("bash"), "pi")
        .unwrap();
    engine.advance_clock(9);
    engine
        .append("a", "idle", first.revision, first.source_bytes, "", false)
        .unwrap();
    engine.advance_clock(10);
    assert_eq!(engine.leases(), 0);
    engine.advance_clock(20);
    let mut latest = engine
        .open("a", "age", "echo", &hint("bash"), "pi")
        .unwrap();
    for now in [28, 36, 44] {
        engine.advance_clock(now);
        latest = engine
            .append("a", "age", latest.revision, latest.source_bytes, "x", false)
            .unwrap();
    }
    engine.advance_clock(45);
    assert!(!engine.contains("a", "age"));
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn all_bundled_grammar_entry_points_smoke_compile() {
    let mut engine = Engine::new(Limits::default());
    let names = engine.syntax_names();
    assert_eq!(
        names.len(),
        220,
        "pinned two-face grammar inventory changed"
    );
    for name in names {
        let source = "value = 1;\n# comment\n\tprint(\"hi\")\n";
        let result = engine
            .one_shot(source, &hint(&name), "pi")
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        check_cover(source, &result);
    }
}

#[test]
fn explicit_custom_selectors_preserve_six_demonstrated_distinctions() {
    use occipital::profile::Profile;
    use std::{collections::HashSet, sync::Arc};
    use syntect::highlighting::{Color, StyleModifier, Theme, ThemeItem};
    let mut theme = Theme::default();
    theme.settings.foreground = Some(Color {
        r: 220,
        g: 220,
        b: 220,
        a: 255,
    });
    let colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
    ];
    for (selector, rgb) in [
        "variable.parameter",
        "variable.other",
        "entity.other.attribute-name",
        "string",
        "constant.character.escape",
        "punctuation.definition.string",
    ]
    .into_iter()
    .zip(colors)
    {
        theme.scopes.push(ThemeItem {
            scope: selector.parse().unwrap(),
            style: StyleModifier {
                foreground: Some(Color {
                    r: rgb[0],
                    g: rgb[1],
                    b: rgb[2],
                    a: 255,
                }),
                ..StyleModifier::default()
            },
        });
    }
    let mut engine = Engine::new(Limits::default());
    engine
        .install_profile(
            Profile::native("custom:proof".into(), "fixture-v1".into(), Arc::new(theme)).unwrap(),
        )
        .unwrap();
    let mut seen = HashSet::new();
    for(language,source)in[("typescript","function greet(name: string) { const result = `hi ${name}`; return result; }\nconst escaped = \"a\\nb\";\n"),("HTML","<div class=\"item\" data-id=\"3\">hello</div>\n")]{
        let result=engine.one_shot(source,&hint(language),"custom:proof").unwrap();check_cover(source,&result);
        let expected:Vec<(&str,[u8;3])>=if language=="typescript"{vec![("name",colors[0]),("result",colors[1]),("hi ",colors[3]),("\\n",colors[4]),("\"",colors[5])]}else{vec![("class",colors[2]),("item",colors[3]),("\"",colors[5])]};
        for (token,rgb) in expected {
            let offset=source.find(token).unwrap() as u32;
            let run=result.runs.iter().find(|r|r[0]<=offset&&offset<r[0]+r[1]).unwrap();
            assert!(matches!(result.styles[run[2] as usize],WireStyle::Rgb{rgb:actual,..} if actual==rgb),"wrong native color at {language}:{token}");
        }
        for run in result.runs {if let WireStyle::Rgb{rgb,..}=result.styles[run[2]as usize]{seen.insert(rgb);}}
    }
    for rgb in colors {
        assert!(seen.contains(&rgb), "missing {rgb:?}");
    }
}

#[test]
fn moderately_large_source_fits_the_generous_compact_result_budget() {
    let mut engine = Engine::new(Limits::default());
    let source = "const value = 42;\n".repeat(12_000);
    let result = engine.one_shot(&source, &hint("typescript"), "pi").unwrap();
    check_cover(&source, &result);
    assert!(serde_json::to_vec(&result).unwrap().len() < 2 * 1024 * 1024);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn partial_failure_discards_state_and_stale_work_cannot_replace_new_slot() {
    let mut limited = Engine::new(Limits {
        runs: 1,
        ..Limits::default()
    });
    let failure = limited
        .open("a", "fail", "const value = 42;", &hint("typescript"), "pi")
        .unwrap_err();
    assert!(failure.started);
    assert_eq!(failure.code, "result_limit");
    assert!(!limited.contains("a", "fail"));
    assert_eq!(limited.retained_state_bytes(), 0);
    let mut engine = Engine::new(Limits::default());
    let mut stale = engine
        .begin_open("a", "same", "/* previous".into(), &hint("typescript"), "pi")
        .unwrap();
    engine.close_scope("a");
    let fresh = engine
        .open("a", "same", "const now = 1;", &hint("typescript"), "pi")
        .unwrap();
    assert!(engine.step(&mut stale).is_err());
    engine.discard(stale);
    assert!(engine.contains("a", "same"));
    engine
        .append("a", "same", fresh.revision, fresh.source_bytes, "\n", true)
        .unwrap();
    assert_eq!(engine.leases(), 0);
}

#[test]
fn compact_json_lengths_reconstruct_canonical_absolute_ranges() {
    let mut engine = Engine::new(Limits::default());
    let source = "const café = 42;\n";
    let result = engine.one_shot(source, &hint("typescript"), "pi").unwrap();
    let wire: serde_json::Value =
        serde_json::from_slice(&serde_json::to_vec(&result).unwrap()).unwrap();
    let flat = wire["runs"].as_array().unwrap();
    assert_eq!(flat.len(), result.runs.len() * 2);
    let mut from = result.replace_from;
    for (pair, [start, len, id]) in flat.as_chunks::<2>().0.iter().zip(&result.runs) {
        assert_eq!(from, *start);
        assert_eq!(pair[0].as_u64().unwrap(), u64::from(*len));
        assert_eq!(pair[1].as_u64().unwrap(), *id as u64);
        from = start + len;
    }
    assert_eq!(from, result.source_bytes);
}

#[test]
fn frozen_scope_categories_use_nearest_lexical_scope_without_semantic_guesses() {
    use occipital::{profile::category, protocol::Role};
    use std::str::FromStr;
    use syntect::parsing::ScopeStack;
    for (stack, role) in [
        ("source.js meta.function", Role::Plain),
        ("source.js storage.type.function", Role::SyntaxKeyword),
        ("source.js entity.name.function", Role::SyntaxFunction),
        ("source.js entity.name.type.class", Role::SyntaxType),
        ("source.js support.function.builtin", Role::SyntaxType),
        ("source.js variable.parameter", Role::SyntaxVariable),
        (
            "text.html.basic entity.other.attribute-name",
            Role::SyntaxVariable,
        ),
        (
            "source.js string.quoted.double constant.character.escape",
            Role::SyntaxString,
        ),
        (
            "source.js string.quoted.double punctuation.definition.string",
            Role::SyntaxString,
        ),
        (
            "source.js comment.block punctuation.definition.comment",
            Role::SyntaxComment,
        ),
        (
            "source.js string.quoted.double variable.other",
            Role::SyntaxVariable,
        ),
        ("source.js keyword.operator", Role::SyntaxOperator),
        ("source.js constant.language.boolean", Role::SyntaxNumber),
        (
            "source.js punctuation.section.block",
            Role::SyntaxPunctuation,
        ),
        ("text.html.basic entity.name.tag", Role::SyntaxPunctuation),
        ("source.cpp meta.preprocessor", Role::SyntaxKeyword),
    ] {
        assert_eq!(
            category(&ScopeStack::from_str(stack).unwrap()),
            role,
            "{stack}"
        );
    }
}

#[test]
fn ordinary_line_over_old_8_kib_limit_is_fully_classified() {
    let mut engine = Engine::new(Limits::default());
    let source = format!("const text = \"{}\";\n", "a".repeat(9000));
    let result = engine.one_shot(&source, &hint("typescript"), "pi").unwrap();
    check_cover(&source, &result);
    assert_eq!(role_at(&source, &result, "const"), Role::SyntaxKeyword);
    assert_eq!(role_at(&source, &result, "aaaa"), Role::SyntaxString);
    assert_eq!(result.counters.committed_line_bytes as usize, source.len());
    assert_eq!(engine.leases(), 0);
}

#[test]
fn elapsed_quantum_yields_only_between_complete_lines() {
    let mut engine = Engine::new(Limits {
        quantum_ms: 0,
        ..Limits::default()
    });
    let source = "const x = 1;\n".repeat(65);
    let mut work = engine
        .begin_one_shot(source.clone(), &hint("typescript"), "pi")
        .unwrap();
    assert!(!engine.step(&mut work).unwrap());
    let mut quanta = 1;
    while !engine.step(&mut work).unwrap() {
        quanta += 1;
    }
    quanta += 1;
    assert_eq!(quanta, 65);
    let result = engine.finish(work).unwrap();
    assert_eq!(result.counters.committed_line_calls, 65);
    let control = engine.one_shot(&source, &hint("typescript"), "pi").unwrap();
    assert_eq!(
        normalized(&result.runs, &result.styles),
        normalized(&control.runs, &control.styles)
    );
}

#[test]
fn native_profile_bounds_selector_alternatives_and_compound_structure() {
    use occipital::profile::Profile;
    use std::sync::Arc;
    use syntect::{
        highlighting::{ScopeSelector, ScopeSelectors, StyleModifier, Theme, ThemeItem},
        parsing::ScopeStack,
    };
    for scope in [
        ScopeSelectors {
            selectors: vec![ScopeSelector::default(); 513],
        },
        ScopeSelectors {
            selectors: vec![ScopeSelector {
                path: ScopeStack::new(),
                excludes: vec![ScopeStack::new(); 4096],
            }],
        },
    ] {
        let mut theme = Theme::default();
        theme.scopes.push(ThemeItem {
            scope,
            style: StyleModifier::default(),
        });
        let theme = Arc::new(theme);
        assert!(
            Profile::native("custom:oversize".into(), "fixture".into(), theme.clone()).is_err()
        );
        let raw = Arc::new(Profile {
            name: "custom:oversize".into(),
            fingerprint: "fixture".into(),
            theme: Some(theme),
        });
        assert_eq!(
            Engine::new(Limits::default())
                .install_profile(raw)
                .unwrap_err()
                .code,
            "theme_limit"
        );
    }
}

#[test]
fn busy_expiry_and_partially_advanced_append_cannot_recreate_a_retired_lease() {
    let mut engine = Engine::new(Limits::default());
    let mut busy = engine
        .begin_open(
            "owner",
            "busy",
            "const x = 1;\n".repeat(1000),
            &hint("typescript"),
            "pi",
        )
        .unwrap();
    assert!(!engine.step(&mut busy).unwrap());
    engine.advance_clock(Limits::default().idle_ms);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.step(&mut busy).unwrap_err().code, "scope_gone");
    engine.discard(busy);
    let initial = engine
        .open(
            "owner",
            "append",
            "const x = 1;\n",
            &hint("typescript"),
            "pi",
        )
        .unwrap();
    let mut appending = engine
        .begin_append(
            "owner",
            "append",
            initial.revision,
            initial.source_bytes,
            "const y = 2;\n".repeat(1000),
            false,
        )
        .unwrap();
    assert!(!engine.step(&mut appending).unwrap());
    engine.close_scope("owner");
    let replacement = engine
        .open("owner", "append", "replacement", &hint("typescript"), "pi")
        .unwrap();
    assert_eq!(engine.finish(appending).unwrap_err().code, "scope_gone");
    assert!(engine.contains("owner", "append"));
    engine
        .append(
            "owner",
            "append",
            replacement.revision,
            replacement.source_bytes,
            "",
            true,
        )
        .unwrap();
    assert_eq!(engine.leases(), 0);
}

#[test]
fn kernel_lease_state_and_style_limits_release_failed_work() {
    let mut engine = Engine::new(Limits {
        leases: 2,
        per_scope: 1,
        ..Limits::default()
    });
    engine.open("a", "one", "x", &hint("bash"), "pi").unwrap();
    assert_eq!(
        engine
            .open("a", "two", "x", &hint("bash"), "pi")
            .unwrap_err()
            .code,
        "session_limit"
    );
    engine.open("b", "one", "x", &hint("bash"), "pi").unwrap();
    assert_eq!(
        engine
            .open("c", "one", "x", &hint("bash"), "pi")
            .unwrap_err()
            .code,
        "session_limit"
    );
    let mut tiny_state = Engine::new(Limits {
        state_pool_bytes: 1,
        ..Limits::default()
    });
    assert_eq!(
        tiny_state
            .open("owner", "one", "x", &hint("bash"), "pi")
            .unwrap_err()
            .code,
        "state_limit"
    );
    assert_eq!(tiny_state.leases(), 0);
    let mut tiny_style = Engine::new(Limits {
        styles: 1,
        ..Limits::default()
    });
    assert_eq!(
        tiny_style
            .open(
                "owner",
                "one",
                "const x = 1;",
                &hint("typescript"),
                "syntect:Catppuccin Mocha"
            )
            .unwrap_err()
            .code,
        "style_limit"
    );
    assert_eq!(tiny_style.leases(), 0);
}

#[test]
fn all_32_bundled_themes_admit_with_finite_native_structures() {
    let names = occipital::profile::Profile::bundled_names();
    assert_eq!(names.len(), 32, "pinned two-face theme inventory changed");
    let mut engine = Engine::new(Limits::default());
    let source = "function greet(name: string) { return `hi ${name}`; }\n";
    for name in names {
        let result = engine
            .one_shot(source, &hint("typescript"), &name)
            .unwrap_or_else(|fault| panic!("{name}: {fault:?}"));
        assert_eq!(result.profile, name);
        assert!(!result.fingerprint.is_empty());
        assert!(result
            .styles
            .iter()
            .all(|style| !matches!(style, WireStyle::Pi { .. })));
        check_cover(source, &result);
    }
}
