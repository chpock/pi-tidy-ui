//! Source-free CONTROL negotiation remains separate from DATA source and STYLE work.
#[allow(dead_code)]
mod support;

use occipital::{
    actor::{ActorPool, Route},
    control::Authority,
    ingress::Incoming,
    semantic_engine::Limits,
};
use serde_json::{json, Value};

async fn describe(authority: &Authority, route: &Route, ticket: &str) -> Value {
    let Incoming::Control(control) = route
        .receive(serde_json::to_vec(&json!({"v":4,"ticket":ticket,"op":"describe"})).unwrap())
        .unwrap()
    else {
        panic!("describe uses CONTROL")
    };
    let reply = authority.control(control).await.unwrap();
    let value = serde_json::from_slice(reply.bytes()).unwrap();
    reply.commit();
    value
}
fn source(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":4,"ticket":ticket,"op":"stream.open","instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,
        "sources":[{"key":ticket,"generation":1,"source_version":1,"hint":{"language":"bash"},"text":"echo 'source'\n"}]})).unwrap()
}

#[tokio::test]
async fn describe_negotiates_exact_v4_source_and_style_operations_without_data_work() {
    let limits = Limits::default();
    let pool = ActorPool::with_limits("boot".into(), 2, limits.clone()).unwrap();
    let authority = Authority::new(pool.handle(), "boot".into(), limits);
    let route = pool.bind().await.unwrap();
    let baseline = pool.stats().credits.bytes;
    let value = describe(&authority, &route, "d").await;
    assert_eq!(value["ticket"], "d");
    assert_eq!(value["instance"], "boot");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["body"]["kind"], "descriptor");
    assert_eq!(value["body"]["capability"], "syntax-highlight/v4");
    assert_eq!(value["body"]["service"], "syntax");
    assert_eq!(value["body"]["protocol_version"], 4);
    assert_eq!(value["body"]["contexts_revision"], 1);
    assert_eq!(value["body"]["resolver_revision"], 3);
    assert_eq!(value["body"]["source_hint_revision"], 2);
    assert_eq!(value["body"]["modes"], json!(["one_shot", "growing"]));
    assert_eq!(
        value["body"]["admission"],
        json!(["try_now", "bounded_queue"])
    );
    assert_eq!(value["body"]["runtime"]["data_bytes"], baseline);
    assert_eq!(value["body"]["runtime"]["data_jobs"], 0);
    assert_eq!(value["body"]["runtime"]["leases"], 0);
    assert_eq!(value["body"]["runtime"]["control_jobs"], 1);
    assert_eq!(
        value["body"]["operations"],
        json!([
            "describe",
            "highlight",
            "stream.open",
            "stream.append",
            "stream.close",
            "styles.resolve"
        ])
    );
    for field in [
        "profiles",
        "catalogue_revision",
        "palette_revision",
        "diagnostic",
    ] {
        assert!(value["body"].get(field).is_none(), "{field}");
    }
    assert_eq!(
        value["body"]["limits"]["source_bytes"],
        occipital::limits::SOURCE_BYTES
    );
    assert_eq!(value["body"]["limits"]["line_bytes"], 64 << 10);
    assert_eq!(value["body"]["limits"]["data_per_route"], 2);
    assert_eq!(value["body"]["limits"]["control_per_route"], 1);
    assert_eq!(value["body"]["limits"]["workers"], 2);
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().control_credits.jobs, 0);
    assert_eq!(value["assets"], occipital::vocabulary::ASSET_FINGERPRINT);
    pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn describe_is_independent_of_source_leases_old_protocol_and_retired_theme_operations() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let authority = Authority::new(pool.handle(), "boot".into(), Limits::default());
    let route = pool.bind().await.unwrap();
    let mut ticket = route.submit(source("o")).unwrap();
    ticket.take().await.unwrap().commit();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    let before = describe(&authority, &route, "before").await;
    let after = describe(&authority, &route, "after").await;
    assert_eq!(before["body"]["capability"], after["body"]["capability"]);
    assert_eq!(pool.stats().leases, 1);
    assert!(route
        .receive(br#"{"v":3,"ticket":"old","op":"describe"}"#.to_vec())
        .is_err());
    assert!(route
        .receive(br#"{"v":4,"ticket":"refresh","op":"themes.refresh"}"#.to_vec())
        .is_err());

    let Incoming::Control(late) = route
        .receive(br#"{"v":4,"ticket":"late","op":"describe"}"#.to_vec())
        .unwrap()
    else {
        panic!("control")
    };
    authority.retire();
    let reply = authority.control(late).await.unwrap();
    let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
    assert_eq!(value["error"]["code"], "scope_gone");
    reply.commit();
    pool.shutdown().await.unwrap();
    assert!(!authority.is_alive());
}
