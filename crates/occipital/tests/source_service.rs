use occipital::{
    protocol::Fault,
    semantic_engine::{Engine, Limits},
    source_request::SourceRequest,
    source_service::{Action, Job, Service},
};
use serde_json::{json, value::RawValue, Value};
use std::io::Write;
fn source(key: &str, text: &str) -> Value {
    json!({"key":key,"generation":1,"source_version":0,"hint":{"language":"rust"},"text":text})
}
fn finite(sources: Vec<Value>, open: bool) -> Value {
    json!({"v":3,"op":if open{"stream.open"}else{"highlight"},"instance":"instance","ticket":"t","admission":"try_now","sources":sources})
}
fn decode(value: Value) -> SourceRequest {
    SourceRequest::decode(
        &RawValue::from_string(value.to_string()).unwrap(),
        "instance",
        occipital::limits::SOURCE_BYTES,
        &mut |_| true,
    )
    .unwrap()
}
fn service(limits: Limits) -> Service {
    let mut service = Service::new(limits, "instance".into());
    service.bind("r", &mut |_| true).unwrap();
    service
}
fn job(
    service: &mut Service,
    route: &str,
    request: Value,
    grant: &mut dyn FnMut(usize) -> bool,
) -> Job {
    match service.start(route, decode(request), grant).unwrap() {
        Action::Job(j) => j,
        _ => panic!("expected Job"),
    }
}
fn drive(
    service: &mut Service,
    mut job: Job,
    grant: &mut dyn FnMut(usize) -> bool,
) -> (Value, Job) {
    loop {
        if let Some(body) = service.step(&mut job, grant).unwrap() {
            return (serde_json::to_value(body).unwrap(), job);
        }
    }
}
fn open(service: &mut Service, key: &str, text: &str) -> Value {
    let request = job_start(service, "r", finite(vec![source(key, text)], true));
    drive(service, request, &mut |_| true).0["sources"][0].clone()
}
fn job_start(service: &mut Service, route: &str, request: Value) -> Job {
    job(service, route, request, &mut |_| true)
}
fn append(result: &Value, text: &str, finalize: bool, version: u32) -> Value {
    json!({"v":3,"op":"stream.append","instance":"instance","ticket":"t","admission":"try_now","key":result["key"],"generation":result["generation"],"source_version":version,"lease":result["lease"],"base_revision":result["revision"],"base_bytes":result["source_bytes"],"append":text,"final":finalize})
}
fn close(result: &Value) -> Value {
    json!({"v":3,"op":"stream.close","instance":"instance","ticket":"t","key":result["key"],"generation":result["generation"],"lease":result["lease"]})
}
fn error(service: &mut Service, route: &str, request: Value) -> Fault {
    service
        .start(route, decode(request), &mut |_| true)
        .err()
        .unwrap()
}
fn closed(service: &mut Service, route: &str, request: Value) {
    let Action::Immediate(body) = service
        .start(route, decode(request), &mut |_| {
            panic!("close must not grow Job state")
        })
        .unwrap()
    else {
        panic!("not immediate")
    };
    assert_eq!(
        serde_json::to_value(body).unwrap(),
        json!({"kind":"closed"})
    );
}
fn assert_source(result: &Value, text: &str, complete: bool) {
    assert_eq!(result["complete"], complete);
    assert_eq!(result["source_bytes"], text.len());
    let mut cursor = result["replace_from"].as_u64().unwrap() as usize;
    let rows = result["contexts"].as_array().unwrap();
    let runs = result["runs"].as_array().unwrap();
    assert_eq!(runs.len() % 2, 0);
    let mut prev = None;
    for pair in runs.as_chunks::<2>().0 {
        let len = pair[0].as_u64().unwrap() as usize;
        let id = pair[1].as_u64().unwrap() as usize;
        assert!(len > 0);
        assert!(id <= rows.len());
        assert_ne!(prev, Some(id));
        assert!(text.is_char_boundary(cursor));
        cursor += len;
        assert!(text.is_char_boundary(cursor));
        prev = Some(id);
    }
    assert_eq!(cursor, text.len());
    for field in ["profile", "fingerprint", "styles", "palette", "theme"] {
        assert!(result.get(field).is_none(), "unexpected {field}");
    }
}
#[test]
fn finite_batch_uses_actual_parser_and_shared_flat_source_schema() {
    let mut service = service(Limits::default());
    let texts = [
        "fn main() { let x = \"界🙂\"; }\n",
        "/* a\n b */ const X: i32 = 1;\n",
        "",
    ];
    let inputs = texts
        .iter()
        .enumerate()
        .map(|(n, t)| source(&format!("s{n}"), t))
        .collect();
    let request = job_start(&mut service, "r", finite(inputs, false));
    let (body, mut job) = drive(&mut service, request, &mut |_| true);
    assert!(job.started());
    assert_eq!(
        service
            .step(&mut job, &mut |_| panic!(
                "completed Job cannot allocate or parse"
            ))
            .err(),
        Some(Fault::not_started("job_complete"))
    );
    assert!(
        job.started(),
        "historical execution authority remains available separately"
    );
    assert_eq!(job.input_bytes(), 0);
    assert_eq!(body["kind"], "source");
    assert_eq!(body["vocabulary"], occipital::vocabulary::FINGERPRINT);
    for (n, text) in texts.iter().enumerate() {
        let row = &body["sources"][n];
        assert_source(row, text, true);
        assert_eq!(row["revision"], 1);
        assert_eq!(row["source_version"], 0);
        assert_eq!(row["generation"], 1);
        assert_eq!(row["committed_bytes"], text.len());
        assert!(row.get("lease").is_none());
        let mut oracle = Engine::new(Limits::default());
        let mut work = oracle
            .begin_one_shot(
                (*text).into(),
                &occipital::protocol::SyntaxHint {
                    language: Some("rust".into()),
                    path: None,
                },
                &mut |_| true,
            )
            .unwrap();
        while !oracle.step(&mut work, &mut |_| true).unwrap() {}
        let chunk = oracle.finish(work, &mut |_| true).unwrap();
        assert_eq!(row["contexts"], json!(chunk.contexts));
        assert_eq!(
            row["runs"],
            json!(chunk.runs.into_iter().flatten().collect::<Vec<_>>())
        );
    }
    assert_eq!(service.leases(), 0);
    let retained = job.acknowledgement_bytes();
    job.trim_completed();
    assert_eq!(job.acknowledgement_bytes(), retained);
    service.discard(job);
}
#[test]
fn open_append_noop_final_close_preserve_version_and_exact_lease_acknowledgement() {
    let mut service = service(Limits::default());
    let mut text = "fn main() {\nlet x = \"界".to_string();
    let first = open(&mut service, "key", &text);
    assert_source(&first, &text, false);
    assert_eq!(first["revision"], 1);
    let lease = first["lease"].as_str().unwrap();
    assert_eq!(lease.len(), 64);
    assert!(lease
        .bytes()
        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    assert_eq!(service.leases(), 1);
    assert_eq!(
        service.known_state_bytes(),
        service.known_idle_state_bytes()
    );
    let work = job_start(&mut service, "r", append(&first, "", false, 0));
    let (body, _) = drive(&mut service, work, &mut |_| true);
    let second = &body["sources"][0];
    assert_eq!(second["revision"], 2);
    assert_eq!(second["lease"], first["lease"]);
    assert_eq!(
        second["counters"],
        json!({"committed_line_calls":0,"committed_line_bytes":0,"tail_calls":0,"tail_bytes":0})
    );
    text.push_str("🙂\";\n}");
    let work = job_start(&mut service, "r", append(second, "🙂\";\n}", false, 7));
    let (body, _) = drive(&mut service, work, &mut |_| true);
    let third = &body["sources"][0];
    assert_source(third, &text, false);
    assert_eq!(third["source_version"], 7);
    assert_eq!(third["revision"], 3);
    assert_eq!(third["lease"], first["lease"]);
    assert_eq!(
        error(&mut service, "r", append(third, "", false, 6)),
        Fault::not_started("restart_required")
    );
    let work = job_start(&mut service, "r", append(third, "", true, 7));
    let (body, ack) = drive(&mut service, work, &mut |_| true);
    let last = &body["sources"][0];
    assert_source(last, &text, true);
    assert_eq!(last["revision"], 4);
    assert_eq!(last["committed_bytes"], text.len());
    assert_eq!(last["lease"], first["lease"]);
    assert_eq!(service.leases(), 0);
    assert_eq!(last["counters"], second["counters"]);
    service.discard(ack);
    closed(&mut service, "r", close(last));
    closed(&mut service, "r", close(last));
}
#[test]
fn wrong_route_key_generation_version_and_append_base_never_mutate_current_state() {
    let mut service = service(Limits::default());
    service.bind("other", &mut |_| true).unwrap();
    let first = open(&mut service, "k", "fn x(){}\n");
    let expected = Fault::not_started("restart_required");
    assert_eq!(
        error(&mut service, "other", append(&first, "x", false, 1)),
        expected
    );
    for (field, value) in [
        ("key", json!("wrong")),
        ("lease", json!("0".repeat(64))),
        ("generation", json!(2)),
        ("base_revision", json!(2)),
        ("base_bytes", json!(0)),
    ] {
        let mut request = append(&first, "x", false, 1);
        request[field] = value;
        assert_eq!(error(&mut service, "r", request), expected, "{field}");
    }
    let mut wrong = close(&first);
    wrong["generation"] = json!(2);
    closed(&mut service, "r", wrong);
    closed(&mut service, "other", close(&first));
    assert_eq!(service.leases(), 1);
    let work = job_start(&mut service, "r", append(&first, "// ok\n", false, 1));
    let (body, _) = drive(&mut service, work, &mut |_| true);
    assert_eq!(body["sources"][0]["revision"], 2);
    assert_eq!(body["sources"][0]["source_version"], 1);
}
#[test]
fn old_incarnations_and_different_services_cannot_close_a_successor() {
    let mut service = service(Limits::default());
    let old = open(&mut service, "same", "old\n");
    closed(&mut service, "r", close(&old));
    let mut next = source("same", "new\n");
    next["generation"] = json!(2);
    let work = job_start(&mut service, "r", finite(vec![next], true));
    let (body, _) = drive(&mut service, work, &mut |_| true);
    let new = &body["sources"][0];
    assert_ne!(old["lease"], new["lease"]);
    closed(&mut service, "r", close(&old));
    assert_eq!(
        error(&mut service, "r", append(&old, "bad", false, 1)),
        Fault::not_started("restart_required")
    );
    assert_eq!(service.leases(), 1);
    let mut second = Service::new(Limits::default(), "instance".into());
    second.bind("r", &mut |_| true).unwrap();
    let other = open(&mut second, "same", "new\n");
    assert_ne!(new["lease"], other["lease"]);
    closed(&mut second, "r", close(new));
    assert_eq!(second.leases(), 1);
}
#[test]
fn pending_error_and_ready_not_drained_cancellation_retire_exact_affected_leases() {
    let mut service = service(Limits::default());
    let unrelated = open(&mut service, "unrelated", "ok\n");
    let request = job_start(
        &mut service,
        "r",
        finite(vec![source("pending", "x\n")], true),
    );
    assert!(!request.started());
    assert!(request.input_bytes() > 0);
    assert_eq!(service.leases(), 2);
    service.discard(request);
    assert_eq!(service.leases(), 1);
    let mut work = job_start(
        &mut service,
        "r",
        finite(vec![source("failing", "fn x(){ let y = 1; }\n")], true),
    );
    let fault = service.step(&mut work, &mut |_| false).err().unwrap();
    assert_eq!(fault, Fault::started("data_limit"));
    assert!(work.started());
    service.discard(work);
    assert_eq!(service.leases(), 1);
    let request = job_start(
        &mut service,
        "r",
        finite(vec![source("ready", "x\n")], true),
    );
    let (body, mut ready) = drive(&mut service, request, &mut |_| true);
    let result = &body["sources"][0];
    assert!(ready.owns_lease("r", result["lease"].as_str().unwrap()));
    assert!(!ready.owns_lease("other", result["lease"].as_str().unwrap()));
    ready.trim_completed();
    assert_eq!(ready.input_bytes(), 0);
    assert!(ready.acknowledgement_bytes() > 0);
    assert_eq!(service.leases(), 2);
    service.discard(ready);
    assert_eq!(service.leases(), 1);
    assert_eq!(
        error(&mut service, "r", append(result, "bad", false, 1)),
        Fault::not_started("restart_required")
    );
    closed(&mut service, "r", close(&unrelated));
    service.close_scope("r");
    assert_eq!(service.known_state_bytes(), 0);
    assert_eq!(service.known_idle_state_bytes(), 0);
}
#[test]
fn route_close_rebind_invalidates_old_finite_jobs_and_preserves_new_authority() {
    let mut service = service(Limits::default());
    let mut not_started = job_start(&mut service, "r", finite(vec![source("old", "x\n")], false));
    service.close_scope("r");
    service.bind("r", &mut |_| true).unwrap();
    assert_eq!(
        service.step(&mut not_started, &mut |_| true).err().unwrap(),
        Fault::not_started("scope_gone")
    );
    let new = open(&mut service, "same", "new\n");
    service.discard(not_started);
    assert_eq!(service.leases(), 1);
    let mut started = job_start(
        &mut service,
        "r",
        finite(vec![source("old", "x\n".repeat(200).as_str())], false),
    );
    assert!(service.step(&mut started, &mut |_| true).unwrap().is_none());
    assert!(started.started());
    service.close_scope("r");
    service.bind("r", &mut |_| true).unwrap();
    let replacement = open(&mut service, "same", "newer\n");
    assert_eq!(
        service.step(&mut started, &mut |_| true).err().unwrap(),
        Fault::started("scope_gone")
    );
    service.discard(started);
    closed(&mut service, "r", close(&new));
    assert_eq!(service.leases(), 1);
    closed(&mut service, "r", close(&replacement));
}
#[test]
fn expiry_and_noop_do_not_renew_age_or_alias_old_wire_lease() {
    let mut service = service(Limits {
        idle_ms: 10,
        age_ms: 25,
        ..Limits::default()
    });
    let first = open(&mut service, "k", "x");
    assert_eq!(service.next_expiry(), Some(10));
    service.advance_clock(9);
    let request = job_start(&mut service, "r", append(&first, "", false, 0));
    let (body, _) = drive(&mut service, request, &mut |_| true);
    let second = &body["sources"][0];
    assert_eq!(service.next_expiry(), Some(10));
    service.advance_clock(10);
    assert_eq!(service.leases(), 0);
    assert_eq!(
        error(&mut service, "r", append(second, "x", false, 1)),
        Fault::not_started("restart_required")
    );
    let mut current = open(&mut service, "k", "x\n");
    for now in [18, 26, 34] {
        service.advance_clock(now);
        let request = job_start(&mut service, "r", append(&current, "x\n", false, 1));
        let (body, _) = drive(&mut service, request, &mut |_| true);
        current = body["sources"][0].clone();
        assert_eq!(service.next_expiry(), Some((now + 10).min(35)));
    }
    service.advance_clock(35);
    assert_eq!(service.leases(), 0);
    let mut pending = job_start(
        &mut service,
        "r",
        finite(vec![source("pending", "x\n")], true),
    );
    service.advance_clock(45);
    assert_eq!(
        service.step(&mut pending, &mut |_| true).err().unwrap(),
        Fault::not_started("scope_gone")
    );
    service.discard(pending);
    service.close_scope("r");
    assert_eq!(service.known_state_bytes(), 0);
}
#[test]
fn late_invalid_batches_reject_before_service_allocation_or_any_parser_work() {
    let mut service = service(Limits::default());
    let good = source("first", "fn f() {}\n");
    let mut bad = source("later", "x");
    bad["hint"]["language"] = json!("unsupported-language-for-source-service");
    let request = decode(finite(vec![good.clone(), bad], false));
    let fault = service
        .start("r", request, &mut |_| {
            panic!("whole syntax batch must validate before reserve/Work")
        })
        .err()
        .unwrap();
    assert_eq!(fault, Fault::not_started("unknown_syntax"));
    assert_eq!(service.leases(), 0);
    let duplicate = finite(
        vec![good.clone(), {
            let mut value = good.clone();
            value["generation"] = json!(2);
            value
        }],
        false,
    );
    let raw = RawValue::from_string(duplicate.to_string()).unwrap();
    assert!(SourceRequest::decode(
        &raw,
        "instance",
        occipital::limits::SOURCE_BYTES,
        &mut |_| panic!("decoder owns duplicate validation")
    )
    .is_err());
    let mut tiny = service_with_limit();
    let request = decode(finite(
        vec![source("first", "x"), source("later", "too long")],
        false,
    ));
    assert_eq!(
        tiny.start("r", request, &mut |_| panic!("all source bounds preflight"))
            .err()
            .unwrap(),
        Fault::not_started("source_limit")
    );
}
fn service_with_limit() -> Service {
    service(Limits {
        source_bytes: 4,
        ..Limits::default()
    })
}
#[test]
fn batch_growth_is_cumulative_across_pending_work_and_ready_results_with_actual_credit() {
    let text = "fn f() { let s = \"界\"; }\n";
    let frame = finite(
        vec![source("a", text), source("b", text), source("c", text)],
        false,
    );
    let mut service = service(Limits::default());
    let mut grants = Vec::new();
    let request = job(&mut service, "r", frame.clone(), &mut |n| {
        grants.push(n);
        true
    });
    let start = request.required_bytes();
    let (body, done) = drive(&mut service, request, &mut |n| {
        assert!(n >= *grants.last().unwrap());
        grants.push(n);
        true
    });
    let peak = done.required_bytes();
    assert!(peak > start);
    assert_eq!(body["sources"].as_array().unwrap().len(), 3);
    assert_eq!(done.input_bytes(), 0);
    assert_eq!(grants.last(), Some(&peak));
    for limit in [peak, peak - 1] {
        let pool = occipital::credit::Budget::new(limit, 1, 1);
        let mut credit = pool.reserve(Some("r"), 0).unwrap();
        credit.started();
        let mut reserve = |n| credit.resize(n).is_ok();
        let mut worker = Service::new(Limits::default(), "instance".into());
        worker.bind("r", &mut |_| true).unwrap();
        let mut request = job(&mut worker, "r", frame.clone(), &mut reserve);
        let outcome = loop {
            match worker.step(&mut request, &mut reserve) {
                Ok(Some(body)) => break Ok(body),
                Ok(None) => {}
                Err(fault) => break Err(fault),
            }
        };
        assert_eq!(outcome.is_ok(), limit == peak);
        if limit < peak {
            assert!(outcome.as_ref().err().unwrap().started);
            assert!(request.started());
            assert!(request.input_bytes() > 0);
        }
        drop(outcome);
        worker.discard(request);
        drop(reserve);
        assert!(pool.snapshot().peak_bytes <= limit);
        drop(credit);
        assert_eq!(
            (
                pool.snapshot().bytes,
                pool.snapshot().jobs,
                pool.snapshot().queued
            ),
            (0, 0, 0)
        );
    }
    writeln!(std::io::stdout(),"source service3-member batch: initial additional={start}, final cumulative={peak}, growth notifications={}; exact budget passes; one-byte-short fails after parsing; real bytes/jobs/queue fully released",grants.len()).unwrap();
}
#[test]
fn bind_denial_precedes_expansion_and_does_not_invalidate_existing_routes() {
    let mut worker = Service::new(Limits::default(), "instance".into());
    let mut grants = Vec::new();
    worker
        .bind("r", &mut |n| {
            grants.push(n);
            true
        })
        .unwrap();
    let first_peak = *grants.last().unwrap();
    let first_retained = worker.known_state_bytes();
    assert!(first_peak >= first_retained);
    for limit in [first_peak, first_peak - 1] {
        let mut other = Service::new(Limits::default(), "instance".into());
        let result = other.bind("r", &mut |n| n <= limit);
        assert_eq!(result.is_ok(), limit == first_peak);
        if result.is_err() {
            assert_eq!(other.known_state_bytes(), 0);
            assert_eq!(
                error(&mut other, "r", finite(vec![source("k", "x")], false)),
                Fault::not_started("scope_gone")
            );
        }
    }
    for route in ["a", "b", "c"] {
        worker.bind(route, &mut |_| true).unwrap();
    }
    let retained = worker.known_state_bytes();
    let mut calls = 0;
    assert_eq!(
        worker
            .bind("denied", &mut |_| {
                calls += 1;
                calls == 1
            })
            .unwrap_err(),
        Fault::not_started("data_limit")
    );
    assert_eq!(calls, 2);
    assert_eq!(worker.known_state_bytes(), retained);
    let request = job_start(&mut worker, "r", finite(vec![source("k", "x\n")], false));
    drive(&mut worker, request, &mut |_| true);
    for route in ["r", "a", "b", "c"] {
        worker.close_scope(route);
    }
    assert_eq!(worker.known_state_bytes(), 0);
    writeln!(std::io::stdout(),"bind controlled state: initial peak={first_peak}, retained={first_retained}; exact/denied allocation and existing route authority verified").unwrap();
}
#[test]
fn source_results_and_lease_survive_unrelated_native_theme_work() {
    let mut worker = service(Limits::default());
    let first = open(&mut worker, "k", "fn x(){}\n");
    let immutable = first.clone();
    let before = worker.known_state_bytes();
    // Real native palette construction cannot retire source state; no theme data
    // is passed into or retained by Service, and the source contract rejects it.
    let themes: two_face::theme::LazyThemeSet = two_face::theme::extra().into();
    for name in ["Nord", "ansi"] {
        let theme = themes.get(name).unwrap();
        let palette = occipital::native_palette::NativeTheme::compile(
            theme,
            occipital::native_palette::HintPaths {
                comment: &[],
                invalid: &[],
                changed: &[],
                inserted: &[],
                deleted: &[],
            },
        )
        .unwrap();
        assert_eq!(palette.palette.slots.len(), 26);
    }
    assert_eq!(worker.known_state_bytes(), before);
    assert_eq!(first, immutable);
    let request = job_start(
        &mut worker,
        "r",
        append(&first, "// same lease\n", false, 1),
    );
    let (body, _) = drive(&mut worker, request, &mut |_| true);
    assert_eq!(body["sources"][0]["lease"], first["lease"]);
    assert_eq!(body["sources"][0]["revision"], 2);
    let mut forbidden = finite(vec![source("k", "x")], false);
    forbidden["sources"][0]["profile"] = json!("syntect:Nord");
    assert!(SourceRequest::decode(
        &RawValue::from_string(forbidden.to_string()).unwrap(),
        "instance",
        occipital::limits::SOURCE_BYTES,
        &mut |_| panic!("theme field must fail before materialization")
    )
    .is_err());
}

#[test]
fn each_start_reservation_denial_rolls_back_without_parsing_or_retiring_unrelated_sources() {
    let frame = finite(vec![source("k", "fn f() {}\n")], true);
    let mut probe = service(Limits::default());
    let mut grants = Vec::new();
    let work = job(&mut probe, "r", frame.clone(), &mut |n| {
        grants.push(n);
        true
    });
    probe.discard(work);
    for fail_at in 0..grants.len() {
        let mut worker = service(Limits::default());
        let mut calls = 0;
        let result = worker.start("r", decode(frame.clone()), &mut |_| {
            let pass = calls != fail_at;
            calls += 1;
            pass
        });
        assert_eq!(
            result.err(),
            Some(Fault::not_started("data_limit")),
            "reservation {fail_at}"
        );
        assert_eq!(worker.leases(), 0);
        worker.close_scope("r");
        assert_eq!(worker.known_state_bytes(), 0);
    }
    let mut worker = service(Limits::default());
    let keep = open(&mut worker, "keep", "x\n");
    let baseline = worker.known_state_bytes();
    let request = finite(
        vec![source("a", "x\n"), source("b", "y\n"), source("c", "z\n")],
        false,
    );
    let mut calls = 0;
    let result = worker.start("r", decode(request), &mut |_| {
        calls += 1;
        calls < 8
    });
    assert_eq!(result.err(), Some(Fault::not_started("data_limit")));
    assert_eq!(worker.leases(), 1);
    assert_eq!(worker.known_state_bytes(), baseline);
    let work = job_start(&mut worker, "r", append(&keep, "x\n", false, 1));
    drive(&mut worker, work, &mut |_| true);
    writeln!(std::io::stdout(),"all{} open start reservation boundaries reject before parsing and clean up; later finite-member preparation denial preserves unrelated lease",grants.len()).unwrap();
}
#[test]
fn refused_open_after_full_binding_capacity_retains_no_unfunded_persistent_growth() {
    let mut worker = service(Limits {
        per_scope: 4,
        ..Limits::default()
    });
    for i in 0..4 {
        open(&mut worker, &format!("k{i}"), "x\n");
    }
    assert_eq!(worker.leases(), 4);
    let baseline = worker.known_idle_state_bytes();
    let result = worker.start(
        "r",
        decode(finite(vec![source("k4", "x\n")], true)),
        &mut |_| true,
    );
    assert_eq!(result.err(), Some(Fault::not_started("session_limit")));
    assert_eq!(worker.leases(), 4);
    // The refused job's credit is reduced to an error envelope; persistent
    // storage it grew must be rolled back rather than left for another request.
    assert_eq!(worker.known_idle_state_bytes(), baseline);
}
#[test]
fn close_during_append_keeps_authority_until_actual_discard() {
    let mut worker = service(Limits::default());
    let first = open(&mut worker, "k", "x\n");
    let baseline = worker.known_idle_state_bytes();
    let mut pending = job_start(
        &mut worker,
        "r",
        append(&first, &"x\n".repeat(200), false, 1),
    );
    assert!(worker.known_idle_state_bytes() < baseline);
    assert!(worker.known_state_bytes() >= worker.known_idle_state_bytes());
    assert!(worker.step(&mut pending, &mut |_| true).unwrap().is_none());
    assert!(pending.started());
    closed(&mut worker, "r", close(&first));
    assert_eq!(
        worker.step(&mut pending, &mut |_| true).err().unwrap(),
        Fault::started("scope_gone")
    );
    let next = open(&mut worker, "k", "new\n");
    worker.discard(pending);
    assert_eq!(worker.leases(), 1);
    let idle = worker.known_idle_state_bytes();
    assert_eq!(worker.known_state_bytes(), idle);
    closed(&mut worker, "r", close(&first));
    assert_eq!(worker.leases(), 1);
    closed(&mut worker, "r", close(&next));
    worker.close_scope("r");
    assert_eq!(worker.known_state_bytes(), 0);
}

#[test]
fn request_path_hint_budget_survives_engine_boundary() {
    let paths = [1024, 1025, 4096].map(|length| {
        let prefix = length - 7;
        format!(
            "{}{}main.rs",
            "a/".repeat(prefix / 2),
            "a".repeat(prefix % 2)
        )
    });
    for path in paths
        .into_iter()
        .chain([format!("{}x.rs", "λ/".repeat(1364))])
    {
        for language in [None, Some("rust")] {
            let mut service = service(Limits::default());
            let mut input = source("path", "fn main() {}");
            input["hint"] = json!({"path":path,"language":language});
            let work = job_start(&mut service, "r", finite(vec![input], false));
            let (body, work) = drive(&mut service, work, &mut |_| true);
            assert_source(&body["sources"][0], "fn main() {}", true);
            service.discard(work);
            assert_eq!(service.leases(), 0);
        }
    }
}
