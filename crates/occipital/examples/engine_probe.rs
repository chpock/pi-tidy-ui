//! Opt-in semantic parser/resolver engineering probe; prints counters, never source.
use occipital::{
    profile::Profile,
    protocol::SyntaxHint,
    resolver::Resolver,
    semantic_engine::{Engine, Limits, SourceChunk, Work},
};
use serde::Serialize;
use serde_json::json;
use std::{fs, time::Instant};
fn hint(language: &str) -> SyntaxHint {
    SyntaxHint {
        language: Some(language.into()),
        path: None,
    }
}
#[derive(Serialize)]
struct AllocatorMemory {
    live_bytes: usize,
    arena_bytes: usize,
    free_bytes: usize,
}
#[derive(Serialize)]
struct Memory {
    rss_kib: Option<u64>,
    peak_rss_kib: Option<u64>,
    pss_kib: Option<u64>,
    private_kib: u64,
    allocator: Option<AllocatorMemory>,
}
#[derive(Serialize)]
struct CaptureCycle {
    cycle: u32,
    active: Memory,
    closed: Memory,
    leases: usize,
    known_bytes: usize,
}
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn allocator_memory() -> Option<AllocatorMemory> {
    // Diagnostic-only glibc ABI: distinguish live allocations from retained RSS.
    // This is not a kernel dependency or a process-memory cap.
    #[repr(C)]
    struct MallInfo2 {
        arena: usize,
        ordblks: usize,
        smblks: usize,
        hblks: usize,
        hblkhd: usize,
        usmblks: usize,
        fsmblks: usize,
        uordblks: usize,
        fordblks: usize,
        keepcost: usize,
    }
    #[link(name = "dl")]
    extern "C" {
        fn dlsym(
            handle: *mut std::ffi::c_void,
            symbol: *const std::ffi::c_char,
        ) -> *mut std::ffi::c_void;
    }
    // mallinfo2 is absent before glibc 2.33; missing diagnostics stay unknown.
    // SAFETY: null is RTLD_DEFAULT and the symbol is a terminated C string.
    let address = unsafe { dlsym(std::ptr::null_mut(), c"mallinfo2".as_ptr()) };
    if address.is_null() {
        return None;
    }
    // SAFETY: glibc's public mallinfo2 has this exact ten-size_t return ABI.
    let capture = unsafe {
        std::mem::transmute::<*mut std::ffi::c_void, unsafe extern "C" fn() -> MallInfo2>(address)
    };
    let info = unsafe { capture() };
    Some(AllocatorMemory {
        live_bytes: info.uordblks + info.hblkhd,
        arena_bytes: info.arena,
        free_bytes: info.fordblks,
    })
}
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn allocator_memory() -> Option<AllocatorMemory> {
    None
}
fn memory() -> Memory {
    let text = fs::read_to_string("/proc/self/status").unwrap_or_default();
    let read = |key: &str| {
        text.lines().find_map(|line| {
            line.strip_prefix(key)?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
    };
    let smaps = fs::read_to_string("/proc/self/smaps_rollup").unwrap_or_default();
    let field = |key: &str| {
        smaps.lines().find_map(|line| {
            line.strip_prefix(key)?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
    };
    Memory {
        rss_kib: read("VmRSS:"),
        peak_rss_kib: read("VmHWM:"),
        pss_kib: field("Pss:"),
        private_kib: field("Private_Clean:").unwrap_or(0) + field("Private_Dirty:").unwrap_or(0),
        allocator: allocator_memory(),
    }
}
fn micros(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1_000_000.0
}
fn execute(engine: &mut Engine, mut work: Work) -> SourceChunk {
    while !engine.step(&mut work, &mut |_| true).unwrap() {}
    engine.finish(work, &mut |_| true).unwrap()
}
fn main() {
    let before = memory();
    let mut engine = Engine::new(Limits::default());
    let corpus = [
        (
            "typescript",
            "function greet(name: string) { return `hi ${name}`; }\n",
        ),
        ("bash", "cat <<'EOF'\nhello $USER\nEOF\nprintf '%s' x\n"),
        ("rust", "fn main() { let x = 42; }\n"),
        ("python", "text = '''two\nlines'''\nprint(text)\n"),
        ("HTML", "<script>const answer = 42;</script>\n"),
    ];
    let mut samples = Vec::new();
    for (language, text) in corpus {
        let start = Instant::now();
        let work = engine
            .begin_one_shot(text.into(), &hint(language), &mut |_| true)
            .unwrap();
        let result = execute(&mut engine, work);
        samples.push(json!({"language":language,"us":micros(start),"source_bytes":result.source_bytes,"runs":result.runs.len(),"contexts":result.contexts.len(),"counters":result.counters}));
    }
    let mut native = Vec::new();
    for name in Profile::bundled_names() {
        let start = Instant::now();
        let profile = Profile::resolve(&name).unwrap();
        let resolver = Resolver::native(profile.native_theme().unwrap());
        let mut cursor = resolver.cursor(0).unwrap();
        let expression = cursor.resolve(&[]).unwrap().expression;
        native.push(json!({"profile":name,"us":micros(start),"default":expression}));
    }
    let text = "const value = 42;\n".repeat(2000);
    let work = engine
        .begin_open(
            "probe",
            "incremental",
            String::new(),
            &hint("typescript"),
            &mut |_| true,
        )
        .unwrap();
    let lease = work.lease().unwrap();
    let mut latest = execute(&mut engine, work);
    let (mut calls, mut bytes) = (0, 0);
    for delta in text.as_bytes().chunks(97) {
        let work = engine
            .begin_append(
                "probe",
                "incremental",
                lease,
                latest.revision,
                latest.source_bytes,
                std::str::from_utf8(delta).unwrap().into(),
                false,
                &mut |_| true,
            )
            .unwrap();
        latest = execute(&mut engine, work);
        calls += latest.counters.committed_line_calls;
        bytes += latest.counters.committed_line_bytes;
    }
    let work = engine
        .begin_append(
            "probe",
            "incremental",
            lease,
            latest.revision,
            latest.source_bytes,
            String::new(),
            true,
            &mut |_| true,
        )
        .unwrap();
    let final_chunk = execute(&mut engine, work);
    assert_eq!(calls, 2000);
    assert_eq!(bytes, text.len() as u64);
    assert_eq!(final_chunk.counters, Default::default());
    let names: Vec<_> = two_face::syntax::extra_newlines()
        .syntaxes()
        .iter()
        .map(|s| s.name.clone())
        .collect();
    for name in &names {
        let work = engine
            .begin_one_shot("value = 1;\n# comment\n".into(), &hint(name), &mut |_| true)
            .unwrap();
        execute(&mut engine, work);
    }
    let all_grammar = memory();
    let mut capture_cycles = Vec::with_capacity(100);
    for cycle in 0..100 {
        let delimiter = format!("CYCLE_{cycle}_{}", "A".repeat(6000));
        let captured = format!("cat <<'{delimiter}'\nprovisional $VAR");
        for i in 0..32 {
            let work = engine
                .begin_open(
                    &format!("route{}", i / 4),
                    &format!("key{i}"),
                    captured.clone(),
                    &hint("bash"),
                    &mut |_| true,
                )
                .unwrap();
            execute(&mut engine, work);
        }
        let active = memory();
        for i in 0..8 {
            engine.close_scope(&format!("route{i}"));
        }
        assert_eq!(engine.leases(), 0);
        assert_eq!(engine.retained_state_bytes(), 0);
        capture_cycles.push(CaptureCycle {
            cycle,
            active,
            closed: memory(),
            leases: engine.leases(),
            known_bytes: engine.retained_state_bytes(),
        });
    }
    println!("{}", serde_json::to_string_pretty(&json!({"kernel_only_not_rpc":true,"before":before,"semantic_corpus":samples,"native_resolver_defaults":native,"incremental":{"source_bytes":text.len(),"committed_calls":calls,"committed_bytes":bytes,"finalization_parse_calls":0},"all_grammar":{"count":names.len(),"memory":all_grammar},"capture_cycles":capture_cycles,"released":memory(),"live_leases":engine.leases(),"known_retained_state_bytes":engine.retained_state_bytes()})).unwrap());
}

#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
#[path = "../tests/support/mod.rs"]
mod support;

#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
#[test]
fn allocator_diagnostic_tracks_the_actual_glibc_api() {
    let root = support::CaseDir::new("allocator");
    let getconf = std::env::var_os("TIDY_TEST_GETCONF").expect("TIDY_TEST_GETCONF is required");
    let output = root
        .command(getconf)
        .arg("GNU_LIBC_VERSION")
        .output()
        .expect("read actual GNU libc version");
    assert!(output.status.success());
    let version = String::from_utf8(output.stdout).unwrap();
    let mut components = version.trim().strip_prefix("glibc ").unwrap().split('.');
    let major = components.next().unwrap().parse::<u32>().unwrap();
    let minor = components.next().unwrap().parse::<u32>().unwrap();
    assert_eq!(allocator_memory().is_some(), (major, minor) >= (2, 33));
}
