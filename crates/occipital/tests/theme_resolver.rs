use occipital::{
    resolver::{self, AttributePatch, Cursor, Resolver, Rule},
    semantic::{Expression, Ink},
};
use std::io::Write;
use syntect::{
    highlighting::{
        Color, FontStyle, HighlightState, Highlighter, RangedHighlightIterator, Style,
        StyleModifier, Theme, ThemeItem,
    },
    parsing::{ClearAmount, ParseState, Scope, ScopeStack, ScopeStackOp, ATOM_LEN_BITS},
};
use two_face::theme::{EmbeddedLazyThemeSet, LazyThemeSet};
fn scope(name: &str) -> Scope {
    Scope::new(name).unwrap()
}
fn expected(style: Style) -> Expression {
    Expression {
        foreground: resolver::native_ink(style.foreground),
        background: resolver::native_ink(style.background),
        attributes: resolver::native_attributes(style.font_style),
        attribute_mask: 31,
    }
}
fn base() -> Expression {
    Expression {
        foreground: Ink::Inherit {},
        background: Ink::Inherit {},
        attributes: 0,
        attribute_mask: 0,
    }
}
fn rule(selector: &str, slot: Option<u16>, patch: Option<(u8, u8)>) -> Rule {
    Rule {
        selector: selector.parse().unwrap(),
        foreground: slot.map(|slot| Ink::Binding { slot }),
        background: None,
        attributes: patch.map(|(value, mask)| AttributePatch { value, mask }),
    }
}
const SAMPLES: &[(&str, &str)] = &[
    ("rs", "/// docs\nfn main() { let x = r#\"raw\"#; println!(\"{x}\"); }\n"),
    ("sh", "#!/bin/bash\ncat <<'END'\nhello $literal\nEND\nprintf '%s' \"$HOME\"\n"),
    ("md", "# Head **bold _italic_** [link](https://x)\n\n> quote `code`\n\n- item\n\n```js\nconst x = `str ${42}`;\n```\n"),
    ("html", "<style>.a {color: red}</style>\n<script>const a = /x+/g;\n</script>\n<p>hi &amp; bye</p>\n"),
    ("ts", "interface A { value: string }\nconst a: A = {value: `x ${42}`}; // hi\n"),
];
fn contexts_for_line(
    ops: &[(usize, ScopeStackOp)],
    line: &str,
    stack: &mut ScopeStack,
) -> Vec<(std::ops::Range<usize>, Vec<Scope>)> {
    let mut position = 0;
    let mut paths = Vec::new();
    for (offset, op) in ops {
        if *offset > position {
            paths.push((position..*offset, stack.as_slice().to_vec()));
        }
        stack.apply(op).unwrap();
        position = *offset;
    }
    if position < line.len() {
        paths.push((position..line.len(), stack.as_slice().to_vec()));
    }
    paths
}
#[test]
fn all_32_native_themes_match_actual_ranged_iterator() {
    let syntaxes = two_face::syntax::extra_newlines();
    let themes: LazyThemeSet = two_face::theme::extra().into();
    let mut checks = 0;
    for name in EmbeddedLazyThemeSet::theme_names() {
        let theme = themes.get(name.as_name()).unwrap();
        let resolver = Resolver::native(theme);
        let highlighter = Highlighter::new(theme);
        for (extension, text) in SAMPLES {
            let mut parser = ParseState::new(syntaxes.find_syntax_by_extension(extension).unwrap());
            let mut state = HighlightState::new(&highlighter, ScopeStack::new());
            let mut stack = ScopeStack::new();
            let mut paths = Vec::new();
            let mut styles = Vec::new();
            for line in syntect::util::LinesWithEndings::from(text) {
                let ops = parser.parse_line(line, &syntaxes).unwrap();
                let reference: Vec<_> =
                    RangedHighlightIterator::new(&mut state, &ops, line, &highlighter).collect();
                for (range, path) in contexts_for_line(&ops, line, &mut stack) {
                    for (style, _, native_range) in &reference {
                        if native_range.start < range.end && native_range.end > range.start {
                            paths.push(path.clone());
                            styles.push(expected(*style));
                        }
                    }
                }
                assert_eq!(
                    stack, state.path,
                    "zero-width operations {name:?}/{extension}"
                );
            }
            let mut cursor = resolver
                .cursor(paths.iter().map(Vec::len).max().unwrap())
                .unwrap();
            for (path, style) in paths.iter().zip(styles) {
                assert_eq!(
                    cursor.resolve(path).unwrap().expression,
                    style,
                    "{name:?}/{extension}: {path:?}"
                );
                checks += 1;
            }
            assert_eq!(cursor.counters().contexts, paths.len());
        }
    }
    assert_eq!(EmbeddedLazyThemeSet::theme_names().len(), 32);
    assert!(checks > 6000, "actual iterator comparisons: {checks}");
    writeln!(
        std::io::stdout(),
        "native iterator: 32 themes, 5 grammars, {checks} comparisons"
    )
    .unwrap();
}
#[test]
fn clear_restore_zero_width_font_replacement_and_empty_root() {
    let theme = Theme {
        scopes: vec![
            ThemeItem {
                scope: "source".parse().unwrap(),
                style: StyleModifier {
                    foreground: Some(Color {
                        r: 1,
                        g: 2,
                        b: 3,
                        a: 255,
                    }),
                    font_style: Some(FontStyle::BOLD | FontStyle::ITALIC),
                    ..Default::default()
                },
            },
            ThemeItem {
                scope: "string".parse().unwrap(),
                style: StyleModifier {
                    font_style: Some(FontStyle::empty()),
                    ..Default::default()
                },
            },
            ThemeItem {
                scope: "source string - comment".parse().unwrap(),
                style: StyleModifier {
                    background: Some(Color {
                        r: 4,
                        g: 5,
                        b: 6,
                        a: 255,
                    }),
                    ..Default::default()
                },
            },
            ThemeItem {
                scope: "".parse().unwrap(),
                style: StyleModifier {
                    foreground: Some(Color {
                        r: 42,
                        g: 43,
                        b: 44,
                        a: 255,
                    }),
                    ..Default::default()
                },
            },
        ],
        ..Default::default()
    };
    let ops = vec![
        (0, ScopeStackOp::Push(scope("source.test"))),
        (1, ScopeStackOp::Push(scope("string.quoted"))),
        (1, ScopeStackOp::Push(scope("meta.zero"))),
        (1, ScopeStackOp::Pop(1)),
        (2, ScopeStackOp::Clear(ClearAmount::TopN(1))),
        (3, ScopeStackOp::Restore),
        (4, ScopeStackOp::Clear(ClearAmount::All)),
        (5, ScopeStackOp::Restore),
        (6, ScopeStackOp::Push(scope("comment.line"))),
        (7, ScopeStackOp::Pop(1)),
        (8, ScopeStackOp::Pop(2)),
    ];
    let highlighter = Highlighter::new(&theme);
    let mut native = HighlightState::new(&highlighter, ScopeStack::new());
    let reference: Vec<_> =
        RangedHighlightIterator::new(&mut native, &ops, "abcdefghi", &highlighter).collect();
    let resolver = Resolver::native(&theme);
    let mut cursor = resolver.cursor(3).unwrap();
    let mut stack = ScopeStack::new();
    for (range, path) in contexts_for_line(&ops, "abcdefghi", &mut stack) {
        let native = reference.iter().find(|(_, _, r)| *r == range).unwrap().0;
        let actual = cursor.resolve(&path).unwrap();
        assert_eq!(actual.expression, expected(native), "{range:?}");
        if range.start == 1 {
            assert_eq!(actual.expression.attributes, 0);
            assert_eq!(actual.expression.attribute_mask, 31);
        }
        if path.is_empty() {
            assert_eq!(&actual.expression, resolver.default_expression());
            assert_eq!(actual.foreground, None);
        }
    }
    assert_eq!(stack, native.path);
    assert!(stack.is_empty());
}
#[test]
fn strict_ties_single_before_multi_property_inheritance_and_exclusions() {
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("source", Some(1), Some((1, 1))),
            rule("source", Some(2), None),
            rule("source - comment", Some(3), Some((2, 2))),
            rule("string", None, Some((0, 1))),
        ],
    );
    let mut cursor = resolver.cursor(3).unwrap();
    let first = cursor.resolve(&[scope("source.test")]).unwrap();
    assert_eq!(first.expression.foreground, Ink::Binding { slot: 1 });
    assert_eq!(first.foreground.unwrap().rule_index, 0);
    assert_eq!(first.expression.attributes, 3);
    let value = cursor
        .resolve(&[
            scope("source.test"),
            scope("string.quoted"),
            scope("comment.line"),
        ])
        .unwrap();
    assert_eq!(value.expression.foreground, Ink::Binding { slot: 1 });
    assert_eq!(value.expression.attributes, 0);
    assert_eq!(value.expression.attribute_mask, 1);
}
#[test]
fn rich_markdown_bindings_faint_and_explicit_zero_survive_rebinding() {
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("markup.heading", Some(1), Some((8, 8))),
            rule("markup.bold", None, Some((1, 1))),
            rule("markup.italic", None, Some((2, 2))),
            rule("markup.italic.clear", None, Some((0, 2))),
            rule("markup.quote", Some(2), None),
            rule("markup.list", Some(3), None),
            rule("markup.raw", Some(4), None),
            rule("meta.link", Some(5), Some((4, 4))),
            rule("markup.heading meta.link", None, Some((0, 8))),
        ],
    );
    let mut cursor = resolver.cursor(5).unwrap();
    let root = scope("text.html.markdown");
    let heading = scope("markup.heading.1.markdown");
    let nested = [
        root,
        heading,
        scope("markup.bold.markdown"),
        scope("markup.italic.markdown"),
    ];
    let value = cursor.resolve(&nested).unwrap().expression;
    assert_eq!(value.foreground, Ink::Binding { slot: 1 });
    assert_eq!((value.attributes, value.attribute_mask), (11, 11));
    assert_eq!(
        cursor
            .resolve(&[
                root,
                heading,
                scope("markup.bold"),
                scope("markup.italic"),
                scope("markup.italic.clear")
            ])
            .unwrap()
            .expression
            .attributes,
        9
    );
    for (name, slot) in [
        ("markup.quote.markdown", 2),
        ("markup.list.unnumbered.markdown", 3),
        ("markup.raw.inline.markdown", 4),
        ("meta.link.inline.markdown", 5),
    ] {
        let expression = cursor
            .resolve(&[root, heading, scope(name)])
            .unwrap()
            .expression;
        assert_eq!(expression.foreground, Ink::Binding { slot });
        if slot == 5 {
            assert_eq!((expression.attributes, expression.attribute_mask), (4, 12));
            for binding_attributes in [0, 8, 15] {
                let bound =
                    (binding_attributes & !expression.attribute_mask) | expression.attributes;
                assert_eq!(bound & 8, 0, "explicit faint clear independent of binding");
            }
        }
    }
    let unknown = cursor
        .resolve(&[root, scope("unknown.scope")])
        .unwrap()
        .expression;
    assert_eq!(unknown, base());
    let empty = cursor.resolve(&[]).unwrap().expression;
    assert_eq!(empty.attribute_mask, 0);
}
#[test]
fn global_selector_is_not_explicit_semantic_hint() {
    let resolver = Resolver::compile(base(), vec![rule("", Some(1), None)]);
    let mut cursor = resolver.cursor(2).unwrap();
    assert_eq!(cursor.resolve(&[]).unwrap().expression, base());
    let value = cursor
        .resolve(&[scope("source.diff"), scope("markup.inserted.diff")])
        .unwrap();
    assert!(!value.foreground.unwrap().explicit_path);
}
#[test]
fn prefix_cursor_reuses_ancestors_and_checked_workspace_guards_external_matching() {
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("source", Some(1), None),
            rule("source comment", Some(2), None),
        ],
    );
    let mut cursor = resolver.cursor(3).unwrap();
    let source = scope("source.test");
    let comment = scope("comment.line");
    for path in [
        vec![source, comment],
        vec![source, comment, scope("markup.bold")],
        vec![source, comment, scope("markup.italic")],
    ] {
        cursor.resolve(&path).unwrap();
    }
    let counters = cursor.counters();
    assert_eq!(
        (
            counters.contexts,
            counters.scored_scopes,
            counters.single_tests,
            counters.selector_calls
        ),
        (3, 4, 4, 3)
    );
    assert!(Cursor::workspace_bytes(3).unwrap() > Cursor::workspace_bytes(2).unwrap());
    assert_eq!(
        resolver::MAX_CONTEXT_DEPTH,
        (u16::MAX / ATOM_LEN_BITS) as usize + 1
    );
    assert_eq!(
        Cursor::workspace_bytes(usize::MAX),
        Err(resolver::Error::ContextTooDeep)
    );
    let hostile = vec![source; resolver::MAX_CONTEXT_DEPTH + 1];
    assert_eq!(
        cursor.resolve(&hostile),
        Err(resolver::Error::ContextTooDeep)
    );
    assert_eq!(
        cursor.counters(),
        counters,
        "no external selector runs before depth admission"
    );
    assert_eq!(
        cursor.resolve(&[source; 4]),
        Err(resolver::Error::WorkspaceDepth)
    );
    // Maximum safe public index reaches the scorer without u16 multiplication overflow.
    let mut safe = resolver.cursor(resolver::MAX_CONTEXT_DEPTH).unwrap();
    safe.resolve(&hostile[..resolver::MAX_CONTEXT_DEPTH])
        .unwrap();
    writeln!(
        std::io::stdout(),
        "workspace depth3={}, depth{}={} bytes",
        Cursor::workspace_bytes(3).unwrap(),
        resolver::MAX_CONTEXT_DEPTH,
        Cursor::workspace_bytes(resolver::MAX_CONTEXT_DEPTH).unwrap()
    )
    .unwrap();
}
#[test]
fn symbolic_alpha_and_native_font_bits_are_normalized_explicitly() {
    for a in [0, 1, 2, 128, 255] {
        assert_eq!(
            resolver::native_ink(Color {
                r: 17,
                g: 23,
                b: 41,
                a
            }),
            match a {
                0 => Ink::Indexed { index: 17 },
                1 => Ink::TerminalDefault {},
                _ => Ink::Rgb {
                    r: 17,
                    g: 23,
                    b: 41
                },
            }
        );
    }
    assert_eq!(resolver::native_attributes(FontStyle::ITALIC), 2);
    assert_eq!(resolver::native_attributes(FontStyle::UNDERLINE), 4);
    assert_eq!(
        Resolver::native(&Theme::default()).default_expression(),
        &expected(Highlighter::new(&Theme::default()).get_default())
    );
}

#[test]
fn actual_markdown_contexts_preserve_rich_generic_bindings() {
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("markup.heading", Some(1), Some((8, 8))),
            rule("markup.bold", None, Some((1, 1))),
            rule("markup.italic", None, Some((2, 2))),
            rule("markup.underline.link", Some(2), Some((4, 4))),
            rule("string.other.link", Some(2), None),
            rule("meta.link.inline.description.markdown", Some(2), None),
            rule("markup.raw", Some(3), None),
            rule("markup.quote", Some(4), None),
            rule("markup.list", Some(5), None),
        ],
    );
    let syntaxes = two_face::syntax::extra_newlines();
    let mut parser = ParseState::new(syntaxes.find_syntax_by_extension("md").unwrap());
    let text = "# Heading **bold _nested_** *italic* [site](https://example.com)\n\n> quote\n\n- item `code`\n\n```\nfenced\n```\n";
    let mut stack = ScopeStack::new();
    let mut segments = Vec::new();
    let mut paths = Vec::new();
    for line in syntect::util::LinesWithEndings::from(text) {
        let ops = parser.parse_line(line, &syntaxes).unwrap();
        for (range, path) in contexts_for_line(&ops, line, &mut stack) {
            segments.push(line[range].to_owned());
            paths.push(path);
        }
    }
    let mut cursor = resolver
        .cursor(paths.iter().map(Vec::len).max().unwrap())
        .unwrap();
    let styles: Vec<_> = paths
        .iter()
        .map(|p| cursor.resolve(p).unwrap().expression)
        .collect();
    let style = |word: &str| -> &Expression {
        &styles[segments
            .iter()
            .position(|s| s.contains(word))
            .unwrap_or_else(|| panic!("missing {word}"))]
    };
    for (word, slot) in [
        ("Heading", 1),
        ("bold", 1),
        ("nested", 1),
        ("site", 2),
        ("code", 3),
        ("fenced", 3),
        ("quote", 4),
        ("item", 5),
    ] {
        assert_eq!(style(word).foreground, Ink::Binding { slot }, "{word}");
    }
    assert_eq!(style("bold").attributes & 9, 9);
    assert_eq!(style("nested").attributes & 11, 11);
    assert_eq!(style("italic").attributes & 2, 2);
    writeln!(
        std::io::stdout(),
        "real Markdown: {} semantic segments through the common binding scorer",
        segments.len()
    )
    .unwrap();
}

#[test]
fn a_queued_cursor_owns_its_immutable_definition_without_a_self_reference() {
    let mut cursor = {
        let resolver = Resolver::compile(base(), vec![rule("source", Some(1), None)]);
        resolver.cursor(2).unwrap()
    };
    assert_eq!(
        cursor
            .resolve(&[scope("source.rust")])
            .unwrap()
            .expression
            .foreground,
        Ink::Binding { slot: 1 }
    );
    assert_eq!(
        cursor
            .resolve(&[scope("source.rust"), scope("string")])
            .unwrap()
            .expression
            .foreground,
        Ink::Binding { slot: 1 }
    );
}

#[test]
fn explicit_custom_selectors_preserve_six_demonstrated_distinctions() {
    use syntect::highlighting::{StyleModifier, ThemeItem};
    let colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
    ];
    let mut theme = Theme::default();
    theme.settings.foreground = Some(Color {
        r: 220,
        g: 220,
        b: 220,
        a: 255,
    });
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
    let resolver = Resolver::native(&theme);
    let set = two_face::syntax::extra_newlines();
    let mut seen = std::collections::HashSet::new();
    for (language, text, tokens) in [
        ("TypeScript", "function greet(name: string) { const result = `hi ${name}`; return result; }\nconst escaped = \"a\\nb\";\n", vec![("name",0),("result",1),("hi ",3),("\\n",4),("\"",5)]),
        ("HTML", "<div class=\"item\" data-id=\"3\">hello</div>\n", vec![("class",2),("item",3),("\"",5)]),
    ] {
        let mut parser = ParseState::new(set.find_syntax_by_name(language).unwrap());
        let mut stack = ScopeStack::new();
        let mut cursor = resolver.cursor(256).unwrap();
        let mut resolved = Vec::new();
        let mut offset = 0;
        for line in text.split_inclusive('\n') {
            let ops = parser.parse_line(line, &set).unwrap();
            for (range, path) in contexts_for_line(&ops, line, &mut stack) {
                let ink = cursor.resolve(&path).unwrap().expression.foreground;
                if let Ink::Rgb { r,g,b } = ink { seen.insert([r,g,b]); }
                resolved.push((offset+range.start, offset+range.end, ink));
            }
            offset += line.len();
        }
        for (token, index) in tokens {
            let at = text.find(token).unwrap();
            let actual = &resolved.iter().find(|s| s.0 <= at && at < s.1).unwrap().2;
            let [r,g,b] = colors[index];
            assert_eq!(actual, &Ink::Rgb {r,g,b}, "{language}:{token}");
        }
    }
    for rgb in colors {
        assert!(seen.contains(&rgb), "missing {rgb:?}");
    }
}

#[test]
fn actual_markdown_strike_contexts() {
    let syntaxes = two_face::syntax::extra_newlines();
    let mut parser = ParseState::new(syntaxes.find_syntax_by_extension("md").unwrap());
    let line = "plain ~~strike **bold _italic_** [link](https://x) `code`~~ after\n";
    let ops = parser.parse_line(line, &syntaxes).unwrap();
    let mut stack = ScopeStack::new();
    let paths = contexts_for_line(&ops, line, &mut stack);
    for name in [
        "markup.strikethrough",
        "punctuation.definition.strikethrough",
    ] {
        assert!(
            occipital::vocabulary::ScopeId::from_name(name).is_some(),
            "trusted {name}"
        );
    }
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("markup.strikethrough", None, Some((16, 16))),
            rule("punctuation.definition.strikethrough", None, Some((0, 16))),
            rule("markup.bold", None, Some((1, 1))),
            rule("markup.italic", None, Some((2, 2))),
            rule(
                "meta.link.inline.description.markdown",
                Some(1),
                Some((4, 4)),
            ),
            rule("markup.underline.link", Some(2), Some((4, 4))),
            rule("markup.raw", Some(3), None),
        ],
    );
    let mut cursor = resolver
        .cursor(paths.iter().map(|(_, p)| p.len()).max().unwrap())
        .unwrap();
    let mut markers = 0;
    for (range, path) in &paths {
        let text = &line[range.clone()];
        let value = cursor.resolve(path).unwrap().expression;
        writeln!(
            std::io::stdout(),
            "strike-context {text:?}: {:?}; font={}/{}",
            path.iter().map(ToString::to_string).collect::<Vec<_>>(),
            value.attributes,
            value.attribute_mask
        )
        .unwrap();
        match text {
            "~~" => {
                markers += 1;
                assert_eq!((value.attributes, value.attribute_mask), (0, 16));
            }
            "strike " => assert_eq!(value.attributes, 16),
            "bold " => assert_eq!(value.attributes, 17),
            "italic" => assert_eq!(value.attributes, 19),
            "link" | "https://x" => assert_eq!(value.attributes, 20),
            "code" => {
                assert_eq!(value.attributes, 16);
                assert_eq!(value.foreground, Ink::Binding { slot: 3 });
            }
            "plain " | " after\n" => assert_eq!(value.attribute_mask, 0),
            _ => {}
        }
    }
    assert_eq!(markers, 2);
}

#[test]
fn strike_has_its_own_winner_and_preserves_other_attributes() {
    let resolver = Resolver::compile(
        base(),
        vec![
            rule("markup.strikethrough", None, Some((16, 16))),
            rule("markup.strikethrough", None, Some((0, 16))),
            rule("markup.bold", None, Some((1, 1))),
            rule("markup.italic", None, Some((2, 2))),
            rule("markup.underline", None, Some((4, 4))),
            rule("punctuation", None, Some((0, 16))),
        ],
    );
    let mut cursor = resolver.cursor(5).unwrap();
    let path = [
        scope("markup.strikethrough"),
        scope("markup.bold"),
        scope("markup.italic"),
        scope("markup.underline"),
    ];
    let value = cursor.resolve(&path).unwrap();
    assert_eq!(value.expression.attributes, 23);
    assert_eq!(value.expression.attribute_mask, 23);
    assert_eq!(value.attributes[4].unwrap().rule_index, 0);
    let mut marker = path.to_vec();
    marker.push(scope("punctuation"));
    let cleared = cursor.resolve(&marker).unwrap();
    assert_eq!(cleared.expression.attributes, 7);
    assert_eq!(cleared.expression.attribute_mask, 23);
    assert_eq!(cleared.attributes[4].unwrap().rule_index, 5);
    assert_eq!(cursor.resolve(&path).unwrap().expression.attributes, 23);
    assert_eq!(cursor.resolve(&[]).unwrap().expression.attributes, 0);
}

#[test]
fn follow_pi_corpus_exposes_actual_pinned_contexts() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/follow_pi_corpus.json")).unwrap();
    let syntaxes = two_face::syntax::extra_newlines();
    for case in corpus.as_array().unwrap() {
        let name = case["syntax"].as_str().unwrap();
        let source = case["source"].as_str().unwrap();
        let syntax = syntaxes
            .find_syntax_by_name(name)
            .unwrap_or_else(|| panic!("missing {name}"));
        let mut parser = ParseState::new(syntax);
        let mut stack = ScopeStack::new();
        let mut bytes = 0;
        for line in syntect::util::LinesWithEndings::from(source) {
            let operations = parser.parse_line(line, &syntaxes).unwrap();
            for (range, path) in contexts_for_line(&operations, line, &mut stack) {
                for scope in &path {
                    assert!(occipital::vocabulary::ScopeId::from_scope(*scope).is_some());
                }
                let text = &line[range.clone()];
                bytes += text.len();
                writeln!(
                    std::io::stdout(),
                    "corpus-context {}",
                    serde_json::json!({
                        "case": case["id"], "text": text,
                        "scopes": path.iter().map(ToString::to_string).collect::<Vec<_>>()
                    })
                )
                .unwrap();
            }
        }
        assert_eq!(bytes, source.len(), "{name}: complete parser coverage");
        for check in case["checks"].as_array().unwrap() {
            assert!(source.contains(check["text"].as_str().unwrap()));
        }
    }
}
