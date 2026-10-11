use occipital::admission::{Admission, AdmissionError, Counters, Limits, Resource};
use std::{io::Cursor, str::FromStr};
use syntect::{
    highlighting::{Color, FontStyle, ScopeSelectors, ThemeSet},
    parsing::ScopeStack,
};

fn definition(selectors: &[&str], global: &str, style: &str) -> Vec<u8> {
    let mut xml = format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>name</key><string>Control</string><key>settings</key><array><dict><key>settings</key><dict>{global}</dict></dict>");
    for scope in selectors {
        xml.push_str(&format!("<dict><key>scope</key><string>{scope}</string><key>settings</key><dict>{style}</dict></dict>"));
    }
    xml.push_str("</array></dict></plist>");
    xml.into_bytes()
}
fn basic(selectors: &[&str]) -> Vec<u8> {
    definition(
        selectors,
        "<key>foreground</key><string>#eeeeee</string>",
        "<key>foreground</key><string>#123456</string>",
    )
}
fn assert_limit(result: Result<syntect::highlighting::Theme, AdmissionError>, expected: Resource) {
    assert!(
        matches!(result, Err(AdmissionError::Limit { resource, .. }) if resource == expected),
        "expected {expected:?}, got {result:?}"
    );
}

#[test]
fn contextual_union_exclusion_grammar_matches_public_api() {
    let text = "source.rust meta.function -comment - string.quoted, source.python | -comment";
    let bytes = basic(&[text]);
    let mut admission = Admission::new(Limits::default());
    let theme = admission.admit(&bytes).unwrap();
    let native = ThemeSet::load_from_reader(&mut Cursor::new(&bytes)).unwrap();
    assert_eq!(theme, native);
    assert_eq!(
        theme.scopes[0].scope,
        ScopeSelectors::from_str(text).unwrap()
    );
    let selectors = &theme.scopes[0].scope;
    assert_eq!(selectors.selectors.len(), 3);
    assert_eq!(selectors.selectors[0].path.len(), 2);
    assert_eq!(selectors.selectors[0].excludes.len(), 2);
    assert!(selectors
        .does_match(
            ScopeStack::from_str("source.rust meta.function")
                .unwrap()
                .as_slice()
        )
        .is_some());
    assert!(selectors
        .does_match(
            ScopeStack::from_str("source.rust meta.function comment")
                .unwrap()
                .as_slice()
        )
        .is_none());
    assert_eq!(
        admission.counters(),
        Counters {
            attempts: 1,
            definition_bytes: bytes.len(),
            selector_bytes: text.len(),
            atom_occurrences: 10,
            syntect_loads: 1
        }
    );
}

#[test]
fn rgba_fonts_and_backgrounds_are_preserved_without_projection() {
    let bytes = definition(&["string"], "<key>foreground</key><string>#0c000000</string><key>background</key><string>#01020380</string>", "<key>foreground</key><string>#aabbcc01</string><key>background</key><string>#44556600</string><key>fontStyle</key><string>bold italic underline</string>");
    let theme = Admission::new(Limits::default()).admit(&bytes).unwrap();
    assert_eq!(
        theme,
        ThemeSet::load_from_reader(&mut Cursor::new(&bytes)).unwrap()
    );
    assert_eq!(
        theme.settings.foreground,
        Some(Color {
            r: 12,
            g: 0,
            b: 0,
            a: 0
        })
    );
    assert_eq!(theme.settings.background.unwrap().a, 128);
    assert_eq!(theme.scopes[0].style.foreground.unwrap().a, 1);
    assert_eq!(theme.scopes[0].style.background.unwrap().a, 0);
    assert_eq!(
        theme.scopes[0].style.font_style,
        Some(FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE)
    );
}

#[test]
fn scope_normalization_and_empty_alternatives_match_syntect() {
    for text in [
        "",
        " , | ",
        " -",
        "a..b...",
        ".",
        "a.b.c.d.e.f.g.h....",
        "source\t-comment",
        "source -comment -string\nother",
        "source-name",
        "source\tmeta",
    ] {
        let bytes = basic(&[text]);
        let theme = Admission::new(Limits::default()).admit(&bytes).unwrap();
        assert_eq!(
            theme,
            ThemeSet::load_from_reader(&mut Cursor::new(&bytes)).unwrap(),
            "{text:?}"
        );
    }
}

#[test]
fn non_ascii_selectors_are_rejected_and_charged() {
    let bytes = basic(&["source.λ"]);
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(&bytes),
        Err(AdmissionError::NonAsciiSelector { item: 1 })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().selector_bytes, "source.λ".len());
    assert_eq!(admission.counters().atom_occurrences, 2);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn depth_is_checked_in_path_and_every_exclusion_before_any_load() {
    for text in [
        "a.b.c.d.e.f.g.h.i",
        "source -a.b.c.d.e.f.g.h.i",
        "ok|ok -ok -a.b.c.d.e.f.g.h.i",
        "a..b.c.d.e.f.g.h",
    ] {
        let mut admission = Admission::new(Limits::default());
        assert!(
            matches!(
                admission.admit(&basic(&[text])),
                Err(AdmissionError::ScopeDepth { atoms: 9, .. })
            ),
            "{text}"
        );
        assert_eq!(admission.counters().syntect_loads, 0);
    }
}

#[test]
fn malformed_plist_fails_before_syntect_but_consumes_attempt_and_bytes() {
    for bytes in [b"not plist".as_slice(), b"<plist><dict>".as_slice()] {
        let mut admission = Admission::new(Limits::default());
        assert!(matches!(
            admission.admit(bytes),
            Err(AdmissionError::Plist(_)
                | AdmissionError::Xml(_)
                | AdmissionError::XmlStructure(_))
        ));
        assert_eq!(
            admission.counters(),
            Counters {
                attempts: 1,
                definition_bytes: bytes.len(),
                ..Counters::default()
            }
        );
    }
}

#[test]
fn malformed_structure_is_not_silently_dropped() {
    for (xml, field) in [
        ("<plist><dict/></plist>", "settings"),
        ("<plist><dict><key>settings</key><array/></dict></plist>", "settings"),
        ("<plist><dict><key>settings</key><array><dict><key>settings</key><dict/></dict><dict><key>scope</key><integer>3</integer><key>settings</key><dict/></dict></array></dict></plist>", "scope"),
    ] {
        let mut admission = Admission::new(Limits::default());
        assert!(matches!(admission.admit(xml.as_bytes()), Err(AdmissionError::Structure { field: actual, .. }) if actual == field));
        assert_eq!(admission.counters().syntect_loads, 0);
    }
}

#[test]
fn malformed_global_and_rule_colors_fonts_are_errors_not_best_effort() {
    for (global, style, field) in [
        (
            "<key>foreground</key><string>invalid</string>",
            "",
            "foreground",
        ),
        ("<key>selection</key><integer>42</integer>", "", "selection"),
        (
            "",
            "<key>foreground</key><string>#gg0000</string>",
            "foreground",
        ),
        (
            "",
            "<key>background</key><string>#12345</string>",
            "background",
        ),
        (
            "",
            "<key>fontStyle</key><string>blink</string>",
            "fontStyle",
        ),
    ] {
        let mut admission = Admission::new(Limits::default());
        assert!(
            matches!(admission.admit(&definition(&["source"], global, style)), Err(AdmissionError::Style { field: actual, .. }) if actual == field)
        );
        assert_eq!(admission.counters().syntect_loads, 0);
        assert_eq!(admission.counters().atom_occurrences, 1);
    }
}

#[test]
fn file_limit_is_inclusive_and_oversize_charged_without_plist_parse() {
    let bytes = basic(&["source"]);
    let mut admission = Admission::new(Limits {
        file_bytes: bytes.len(),
        ..Limits::default()
    });
    admission.admit(&bytes).unwrap();
    assert_limit(
        admission.admit(&[bytes.clone(), vec![b' '; 1]].concat()),
        Resource::FileBytes,
    );
    assert_eq!(admission.counters().attempts, 2);
    assert_eq!(admission.counters().definition_bytes, 2 * bytes.len() + 1);
    assert_eq!(admission.counters().syntect_loads, 1);
}

#[test]
fn selector_limit_counts_union_branches_including_empty_ones_across_rules() {
    let mut admission = Admission::new(Limits {
        selectors: 4,
        ..Limits::default()
    });
    admission.admit(&basic(&["a,b", "c|d"])).unwrap();
    assert_limit(
        admission.admit(&basic(&["a,b", "c|d,"])),
        Resource::Selectors,
    );
    assert_eq!(admission.counters().syntect_loads, 1);
}

#[test]
fn default_selector_limit_is_512_not_512_rules() {
    let text = std::iter::repeat_n("a", 512).collect::<Vec<_>>().join(",");
    let mut admission = Admission::new(Limits::default());
    admission.admit(&basic(&[&text])).unwrap();
    assert_limit(
        admission.admit(&basic(&[&format!("{text},")])),
        Resource::Selectors,
    );
}

#[test]
fn attempt_budget_includes_repeated_failures_and_does_not_reset() {
    let mut admission = Admission::new(Limits {
        attempts: 2,
        ..Limits::default()
    });
    assert!(admission.admit(b"bad").is_err());
    assert!(admission.admit(b"bad").is_err());
    assert_limit(admission.admit(&basic(&[])), Resource::Attempts);
    assert_eq!(admission.counters().attempts, 2);
    assert_eq!(admission.counters().definition_bytes, 6);
}

#[test]
fn definition_byte_budget_reserves_before_parse_and_never_refunds() {
    let mut admission = Admission::new(Limits {
        definition_bytes: 6,
        ..Limits::default()
    });
    assert!(admission.admit(b"bad").is_err());
    assert!(admission.admit(b"bad").is_err());
    assert_limit(admission.admit(b"x"), Resource::DefinitionBytes);
    assert_eq!(admission.counters().attempts, 3);
    assert_eq!(admission.counters().definition_bytes, 6);
}

#[test]
fn selector_text_budget_reserves_failures_and_denial_does_not_intern() {
    let mut admission = Admission::new(Limits {
        selector_bytes: 4,
        ..Limits::default()
    });
    assert!(admission.admit(&basic(&["λ"])).is_err());
    admission.admit(&basic(&["ab"])).unwrap();
    assert_limit(admission.admit(&basic(&["a"])), Resource::SelectorBytes);
    assert_eq!(admission.counters().selector_bytes, 4);
    assert_eq!(admission.counters().atom_occurrences, 2);
    assert_eq!(admission.counters().syntect_loads, 1);
}

#[test]
fn occurrence_budget_counts_repeated_atoms_and_failed_depths() {
    let mut admission = Admission::new(Limits {
        atom_occurrences: 10,
        ..Limits::default()
    });
    assert!(admission.admit(&basic(&["a.a.a.a.a.a.a.a.a"])).is_err());
    admission.admit(&basic(&["a"])).unwrap();
    assert_limit(admission.admit(&basic(&["a"])), Resource::AtomOccurrences);
    assert_eq!(admission.counters().atom_occurrences, 10);
    assert_eq!(admission.counters().syntect_loads, 1);
}

#[test]
fn cumulative_charge_is_atomic_across_selector_text_and_atoms() {
    let mut admission = Admission::new(Limits {
        atom_occurrences: 0,
        ..Limits::default()
    });
    assert_limit(admission.admit(&basic(&["a"])), Resource::AtomOccurrences);
    assert_eq!(admission.counters().selector_bytes, 0);
    assert_eq!(admission.counters().atom_occurrences, 0);
}

#[test]
fn counters_use_checked_arithmetic() {
    let mut admission = Admission::new(Limits {
        definition_bytes: usize::MAX,
        ..Limits::default()
    });
    assert!(admission.admit(b"bad").is_err());
    assert_eq!(admission.counters().definition_bytes, 3);
}

#[test]
fn default_limits_are_exact_and_attempt_64_is_the_last_admitted_failure() {
    let mut admission = Admission::new(Limits::default());
    let limits = admission.limits();
    assert_eq!(limits.file_bytes, 128 * 1024);
    assert_eq!(limits.selectors, 512);
    assert_eq!(limits.attempts, 64);
    assert_eq!(limits.definition_bytes, 8 * 1024 * 1024);
    assert_eq!(limits.selector_bytes, 256 * 1024);
    assert_eq!(limits.atom_occurrences, 4096);
    for _ in 0..64 {
        assert!(matches!(
            admission.admit(b"bad"),
            Err(AdmissionError::Plist(_)
                | AdmissionError::Xml(_)
                | AdmissionError::XmlStructure(_))
        ));
    }
    assert_limit(admission.admit(&basic(&[])), Resource::Attempts);
    assert_eq!(admission.counters().attempts, 64);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn default_file_and_total_definition_bytes_accept_exact_boundaries() {
    let mut bytes = basic(&[]);
    bytes.resize(128 * 1024, b' ');
    let mut admission = Admission::new(Limits::default());
    for _ in 0..64 {
        admission.admit(&bytes).unwrap();
    }
    assert_eq!(admission.counters().definition_bytes, 8 * 1024 * 1024);
    assert_eq!(admission.counters().syntect_loads, 64);
    assert_limit(admission.admit(&bytes), Resource::Attempts);
    bytes.push(b' ');
    let mut fresh = Admission::new(Limits::default());
    assert_limit(fresh.admit(&bytes), Resource::FileBytes);
    assert_eq!(fresh.counters().syntect_loads, 0);
}

#[test]
fn default_cumulative_selector_text_boundary_counts_whitespace() {
    let mut admission = Admission::new(Limits::default());
    let spaces = " ".repeat(100 * 1024);
    admission.admit(&basic(&[&spaces])).unwrap();
    admission.admit(&basic(&[&spaces])).unwrap();
    admission.admit(&basic(&[&" ".repeat(56 * 1024)])).unwrap();
    assert_eq!(admission.counters().selector_bytes, 256 * 1024);
    assert_eq!(admission.counters().atom_occurrences, 0);
    assert_limit(admission.admit(&basic(&[" "])), Resource::SelectorBytes);
    assert_eq!(admission.counters().syntect_loads, 3);
}

#[test]
fn default_cumulative_atom_occurrences_boundary_counts_every_stack_term() {
    let mut admission = Admission::new(Limits::default());
    let text = "a ".repeat(4096);
    admission.admit(&basic(&[&text])).unwrap();
    assert_eq!(admission.counters().atom_occurrences, 4096);
    assert_limit(admission.admit(&basic(&["a"])), Resource::AtomOccurrences);
    assert_eq!(admission.counters().syntect_loads, 1);
}

#[test]
fn ignored_first_scope_and_unknown_metadata_follow_native_semantics() {
    let bytes = b"<plist><dict><key>name</key><string>Metadata</string><key>gutterSettings</key><dict><key>foreground</key><string>#abcdef80</string></dict><key>settings</key><array><dict><key>scope</key><string>a.b.c.d.e.f.g.h.i</string><key>settings</key><dict><key>unknownColor</key><string>not-a-color</string><key>bracketsOptions</key><string>squiggly_underline</string></dict></dict></array></dict></plist>";
    let mut admission = Admission::new(Limits::default());
    assert_eq!(
        admission.admit(bytes).unwrap(),
        ThemeSet::load_from_reader(&mut Cursor::new(bytes)).unwrap()
    );
    assert_eq!(admission.counters().selector_bytes, 0);
    assert_eq!(admission.counters().atom_occurrences, 0);
}

#[test]
fn global_gutter_color_errors_are_not_silently_ignored() {
    let bytes = b"<plist><dict><key>gutterSettings</key><dict><key>foreground</key><string>bad</string></dict><key>settings</key><array><dict><key>settings</key><dict/></dict></array></dict></plist>";
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(bytes),
        Err(AdmissionError::Style {
            item: None,
            field: "foreground",
            ..
        })
    ));
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn decoded_entity_selectors_are_measured_not_the_raw_xml_spelling() {
    let mut admission = Admission::new(Limits::default());
    let theme = admission.admit(&basic(&["a&#46;b&#32;-c|d"])).unwrap();
    assert_eq!(
        theme.scopes[0].scope,
        ScopeSelectors::from_str("a.b -c|d").unwrap()
    );
    assert_eq!(admission.counters().selector_bytes, "a.b -c|d".len());
    assert_eq!(admission.counters().atom_occurrences, 4);
}

#[test]
fn measured_bundled_maximum_of_387_alternatives_fits_custom_admission() {
    // The pinned four Catppuccin presets each contain 387 union branches.
    // This is a structural-size control, not a copied upstream theme definition.
    let scope = std::iter::repeat_n("variable.parameter", 387)
        .collect::<Vec<_>>()
        .join(",");
    let mut admission = Admission::new(Limits::default());
    let theme = admission.admit(&basic(&[&scope])).unwrap();
    assert_eq!(theme.scopes[0].scope.selectors.len(), 387);
    assert_eq!(admission.counters().atom_occurrences, 774);
}
