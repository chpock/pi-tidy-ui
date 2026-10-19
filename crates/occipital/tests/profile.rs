use occipital::profile::Profile;
use std::sync::Arc;
use syntect::{
    highlighting::{ScopeSelector, ScopeSelectors, StyleModifier, Theme, ThemeItem},
    parsing::{Scope, ScopeStack},
};

#[test]
fn native_profile_bounds_selector_alternatives_and_compound_structure() {
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
        ScopeSelectors {
            selectors: vec![ScopeSelector {
                path: ScopeStack::from_vec(vec![Scope::new("source.rust").unwrap(); 4097]),
                excludes: vec![],
            }],
        },
    ] {
        let mut theme = Theme::default();
        theme.scopes.push(ThemeItem {
            scope,
            style: StyleModifier::default(),
        });
        assert_eq!(
            Profile::native("custom:oversize".into(), "fixture".into(), Arc::new(theme))
                .err()
                .unwrap()
                .code,
            "theme_limit"
        );
    }
}

#[test]
fn bundled_profiles_keep_exact_definition_fingerprints_and_never_manufacture_pi() {
    use sha2::{Digest, Sha256};
    let names = Profile::bundled_names();
    assert_eq!(names.len(), 32);
    for name in names {
        let profile = Profile::resolve(&name).unwrap();
        let expected = format!(
            "{:x}",
            Sha256::digest(format!(
                "syntect/5.3.0:two-face/0.5.2+bat-0.26.1:roles/v1:line-prefix/65536/v1:{name}"
            ))
        );
        assert_eq!(profile.fingerprint, expected);
        assert!(profile.native_theme().is_some());
        assert!(Arc::ptr_eq(&profile, &Profile::resolve(&name).unwrap()));
    }
    for invalid in [
        "pi",
        "missing",
        "syntect:missing",
        "syntect:\nNord",
        &"x".repeat(129),
    ] {
        assert_eq!(
            Profile::resolve(invalid).err().unwrap().code,
            "profile_unavailable"
        );
    }
}
