//! Independent-process probes keep other tests' legitimate grammar interning out.
use occipital::{
    style_rules::{ClientRulePlan, Error},
    vocabulary::ScopeId,
};
use serde_json::{json, value::RawValue};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    io::Write,
    process::Command,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use syntect::parsing::Scope;
struct Observed;
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGE: AtomicUsize = AtomicUsize::new(0);
#[global_allocator]
static ALLOCATOR: Observed = Observed;
unsafe impl GlobalAlloc for Observed {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) && layout.size() >= 4096 {
            LARGE.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) && size >= 4096 {
            LARGE.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}
fn document(text: String) -> Box<RawValue> {
    RawValue::from_string(text).unwrap()
}
fn definition(path: serde_json::Value) -> serde_json::Value {
    json!({"revision":1,"binding_slots":1,"default":{"foreground":{"kind":"inherit"},"background":{"kind":"inherit"},"attributes":0,"attribute_mask":0},"rules":[{"path":path,"excludes":[],"foreground":null,"background":null,"font":null}]})
}
#[test]
fn rejected_definitions_and_successful_inspection_never_materialize_or_intern() {
    if std::env::var_os("STYLE_RULES_BOUNDARY_CHILD").is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "rejected_definitions_and_successful_inspection_never_materialize_or_intern",
                "--nocapture",
            ])
            .env("STYLE_RULES_BOUNDARY_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let receipt = stdout
            .lines()
            .find(|line| line.starts_with("rule boundary:"))
            .expect("child boundary receipt");
        writeln!(std::io::stdout(), "{receipt}").unwrap();
        return;
    }
    let before = Scope::new("style-rules-before-marker").unwrap().atom_at(0);
    let valid = document(definition(json!(vec!["comment"; 4096])).to_string());
    let mut later = definition(json!(["comment"]));
    let mut wrong = later["rules"][0].clone();
    wrong["path"] = json!(["never-shipped-later-rule"]);
    later["rules"].as_array_mut().unwrap().push(wrong);
    let later = document(later.to_string());
    let mut malformed = definition(json!(["comment"]));
    malformed["default"]["foreground"] =
        json!({"kind":"rgb","r":{"nested":["x".repeat(1024*1024)]},"g":2,"b":3});
    let malformed = document(malformed.to_string());
    let mut missing = definition(json!(["comment"]));
    missing["rules"][0].as_object_mut().unwrap().remove("font");
    let missing = document(missing.to_string());
    LARGE.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let measurement = ClientRulePlan::inspect(&valid, usize::MAX)
        .unwrap()
        .measurement();
    let mut rejections = 0;
    for _ in 0..32 {
        for (raw, available, error) in [
            (&later, usize::MAX, Error::UnknownScope),
            (&malformed, usize::MAX, Error::InvalidRules),
            (&missing, usize::MAX, Error::InvalidRules),
            (&valid, measurement.policy_bytes - 1, Error::AllocationLimit),
        ] {
            assert_eq!(ClientRulePlan::inspect(raw, available).err(), Some(error));
            rejections += 1;
        }
    }
    TRACK.store(false, Ordering::SeqCst);
    let negative_allocations = LARGE.load(Ordering::SeqCst);
    let after = Scope::new("style-rules-after-marker").unwrap().atom_at(0);
    assert_eq!(
        after,
        before + 1,
        "inspection or rejection materialized trusted handles / caller atoms"
    );
    assert_eq!(
        negative_allocations, 0,
        "unescaped hostile declarations were buffered or names/scopes materialized"
    );
    Scope::new("style-rules-positive-marker").unwrap();
    let control = Scope::new("style-rules-final-marker").unwrap().atom_at(0);
    assert_eq!(control, after + 2, "atom probe positive control");
    // A valid compile may initialize only the finite generated asset vocabulary.
    ScopeId::from_name("comment").unwrap().scope();
    let plan = ClientRulePlan::inspect(&valid, usize::MAX).unwrap();
    LARGE.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let resolver = plan.compile();
    TRACK.store(false, Ordering::SeqCst);
    let compiled_allocations = LARGE.load(Ordering::SeqCst);
    assert!(
        compiled_allocations > 0,
        "allocation probe positive control"
    );
    drop(resolver);
    writeln!(std::io::stdout(),"rule boundary: {rejections} rejections; caller/asset atom growth=0 during inspection; allocations >=4096 bytes=0; valid compile positive-control large allocations={compiled_allocations}; measurement={measurement:?}").unwrap();
}
