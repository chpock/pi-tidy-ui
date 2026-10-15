//! Opt-in engineering probe; prints counters and process memory, never source.
use occipital::{
    engine::{Engine, Limits},
    protocol::{Chunk, SyntaxHint},
};
use serde::Serialize;
use serde_json::{json, Value};
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
fn sample(engine: &mut Engine, language: &str, source: &str) -> (Chunk, f64) {
    let now = Instant::now();
    let result = engine.one_shot(source, &hint(language), "pi").unwrap();
    (result, micros(now))
}
fn distribution(mut data: Vec<f64>) -> Value {
    data.sort_by(f64::total_cmp);
    let at = |p: f64| data[((data.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({"n":data.len(),"p50_us":at(0.5),"p95_us":at(0.95),"p99_us":at(0.99),"max_us":data.last()})
}
fn main() {
    let before = memory();
    let clock = Instant::now();
    let mut engine = Engine::new(Limits::default());
    let cold_assets_us = micros(clock);
    let corpus = [
        (
            "typescript",
            "function greet(name: string) { const result = `hello ${name}`; return result; }\n",
        ),
        (
            "bash",
            "cat <<'EOF'\nhello\nEOF\nrg -n 'input' src --glob '*.ts'\n",
        ),
        (
            "Rust",
            "fn main() { let result = vec![1, 2, 3]; println!(\"{:?}\", result); }\n",
        ),
        ("python", "def greet(name):\n    return f\"hello {name}\"\n"),
        (
            "HTML",
            "<script>const answer = 42;</script>\n<div class=\"item\">hello</div>\n",
        ),
        ("CSS", ".item { color: #ffeeaa; margin: 1rem; }\n"),
        ("JSON", "{\"answer\":42,\"nested\":[true,false,null]}\n"),
        ("YAML", "name: item\nvalues:\n  - hello\n  - 42\n"),
        ("Makefile", "target:\n\techo \"hi $(NAME)\"\n"),
        ("Dockerfile", "FROM alpine:3\nRUN echo hello\n"),
    ];
    let cold: Vec<_> = corpus
        .iter()
        .map(|(lang, source)| {
            let (result, time) = sample(&mut engine, lang, source);
            json!({"language":lang,"us":time,"source_bytes":source.len(),"runs":result.runs.len()})
        })
        .collect();
    let ordinary_warm = memory();
    let native_themes: Vec<_> = ["syntect:Catppuccin Mocha", "syntect:Nord", "syntect:ansi"]
        .iter()
        .map(|name| {
            let now = Instant::now();
            let result = engine
                .one_shot(corpus[0].1, &hint(corpus[0].0), name)
                .unwrap();
            json!({"profile":name,"us":micros(now),"styles":result.styles.len()})
        })
        .collect();
    let mut timings = Vec::new();
    let mut encodings = Vec::new();
    let mut decodings = Vec::new();
    let mut encoded_bytes = 0;
    for _ in 0..100 {
        for (lang, source) in corpus {
            let (result, time) = sample(&mut engine, lang, source);
            timings.push(time);
            let clock = Instant::now();
            let encoded = serde_json::to_vec(&result).unwrap();
            encodings.push(micros(clock));
            encoded_bytes += encoded.len();
            let clock = Instant::now();
            let _: Value = serde_json::from_slice(&encoded).unwrap();
            decodings.push(micros(clock));
        }
    }
    let mut larger_warm = Vec::new();
    for profile in [
        "pi",
        "syntect:Catppuccin Mocha",
        "syntect:Nord",
        "syntect:ansi",
    ] {
        for language in [
            "typescript",
            "bash",
            "Rust",
            "python",
            "HTML",
            "CSS",
            "JSON",
            "YAML",
            "Makefile",
            "Dockerfile",
        ] {
            let (_, base) = corpus.iter().find(|(name, _)| *name == language).unwrap();
            let source = base.repeat((2048 / base.len()).max(1));
            engine.one_shot(&source, &hint(language), profile).unwrap();
            let mut samples = Vec::new();
            for _ in 0..20 {
                let now = Instant::now();
                engine.one_shot(&source, &hint(language), profile).unwrap();
                samples.push(micros(now));
            }
            larger_warm.push(json!({"profile":profile,"language":language,"bytes":source.len(),"parse":distribution(samples)}));
        }
    }
    let multiline = "const value = 42;\n".repeat(2_000);
    let mut stream = engine
        .open("probe", "incremental", "", &hint("typescript"), "pi")
        .unwrap();
    let mut calls = 0;
    let mut bytes = 0;
    let mut tail_bytes = 0;
    let mut increment = Vec::new();
    for delta in multiline.as_bytes().chunks(97) {
        let delta = std::str::from_utf8(delta).unwrap();
        let now = Instant::now();
        stream = engine
            .append(
                "probe",
                "incremental",
                stream.revision,
                stream.source_bytes,
                delta,
                false,
            )
            .unwrap();
        increment.push(micros(now));
        calls += stream.counters.committed_line_calls;
        bytes += stream.counters.committed_line_bytes;
        tail_bytes += stream.counters.tail_bytes;
    }
    let final_result = engine
        .append(
            "probe",
            "incremental",
            stream.revision,
            stream.source_bytes,
            "",
            true,
        )
        .unwrap();
    // Use the rejected proposal only for calibration, not production admission.
    let mut stress_engine = Engine::new(Limits {
        line_bytes: 32 << 10,
        ..Limits::default()
    });
    let mut stress = Vec::new();
    for (lang, source) in [
        ("typescript", "const value = 42;\n".repeat(12_000)),
        ("bash", format!("echo {}", "x".repeat(30_000))),
        ("JSON", format!("{}0{}\n", "[".repeat(128), "]".repeat(128))),
        (
            "HTML",
            format!("{}hello{}\n", "<div>".repeat(128), "</div>".repeat(128)),
        ),
        (
            "python",
            format!("{}0{}\n", "(".repeat(128), ")".repeat(128)),
        ),
    ] {
        let now = Instant::now();
        let outcome = stress_engine.one_shot(&source, &hint(lang), "pi");
        stress.push(match outcome{Ok(result)=>json!({"language":lang,"bytes":source.len(),"us":micros(now),"status":"ok","runs":result.runs.len(),"encoded_bytes":serde_json::to_vec(&result).unwrap().len()}),Err(error)=>json!({"language":lang,"bytes":source.len(),"us":micros(now),"status":error.code,"started":error.started})});
    }
    for language in [
        "typescript",
        "bash",
        "python",
        "HTML",
        "CSS",
        "JSON",
        "YAML",
    ] {
        for bytes in [2048, 4096, 8192, 16_384, 32_000] {
            for unit in ["identifier_123=", "\\\"'\\\\\\\\$${{[/*", "()[]{}<>"] {
                let source = unit.repeat(bytes / unit.len());
                let now = Instant::now();
                let outcome = stress_engine.one_shot(&source, &hint(language), "pi");
                stress.push(match outcome{Ok(result)=>json!({"language":language,"bytes":source.len(),"single_line":true,"us":micros(now),"status":"ok","runs":result.runs.len()}),Err(error)=>json!({"language":language,"bytes":source.len(),"single_line":true,"us":micros(now),"status":error.code,"started":error.started})});
            }
        }
    }
    let mut large = engine
        .begin_one_shot(
            "const value = 42;\n".repeat(12_000),
            &hint("typescript"),
            "pi",
        )
        .unwrap();
    let mut quantum = Vec::new();
    let mut peer = Vec::new();
    loop {
        let now = Instant::now();
        let complete = engine.step(&mut large).unwrap();
        quantum.push(micros(now));
        let now = Instant::now();
        engine.one_shot(corpus[1].1, &hint("bash"), "pi").unwrap();
        peer.push(micros(now));
        if complete {
            break;
        }
    }
    let completed_large = engine.finish(large).unwrap();
    let fair_quanta = json!({"controlled_interleave_not_transport":true,"large_committed_calls":completed_large.counters.committed_line_calls,"quanta":distribution(quantum),"peer_after_each_quantum":distribution(peer)});
    let mut lease_bytes = 0;
    for route in 0..8 {
        for key in 0..4 {
            engine
                .open(
                    &format!("r{route}"),
                    &format!("s{key}"),
                    "function greet(name: string) { return `hi ${name",
                    &hint("typescript"),
                    "pi",
                )
                .unwrap();
        }
    }
    lease_bytes += engine.retained_state_bytes();
    let leased = memory();
    for route in 0..8 {
        engine.close_scope(&format!("r{route}"));
    }
    assert_eq!(engine.leases(), 0);
    assert_eq!(engine.retained_state_bytes(), 0);
    let names = engine.syntax_names();
    for name in &names {
        engine
            .one_shot(
                "value = 1;\n# comment\n\tprint(\"hi\")\n",
                &hint(name),
                "pi",
            )
            .unwrap();
    }
    let all_grammar = memory();
    let delimiter = format!("BOUNDARY_{}", "A".repeat(6_000));
    let captured = format!("cat <<'{delimiter}'\nprovisional $VAR");
    for i in 0..32 {
        engine
            .open(
                &format!("capture-client{}", i / 4),
                &format!("capture{i}"),
                &captured,
                &hint("bash"),
                "pi",
            )
            .unwrap();
    }
    let capture_leases = json!({"count":engine.leases(),"header_bytes":captured.len(),"known_bytes":engine.retained_state_bytes(),"tail_bytes":engine.retained_tail_bytes(),"memory":memory()});
    for i in 0..8 {
        engine.close_scope(&format!("capture-client{i}"));
    }
    let capture_released = memory();
    // Fixed-size scalar samples: reserve all observer storage BEFORE cycling.
    // Retaining JSON Value maps here would itself look like a native heap leak.
    let mut capture_cycles = Vec::with_capacity(100);
    for cycle in 0..100 {
        let delimiter = format!("CYCLE_{cycle}_{}", "A".repeat(6000));
        let source = format!("cat <<'{delimiter}'\nprovisional $VAR");
        for i in 0..32 {
            engine
                .open(
                    &format!("cycle-client{}", i / 4),
                    &format!("cycle{i}"),
                    &source,
                    &hint("bash"),
                    "pi",
                )
                .unwrap();
        }
        let active = memory();
        for i in 0..8 {
            engine.close_scope(&format!("cycle-client{i}"));
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
    let mut admitted_peer = Vec::new();
    for profile in [
        "pi",
        "syntect:Catppuccin Mocha",
        "syntect:Nord",
        "syntect:ansi",
    ] {
        let mut acknowledged = engine
            .open("peer-heavy", "stream", "", &hint("bash"), profile)
            .unwrap();
        for bytes in [2048, 4096, 6144, 8192] {
            let delta = "()[]{}<>".repeat(2048 / 8);
            let arrival = Instant::now();
            let result = engine
                .append(
                    "peer-heavy",
                    "stream",
                    acknowledged.revision,
                    acknowledged.source_bytes,
                    &delta,
                    false,
                )
                .unwrap();
            let heavy_us = micros(arrival);
            let peer_start = Instant::now();
            engine.one_shot(corpus[1].1, &hint("bash"), "pi").unwrap();
            admitted_peer.push(json!({"controlled_interleave_not_rpc":true,"profile":profile,"bytes":bytes,"heavy_us":heavy_us,"peer_execution_us":micros(peer_start),"peer_wait_plus_execution_us":micros(arrival),"tail_bytes":result.counters.tail_bytes}));
            acknowledged = result;
        }
        engine.close_scope("peer-heavy");
    }

    println!("{}",serde_json::to_string_pretty(&json!({"kernel_only_not_rpc":true,"pid":std::process::id(),"before":before,"cold_assets_us":cold_assets_us,"cold_grammars":cold,"larger_warm":larger_warm,"ordinary_warm":ordinary_warm,"warm_parse":distribution(timings),"json_encode":distribution(encodings),"json_decode_rust_value_not_node":distribution(decodings),"encoded_bytes_over_1000":encoded_bytes,"incremental":{"source_bytes":multiline.len(),"committed_calls":calls,"committed_bytes":bytes,"tail_parse_bytes":tail_bytes,"finalization_parse_calls":final_result.counters.committed_line_calls+final_result.counters.tail_calls,"latency":distribution(increment)},"stress":stress,"calibration_line_cap":32<<10,"production_line_cap":engine.limits.line_bytes,"fair_quanta":fair_quanta,"leases32":{"known_bytes":lease_bytes,"memory":leased},"all_grammar":{"count":names.len(),"memory":all_grammar},"capture_leases":capture_leases,"capture_released":capture_released,"capture_cycles":capture_cycles,"admitted_peer":admitted_peer,"selected_theme_cold":native_themes,"released":memory(),"live_leases":engine.leases(),"known_retained_state_bytes":engine.retained_state_bytes()})).unwrap());
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
