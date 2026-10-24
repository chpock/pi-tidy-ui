use occipital::{
    protocol::{Fault, SyntaxHint},
    semantic_engine::{Engine, Limits, SourceChunk, Work},
    vocabulary::ScopeId,
};
use std::io::Write;
use syntect::parsing::{ParseState, ScopeStack};
fn hint(name: &str) -> SyntaxHint {
    SyntaxHint {
        language: Some(name.into()),
        path: None,
    }
}
fn execute(engine: &mut Engine, mut work: Work) -> (SourceChunk, usize, usize) {
    let mut peak = 0;
    let mut reserve = |n| {
        peak = peak.max(n);
        true
    };
    while !engine.step(&mut work, &mut reserve).unwrap() {}
    let scratch = work.parser_scratch_peak_bytes();
    let chunk = engine.finish(work, &mut reserve).unwrap();
    (chunk, peak, scratch)
}
fn finite(source: &str, language: &str, window: usize) -> SourceChunk {
    let mut engine = Engine::new(Limits {
        line_bytes: window,
        ..Limits::default()
    });
    let work = engine
        .begin_one_shot(source.into(), &hint(language), &mut |_| true)
        .unwrap();
    execute(&mut engine, work).0
}
type Span = (u32, u32, Option<Vec<u32>>);
fn expanded(chunk: &SourceChunk) -> Vec<Vec<u32>> {
    let mut paths: Vec<Vec<u32>> = Vec::new();
    for row in &chunk.contexts {
        assert!(!row.is_empty());
        let n = row[0] as usize;
        let mut path = if n == 0 {
            Vec::new()
        } else {
            paths.last().unwrap()[..n].to_vec()
        };
        for id in &row[1..] {
            assert!(ScopeId::from_raw(*id).is_some());
            path.push(*id);
        }
        paths.push(path);
    }
    paths
}
fn spans(chunk: &SourceChunk, text: &str) -> Vec<Span> {
    let paths = expanded(chunk);
    let mut result = Vec::new();
    let mut cursor = chunk.replace_from;
    let mut previous = None;
    for [len, id] in &chunk.runs {
        assert!(*len > 0);
        assert_ne!(previous, Some(*id));
        assert!(text.is_char_boundary(cursor as usize));
        let end = cursor + len;
        assert!(text.is_char_boundary(end as usize));
        result.push((
            cursor,
            end,
            if *id == 0 {
                None
            } else {
                Some(paths[*id as usize - 1].clone())
            },
        ));
        cursor = end;
        previous = Some(*id);
    }
    assert_eq!(cursor, chunk.source_bytes);
    result
}
fn patch(old: &mut Vec<Span>, chunk: &SourceChunk, text: &str) {
    old.retain(|s| s.0 < chunk.replace_from);
    if let Some(last) = old.last_mut() {
        last.1 = last.1.min(chunk.replace_from);
    }
    for span in spans(chunk, text) {
        if let Some(last) = old.last_mut() {
            if last.1 == span.0 && last.2 == span.2 {
                last.1 = span.1;
                continue;
            }
        }
        old.push(span);
    }
}
// Independent Syntect traversal: no new emitter, table, stream state or operation helper.
fn oracle(text: &str, language: &str, window: usize) -> Vec<Span> {
    let set = two_face::syntax::extra_newlines();
    let syntax = set.find_syntax_by_name(language).unwrap();
    let mut parse = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut offset = 0;
    let mut out: Vec<Span> = Vec::new();
    for line in text.split_inclusive('\n') {
        let mut end = line.len().min(window);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let prefix = &line[..end];
        let ops = if prefix.is_empty() {
            Vec::new()
        } else {
            parse.parse_line(prefix, &set).unwrap()
        };
        let mut cursor = 0;
        let mut add = |start: usize, end: usize, path: Option<Vec<u32>>| {
            if start == end {
                return;
            }
            let start = (offset + start) as u32;
            let end = (offset + end) as u32;
            if let Some(last) = out.last_mut() {
                if last.1 == start && last.2 == path {
                    last.1 = end;
                    return;
                }
            }
            out.push((start, end, path));
        };
        for (end, op) in ops {
            if end > cursor {
                let path = stack
                    .as_slice()
                    .iter()
                    .map(|scope| ScopeId::from_scope(*scope).unwrap().get())
                    .collect();
                add(cursor, end, Some(path));
            }
            cursor = end;
            stack.apply(&op).unwrap();
        }
        if cursor < prefix.len() {
            let path = stack
                .as_slice()
                .iter()
                .map(|scope| ScopeId::from_scope(*scope).unwrap().get())
                .collect();
            add(cursor, prefix.len(), Some(path));
        }
        add(prefix.len(), line.len(), None);
        offset += line.len();
    }
    out
}
#[test]
fn actual_parsers_preserve_every_full_context_and_utf8_boundary() {
    let examples = [
        ("Rust", "//界🙂\nfn main(){ let s = \"雪\"; }\n"),
        ("TypeScript", "/* a\n b */ const s = `hi ${1}`;\n"),
        (
            "Markdown",
            "# **heading**\n\n> [link](url) `code`\n```rs\nfn f() {}\n```\n",
        ),
        ("HTML", "<script>const x = \"界\";</script>\n<!-- tail -->"),
        (
            "Bourne Again Shell (bash)",
            "echo \"$HOME\" #🙂\nprintf '%s' x\n",
        ),
        ("Plain Text", "\n界🙂\r\nlast"),
    ];
    let mut comparisons = 0;
    for (language, text) in examples {
        for window in [8, 65536] {
            let actual = finite(text, language, window);
            let got = spans(&actual, text);
            assert_eq!(
                got,
                oracle(text, language, window),
                "{language} window={window}"
            );
            comparisons += got.len();
        }
    }
    assert!(comparisons > 30);
    writeln!(
        std::io::stdout(),
        "independent native full-context span comparisons={comparisons}"
    )
    .unwrap();
}
#[test]
fn every_scalar_prefix_append_matches_finite_modulo_reply_ids() {
    let cases = [
        ("TypeScript", "/*界🙂abcdef*/\nconst x = `hi ${1}`;\n"),
        ("Markdown", "# **bold**\n\n```rs\nfn x(){}\n```\n"),
        ("Bourne Again Shell (bash)", "echo \"$HOME\"\n#界🙂\n"),
        (
            "TypeScript",
            "/* two\r\nlines */\r\nconst café = `界🙂\n${name}`;\nlet last=1;",
        ),
        (
            "Bourne Again Shell (bash)",
            "cat <<'EOF'\nhello $USER\nEOF\nprintf '%s' \"$USER\"",
        ),
        ("Makefile", "target:\n\techo \"hi\" # comment\n"),
        (
            "HTML",
            "<script>const x = `界 ${name}`;</script>\n<div class=\"a\">x</div>",
        ),
        ("Python", "text = '''two\nlines é'''\nprint(text)\n"),
    ];
    let mut prefixes = 0;
    for (language, text) in cases {
        for window in [8, 65536] {
            let mut engine = Engine::new(Limits {
                line_bytes: window,
                ..Limits::default()
            });
            let work = engine
                .begin_open("route", "key", String::new(), &hint(language), &mut |_| {
                    true
                })
                .unwrap();
            let lease = work.lease().unwrap();
            let mut latest = execute(&mut engine, work).0;
            let mut accumulated = Vec::new();
            let mut end = 0;
            let (mut line_calls, mut line_bytes) = (0, 0);
            for ch in text.chars() {
                let delta = ch.to_string();
                end += delta.len();
                let work = engine
                    .begin_append(
                        "route",
                        "key",
                        lease,
                        latest.revision,
                        latest.source_bytes,
                        delta,
                        false,
                        &mut |_| true,
                    )
                    .unwrap();
                latest = execute(&mut engine, work).0;
                line_calls += latest.counters.committed_line_calls;
                line_bytes += latest.counters.committed_line_bytes;
                if window == 65536 {
                    assert_eq!(
                        line_calls,
                        text[..end].bytes().filter(|b| *b == b'\n').count() as u64
                    );
                    assert_eq!(line_bytes, latest.committed_bytes as u64);
                    assert_eq!(
                        engine.retained_tail_bytes(),
                        end - latest.committed_bytes as usize
                    );
                }
                patch(&mut accumulated, &latest, &text[..end]);
                assert_eq!(
                    accumulated,
                    spans(&finite(&text[..end], language, window), &text[..end]),
                    "{language} {end}"
                );
                prefixes += 1;
            }
            let work = engine
                .begin_append(
                    "route",
                    "key",
                    lease,
                    latest.revision,
                    latest.source_bytes,
                    String::new(),
                    true,
                    &mut |_| true,
                )
                .unwrap();
            assert_eq!(work.lease(), Some(lease));
            let final_chunk = execute(&mut engine, work).0;
            patch(&mut accumulated, &final_chunk, text);
            assert_eq!(final_chunk.committed_bytes, text.len() as u32);
            assert_eq!(final_chunk.counters, Default::default());
            assert_eq!(accumulated, spans(&finite(text, language, window), text));
            assert_eq!(engine.leases(), 0);
            assert_eq!(engine.retained_state_bytes(), 0);
        }
    }
    writeln!(
        std::io::stdout(),
        "every-scalar prefix comparisons={prefixes}"
    )
    .unwrap();
}
#[test]
fn frozen_window_remaps_local_contexts_without_parsing_ignored_suffix() {
    let mut engine = Engine::new(Limits {
        line_bytes: 8,
        ..Limits::default()
    });
    let mut text = "/*abcdef".to_string();
    let work = engine
        .begin_open("r", "k", text.clone(), &hint("typescript"), &mut |_| true)
        .unwrap();
    let lease = work.lease().unwrap();
    let mut latest = execute(&mut engine, work).0;
    let mut accumulated = spans(&latest, &text);
    assert_eq!(latest.counters.tail_calls, 1);
    for delta in ["界", "*/", "\r", "\n", "const next = 1;\n"] {
        text.push_str(delta);
        let work = engine
            .begin_append(
                "r",
                "k",
                lease,
                latest.revision,
                latest.source_bytes,
                delta.into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        latest = execute(&mut engine, work).0;
        patch(&mut accumulated, &latest, &text);
        assert_eq!(accumulated, spans(&finite(&text, "typescript", 8), &text));
        if delta != "const next = 1;\n" {
            assert_eq!(latest.counters, Default::default());
        }
        assert!(engine.retained_tail_bytes() <= 8);
    }
    assert_eq!(latest.replace_from, text.find("const").unwrap() as u32);
    assert!(latest.counters.committed_line_calls > 0);
    assert!(engine.close("r", "k", lease));
    assert_eq!(engine.retained_state_bytes(), 0);
}
#[test]
fn finite_maximum_prefix_is_one_work_item_and_retains_no_completed_source() {
    let line = format!("{}\n", "x".repeat(1023));
    let text = line.repeat(64);
    assert_eq!(text.len(), occipital::limits::SOURCE_BYTES);
    let mut engine = Engine::new(Limits::default());
    let work = engine
        .begin_one_shot(text.clone(), &hint("text"), &mut |_| true)
        .unwrap();
    assert_eq!(work.retained_input_bytes(), text.len());
    let (chunk, peak, scratch) = execute(&mut engine, work);
    assert_eq!(chunk.source_bytes, text.len() as u32);
    assert_eq!(chunk.committed_bytes, chunk.source_bytes);
    assert_eq!(chunk.counters.committed_line_calls, 64);
    assert_eq!(chunk.counters.committed_line_bytes, text.len() as u64);
    assert_eq!(chunk.runs.len(), 1);
    assert_eq!(engine.retained_state_bytes(), 0);
    assert_eq!(engine.retained_tail_bytes(), 0);
    writeln!(std::io::stdout(), "finite64KiB: one Work,64 actual line calls, controlled peak={peak}, parser operation scratch peak={scratch}").unwrap();
}
#[test]
fn callbacks_bound_growth_and_report_actual_started_authority() {
    let mut engine = Engine::new(Limits::default());
    assert_eq!(
        engine
            .begin_one_shot("x".into(), &hint("unknown-syntax"), &mut |_| panic!(
                "unsupported syntax must not reserve"
            ))
            .err()
            .unwrap(),
        Fault::not_started("unknown_syntax")
    );
    assert_eq!(
        engine
            .begin_one_shot("x".into(), &hint("rust"), &mut |_| false)
            .err()
            .unwrap(),
        Fault::not_started("data_limit")
    );
    let mut work = engine
        .begin_open("r", "k", "fn f(){}\n".into(), &hint("rust"), &mut |_| true)
        .unwrap();
    let fault = engine.step(&mut work, &mut |_| false).unwrap_err();
    assert_eq!(fault, Fault::started("data_limit"));
    assert!(work.started());
    assert_eq!(engine.leases(), 0);
    assert!(engine.finish(work, &mut |_| true).is_err());
    // Persistence admission and final Box allocation are separate from parser work.
    for deny_state_pool in [true, false] {
        let mut isolated = Engine::new(Limits::default());
        let mut work = isolated
            .begin_open("r", "k", "x\n".into(), &hint("text"), &mut |_| true)
            .unwrap();
        while !isolated.step(&mut work, &mut |_| true).unwrap() {}
        if deny_state_pool {
            isolated.limits.state_pool_bytes = isolated.retained_state_bytes();
        }
        let expected = if deny_state_pool {
            "state_limit"
        } else {
            "data_limit"
        };
        assert_eq!(
            isolated.finish(work, &mut |_| false).unwrap_err(),
            Fault::started(expected)
        );
        assert_eq!(isolated.leases(), 0);
        assert_eq!(isolated.retained_state_bytes(), 0);
    }
    let text = "# heading\n**bold** `code` [link](x)\n";
    let mut work = engine
        .begin_one_shot(text.into(), &hint("Markdown"), &mut |_| true)
        .unwrap();
    let base = work.required_bytes();
    let mut calls = 0;
    let mut previous = base;
    while !engine
        .step(&mut work, &mut |n| {
            assert!(n > previous);
            previous = n;
            calls += 1;
            true
        })
        .unwrap()
    {}
    let peak = work.required_bytes();
    assert!(peak > base);
    assert!(calls > 1);
    let chunk = engine.finish(work, &mut |_| true).unwrap();
    assert_eq!(spans(&chunk, text), oracle(text, "Markdown", 65536));
    // Identical work with the measured peak available succeeds; one byte below the
    // measured peak fails after parsing rather than guessing a fixed output estimate.
    for (limit, success) in [(peak, true), (peak - 1, false)] {
        let mut reserve = |n| n <= limit;
        let mut work = engine
            .begin_one_shot(text.into(), &hint("Markdown"), &mut reserve)
            .unwrap();
        let result = loop {
            match engine.step(&mut work, &mut reserve) {
                Ok(true) => break Ok(()),
                Ok(false) => {}
                Err(e) => break Err(e),
            }
        };
        assert_eq!(result.is_ok(), success);
        if success {
            engine.finish(work, &mut reserve).unwrap();
        } else {
            assert!(result.unwrap_err().started);
            engine.discard(work);
        }
    }
    for (limit, success) in [(peak, true), (peak - 1, false)] {
        let pool = occipital::credit::Budget::new(limit, 1, 1);
        let mut fund = pool.reserve(Some("route"), 0).unwrap();
        fund.started();
        {
            let mut reserve = |required| fund.resize(required).is_ok();
            let mut work = engine
                .begin_one_shot(text.into(), &hint("Markdown"), &mut reserve)
                .unwrap();
            let result = loop {
                match engine.step(&mut work, &mut reserve) {
                    Ok(true) => break Ok(()),
                    Ok(false) => {}
                    Err(error) => break Err(error),
                }
            };
            assert_eq!(result.is_ok(), success);
            if success {
                engine.finish(work, &mut reserve).unwrap();
            } else {
                assert!(result.unwrap_err().started);
                engine.discard(work);
            }
        }
        assert_eq!(pool.snapshot().jobs, 1);
        assert!(pool.snapshot().peak_bytes <= limit);
        if success {
            assert_eq!(pool.snapshot().peak_bytes, peak);
        }
        drop(fund);
        let snapshot = pool.snapshot();
        assert_eq!((snapshot.bytes, snapshot.jobs, snapshot.queued), (0, 0, 0));
    }
    writeln!(std::io::stdout(), "actual controlled output growth: base={base}, peak={peak}, reservation growth callbacks={calls}; exact peak passes, one byte short rejects; real Credit.resize confirms bounds and releases bytes/jobs/queue to0").unwrap();
}
#[test]
fn incarnation_close_replacement_expiry_and_final_discard_are_exact() {
    let mut engine = Engine::new(Limits {
        idle_ms: 10,
        age_ms: 30,
        ..Limits::default()
    });
    let work = engine
        .begin_open("r", "k", "x".into(), &hint("rust"), &mut |_| true)
        .unwrap();
    let old = work.lease().unwrap();
    assert!(engine.close("r", "k", old));
    let mut stale = work;
    assert_eq!(
        engine.step(&mut stale, &mut |_| true).unwrap_err(),
        Fault::not_started("scope_gone")
    );
    let replacement = engine
        .begin_open("r", "k", "new\n".into(), &hint("rust"), &mut |_| true)
        .unwrap();
    let lease = replacement.lease().unwrap();
    assert_ne!(old, lease);
    engine.discard(stale);
    assert!(!engine.close("r", "k", old));
    let chunk = execute(&mut engine, replacement).0;
    assert_eq!(engine.leases(), 1);
    assert_eq!(
        engine
            .begin_append(
                "r",
                "k",
                old,
                chunk.revision,
                chunk.source_bytes,
                String::new(),
                false,
                &mut |_| true
            )
            .err()
            .unwrap(),
        Fault::not_started("restart_required")
    );
    assert_eq!(engine.next_expiry(), Some(10));
    engine.advance_clock(9);
    let work = engine
        .begin_append(
            "r",
            "k",
            lease,
            chunk.revision,
            chunk.source_bytes,
            String::new(),
            false,
            &mut |_| true,
        )
        .unwrap();
    execute(&mut engine, work);
    assert_eq!(engine.next_expiry(), Some(10));
    engine.advance_clock(10);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
    let mut work = engine
        .begin_open("r", "k", "x\n".repeat(200), &hint("rust"), &mut |_| true)
        .unwrap();
    assert!(!engine.step(&mut work, &mut |_| true).unwrap());
    engine.close_scope("r");
    assert_eq!(
        engine.step(&mut work, &mut |_| true).unwrap_err(),
        Fault::started("scope_gone")
    );
    engine.discard(work);
    assert_eq!(engine.retained_state_bytes(), 0);
}
#[test]
fn empty_paths_aliases_unsupported_hints_and_state_pool_failure() {
    let mut engine = Engine::new(Limits::default());
    let empty = engine
        .begin_one_shot(String::new(), &hint("text"), &mut |_| true)
        .unwrap();
    let chunk = execute(&mut engine, empty).0;
    assert!(chunk.contexts.is_empty() && chunk.runs.is_empty());
    assert_eq!(chunk.revision, 1);
    let source = "const x = 1;\n";
    for path in ["a.TS", "C:\\foo\\x.ts"] {
        let work = engine
            .begin_one_shot(
                source.into(),
                &SyntaxHint {
                    language: None,
                    path: Some(path.into()),
                },
                &mut |_| true,
            )
            .unwrap();
        assert_eq!(
            spans(&execute(&mut engine, work).0, source),
            spans(&finite(source, "typescript", 65536), source)
        );
    }
    for (alias, canonical) in [
        ("TS", "TypeScript"),
        ("JS", "JavaScript"),
        ("shell", "Bourne Again Shell (bash)"),
        ("make", "Makefile"),
        ("PY", "Python"),
        ("RS", "Rust"),
        ("json", "JSON"),
        ("TXT", "Plain Text"),
    ] {
        assert_eq!(
            spans(&finite(source, alias, 65536), source),
            oracle(source, canonical, 65536),
            "{alias}"
        );
    }
    for invalid in [
        SyntaxHint {
            language: Some("x".repeat(129)),
            path: None,
        },
        SyntaxHint {
            language: None,
            path: Some("x".repeat(occipital::limits::PATH_HINT_BYTES + 1)),
        },
    ] {
        assert_eq!(
            engine
                .begin_one_shot(String::new(), &invalid, &mut |_| panic!(
                    "invalid hints must not reserve"
                ))
                .err()
                .unwrap(),
            Fault::not_started("invalid_hint")
        );
    }
    let mut tiny = Engine::new(Limits {
        state_pool_bytes: 0,
        ..Limits::default()
    });
    assert_eq!(
        tiny.begin_open("r", "k", String::new(), &hint("text"), &mut |_| true)
            .err()
            .unwrap(),
        Fault::not_started("state_limit")
    );
    assert_eq!(tiny.leases(), 0);
    let mut limited = Engine::new(Limits {
        runs: 1,
        ..Limits::default()
    });
    let mut work = limited
        .begin_one_shot("fn x(){}\n".into(), &hint("rust"), &mut |_| true)
        .unwrap();
    assert_eq!(
        limited.step(&mut work, &mut |_| true).unwrap_err(),
        Fault::started("result_limit")
    );
    limited.discard(work);
}
#[test]
fn reverse_vocabulary_preserves_canonical_aliases_and_rejects_unknown_handles() {
    let mut canonical = std::collections::BTreeMap::new();
    for name in occipital::vocabulary::names() {
        let id = ScopeId::from_name(name).unwrap();
        canonical.entry(id.scope()).or_insert(id);
    }
    for (scope, id) in &canonical {
        assert_eq!(ScopeId::from_scope(*scope), Some(*id));
    }
    assert_eq!(
        ScopeId::from_scope(syntect::parsing::Scope::new("comment.").unwrap()),
        ScopeId::from_scope(ScopeId::from_name("comment").unwrap().scope())
    );
    assert_eq!(
        ScopeId::from_scope(syntect::parsing::Scope::new("semantic-parser-never-shipped").unwrap()),
        None
    );
    writeln!(
        std::io::stdout(),
        "reverse vocabulary: {} canonical native handles, finite asset names={}",
        canonical.len(),
        occipital::vocabulary::names().len()
    )
    .unwrap();
}

#[test]
fn idle_state_retains_only_current_window_and_contexts_survive_lease_removal() {
    let mut engine = Engine::new(Limits::default());
    let text = "// comment\nfn main() { let s = \"界\"; }\n";
    let work = engine
        .begin_open("r", "k", text.into(), &hint("rust"), &mut |_| true)
        .unwrap();
    let lease = work.lease().unwrap();
    let saved = execute(&mut engine, work).0;
    let original = spans(&saved, text);
    let mut revision = saved.revision;
    let mut bytes = saved.source_bytes;
    let retained = engine.retained_state_bytes();
    assert_eq!(engine.retained_tail_bytes(), 0);
    for _ in 0..40 {
        let work = engine
            .begin_append(
                "r",
                "k",
                lease,
                revision,
                bytes,
                text.into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        let chunk = execute(&mut engine, work).0;
        assert_eq!(chunk.replace_from, bytes);
        assert_eq!(chunk.counters.tail_calls, 0);
        assert_eq!(chunk.counters.committed_line_bytes, text.len() as u64);
        revision = chunk.revision;
        bytes = chunk.source_bytes;
        assert_eq!(engine.retained_tail_bytes(), 0);
        assert_eq!(
            engine.retained_state_bytes(),
            retained,
            "reply dictionaries/history must not accumulate in the lease"
        );
    }
    assert!(engine.close("r", "k", lease));
    assert_eq!(engine.retained_state_bytes(), 0);
    assert_eq!(spans(&saved, text), original);
    assert_eq!(original, oracle(text, "Rust", 65536));
    writeln!(std::io::stdout(),"completed stream replies=41; retained controlled idle bytes constant={retained}; retained completed source/tail bytes=0; saved full contexts survive close").unwrap();
}
#[test]
fn completed_stale_work_cannot_finish_or_discard_a_successor_and_age_is_absolute() {
    let mut engine = Engine::new(Limits {
        idle_ms: 10,
        age_ms: 25,
        ..Limits::default()
    });
    let mut old = engine
        .begin_open("r", "k", "old\n".into(), &hint("text"), &mut |_| true)
        .unwrap();
    let old_lease = old.lease().unwrap();
    while !engine.step(&mut old, &mut |_| true).unwrap() {}
    assert!(engine.close("r", "k", old_lease));
    let successor = engine
        .begin_open("r", "k", "new\n".into(), &hint("text"), &mut |_| true)
        .unwrap();
    let lease = successor.lease().unwrap();
    assert_eq!(
        engine.finish(old, &mut |_| true).unwrap_err(),
        Fault::started("scope_gone")
    );
    let mut latest = execute(&mut engine, successor).0;
    for now in [8, 16, 24] {
        engine.advance_clock(now);
        let work = engine
            .begin_append(
                "r",
                "k",
                lease,
                latest.revision,
                latest.source_bytes,
                "x\n".into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        latest = execute(&mut engine, work).0;
        assert_eq!(engine.next_expiry(), Some((now + 10).min(25)));
    }
    engine.advance_clock(25);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn completed_sides_never_share_parser_state() {
    let mut engine = Engine::new(Limits::default());
    for text in ["/* unclosed\n", "const value = 1;\n"] {
        let work = engine
            .begin_one_shot(text.into(), &hint("typescript"), &mut |_| true)
            .unwrap();
        let chunk = execute(&mut engine, work).0;
        assert_eq!(spans(&chunk, text), oracle(text, "TypeScript", 65536));
        assert_eq!(engine.retained_state_bytes(), 0);
    }
}

#[test]
fn shared_shebang_vectors_resolve_as_regular_explicit_language_hints() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../protocol/syntax-v3/source-hint-vectors.json"
    ))
    .unwrap();
    assert_eq!(vectors["revision"], 2);
    let interpreters = vectors["interpreters"].as_object().unwrap();
    let mut engine = Engine::new(Limits::default());
    for grammar in interpreters.keys() {
        let hint = SyntaxHint {
            language: Some(grammar.clone()),
            path: None,
        };
        let work = engine
            .begin_one_shot("value = 1;\n".into(), &hint, &mut |_| true)
            .unwrap_or_else(|error| panic!("{grammar}: {error}"));
        let _ = execute(&mut engine, work);
    }
    let text = "print(1)\n";
    let explicit = SyntaxHint {
        language: Some("bash".into()),
        path: Some("known.py".into()),
    };
    let work = engine
        .begin_one_shot(text.into(), &explicit, &mut |_| true)
        .unwrap();
    assert_eq!(
        spans(&execute(&mut engine, work).0, text),
        oracle(text, "Bourne Again Shell (bash)", 65536),
        "explicit language outranks a recognizable path"
    );
    let empty = SyntaxHint {
        language: Some(String::new()),
        path: Some("known.py".into()),
    };
    let work = engine
        .begin_one_shot(text.into(), &empty, &mut |_| true)
        .unwrap();
    assert_eq!(
        spans(&execute(&mut engine, work).0, text),
        oracle(text, "Python", 65536),
        "empty language means select by path"
    );
    let no_hint = SyntaxHint {
        language: None,
        path: None,
    };
    assert_eq!(
        engine
            .begin_one_shot(text.into(), &no_hint, &mut |_| panic!(
                "unknown format must not reserve"
            ))
            .err()
            .unwrap(),
        Fault::not_started("unknown_syntax")
    );
}

#[test]
fn explicit_language_survives_stream_open_append_finalize() {
    let mut engine = Engine::new(Limits::default());
    let hint = SyntaxHint {
        language: Some("python".into()),
        path: None,
    };
    let mut text = "#!/usr/bin/env python3\nprint(\"same".to_owned();
    let work = engine
        .begin_open("r", "language-stream", text.clone(), &hint, &mut |_| true)
        .unwrap();
    let lease = work.lease().unwrap();
    let chunk = execute(&mut engine, work).0;
    let mut accumulated = spans(&chunk, &text);

    let work = engine
        .begin_append(
            "r",
            "language-stream",
            lease,
            chunk.revision,
            chunk.source_bytes,
            "\")\n".into(),
            true,
            &mut |_| true,
        )
        .unwrap();
    text.push_str("\")\n");
    let final_chunk = execute(&mut engine, work).0;
    patch(&mut accumulated, &final_chunk, &text);
    assert_eq!(
        accumulated,
        oracle(&text, "Python", Limits::default().line_bytes)
    );
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn all_bundled_grammar_entry_points_smoke_compile() {
    let mut engine = Engine::new(Limits::default());
    let names: Vec<_> = two_face::syntax::extra_newlines()
        .syntaxes()
        .iter()
        .map(|s| s.name.clone())
        .collect();
    assert_eq!(names.len(), 220);
    for name in names {
        let text = "value = 1;\n# comment\n\tprint(\"hi\")\n";
        let work = engine
            .begin_one_shot(text.into(), &hint(&name), &mut |_| true)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let chunk = execute(&mut engine, work).0;
        assert_eq!(spans(&chunk, text), oracle(text, &name, 65536), "{name}");
    }
}

#[test]
fn ordinary_line_over_old_8_kib_limit_is_fully_classified() {
    let text = "const value = 1; ".repeat(600) + "\n";
    let chunk = finite(&text, "typescript", 65536);
    assert_eq!(spans(&chunk, &text), oracle(&text, "TypeScript", 65536));
    assert_eq!(chunk.counters.committed_line_bytes, text.len() as u64);
    assert!(spans(&chunk, &text).iter().all(|s| s.2.is_some()));
}

#[test]
fn elapsed_quantum_yields_only_between_complete_lines() {
    let mut engine = Engine::new(Limits {
        quantum_ms: 0,
        ..Limits::default()
    });
    let text = "const x = 1;\n".repeat(65);
    let mut work = engine
        .begin_one_shot(text.clone(), &hint("typescript"), &mut |_| true)
        .unwrap();
    let mut quanta = 1;
    while !engine.step(&mut work, &mut |_| true).unwrap() {
        quanta += 1;
    }
    let chunk = engine.finish(work, &mut |_| true).unwrap();
    assert_eq!(quanta, 65);
    assert_eq!(chunk.counters.committed_line_calls, 65);
    assert_eq!(spans(&chunk, &text), oracle(&text, "TypeScript", 65536));
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
            &mut |_| true,
        )
        .unwrap();
    assert!(!engine.step(&mut busy, &mut |_| true).unwrap());
    engine.advance_clock(Limits::default().idle_ms);
    assert_eq!(engine.leases(), 0);
    assert_eq!(
        engine.step(&mut busy, &mut |_| true).unwrap_err().code,
        "scope_gone"
    );
    engine.discard(busy);
    let first = engine
        .begin_open(
            "owner",
            "append",
            "const x = 1;\n".into(),
            &hint("typescript"),
            &mut |_| true,
        )
        .unwrap();
    let lease = first.lease().unwrap();
    let initial = execute(&mut engine, first).0;
    let mut appending = engine
        .begin_append(
            "owner",
            "append",
            lease,
            initial.revision,
            initial.source_bytes,
            "const y = 2;\n".repeat(1000),
            false,
            &mut |_| true,
        )
        .unwrap();
    assert!(!engine.step(&mut appending, &mut |_| true).unwrap());
    engine.close_scope("owner");
    let replacement = engine
        .begin_open(
            "owner",
            "append",
            "replacement".into(),
            &hint("typescript"),
            &mut |_| true,
        )
        .unwrap();
    let fresh = replacement.lease().unwrap();
    execute(&mut engine, replacement);
    assert_eq!(
        engine.finish(appending, &mut |_| true).unwrap_err().code,
        "scope_gone"
    );
    assert!(engine.close("owner", "append", fresh));
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn kernel_lease_limits_and_oversize_source_refuse_before_work() {
    let mut engine = Engine::new(Limits {
        leases: 2,
        per_scope: 1,
        source_bytes: 64,
        ..Limits::default()
    });
    assert_eq!(
        engine
            .begin_one_shot("x".repeat(65), &hint("bash"), &mut |_| panic!(
                "oversize reservation"
            ))
            .err()
            .unwrap(),
        Fault::not_started("source_limit")
    );
    for route in ["a", "b"] {
        let work = engine
            .begin_open(route, "one", "x".into(), &hint("bash"), &mut |_| true)
            .unwrap();
        execute(&mut engine, work);
    }
    for (route, key) in [("a", "two"), ("c", "one")] {
        assert_eq!(
            engine
                .begin_open(route, key, "x".into(), &hint("bash"), &mut |_| true)
                .err()
                .unwrap()
                .code,
            "session_limit"
        );
    }
    engine.close_scope("a");
    engine.close_scope("b");
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn moderately_large_source_preserves_contexts_and_releases_completed_state() {
    let text = "const value = 42;\n".repeat(3000);
    let chunk = finite(&text, "typescript", 65536);
    assert_eq!(spans(&chunk, &text), oracle(&text, "TypeScript", 65536));
    assert_eq!(chunk.counters.committed_line_calls, 3000);
}

#[test]
fn default_window_and_hidden_closer_preserve_full_context_not_synthetic_newline() {
    assert_eq!(Limits::default().line_bytes, 65536);
    for (text, window) in [
        (
            format!("/*{}*/\nconst later = 1;\n", "a".repeat(32772)),
            32768,
        ),
        ("/*abcdefghij*/\nconst next = 1;\n".into(), 8),
        ("//界🙂tail\r\nconst next = 1;\n".into(), 6),
    ] {
        let chunk = finite(&text, "typescript", window);
        let actual = spans(&chunk, &text);
        assert_eq!(actual, oracle(&text, "TypeScript", window));
        assert!(actual.iter().any(|s| s.2.is_none()));
        assert_ne!(
            actual,
            spans(&finite(&text, "typescript", text.len()), &text)
        );
    }
}

#[test]
fn utf8_underfilled_cut_and_frozen_retention_stay_constant_until_close() {
    for (window, text, retained) in [(6, "/*界🙂", 5), (8, "/*abcdefignored", 8)] {
        let mut engine = Engine::new(Limits {
            line_bytes: window,
            ..Limits::default()
        });
        let work = engine
            .begin_open("r", "k", text.into(), &hint("typescript"), &mut |_| true)
            .unwrap();
        let lease = work.lease().unwrap();
        let mut chunk = execute(&mut engine, work).0;
        let state = engine.retained_state_bytes();
        for delta in ["x", "y", "*/", "ignored again"] {
            let work = engine
                .begin_append(
                    "r",
                    "k",
                    lease,
                    chunk.revision,
                    chunk.source_bytes,
                    delta.into(),
                    false,
                    &mut |_| true,
                )
                .unwrap();
            chunk = execute(&mut engine, work).0;
            assert_eq!(chunk.counters, Default::default());
            assert_eq!(engine.retained_tail_bytes(), retained);
            assert_eq!(engine.retained_state_bytes(), state);
        }
        assert!(engine.close("r", "k", lease));
        assert_eq!(engine.retained_state_bytes(), 0);
    }
}

#[test]
fn ignored_tail_is_started_and_clipped_result_failure_releases_state() {
    let mut engine = Engine::new(Limits {
        line_bytes: 8,
        ..Limits::default()
    });
    let work = engine
        .begin_open(
            "r",
            "k",
            "/*abcdef".into(),
            &hint("typescript"),
            &mut |_| true,
        )
        .unwrap();
    let lease = work.lease().unwrap();
    let chunk = execute(&mut engine, work).0;
    let mut work = engine
        .begin_append(
            "r",
            "k",
            lease,
            chunk.revision,
            chunk.source_bytes,
            "ignored".into(),
            false,
            &mut |_| true,
        )
        .unwrap();
    assert!(!work.started());
    assert!(engine.step(&mut work, &mut |_| true).unwrap());
    assert!(work.started());
    engine.close_scope("r");
    assert_eq!(
        engine.step(&mut work, &mut |_| true).unwrap_err(),
        Fault::started("scope_gone")
    );
    engine.discard(work);
    engine.limits.runs = 1;
    let mut work = engine
        .begin_open(
            "r",
            "k",
            "/*abcdefghijk".into(),
            &hint("typescript"),
            &mut |_| true,
        )
        .unwrap();
    assert_eq!(
        engine.step(&mut work, &mut |_| true).unwrap_err(),
        Fault::started("result_limit")
    );
    engine.discard(work);
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
}

#[test]
fn capped_finalize_with_data_replaces_only_tail_without_reparse() {
    let mut engine = Engine::new(Limits {
        line_bytes: 8,
        ..Limits::default()
    });
    let mut text = "/*abc界🙂def*/\r\nconst x = 1;\n\"long string".to_owned();
    let work = engine
        .begin_open("r", "k", text.clone(), &hint("typescript"), &mut |_| true)
        .unwrap();
    let lease = work.lease().unwrap();
    let chunk = execute(&mut engine, work).0;
    let mut accumulated = spans(&chunk, &text);
    let work = engine
        .begin_append(
            "r",
            "k",
            lease,
            chunk.revision,
            chunk.source_bytes,
            " ending".into(),
            true,
            &mut |_| true,
        )
        .unwrap();
    let final_chunk = execute(&mut engine, work).0;
    text.push_str(" ending");
    patch(&mut accumulated, &final_chunk, &text);
    assert_eq!(accumulated, oracle(&text, "TypeScript", 8));
    assert_eq!(final_chunk.committed_bytes as usize, text.len());
    assert_eq!(final_chunk.counters, Default::default());
    assert_eq!(engine.retained_state_bytes(), 0);
}
