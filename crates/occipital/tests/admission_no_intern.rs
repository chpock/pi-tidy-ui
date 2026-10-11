//! Keep this sentinel test in its own integration binary: no parallel test in
//! this process may intern atoms between the public atom_at observations.
use occipital::admission::{Admission, Limits};
use syntect::parsing::Scope;

fn definition(selectors: &[&str], style: &str) -> Vec<u8> {
    let mut xml = String::from(
        "<plist><dict><key>settings</key><array><dict><key>settings</key><dict/></dict>",
    );
    for text in selectors {
        xml.push_str(&format!("<dict><key>scope</key><string>{text}</string><key>settings</key><dict>{style}</dict></dict>"));
    }
    xml.push_str("</array></dict></plist>");
    xml.into_bytes()
}

#[test]
fn rejected_definitions_do_not_intern_even_earlier_valid_terms() {
    let before = Scope::new("admissionSentinelBeforeUnique")
        .unwrap()
        .atom_at(0);
    let mut admission = Admission::new(Limits::default());
    for selectors in [
        vec!["admissionFreshAllowed", "admissionFresh1.admissionFresh2.admissionFresh3.admissionFresh4.admissionFresh5.admissionFresh6.admissionFresh7.admissionFresh8.admissionFresh9"],
        vec!["admissionFreshAscii", "admissionNonAsciiλ"],
        vec!["admissionAllowedPath -admissionFresh1.admissionFresh2.admissionFresh3.admissionFresh4.admissionFresh5.admissionFresh6.admissionFresh7.admissionFresh8.admissionFresh9"],
    ] {
        assert!(admission.admit(&definition(&selectors, "")).is_err());
    }
    assert!(admission
        .admit(&definition(
            &["admissionBadColorFresh"],
            "<key>foreground</key><string>bad</string>"
        ))
        .is_err());
    // Fully formed scope appears before the XML failure; no Syntect call allowed.
    let mut malformed = definition(&["admissionPlistFresh"], "");
    malformed.truncate(malformed.len() - 8);
    assert!(admission.admit(&malformed).is_err());
    for limits in [
        Limits {
            selectors: 0,
            ..Limits::default()
        },
        Limits {
            atom_occurrences: 0,
            ..Limits::default()
        },
        Limits {
            selector_bytes: 0,
            ..Limits::default()
        },
        Limits {
            file_bytes: 0,
            ..Limits::default()
        },
        Limits {
            definition_bytes: 0,
            ..Limits::default()
        },
        Limits {
            attempts: 0,
            ..Limits::default()
        },
    ] {
        assert!(Admission::new(limits)
            .admit(&definition(&["admissionLimitFresh"], ""))
            .is_err());
    }
    // Structural safety failures in both formats also allocate no scope atoms.
    let mut nested = serde_json::json!("leaf");
    for _ in 0..129 {
        nested = serde_json::json!([nested]);
    }
    let raw = serde_json::json!({"settings": [{"settings": {}}, {"scope": "admissionDeepFresh", "settings": {}}], "unused": nested});
    let mut deep_xml = Vec::new();
    let mut deep_binary = Vec::new();
    plist::to_writer_xml(&mut deep_xml, &raw).unwrap();
    plist::to_writer_binary(&mut deep_binary, &raw).unwrap();
    for bytes in [deep_xml, deep_binary] {
        assert!(admission.admit(&bytes).is_err());
    }
    let raw = serde_json::json!({"settings": [{"settings": {}}, {"scope": "admissionExpansionFresh", "settings": {}}], "unused": vec!["x".repeat(16 * 1024); 16]});
    let mut expanded_binary = Vec::new();
    plist::to_writer_binary(&mut expanded_binary, &raw).unwrap();
    assert!(admission.admit(&expanded_binary).is_err());
    let deep_ascii = format!("{{ settings = ({{ settings = {{}}; }}, {{ scope = asciiDeepFresh; settings = {{}}; }}); unused = {}leaf {}; }}", "(".repeat(129), ")".repeat(129));
    for bytes in [
        deep_ascii,
        "{ settings = ({ settings = {}; }, { scope = asciiMalformedFresh; settings = {}; }); ".to_owned(),
        "{ settings = ({ settings = {}; }, { scope = asciiQuotedFresh; settings = {}; }); broken = \"unfinished".to_owned(),
        "{ settings = ({ settings = {}; }, { scope = \"asciiFresh1.asciiFresh2.asciiFresh3.asciiFresh4.asciiFresh5.asciiFresh6.asciiFresh7.asciiFresh8.asciiFresh9\"; settings = {}; }); }".to_owned(),
    ] {
        let before = admission.counters();
        assert!(admission.admit(bytes.as_bytes()).is_err());
        let after = admission.counters();
        assert_eq!(after.attempts, before.attempts + 1);
        assert_eq!(after.definition_bytes, before.definition_bytes + bytes.len());
        assert_eq!(after.syntect_loads, before.syntect_loads);
    }
    let ascii =
        b"{ settings = ({ settings = {}; }, { scope = asciiLimitFresh; settings = {}; }); }";
    for limits in [
        Limits {
            plist_events: 0,
            ..Limits::default()
        },
        Limits {
            expanded_bytes: 0,
            ..Limits::default()
        },
        Limits {
            plist_depth: 0,
            ..Limits::default()
        },
    ] {
        let mut admission = Admission::new(limits);
        assert!(admission.admit(ascii).is_err());
        assert_eq!(admission.counters().attempts, 1);
        assert_eq!(admission.counters().definition_bytes, ascii.len());
        assert_eq!(admission.counters().syntect_loads, 0);
    }
    let too_many_paths = format!("admissionEmptyExclusionFresh{}", " -".repeat(4096));
    let before_limits = admission.counters();
    assert!(admission
        .admit(&definition(&[&too_many_paths], ""))
        .is_err());
    assert_eq!(
        admission.counters().syntect_loads,
        before_limits.syntect_loads
    );
    let after = Scope::new("admissionSentinelAfterUnique")
        .unwrap()
        .atom_at(0);
    assert_eq!(
        after,
        before + 1,
        "preflight rejection must allocate no scope atoms"
    );
}
