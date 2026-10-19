#[allow(dead_code)] // Shared filesystem fixture; its child-command helper is not needed here.
mod support;
use occipital::{
    catalogue::{Catalogue, Descriptor},
    credit::Budget,
    native_definitions::NativeDefinitions,
    resolver::native_default,
    style_rules::{fingerprint_native_palette, fingerprint_native_rules},
    style_work::StyleWork,
    vocabulary::ScopeId,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::RefCell,
    fs,
    io::Write,
};
use syntect::highlighting::{Color, FontStyle, Highlighter, StyleModifier, Theme, ThemeItem};

struct Meter;
struct Watch {
    budget: Budget,
    allocations: usize,
    live: isize,
    peak: usize,
    minimum_reservation: usize,
}
#[derive(Debug)]
struct Observed {
    allocations: usize,
    live: isize,
    peak: usize,
    minimum_reservation: usize,
}
thread_local! { static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) }; }
fn allocation(size: usize, old: usize) {
    let _ = WATCH.try_with(|slot| {
        if let Some(watch) = slot.borrow_mut().as_mut() {
            watch.allocations += 1;
            watch.live += size as isize;
            watch.peak = watch.peak.max(watch.live.max(0) as usize);
            watch.live -= old as isize;
            watch.minimum_reservation =
                watch.minimum_reservation.min(watch.budget.snapshot().bytes);
        }
    });
}
unsafe impl GlobalAlloc for Meter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            allocation(layout.size(), 0);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = WATCH.try_with(|slot| {
            if let Some(watch) = slot.borrow_mut().as_mut() {
                watch.live -= layout.size() as isize;
            }
        });
        unsafe { System.dealloc(ptr, layout) };
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(ptr, layout, size) };
        if !result.is_null() {
            allocation(size, layout.size());
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: Meter = Meter;
fn observe<T>(budget: &Budget, work: impl FnOnce() -> T) -> (T, Observed) {
    WATCH.with(|slot| {
        *slot.borrow_mut() = Some(Watch {
            budget: budget.clone(),
            allocations: 0,
            live: 0,
            peak: 0,
            minimum_reservation: usize::MAX,
        })
    });
    let result = work();
    let watch = WATCH.with(|slot| slot.borrow_mut().take().unwrap());
    (
        result,
        Observed {
            allocations: watch.allocations,
            live: watch.live,
            peak: watch.peak,
            minimum_reservation: watch.minimum_reservation,
        },
    )
}
fn bundled() -> std::sync::Arc<occipital::catalogue::Snapshot> {
    Catalogue::from_os_root(None).snapshot()
}
fn descriptor(snapshot: &occipital::catalogue::Snapshot) -> Descriptor {
    snapshot
        .descriptors()
        .find(|d| d.id.starts_with("syntect:"))
        .unwrap()
        .clone()
}
fn warm_vocabulary() {
    ScopeId::from_name("comment").unwrap().scope();
}
fn receipt(label: &str, data: impl std::fmt::Debug) {
    writeln!(std::io::stderr().lock(), "{label}: {data:?}").unwrap();
}

#[test]
fn all_bundled_selected_definitions_compile_once_across_clients_and_release_without_jobs() {
    warm_vocabulary();
    let snapshot = bundled();
    let budget = Budget::new(32 << 20, 2, 1);
    let mut cache = NativeDefinitions::new(snapshot.clone(), budget.clone()).unwrap();
    assert_eq!(budget.snapshot().jobs, 0);
    let mut a = budget.reserve(Some("a"), 1024).unwrap();
    let mut b = budget.reserve(Some("b"), 1024).unwrap();
    let mut count = 0;
    for d in snapshot.descriptors().filter(|d| d.id != "pi") {
        count += 1;
        let plan = cache.preparation(&d.id, &d.fingerprint).unwrap();
        let before = budget.snapshot().bytes;
        let metadata_before = cache.counters().metadata_bytes;
        let (first, allocated) = observe(&budget, || {
            cache.prepare(&d.id, &d.fingerprint, &mut a).unwrap()
        });
        assert_eq!(
            allocated.live as usize,
            first.bytes() + cache.counters().metadata_bytes - metadata_before
        );
        assert!(
            allocated.peak <= plan.additional_bytes,
            "{}: {allocated:?} / {plan:?}",
            d.id
        );
        assert_eq!(
            allocated.minimum_reservation,
            before + plan.additional_bytes
        );
        let (second, hit) = observe(&budget, || {
            cache.prepare(&d.id, &d.fingerprint, &mut b).unwrap()
        });
        assert_eq!(hit.allocations, 0);
        assert!(std::ptr::eq(first.palette(), second.palette()));
        assert_eq!(first.palette().slots.len(), 26);
        assert_eq!(first.palette().counters.palettes, 1);
        assert_eq!(budget.snapshot().jobs, 2);
    }
    assert_eq!(count, 32);
    let stats = cache.counters();
    assert_eq!(
        (
            stats.compilations,
            stats.palette_derivations,
            stats.hits,
            stats.entries
        ),
        (32, 32, 32, 32)
    );
    receipt("native bundled cache", stats);
    drop(a);
    drop(b);
    assert_eq!(budget.snapshot().jobs, 0);
    assert_eq!(
        budget.snapshot().bytes,
        stats.metadata_bytes + stats.cached_definition_bytes
    );
    drop(cache);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn exact_peak_admission_precedes_every_controlled_allocation_and_denial_does_no_work() {
    warm_vocabulary();
    let snapshot = bundled();
    let d = descriptor(&snapshot);
    let probe = Budget::new(32 << 20, 1, 1);
    let cache = NativeDefinitions::new(snapshot.clone(), probe.clone()).unwrap();
    let plan = cache.preparation(&d.id, &d.fingerprint).unwrap(); // Asset loading belongs to the catalogue.
    let limit = cache.counters().metadata_bytes + 1024 + plan.additional_bytes;
    drop(cache);
    for denied in [true, false] {
        let budget = Budget::new(limit - usize::from(denied), 1, 1);
        let mut cache = NativeDefinitions::new(snapshot.clone(), budget.clone()).unwrap();
        let mut job = budget.reserve(Some("a"), 1024).unwrap();
        let before = budget.snapshot();
        let (result, allocation) =
            observe(&budget, || cache.prepare(&d.id, &d.fingerprint, &mut job));
        if denied {
            assert_eq!(result.err().unwrap().code, "busy");
            assert_eq!(allocation.allocations, 0, "{allocation:?}");
            assert_eq!(cache.counters().compilations, 0);
            assert_eq!(budget.snapshot().bytes, before.bytes);
        } else {
            let owner = result.unwrap();
            assert_eq!(owner.bytes(), plan.definition_bytes);
            assert!(allocation.allocations > 0);
            assert_eq!(
                allocation.live as usize,
                plan.definition_bytes + plan.cache_growth_bytes
            );
            assert_eq!(allocation.minimum_reservation, limit);
            assert!(
                allocation.peak <= plan.additional_bytes,
                "{allocation:?}, plan={plan:?}"
            );
            assert_eq!(budget.snapshot().peak_bytes, limit);
            assert_eq!(
                cache
                    .preparation(&d.id, &d.fingerprint)
                    .unwrap()
                    .additional_bytes,
                0
            );
            let (_, hit) = observe(&budget, || {
                cache.prepare(&d.id, &d.fingerprint, &mut job).unwrap()
            });
            assert_eq!(hit.allocations, 0);
            receipt("native pre-reserved peak", (plan, allocation));
        }
        assert_eq!(budget.snapshot().jobs, 1);
        assert!(budget.reserve(Some("a"), 0).is_err());
        // Positive mutant: the same meter detects an allocation without the reservation.
        let (_, unreserved) = observe(&budget, || {
            let value = Box::new([0u8; 256]);
            std::hint::black_box(&value);
        });
        assert!(unreserved.allocations > 0);
        if denied {
            assert!(unreserved.minimum_reservation < limit);
        }
        drop(job);
        drop(cache);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}

#[test]
fn denied_second_selection_preserves_old_cache_and_stale_unknown_and_pi_reject() {
    let snapshot = bundled();
    let all: Vec<_> = snapshot
        .descriptors()
        .filter(|d| d.id != "pi")
        .cloned()
        .collect();
    let budget = Budget::new(32 << 20, 1, 1);
    let mut cache = NativeDefinitions::new(snapshot.clone(), budget.clone()).unwrap();
    let mut job = budget.reserve(Some("a"), 1024).unwrap();
    let old = cache
        .prepare(&all[0].id, &all[0].fingerprint, &mut job)
        .unwrap();
    cache.preparation(&all[1].id, &all[1].fingerprint).unwrap();
    let fill = budget
        .reserve(None, (32 << 20) - budget.snapshot().bytes)
        .unwrap();
    let before = budget.snapshot();
    let (failure, denied) = observe(&budget, || {
        cache.prepare(&all[1].id, &all[1].fingerprint, &mut job)
    });
    assert_eq!(failure.err().unwrap().code, "busy");
    assert_eq!(denied.allocations, 0);
    assert_eq!(cache.counters().entries, 1);
    assert_eq!(cache.counters().compilations, 1);
    assert!(std::ptr::eq(
        old.palette(),
        cache
            .prepare(&all[0].id, &all[0].fingerprint, &mut job)
            .unwrap()
            .palette()
    ));
    for (id, fp, code) in [
        ("absent", &all[0].fingerprint, "profile_unavailable"),
        (all[0].id.as_str(), &"0".repeat(64), "profile_changed"),
        ("pi", &"0".repeat(64), "profile_unavailable"),
    ] {
        assert_eq!(cache.prepare(id, fp, &mut job).err().unwrap().code, code);
    }
    assert_eq!(budget.snapshot().bytes, before.bytes);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(fill);
    drop(job);
    drop(cache);
    assert_eq!(budget.snapshot().bytes, old.bytes());
    drop(old);
    assert_eq!(budget.snapshot().bytes, 0);
}

struct Fixture(support::CaseDir);
impl Fixture {
    fn new() -> Self {
        let root = support::CaseDir::new("native-definitions");
        fs::create_dir(root.join("themes")).unwrap();
        fs::write(
            root.join("config.json"),
            r#"{"themeDirectories":["themes"]}"#,
        )
        .unwrap();
        Self(root)
    }
    fn write(&self, name: &str, color: &str) {
        fs::write(self.0.join("themes").join(name), format!("<plist><dict><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>{color}</string><key>background</key><string>#111111</string></dict></dict></array></dict></plist>")).unwrap();
    }
    fn catalogue(&self) -> Catalogue {
        Catalogue::new(Some(self.0.join("config.json")))
    }
}
#[test]
fn same_id_replacement_keeps_pending_and_ready_cursor_charge_then_reply_uses_job_only() {
    for ready_before_publish in [false, true] {
        let fixture = Fixture::new();
        fixture.write("same.tmTheme", "#eeeeee");
        let mut catalogue = fixture.catalogue();
        let old_snapshot = catalogue.snapshot();
        let old = old_snapshot
            .descriptors()
            .find(|d| d.id.starts_with("custom:"))
            .unwrap()
            .clone();
        let budget = Budget::new(1 << 20, 2, 1);
        let mut cache = NativeDefinitions::new(old_snapshot, budget.clone()).unwrap();
        let mut job = budget.reserve(Some("a"), 1024).unwrap();
        let owner = cache.prepare(&old.id, &old.fingerprint, &mut job).unwrap();
        let old_bytes = owner.bytes();
        let scope = ScopeId::from_name("comment").unwrap().get();
        let mut work = StyleWork::native(vec![vec![], vec![scope]], owner, job).unwrap();
        assert!(!work.step().unwrap());
        if ready_before_publish {
            assert!(work.step().unwrap());
        }
        fixture.write("same.tmTheme", "#bbbbbb");
        let snapshot = catalogue.refresh().unwrap();
        let replacement = snapshot
            .descriptors()
            .find(|d| d.id == old.id)
            .unwrap()
            .clone();
        assert_ne!(replacement.fingerprint, old.fingerprint);
        let before = budget.snapshot().bytes;
        cache.publish(snapshot.clone());
        assert_eq!(cache.counters().entries, 0);
        assert_eq!(budget.snapshot().bytes, before);
        let mut second_job = budget.reserve(Some("b"), 1024).unwrap();
        assert_eq!(
            cache
                .prepare(&old.id, &old.fingerprint, &mut second_job)
                .err()
                .unwrap()
                .code,
            "profile_changed"
        );
        let current = cache
            .prepare(&replacement.id, &replacement.fingerprint, &mut second_job)
            .unwrap();
        let current_bytes = current.bytes();
        drop(second_job);
        if !ready_before_publish {
            assert!(work.step().unwrap());
        }
        let ready = budget.snapshot().bytes;
        let (body, credit) = work.finish().unwrap();
        assert_eq!(ready - budget.snapshot().bytes, old_bytes);
        body.validate(true, 0, 2).unwrap();
        assert_eq!(
            body.rules,
            fingerprint_native_rules(&old.fingerprint).unwrap()
        );
        assert_eq!(
            body.palette.as_ref().unwrap().fingerprint,
            fingerprint_native_palette(&old.fingerprint).unwrap()
        );
        let held = budget.snapshot().bytes;
        drop(body);
        assert_eq!(budget.snapshot().bytes, held);
        assert_eq!(budget.snapshot().jobs, 1);
        // Removal prunes the last selected entry, retaining its metadata capacity.
        fs::remove_file(fixture.0.join("themes/same.tmTheme")).unwrap();
        cache.publish(catalogue.refresh().unwrap());
        assert_eq!(cache.counters().entries, 0);
        let metadata = cache.counters().metadata_bytes;
        drop(cache);
        assert!(budget.snapshot().bytes >= current.bytes());
        drop(current);
        assert_eq!(budget.snapshot().bytes, held - metadata - current_bytes);
        drop(credit);
        assert_eq!(budget.snapshot().jobs, 0);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}
#[test]
fn empty_source_palette_and_constructor_failure_keep_the_right_owners_and_route_slot() {
    let snapshot = bundled();
    let d = descriptor(&snapshot);
    let budget = Budget::new(1 << 20, 1, 1);
    let mut cache = NativeDefinitions::new(snapshot, budget.clone()).unwrap();
    let mut job = budget.reserve(Some("a"), 1024).unwrap();
    let owner = cache.prepare(&d.id, &d.fingerprint, &mut job).unwrap();
    let mut work = StyleWork::native(vec![], owner.clone(), job).unwrap();
    assert!(work.step().unwrap());
    assert_eq!(work.counters().contexts, 0);
    let (body, mut job) = work.finish().unwrap();
    body.validate(true, 0, 0).unwrap();
    drop(body);
    job.resize(1024).unwrap();
    let fill = budget
        .reserve(None, (1 << 20) - budget.snapshot().bytes - 128)
        .unwrap();
    let contexts = vec![vec![]]; // Already covered by the caller's descriptor allowance.
    let (failure, copies) = observe(&budget, || {
        StyleWork::native(contexts, owner, job).err().unwrap()
    });
    assert_eq!(copies.minimum_reservation, 1 << 20);
    assert!(
        copies.peak <= 128,
        "fingerprint copies exceeded their allowance: {copies:?}"
    );
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("a"), 0).is_err());
    drop(fill);
    drop(cache);
    assert!(budget.snapshot().bytes > 0);
    drop(failure);
    assert_eq!(budget.snapshot().bytes, 0);
    assert_eq!(budget.snapshot().jobs, 0);
}

#[test]
fn all_existing_catalogue_slots_are_selectable_without_a_second_cache_count_limit() {
    let fixture = Fixture::new();
    for i in 0..16 {
        fixture.write(&format!("{i}.tmTheme"), &format!("#{i:02x}aabb"));
    }
    let catalogue = fixture.catalogue();
    let snapshot = catalogue.snapshot();
    let budget = Budget::new(32 << 20, 1, 1);
    let mut cache = NativeDefinitions::new(snapshot.clone(), budget.clone()).unwrap();
    let mut job = budget.reserve(Some("a"), 1024).unwrap();
    for d in snapshot.descriptors().filter(|d| d.id != "pi") {
        cache.prepare(&d.id, &d.fingerprint, &mut job).unwrap();
    }
    assert_eq!(cache.counters().entries, 48);
    assert_eq!(cache.counters().compilations, 48);
    drop(job);
    drop(cache);
    assert_eq!(budget.snapshot().bytes, 0);
}

#[test]
fn default_only_extraction_matches_actual_highlighter_for_absent_explicit_alpha_and_font_reset() {
    let mut themes: Vec<_> = bundled()
        .descriptors()
        .filter(|d| d.id != "pi")
        .map(|d| {
            occipital::profile::Profile::resolve(&d.id)
                .unwrap()
                .native_theme()
                .unwrap()
                .clone()
        })
        .collect();
    let mut empty = Theme::default();
    empty.scopes.push(ThemeItem {
        scope: "".parse().unwrap(),
        style: StyleModifier {
            foreground: None,
            background: None,
            font_style: Some(FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE),
        },
    });
    themes.push(empty.clone());
    for alpha in [0, 1, 2, 128, 255] {
        let color = Color {
            r: 17,
            g: 29,
            b: 43,
            a: alpha,
        };
        for (foreground, background) in [
            (Some(color), None),
            (None, Some(color)),
            (Some(color), Some(color)),
        ] {
            let mut t = empty.clone();
            t.settings.foreground = foreground;
            t.settings.background = background;
            themes.push(t);
        }
    }
    for theme in &themes {
        assert_eq!(native_default(theme), Highlighter::new(theme).get_default());
        assert_eq!(native_default(theme).font_style, FontStyle::empty());
    }
    receipt("native default differential cases", themes.len());
}

#[test]
fn pruning_after_finish_leaves_held_palette_and_encoded_reply_under_job_credit_only() {
    let fixture = Fixture::new();
    fixture.write("same.tmTheme", "#eeeeee");
    let mut catalogue = fixture.catalogue();
    let snapshot = catalogue.snapshot();
    let d = snapshot
        .descriptors()
        .find(|d| d.id.starts_with("custom:"))
        .unwrap()
        .clone();
    let budget = Budget::new(1 << 20, 1, 1);
    let mut cache = NativeDefinitions::new(snapshot, budget.clone()).unwrap();
    let mut job = budget.reserve(Some("a"), 1024).unwrap();
    let owner = cache.prepare(&d.id, &d.fingerprint, &mut job).unwrap();
    let state_bytes = owner.bytes();
    let work = StyleWork::native(vec![], owner, job).unwrap();
    let (body, mut job) = work.finish().unwrap();
    let before = budget.snapshot().bytes;
    fs::remove_file(fixture.0.join("themes/same.tmTheme")).unwrap();
    cache.publish(catalogue.refresh().unwrap());
    assert_eq!(before - budget.snapshot().bytes, state_bytes);
    body.validate(true, 0, 0).unwrap();
    let reply = occipital::semantic_reply::ok("ticket", "instance", body);
    let encoded = reply.encode_with_credit(&mut job, 16 * 1024).unwrap();
    drop(reply);
    drop(cache);
    job.resize(encoded.capacity()).unwrap();
    assert_eq!(budget.snapshot().bytes, encoded.capacity());
    assert_eq!(budget.snapshot().jobs, 1);
    assert!(budget.reserve(Some("a"), 0).is_err());
    drop(encoded);
    assert_eq!(budget.snapshot().jobs, 1);
    drop(job);
    assert_eq!(budget.snapshot().bytes, 0);
    assert_eq!(budget.snapshot().jobs, 0);
}
