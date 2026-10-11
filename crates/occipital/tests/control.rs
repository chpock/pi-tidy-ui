//! Real worker/catalogue controls; no alternate parser or filesystem catalogue.
use occipital::{
    actor::{ActorPool, Route},
    catalogue::Catalogue,
    control::Authority,
    engine::Limits,
    ingress::Incoming,
    profile::Profile,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "occipital-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("themes")).unwrap();
        Self(path)
    }
    fn catalogue(&self) -> Catalogue {
        Catalogue::new(Some(self.0.join("config.json")))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn metadata(authority: &Authority, route: &Route, op: &str, ticket: &str) -> Value {
    let Incoming::Control(control) = route
        .receive(serde_json::to_vec(&json!({"v":2,"ticket":ticket,"op":op})).unwrap())
        .ok()
        .unwrap()
    else {
        panic!("control lane");
    };
    let reply = authority.control(control).await.unwrap();
    let value = serde_json::from_slice(reply.bytes()).unwrap();
    reply.commit();
    value
}
fn theme(color: &str) -> String {
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>name</key><string>Local</string><key>settings</key><array><dict><key>settings</key><dict><key>foreground</key><string>{color}</string></dict></dict><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>{color}</string></dict></dict></array></dict></plist>")
}
fn source(ticket: &str, op: &str, profile: &str, fingerprint: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":2,"ticket":ticket,"op":op,"instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":"code","generation":1,"source_version":1,"profile":profile,"fingerprint":fingerprint,"hint":{"language":"bash"},"text":"echo 'source'\n"}]})).unwrap()
}

#[tokio::test]
async fn describe_negotiates_actual_profiles_and_limits_without_native_source_work() {
    let temp = Temp::new();
    let limits = Limits::default();
    let pool = ActorPool::with_limits("boot".into(), 2, limits.clone()).unwrap();
    let authority = Authority::new(pool.handle(), "boot".into(), limits, temp.catalogue()).unwrap();
    let route = pool.bind().await.unwrap();
    let value = metadata(&authority, &route, "describe", "d").await;
    assert_eq!(value["ticket"], "d");
    assert_eq!(value["instance"], "boot");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["body"]["kind"], "descriptor");
    assert_eq!(value["body"]["capability"], "syntax-highlight/v2");
    assert_eq!(value["body"]["service"], "syntax");
    assert_eq!(value["body"]["protocol_version"], 2);
    assert_eq!(value["body"]["category_version"], 1);
    assert_eq!(value["body"]["modes"], json!(["one_shot", "growing"]));
    assert_eq!(
        value["body"]["admission"],
        json!(["try_now", "bounded_queue"])
    );
    assert_eq!(value["body"]["runtime"]["data_bytes"], 0);
    assert_eq!(value["body"]["runtime"]["data_jobs"], 0);
    assert_eq!(value["body"]["runtime"]["leases"], 0);
    assert_eq!(value["body"]["runtime"]["control_jobs"], 1);
    assert_eq!(value["body"]["profiles"].as_array().unwrap().len(), 33);
    assert_eq!(
        value["body"]["limits"]["source_bytes"],
        occipital::limits::SOURCE_BYTES
    );
    assert_eq!(value["body"]["limits"]["line_bytes"], 64 << 10);
    assert_eq!(value["body"]["limits"]["data_per_route"], 2);
    assert_eq!(value["body"]["limits"]["control_per_route"], 1);
    assert_eq!(value["body"]["limits"]["workers"], 2);
    assert!(value["body"]["diagnostic"].is_null());
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().control_credits.jobs, 0);
    let pi = value["body"]["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "pi")
        .unwrap();
    assert_eq!(
        pi["fingerprint"],
        Profile::resolve("pi").unwrap().fingerprint
    );
    pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_refresh_publishes_to_workers_and_preserves_last_good_on_failure() {
    let temp = Temp::new();
    let pool = ActorPool::new("boot".into(), 2).unwrap();
    let authority = Authority::new(
        pool.handle(),
        "boot".into(),
        Limits::default(),
        temp.catalogue(),
    )
    .unwrap();
    let first = pool.bind().await.unwrap();
    let peer = pool.bind().await.unwrap();
    fs::write(temp.0.join("themes/local.tmTheme"), theme("#123456")).unwrap();
    let refreshed = metadata(&authority, &first, "themes.refresh", "r").await;
    let profiles = refreshed["body"]["profiles"].as_array().unwrap();
    let custom = profiles
        .iter()
        .find(|p| p["id"].as_str().unwrap().starts_with("custom:"))
        .unwrap();
    let id = custom["id"].as_str().unwrap();
    let fingerprint = custom["fingerprint"].as_str().unwrap();
    let peer_meta = metadata(&authority, &peer, "describe", "peer").await;
    assert_eq!(peer_meta["body"]["profiles"], refreshed["body"]["profiles"]);
    for route in [&first, &peer] {
        let mut ticket = route
            .submit(source("s", "highlight", id, fingerprint))
            .unwrap();
        let reply = ticket.take().await.unwrap();
        let parsed: Value = serde_json::from_slice(reply.bytes()).unwrap();
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["body"]["sources"][0]["fingerprint"], fingerprint);
        assert!(parsed["body"]["sources"][0]["styles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|style| style["rgb"] == json!([18, 52, 86])));
        reply.commit();
    }
    // Compare complete descriptors only after the worker has dropped the prior
    // source requests. Runtime counters are a live snapshot, not catalogue data.
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.bytes, 0);
    fs::write(temp.0.join("config.json"), "{invalid confidential path}").unwrap();
    let failed = metadata(&authority, &first, "themes.refresh", "bad").await;
    assert_eq!(
        failed["body"]["catalogue_revision"],
        refreshed["body"]["catalogue_revision"]
    );
    assert_eq!(failed["body"]["profiles"], refreshed["body"]["profiles"]);
    assert_eq!(failed["body"]["diagnostic"], "invalid theme configuration");
    assert!(!failed.to_string().contains("confidential"));
    assert!(!failed.to_string().contains(temp.0.to_str().unwrap()));
    let peer_meta = metadata(&authority, &peer, "describe", "bad-peer").await;
    assert_eq!(peer_meta["body"], failed["body"]);
    pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn no_change_refresh_keeps_active_checkpoint_and_shutdown_rejects_late_control() {
    let temp = Temp::new();
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let authority = Authority::new(
        pool.handle(),
        "boot".into(),
        Limits::default(),
        temp.catalogue(),
    )
    .unwrap();
    let route = pool.bind().await.unwrap();
    let mut ticket = route
        .submit(source(
            "o",
            "stream.open",
            "pi",
            &Profile::resolve("pi").unwrap().fingerprint,
        ))
        .unwrap();
    ticket.take().await.unwrap().commit();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    let before = metadata(&authority, &route, "describe", "before").await;
    let refreshed = metadata(&authority, &route, "themes.refresh", "same").await;
    assert_eq!(before["body"], refreshed["body"]);
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    let Incoming::Control(late) = route
        .receive(serde_json::to_vec(&json!({"v":2,"ticket":"late","op":"describe"})).unwrap())
        .ok()
        .unwrap()
    else {
        panic!("control");
    };
    authority.retire();
    let reply = authority.control(late).await.unwrap();
    let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
    assert_eq!(value["error"]["code"], "scope_gone");
    reply.commit();
    pool.shutdown().await.unwrap();
    // The authority does not strongly retain the pool's join ownership.
    assert!(!authority.is_alive());
}
