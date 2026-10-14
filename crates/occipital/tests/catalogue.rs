mod support;

use occipital::catalogue::{
    Catalogue, Diagnostic, MAX_CONFIG_BYTES, MAX_CUSTOM_THEMES, MAX_DIRECTORY_ENTRIES,
    MAX_THEME_BYTES,
};
use std::{fs, path::PathBuf, sync::Arc};

struct Fixture(support::CaseDir);
impl Fixture {
    fn new() -> Self {
        let root = support::CaseDir::new("catalogue");
        fs::create_dir(root.join("themes")).unwrap();
        Self(root)
    }
    fn config(&self, text: &str) {
        fs::write(self.0.join("config.json"), text).unwrap();
    }
    fn file(&self, name: &str, bytes: impl AsRef<[u8]>) {
        fs::write(self.0.join("themes").join(name), bytes).unwrap();
    }
    fn catalogue(&self) -> Catalogue {
        Catalogue::new(Some(self.0.join("config.json")))
    }
}
fn theme(color: &str) -> Vec<u8> {
    format!("<plist><dict><key>name</key><string>Custom control</string><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>{color}</string></dict></dict><dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#112233</string></dict></dict></array></dict></plist>").into_bytes()
}
fn custom(snapshot: &occipital::catalogue::Snapshot) -> Vec<occipital::catalogue::Descriptor> {
    snapshot
        .descriptors()
        .filter(|d| d.id.starts_with("custom:"))
        .cloned()
        .collect()
}

#[test]
fn default_explicit_and_relative_roots_and_unresolved_os_root() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("occipital/themes")).unwrap();
    fs::write(
        f.0.join("occipital/themes/default.tmTheme"),
        theme("#223344"),
    )
    .unwrap();
    let default = Catalogue::from_os_root(Some(f.0.to_path_buf()));
    assert_eq!(
        default.config_path(),
        Some(f.0.join("occipital/config.json").as_path())
    );
    assert_eq!(custom(&default.snapshot()).len(), 1);
    f.config(r#"{"themeDirectories":["themes"]}"#);
    f.file("explicit.tmTheme", theme("#223344"));
    let explicit = f.catalogue();
    assert_eq!(custom(&explicit.snapshot()).len(), 1);
    assert_eq!(explicit.snapshot().descriptors().count(), 34);
    assert!(explicit.snapshot().profile("pi").unwrap().theme.is_none());
    assert!(explicit
        .snapshot()
        .profile("syntect:Catppuccin Mocha")
        .is_some());
    assert!(explicit.snapshot().profile("../../secret").is_none());
    let unresolved = Catalogue::from_os_root(None);
    assert_eq!(unresolved.diagnostic(), Some(Diagnostic::RootUnavailable));
    assert_eq!(unresolved.snapshot().descriptors().count(), 33);
    assert!(unresolved.config_path().is_none());
}

#[test]
fn missing_defaults_and_missing_field_are_normal_but_observed_directory_loss_fails() {
    let f = Fixture::new();
    fs::remove_dir(f.0.join("themes")).unwrap();
    let mut c = f.catalogue();
    assert_eq!(c.diagnostic(), None);
    assert_eq!(c.snapshot().descriptors().count(), 33);
    f.config("{}");
    assert!(c.refresh().is_ok());
    fs::create_dir(f.0.join("themes")).unwrap();
    f.file("present.tmTheme", theme("#223344"));
    c.refresh().unwrap();
    fs::remove_dir_all(f.0.join("themes")).unwrap();
    let old = c.snapshot();
    assert_eq!(c.refresh().err(), Some(Diagnostic::DirectoryRead));
    assert!(Arc::ptr_eq(&old, &c.snapshot()));
    f.config(r#"{"themeDirectories":["missing"]}"#);
    assert_eq!(c.refresh().err(), Some(Diagnostic::DirectoryRead));
}

#[test]
fn malformed_oversize_unknown_and_duplicate_config_fail_without_admission() {
    let f = Fixture::new();
    let mut c = f.catalogue();
    let old = c.snapshot();
    for text in [
        "[]",
        "{",
        r#"{"themeDirectories":"themes"}"#,
        r#"{"themeDirectories":null}"#,
        r#"{"activeTheme":"secret source"}"#,
        r#"{"themeDirectories":[],"themeDirectories":[]}"#,
    ] {
        f.config(text);
        assert_eq!(c.refresh().err(), Some(Diagnostic::ConfigInvalid));
        assert!(Arc::ptr_eq(&old, &c.snapshot()));
    }
    f.config(&" ".repeat(MAX_CONFIG_BYTES + 1));
    assert_eq!(c.refresh().err(), Some(Diagnostic::ConfigLimit));
    assert_eq!(c.admission_counters().attempts, 0);
}

#[test]
fn stable_id_content_fingerprint_and_unchanged_refresh_share_profiles() {
    let f = Fixture::new();
    f.file("stable.tmTheme", theme("#223344"));
    let mut c = f.catalogue();
    let first = c.snapshot();
    let d = custom(&first).pop().unwrap();
    let profile = first.profile(&d.id).unwrap();
    let counters = c.admission_counters();
    assert!(Arc::ptr_eq(&first, &c.refresh().unwrap()));
    assert_eq!(c.admission_counters(), counters);
    assert!(Arc::ptr_eq(&profile, &c.snapshot().profile(&d.id).unwrap()));
    f.file("stable.tmTheme", theme("#556677"));
    let changed = c.refresh().unwrap();
    let next = custom(&changed).pop().unwrap();
    assert_eq!(d.id, next.id);
    assert_ne!(d.fingerprint, next.fingerprint);
    assert_eq!(changed.revision(), first.revision() + 1);
    assert_eq!(
        c.admission_counters().syntect_loads,
        counters.syntect_loads + 1
    );
    assert_ne!(
        profile.theme.as_ref().unwrap().settings.foreground,
        changed
            .profile(&d.id)
            .unwrap()
            .theme
            .as_ref()
            .unwrap()
            .settings
            .foreground
    );
    fs::remove_file(f.0.join("themes/stable.tmTheme")).unwrap();
    let removed = c.refresh().unwrap();
    assert!(removed.profile(&d.id).is_none());
    f.file("stable.tmTheme", theme("#223344"));
    c.refresh().unwrap();
    assert_eq!(
        c.admission_counters().syntect_loads,
        counters.syntect_loads + 2
    );
}

#[test]
fn invalid_replacement_and_repeated_failed_bytes_retain_last_valid_snapshot() {
    let f = Fixture::new();
    f.file("stable.tmTheme", theme("#223344"));
    let mut c = f.catalogue();
    let valid = c.snapshot();
    f.file("stable.tmTheme", theme("bad"));
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    let counters = c.admission_counters();
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    assert_eq!(c.admission_counters(), counters);
    assert!(Arc::ptr_eq(&valid, &c.snapshot()));
    f.file("stable.tmTheme", theme("#223344"));
    assert!(Arc::ptr_eq(&valid, &c.refresh().unwrap()));
    assert_eq!(c.diagnostic(), None);
}

#[test]
fn bounded_enumeration_file_count_and_bytes_precede_admission() {
    let f = Fixture::new();
    let mut c = f.catalogue();
    f.file("large.tmTheme", vec![b'x'; MAX_THEME_BYTES + 1]);
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeLimit));
    assert_eq!(c.admission_counters().attempts, 0);
    fs::remove_file(f.0.join("themes/large.tmTheme")).unwrap();
    for n in 0..=MAX_CUSTOM_THEMES {
        f.file(&format!("{n}.tmTheme"), theme("#223344"));
    }
    assert_eq!(c.refresh().err(), Some(Diagnostic::CatalogueLimit));
    assert_eq!(c.admission_counters().attempts, 0);
    fs::remove_dir_all(f.0.join("themes")).unwrap();
    fs::create_dir(f.0.join("themes")).unwrap();
    for n in 0..=MAX_DIRECTORY_ENTRIES {
        f.file(&format!("{n}.txt"), []);
    }
    assert_eq!(c.refresh().err(), Some(Diagnostic::EnumerationLimit));
    assert_eq!(c.admission_counters().attempts, 0);
}

#[test]
fn duplicate_roots_and_parent_escape_fail_without_parsing() {
    let f = Fixture::new();
    f.file("same.tmTheme", theme("#223344"));
    f.config(r#"{"themeDirectories":["themes","themes/."]}"#);
    let c = f.catalogue();
    assert_eq!(c.diagnostic(), Some(Diagnostic::DuplicateId));
    assert_eq!(c.admission_counters().syntect_loads, 0);
    f.config(r#"{"themeDirectories":["../outside"]}"#);
    let c = f.catalogue();
    assert_eq!(c.diagnostic(), Some(Diagnostic::PathEscape));
}

#[cfg(unix)]
#[test]
fn symlink_file_escape_is_rejected_and_nonrecursive_listing_ignores_nested_files() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("themes/nested")).unwrap();
    fs::write(f.0.join("themes/nested/ignored.tmTheme"), b"invalid").unwrap();
    let mut c = f.catalogue();
    assert_eq!(custom(&c.snapshot()).len(), 0);
    fs::write(f.0.join("outside.tmTheme"), theme("#223344")).unwrap();
    std::os::unix::fs::symlink(
        f.0.join("outside.tmTheme"),
        f.0.join("themes/escape.tmTheme"),
    )
    .unwrap();
    assert_eq!(c.refresh().err(), Some(Diagnostic::PathEscape));
    assert_eq!(c.admission_counters().attempts, 0);
}

#[test]
fn native_xml_binary_and_openstep_formats_are_admitted() {
    let f = Fixture::new();
    f.file("xml.tmTheme", theme("#223344"));
    let mut bytes = Vec::new();
    plist::to_writer_binary(
        &mut bytes,
        &serde_json::json!({"settings":[{"settings":{"foreground":"#445566"}}]}),
    )
    .unwrap();
    f.file("binary.tmTheme", bytes);
    f.file(
        "ascii.tmTheme",
        b"{ settings = ({ settings = { foreground = \"#778899\"; }; }); }",
    );
    let c = f.catalogue();
    assert_eq!(c.diagnostic(), None);
    assert_eq!(custom(&c.snapshot()).len(), 3);
    assert_eq!(c.admission_counters().syntect_loads, 3);
}

#[test]
fn cumulative_attempts_bound_changing_failures_without_syntect_interning() {
    let f = Fixture::new();
    let mut c = f.catalogue();
    let baseline = c.snapshot();
    for n in 0..64 {
        f.file("bad.tmTheme", format!("invalid {n}"));
        assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    }
    assert_eq!(c.admission_counters().attempts, 64);
    f.file("bad.tmTheme", theme("#223344"));
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    assert_eq!(c.admission_counters().attempts, 64);
    assert_eq!(c.admission_counters().syntect_loads, 0);
    assert!(Arc::ptr_eq(&baseline, &c.snapshot()));
}

#[test]
fn rejected_scope_depth_never_reaches_syntect_loader() {
    // Isolate the actual public atom counter from all other tests/bundled loads.
    if std::env::var_os("OCCIPITAL_CATALOGUE_ATOM_PROBE").is_none() {
        let root = support::CaseDir::new("catalogue-atom");
        let output = root
            .command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "rejected_scope_depth_never_reaches_syntect_loader",
            ])
            .env("OCCIPITAL_CATALOGUE_ATOM_PROBE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let before = syntect::parsing::Scope::new("catalogueSentinelBeforeUnique")
        .unwrap()
        .atom_at(0);
    let f = Fixture::new();
    let text = String::from_utf8(theme("#223344")).unwrap().replace(
        "<string>comment</string>",
        "<string>catalogueFreshAllowed, a.b.c.d.e.f.g.h.i</string>",
    );
    f.file("reject.tmTheme", text);
    let c = f.catalogue();
    assert_eq!(c.diagnostic(), Some(Diagnostic::ThemeAdmission));
    assert_eq!(c.admission_counters().attempts, 1);
    assert_eq!(c.admission_counters().syntect_loads, 0);
    let after = syntect::parsing::Scope::new("catalogueSentinelAfterUnique")
        .unwrap()
        .atom_at(0);
    assert_eq!(
        after,
        before + 1,
        "rejected filesystem definition must not intern even its valid leading term"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn native_platform_resolver_obeys_xdg_config_home() {
    if let Some(root) = std::env::var_os("OCCIPITAL_CATALOGUE_ROOT_PROBE") {
        let root = PathBuf::from(root);
        let c = Catalogue::new(None);
        assert_eq!(
            c.config_path(),
            Some(root.join("occipital/config.json").as_path())
        );
        assert_eq!(custom(&c.snapshot()).len(), 1);
        assert_eq!(c.diagnostic(), None);
        return;
    }
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("occipital/themes")).unwrap();
    fs::write(
        f.0.join("occipital/themes/native.tmTheme"),
        theme("#123456"),
    )
    .unwrap();
    let output =
        f.0.command(std::env::current_exe().unwrap())
            .args(["--exact", "native_platform_resolver_obeys_xdg_config_home"])
            .env("XDG_CONFIG_HOME", f.0.as_os_str())
            .env("OCCIPITAL_CATALOGUE_ROOT_PROBE", f.0.as_os_str())
            .output()
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let home = f.0.join("home");
    let config = home.join(".config");
    fs::create_dir_all(config.join("occipital/themes")).unwrap();
    fs::write(
        config.join("occipital/themes/home.tmTheme"),
        theme("#123456"),
    )
    .unwrap();
    let output =
        f.0.command(std::env::current_exe().unwrap())
            .args(["--exact", "native_platform_resolver_obeys_xdg_config_home"])
            .env_remove("XDG_CONFIG_HOME")
            .env("HOME", &home)
            .env("OCCIPITAL_CATALOGUE_ROOT_PROBE", &config)
            .output()
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[test]
fn explicit_absolute_directories_and_same_filename_have_distinct_bounded_ids() {
    let f = Fixture::new();
    let other = Fixture::new();
    f.file("same.tmTheme", theme("#123456"));
    other.file("same.tmTheme", theme("#123456"));
    f.config(
        &serde_json::json!({"themeDirectories":["themes", other.0.join("themes")]}).to_string(),
    );
    let c = f.catalogue();
    let items = custom(&c.snapshot());
    assert_eq!(items.len(), 2);
    assert_ne!(items[0].id, items[1].id);
    for item in items {
        assert_eq!(item.id.len(), 63);
        assert_eq!(item.fingerprint.len(), 64);
        assert!(!item.id.contains("same"));
        assert_eq!(item.label, "same");
    }
}

#[test]
fn directory_list_path_and_nonregular_config_inputs_are_bounded() {
    let f = Fixture::new();
    f.config(&serde_json::json!({"themeDirectories": vec!["themes"; 9]}).to_string());
    let c = f.catalogue();
    assert_eq!(c.diagnostic(), Some(Diagnostic::ConfigInvalid));
    assert_eq!(c.admission_counters().attempts, 0);
    f.config(&serde_json::json!({"themeDirectories": ["x".repeat(4097)]}).to_string());
    assert_eq!(f.catalogue().diagnostic(), Some(Diagnostic::ConfigInvalid));
    fs::remove_file(f.0.join("config.json")).unwrap();
    fs::create_dir(f.0.join("config.json")).unwrap();
    assert_eq!(f.catalogue().diagnostic(), Some(Diagnostic::ConfigRead));
}

#[test]
fn maximal_raw_candidate_and_selector_lifetime_budget_are_independent() {
    let f = Fixture::new();
    let mut definition = theme("#123456");
    definition.resize(MAX_THEME_BYTES, b' ');
    for n in 0..MAX_CUSTOM_THEMES {
        f.file(&format!("{n}.tmTheme"), &definition);
    }
    let mut c = f.catalogue();
    assert_eq!(c.diagnostic(), None);
    assert_eq!(custom(&c.snapshot()).len(), MAX_CUSTOM_THEMES);
    assert_eq!(
        c.admission_counters().definition_bytes,
        occipital::catalogue::MAX_CATALOGUE_BYTES
    );
    let counters = c.admission_counters();
    c.refresh().unwrap();
    assert_eq!(c.admission_counters(), counters);
    // Five distinct definitions with 512 x two-atom selectors exhaust G1's
    // cumulative4096 atom-occurrence budget independently of catalogue size.
    let f = Fixture::new();
    let mut c = f.catalogue();
    for n in 0..5 {
        let source = String::from_utf8(theme("#123456")).unwrap().replace(
            "<string>comment</string>",
            &format!(
                "<string>{}</string>",
                vec![format!("catalogueLifetime{n}.term"); 512].join(",")
            ),
        );
        f.file("budget.tmTheme", source);
        let previous = c.snapshot();
        if n < 4 {
            c.refresh().unwrap();
        } else {
            assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
            assert!(Arc::ptr_eq(&previous, &c.snapshot()));
            let counters = c.admission_counters();
            assert!(c.refresh().is_err());
            assert_eq!(c.admission_counters(), counters);
        }
    }
    assert_eq!(c.admission_counters().atom_occurrences, 4096);
    assert_eq!(c.admission_counters().syntect_loads, 4);
    assert_eq!(c.admission_counters().attempts, 5);
}

#[test]
fn unrelated_theme_change_preserves_unchanged_definition_and_diagnostics_are_source_free() {
    let f = Fixture::new();
    f.file("a.tmTheme", theme("#123456"));
    f.file("b.tmTheme", theme("#123456"));
    let mut c = f.catalogue();
    let first = c.snapshot();
    let a = custom(&first)
        .into_iter()
        .find(|item| item.label == "a")
        .unwrap();
    let profile = first.profile(&a.id).unwrap();
    f.file("b.tmTheme", theme("#654321"));
    let next = c.refresh().unwrap();
    assert!(Arc::ptr_eq(&profile, &next.profile(&a.id).unwrap()));
    f.file("b.tmTheme", b"SECRET_THEME_TEXT");
    let error = c.refresh().err().unwrap().to_string();
    assert!(error.len() < 128);
    assert!(!error.contains("SECRET"));
    assert!(!error.contains(&f.0.to_string_lossy().into_owned()));
    assert!(Arc::ptr_eq(&next, &c.snapshot()));
}

#[test]
fn relative_os_root_does_not_fall_back_to_working_directory() {
    let c = Catalogue::from_os_root(Some(PathBuf::from("relative")));
    assert_eq!(c.diagnostic(), Some(Diagnostic::RootUnavailable));
    assert!(c.config_path().is_none());
    assert_eq!(c.snapshot().descriptors().count(), 33);
}

#[test]
fn failed_whole_candidate_drops_partial_successes_with_bounded_cumulative_charges() {
    let f = Fixture::new();
    f.file("a.tmTheme", theme("#123456"));
    f.file("b.tmTheme", theme("#123456"));
    let mut c = f.catalogue();
    let first = c.snapshot();
    let ordered = custom(&first);
    f.file(&format!("{}.tmTheme", ordered[0].label), theme("#654321"));
    f.file(&format!("{}.tmTheme", ordered[1].label), theme("bad"));
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    assert!(Arc::ptr_eq(&first, &c.snapshot()));
    assert_eq!(c.admission_counters().attempts, 4);
    assert_eq!(c.admission_counters().syntect_loads, 3);
    // Failed bytes are memoized; discarded successful candidate definitions are
    // not a new retained cache and may consume another finite attempt on retry.
    assert_eq!(c.refresh().err(), Some(Diagnostic::ThemeAdmission));
    assert_eq!(c.admission_counters().attempts, 5);
    assert_eq!(c.admission_counters().syntect_loads, 4);
    assert!(Arc::ptr_eq(&first, &c.snapshot()));
    f.file(&format!("{}.tmTheme", ordered[1].label), theme("#abcdef"));
    let next = c.refresh().unwrap();
    assert_eq!(next.revision(), first.revision() + 1);
    assert_eq!(c.admission_counters().attempts, 7);
    assert_eq!(c.admission_counters().syntect_loads, 6);
    f.config(r#"{"themeDirectories":[]}"#);
    let empty = c.refresh().unwrap();
    assert_eq!(custom(&empty).len(), 0);
    assert_eq!(c.admission_counters().attempts, 7);
}

#[test]
fn read_failed_config_retains_loaded_profiles_and_snapshot() {
    let f = Fixture::new();
    f.file("valid.tmTheme", theme("#123456"));
    f.config("{}");
    let mut c = f.catalogue();
    let first = c.snapshot();
    fs::remove_file(f.0.join("config.json")).unwrap();
    fs::create_dir(f.0.join("config.json")).unwrap();
    assert_eq!(c.refresh().err(), Some(Diagnostic::ConfigRead));
    assert!(Arc::ptr_eq(&first, &c.snapshot()));
    assert_eq!(c.admission_counters().attempts, 1);
}

#[test]
fn fixture_roots_are_unique_and_owned() {
    const PROBE: &str = "OCCIPITAL_FIXTURE_PARENT_CASE";
    if let Some(parent) = std::env::var_os(PROBE) {
        let root = support::CaseDir::new("isolation");
        assert_ne!(root.as_ref(), std::path::Path::new(&parent));
        assert_eq!(
            fs::read(std::path::Path::new(&parent).join("sentinel")).unwrap(),
            b"parent"
        );
        fs::write(root.join("sentinel"), b"child").unwrap();
        return;
    }
    let sandbox = support::CaseDir::new("isolation-regression");
    let roots: Vec<_> = std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| support::CaseDir::new("isolation")))
            .collect();
        jobs.into_iter().map(|job| job.join().unwrap()).collect()
    });
    let paths: std::collections::HashSet<_> = roots.iter().map(|root| root.as_ref()).collect();
    assert_eq!(paths.len(), 8);
    for root in &roots {
        assert_eq!(root.parent(), sandbox.parent());
        fs::write(root.join("sentinel"), b"parent").unwrap();
    }
    let output = sandbox
        .command(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_roots_are_unique_and_owned"])
        .env("TIDY_TEST_ROOT", roots[0].parent().unwrap())
        .env(PROBE, roots[0].as_os_str())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    for root in &roots {
        assert_eq!(fs::read(root.join("sentinel")).unwrap(), b"parent");
    }
    let released = roots[0].to_path_buf();
    drop(roots);
    assert!(!released.exists());
}

#[test]
fn fixture_children_drop_unrelated_environment() {
    const PROBE: &str = "OCCIPITAL_FIXTURE_ENV_PROBE";
    match std::env::var(PROBE).as_deref() {
        Ok("leaf") => {
            for name in [
                "OCCIPITAL_UNRELATED_SECRET",
                "NODE_OPTIONS",
                "PATH",
                "OCCIPITAL_CATALOGUE_ATOM_PROBE",
                "OCCIPITAL_CATALOGUE_ROOT_PROBE",
            ] {
                assert!(std::env::var_os(name).is_none(), "inherited {name}");
            }
            let root = PathBuf::from(std::env::var_os("TIDY_TEST_ROOT").unwrap());
            assert_eq!(std::env::current_dir().unwrap(), root);
            for (name, directory) in [
                ("HOME", "home"),
                ("XDG_CONFIG_HOME", "config"),
                ("TMPDIR", "tmp"),
            ] {
                assert_eq!(
                    PathBuf::from(std::env::var_os(name).unwrap()),
                    root.join(directory)
                );
            }
        }
        Ok("poisoned") => {
            assert_eq!(
                std::env::var("OCCIPITAL_UNRELATED_SECRET").unwrap(),
                "poison"
            );
            let root = support::CaseDir::new("env-clean-child");
            let output = root
                .command(std::env::current_exe().unwrap())
                .args(["--exact", "fixture_children_drop_unrelated_environment"])
                .env(PROBE, "leaf")
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        _ => {
            let root = support::CaseDir::new("env-poison-control");
            let output = root
                .command(std::env::current_exe().unwrap())
                .args(["--exact", "fixture_children_drop_unrelated_environment"])
                .env(PROBE, "poisoned")
                .env("OCCIPITAL_UNRELATED_SECRET", "poison")
                .env("NODE_OPTIONS", "poison")
                .env("PATH", root.as_os_str())
                .env("HOME", "unrelated-home")
                .env("XDG_CONFIG_HOME", "unrelated-config")
                .env("TMPDIR", "unrelated-temp")
                .env("OCCIPITAL_CATALOGUE_ATOM_PROBE", "unrelated")
                .env("OCCIPITAL_CATALOGUE_ROOT_PROBE", "unrelated")
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
    }
}

#[test]
fn fixture_context_is_required_without_fallback() {
    if std::env::var_os("OCCIPITAL_FIXTURE_CONTEXT_PROBE").is_some() {
        let _root = support::CaseDir::new("must-fail");
        panic!("invalid context was accepted");
    }
    let root = support::CaseDir::new("missing-context-control");
    for invalid in [None, Some("relative-root")] {
        let mut command = root.command(std::env::current_exe().unwrap());
        command
            .args(["--exact", "fixture_context_is_required_without_fallback"])
            .env("OCCIPITAL_FIXTURE_CONTEXT_PROBE", "1");
        if let Some(value) = invalid {
            command.env("TIDY_TEST_ROOT", value);
        } else {
            command.env_remove("TIDY_TEST_ROOT");
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("TIDY_TEST_ROOT"),
            "{output:?}"
        );
    }
}
