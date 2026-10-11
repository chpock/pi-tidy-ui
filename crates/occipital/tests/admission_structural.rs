use occipital::admission::{Admission, AdmissionError, Limits, Resource};
use serde_json::{json, Value};

fn theme_with_extra(extra: Value) -> Value {
    json!({"name": "Structural control", "unused": extra, "settings": [{"settings": {}}, {"scope": "structuralFreshAtom", "settings": {"foreground": "#11223380", "fontStyle": "italic"}}]})
}
fn binary(value: &Value) -> Vec<u8> {
    let mut bytes = Vec::new();
    plist::to_writer_binary(&mut bytes, value).unwrap();
    bytes
}

#[test]
fn deep_binary_is_rejected_before_recursive_theme_decoding() {
    let mut nested = json!("leaf");
    for _ in 0..129 {
        nested = json!([nested]);
    }
    let bytes = binary(&theme_with_extra(nested));
    assert!(bytes.len() < 128 * 1024);
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(&bytes),
        Err(AdmissionError::Limit {
            resource: Resource::PlistDepth,
            ..
        })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn deep_xml_is_rejected_before_recursive_theme_decoding() {
    let mut nested = json!("leaf");
    for _ in 0..129 {
        nested = json!([nested]);
    }
    let mut bytes = Vec::new();
    plist::to_writer_xml(&mut bytes, &theme_with_extra(nested)).unwrap();
    assert!(bytes.len() < 128 * 1024);
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(&bytes),
        Err(AdmissionError::Limit {
            resource: Resource::PlistDepth,
            ..
        })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn compact_binary_shared_string_dag_is_bounded_before_value_expansion() {
    // plist's public writer interns equal scalar objects: 16 root references
    // share one 16KiB string, but a Value tree would duplicate it 16 times.
    let bytes = binary(&theme_with_extra(json!(vec!["x".repeat(16 * 1024); 16])));
    assert!(bytes.len() < 20 * 1024);
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(&bytes),
        Err(AdmissionError::Limit {
            resource: Resource::ExpandedBytes,
            ..
        })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn compact_binary_shared_empty_string_dag_has_a_node_bound() {
    let bytes = binary(&theme_with_extra(json!(vec![""; 9000])));
    assert!(bytes.len() < 20 * 1024);
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(&bytes),
        Err(AdmissionError::Limit {
            resource: Resource::PlistEvents,
            ..
        })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn valid_binary_theme_preserves_exact_public_loader_definition() {
    let bytes = binary(&theme_with_extra(json!(["ordinary metadata"])));
    let theme = Admission::new(Limits::default()).admit(&bytes).unwrap();
    assert_eq!(
        theme,
        syntect::highlighting::ThemeSet::load_from_reader(&mut std::io::Cursor::new(&bytes))
            .unwrap()
    );
    assert_eq!(theme.scopes.len(), 1);
    assert_eq!(theme.scopes[0].style.foreground.unwrap().a, 128);
}

#[test]
fn public_stream_api_compile_guard_and_inclusive_structural_limits() {
    // Explicit dependency seam guard: these public APIs require the pinned
    // plist version plus its named unstable feature, not any private field.
    fn assert_iterator(_: impl Iterator<Item = Result<plist::stream::OwnedEvent, plist::Error>>) {}
    let xml = b"<plist><dict><key>settings</key><array><dict><key>settings</key><dict/></dict></array></dict></plist>";
    assert_iterator(plist::stream::XmlReader::new(std::io::Cursor::new(xml)));
    let binary = binary(&json!({"settings": [{"settings": {}}]}));
    assert_iterator(plist::stream::BinaryReader::new(std::io::Cursor::new(
        &binary,
    )));
    let ascii = b"{ settings = ({ settings = {}; }); }";
    assert_iterator(plist::stream::AsciiReader::new(std::io::Cursor::new(ascii)));
    for bytes in [xml.as_slice(), binary.as_slice(), ascii.as_slice()] {
        let limits = Limits {
            plist_depth: 4,
            plist_events: 10,
            expanded_bytes: 16,
            ..Limits::default()
        };
        Admission::new(limits).admit(bytes).unwrap();
        for (limits, expected) in [
            (
                Limits {
                    plist_depth: 3,
                    ..limits
                },
                Resource::PlistDepth,
            ),
            (
                Limits {
                    plist_events: 9,
                    ..limits
                },
                Resource::PlistEvents,
            ),
            (
                Limits {
                    expanded_bytes: 15,
                    ..limits
                },
                Resource::ExpandedBytes,
            ),
        ] {
            let mut admission = Admission::new(limits);
            assert!(
                matches!(admission.admit(bytes), Err(AdmissionError::Limit { resource, .. }) if resource == expected)
            );
            assert_eq!(admission.counters().attempts, 1);
            assert_eq!(admission.counters().definition_bytes, bytes.len());
            assert_eq!(admission.counters().syntect_loads, 0);
        }
    }
}

#[test]
fn incomplete_multiple_root_mismatched_and_bad_attribute_xml_never_reaches_syntect() {
    let valid = "<plist><dict><key>settings</key><array><dict><key>settings</key><dict/></dict></array></dict></plist>";
    let cases = [
        valid.trim_end_matches("</plist>").to_owned(),
        format!("{valid}{valid}"),
        valid.replace("</dict></plist>", "</array></plist>"),
        valid.replace("<plist>", "<plist version=\"1\" version=\"1\">"),
        valid.replace(
            "<dict/>",
            "<dict><key>unknown</key><string>&undeclared;</string></dict>",
        ),
        valid.replace(
            "<dict/>",
            "<dict><key>unknown</key><string>&#garbage;</string></dict>",
        ),
    ];
    for bytes in cases {
        let mut admission = Admission::new(Limits::default());
        assert!(matches!(
            admission.admit(bytes.as_bytes()),
            Err(AdmissionError::Xml(_) | AdmissionError::XmlStructure(_))
        ));
        assert_eq!(admission.counters().attempts, 1);
        assert_eq!(admission.counters().definition_bytes, bytes.len());
        assert_eq!(admission.counters().syntect_loads, 0);
    }
}

#[test]
fn malformed_binary_is_rejected_and_charged_before_syntect() {
    let bytes = b"bplist00invalid";
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(bytes),
        Err(AdmissionError::Plist(_))
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().definition_bytes, bytes.len());
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn valid_ascii_theme_preserves_exact_public_loader_definition() {
    let text = "source.rust string.quoted -comment | source.python";
    for prefix in [
        "",
        " // ordinary comment\n",
        " /* ordinary comment */ ",
        " // comment with <plist> <?xml version=\"1.0\"?>\n",
    ] {
        let bytes = format!("{prefix}{{ name = Legacy; settings = ({{ settings = {{ foreground = \"#0c000000\"; background = \"#11223380\"; }}; }}, {{ scope = \"{text}\"; settings = {{ foreground = \"#aabbcc01\"; background = \"#44556600\"; fontStyle = \"bold italic underline\"; }}; }}); }}");
        let mut admission = Admission::new(Limits::default());
        let theme = admission.admit(bytes.as_bytes()).unwrap();
        assert_eq!(
            theme,
            syntect::highlighting::ThemeSet::load_from_reader(&mut std::io::Cursor::new(
                bytes.as_bytes()
            ))
            .unwrap()
        );
        assert_eq!(theme.scopes.len(), 1);
        assert_eq!(theme.settings.foreground.unwrap().a, 0);
        assert_eq!(theme.settings.background.unwrap().a, 128);
        assert_eq!(theme.scopes[0].style.foreground.unwrap().a, 1);
        assert_eq!(theme.scopes[0].style.background.unwrap().a, 0);
        assert_eq!(admission.counters().attempts, 1);
        assert_eq!(admission.counters().definition_bytes, bytes.len());
        assert_eq!(admission.counters().selector_bytes, text.len());
        assert_eq!(admission.counters().atom_occurrences, 7);
        assert_eq!(admission.counters().syntect_loads, 1);
    }
}

#[test]
fn deep_ascii_is_rejected_before_recursive_theme_decoding() {
    let bytes = format!("{{ settings = ({{ settings = {{}}; }}, {{ scope = asciiDepthFresh; settings = {{}}; }}); unused = {}leaf {}; }}", "(".repeat(129), ")".repeat(129));
    let mut admission = Admission::new(Limits::default());
    assert!(matches!(
        admission.admit(bytes.as_bytes()),
        Err(AdmissionError::Limit {
            resource: Resource::PlistDepth,
            ..
        })
    ));
    assert_eq!(admission.counters().attempts, 1);
    assert_eq!(admission.counters().definition_bytes, bytes.len());
    assert_eq!(admission.counters().selector_bytes, 0);
    assert_eq!(admission.counters().syntect_loads, 0);
}

#[test]
fn malformed_ascii_is_rejected_and_charged_before_syntect() {
    let valid =
        "{ settings = ({ settings = {}; }, { scope = asciiMalformedFresh; settings = {}; }); }";
    for bytes in [
        valid.trim_end_matches('}').to_owned(),
        format!("{valid} {{}}"),
        format!("{valid} \"unfinished"),
        format!("{valid} /* unfinished"),
    ] {
        let mut admission = Admission::new(Limits::default());
        assert!(matches!(
            admission.admit(bytes.as_bytes()),
            Err(AdmissionError::Plist(_) | AdmissionError::Structure { .. })
        ));
        assert_eq!(admission.counters().attempts, 1);
        assert_eq!(admission.counters().definition_bytes, bytes.len());
        assert_eq!(admission.counters().selector_bytes, 0);
        assert_eq!(admission.counters().syntect_loads, 0);
    }
}

#[test]
fn malformed_xml_cannot_fall_back_to_ascii() {
    for prefix in [
        "",
        " ",
        "<!-- prolog -->",
        "<?xml version=\"1.0\"?>",
        "<!DOCTYPE plist>",
    ] {
        for suffix in [
            "<plist><dict>",
            "<unknown/>",
            "<plist version=\"1\" version=\"2\"><dict/></plist>",
        ] {
            let bytes = format!("{prefix}{suffix}");
            let mut admission = Admission::new(Limits::default());
            let result = admission.admit(bytes.as_bytes());
            if suffix == "<unknown/>" {
                // Well-framed XML, but the public XML plist reader rejects the tag.
                assert!(matches!(result, Err(AdmissionError::Plist(_))));
            } else {
                // These must reach XML framing, not an ASCII fallback failure.
                assert!(matches!(
                    result,
                    Err(AdmissionError::Xml(_) | AdmissionError::XmlStructure(_))
                ));
            }
            assert_eq!(admission.counters().attempts, 1);
            assert_eq!(admission.counters().definition_bytes, bytes.len());
            assert_eq!(admission.counters().syntect_loads, 0);
        }
    }
}
