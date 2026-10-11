//! Worker-local authority checks. Real transport scheduling is a separate gate.
use occipital::{
    engine::Limits,
    profile::Profile,
    reply::SourceBody,
    request::decode,
    service::{Action, Service},
};
use serde_json::{json, Value};
fn data(op: &str, key: &str, generation: u32) -> Value {
    json!({"v":2,"ticket":"t","instance":"boot","op":op,"admission":"try_now","sources":[{"key":key,"generation":generation,"source_version":1,"profile":"pi","fingerprint":Profile::resolve("pi").unwrap().fingerprint,"hint":{"language":"bash"},"text":"echo one"}]})
}
fn start(service: &mut Service, scope: &str, value: Value) -> Action {
    service
        .start(scope, decode(&serde_json::to_vec(&value).unwrap()).unwrap())
        .unwrap()
}
fn execute(service: &mut Service, action: Action) -> SourceBody {
    match action {
        Action::Immediate(body) => body,
        Action::Job(mut job) => loop {
            if let Some(body) = service.step(&mut job).unwrap() {
                break body;
            }
        },
    }
}
fn open(service: &mut Service, scope: &str, generation: u32) -> Value {
    let action = start(service, scope, data("stream.open", "same", generation));
    serde_json::to_value(execute(service, action)).unwrap()["sources"][0].clone()
}
fn append(source: &Value) -> Value {
    json!({"v":2,"ticket":"a","instance":"boot","op":"stream.append","admission":"try_now","key":source["key"],"generation":source["generation"],"source_version":2,"lease":source["lease"],"base_revision":source["revision"],"base_bytes":source["source_bytes"],"profile":source["profile"],"fingerprint":source["fingerprint"],"append":"\nnext\n","final":true})
}
#[test]
fn opaque_leases_are_route_scoped_and_old_generations_never_replace_newer_state() {
    let mut service = Service::new(Limits::default(), "boot".into());
    service.bind("peer-a").unwrap();
    service.bind("peer-b").unwrap();
    let old = open(&mut service, "peer-a", 1);
    let new = open(&mut service, "peer-a", 2);
    assert_ne!(old["lease"], new["lease"]);
    let request = decode(&serde_json::to_vec(&append(&new)).unwrap()).unwrap();
    let fault = service.start("peer-b", request).err().unwrap();
    assert!(!fault.started);
    assert_eq!(fault.code, "restart_required");
    let close = json!({"v":2,"ticket":"c","op":"stream.close","instance":"boot","key":"same","generation":1,"lease":old["lease"]});
    let action = start(&mut service, "peer-a", close);
    assert!(matches!(execute(&mut service, action), SourceBody::Closed));
    let action = start(&mut service, "peer-a", append(&new));
    let reply = serde_json::to_value(execute(&mut service, action)).unwrap();
    assert_eq!(reply["sources"][0]["revision"], 2);
    assert_eq!(service.leases(), 0);
}
#[test]
fn complete_batch_validation_is_no_start_and_profile_changes_never_advance_a_lease() {
    let mut service = Service::new(Limits::default(), "boot".into());
    service.bind("peer").unwrap();
    let mut batch = data("highlight", "first", 1);
    let mut other = batch["sources"][0].clone();
    other["key"] = json!("second");
    other["fingerprint"] = json!("b".repeat(64));
    batch["sources"].as_array_mut().unwrap().push(other);
    let fault = service
        .start(
            "peer",
            decode(&serde_json::to_vec(&batch).unwrap()).unwrap(),
        )
        .err()
        .unwrap();
    assert_eq!(fault.code, "profile_changed");
    assert!(!fault.started);
    assert_eq!(service.leases(), 0);
    let source = open(&mut service, "peer", 1);
    let mut bad = append(&source);
    bad["fingerprint"] = json!("b".repeat(64));
    let fault = service
        .start("peer", decode(&serde_json::to_vec(&bad).unwrap()).unwrap())
        .err()
        .unwrap();
    assert_eq!(fault.code, "profile_changed");
    assert!(!fault.started);
    let action = start(&mut service, "peer", append(&source));
    execute(&mut service, action);
    assert_eq!(service.leases(), 0);
}
#[test]
fn busy_route_loss_expiry_and_unknown_incarnation_do_not_resurrect_binding_state() {
    let mut service = Service::new(
        Limits {
            idle_ms: 5,
            ..Limits::default()
        },
        "boot".into(),
    );
    service.bind("peer").unwrap();
    let source = open(&mut service, "peer", 1);
    service.advance_clock(5);
    assert_eq!(service.leases(), 0);
    assert!(service
        .start(
            "peer",
            decode(&serde_json::to_vec(&append(&source)).unwrap()).unwrap()
        )
        .is_err());
    let mut wrong = data("highlight", "key", 1);
    wrong["instance"] = json!("old-boot");
    assert_eq!(
        service
            .start(
                "peer",
                decode(&serde_json::to_vec(&wrong).unwrap()).unwrap()
            )
            .err()
            .unwrap()
            .code,
        "restart_required"
    );
    let action = start(&mut service, "peer", data("stream.open", "active", 2));
    let Action::Job(mut job) = action else {
        panic!()
    };
    service.close_scope("peer");
    assert!(service.step(&mut job).is_err());
    service.discard(job);
    assert_eq!(service.leases(), 0);
}
#[test]
fn cancellation_before_and_after_parser_progress_releases_exact_work() {
    let mut service = Service::new(Limits::default(), "boot".into());
    service.bind("peer").unwrap();
    let action = start(&mut service, "peer", data("stream.open", "cold", 1));
    let Action::Job(job) = action else { panic!() };
    assert!(!job.started());
    service.discard(job);
    assert_eq!(service.leases(), 0);
    let mut source = data("stream.open", "growing", 2);
    source["sources"][0]["text"] = json!("echo x\n".repeat(200));
    let action = start(&mut service, "peer", source);
    let Action::Job(mut job) = action else {
        panic!()
    };
    assert!(service.step(&mut job).unwrap().is_none());
    assert!(job.started());
    service.discard(job);
    assert_eq!(service.leases(), 0);
}

#[test]
fn cancellation_of_ready_but_unhanded_reply_releases_the_opened_lease() {
    let mut service = Service::new(Limits::default(), "boot".into());
    service.bind("peer").unwrap();
    let action = start(&mut service, "peer", data("stream.open", "ready", 1));
    let Action::Job(mut job) = action else {
        panic!()
    };
    assert!(service.step(&mut job).unwrap().is_some());
    assert_eq!(service.leases(), 1);
    service.discard(job);
    assert_eq!(service.leases(), 0);
}

#[test]
fn replacing_worker_state_in_same_provider_cannot_alias_an_old_opaque_lease() {
    let mut first = Service::new(Limits::default(), "boot".into());
    first.bind("peer").unwrap();
    let old = open(&mut first, "peer", 1);
    let mut replacement = Service::new(Limits::default(), "boot".into());
    replacement.bind("peer").unwrap();
    let fresh = open(&mut replacement, "peer", 1);
    assert_ne!(old["lease"], fresh["lease"]);
    let request = decode(&serde_json::to_vec(&append(&old)).unwrap()).unwrap();
    let fault = replacement.start("peer", request).err().unwrap();
    assert_eq!(fault.code, "restart_required");
    assert!(!fault.started);
    let action = start(&mut replacement, "peer", append(&fresh));
    execute(&mut replacement, action);
    assert_eq!(replacement.leases(), 0);
}

#[test]
fn current_custom_catalogue_profiles_are_authoritative_and_replacement_retires_only_affected_leases(
) {
    let theme = Profile::resolve("syntect:Catppuccin Mocha")
        .unwrap()
        .theme
        .clone()
        .unwrap();
    let custom = Profile::native("custom:first".into(), "a".repeat(64), theme.clone()).unwrap();
    let mut service = Service::new(Limits::default(), "boot".into());
    service.bind("peer").unwrap();
    service.replace_profiles(vec![custom]).unwrap();
    let native = open(&mut service, "peer", 1);
    let mut request = data("stream.open", "custom", 2);
    request["sources"][0]["profile"] = json!("custom:first");
    request["sources"][0]["fingerprint"] = json!("a".repeat(64));
    let action = start(&mut service, "peer", request.clone());
    let saved = serde_json::to_value(execute(&mut service, action)).unwrap()["sources"][0].clone();
    assert_eq!(service.leases(), 2);
    service
        .replace_profiles(vec![Profile::native(
            "custom:first".into(),
            "b".repeat(64),
            theme,
        )
        .unwrap()])
        .unwrap();
    assert_eq!(service.leases(), 1);
    let fault = service
        .start(
            "peer",
            decode(&serde_json::to_vec(&append(&saved)).unwrap()).unwrap(),
        )
        .err()
        .unwrap();
    assert_eq!(fault.code, "restart_required");
    assert!(!fault.started);
    let fault = service
        .start(
            "peer",
            decode(&serde_json::to_vec(&request).unwrap()).unwrap(),
        )
        .err()
        .unwrap();
    assert_eq!(fault.code, "profile_changed");
    assert!(!fault.started);
    service.replace_profiles(vec![]).unwrap();
    let fault = service
        .start(
            "peer",
            decode(&serde_json::to_vec(&request).unwrap()).unwrap(),
        )
        .err()
        .unwrap();
    assert_eq!(fault.code, "theme_unavailable");
    assert!(!fault.started);
    let action = start(&mut service, "peer", append(&native));
    execute(&mut service, action);
    assert_eq!(service.leases(), 0);
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
        assert!(path.len() <= 4096);
        for language in [None, Some("rust")] {
            let mut service = Service::new(Limits::default(), "boot".into());
            service.bind("peer").unwrap();
            let mut value = data("highlight", "source", 1);
            value["sources"][0]["text"] = json!("fn main() {}");
            value["sources"][0]["hint"] = json!({"path":path});
            if let Some(language) = language {
                value["sources"][0]["hint"]["language"] = json!(language);
            }
            let request = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
            let action = service.start("peer", request).unwrap_or_else(|fault| {
                panic!(
                    "validated {}-byte path, language {language:?}: {fault:?}",
                    path.len()
                )
            });
            let reply = serde_json::to_value(execute(&mut service, action)).unwrap();
            assert_eq!(reply["sources"][0]["source_bytes"], 12);
            assert_eq!(reply["sources"][0]["complete"], true);
            assert_eq!(service.leases(), 0);
        }
    }
    let mut oversized = data("highlight", "source", 1);
    oversized["sources"][0]["hint"]["path"] = json!("a".repeat(4097));
    let fault = decode(&serde_json::to_vec(&oversized).unwrap()).unwrap_err();
    assert!(!fault.started);
}
