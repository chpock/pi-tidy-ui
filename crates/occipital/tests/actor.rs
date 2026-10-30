//! Actual fixed owning-worker threads; no test parser or transport emulation.
use occipital::actor::ActorPool;
use serde_json::{json, Value};
fn open(ticket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"v":4,"ticket":ticket,"op":"stream.open","instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":"same","generation":1,"source_version":1,"hint":{"language":"bash"},"text":"echo one"}]})).unwrap()
}
#[tokio::test]
async fn eight_routes_share_fixed_workers_with_independent_colliding_keys() {
    let pool = ActorPool::new("boot".into(), 2).unwrap();
    let mut routes = Vec::new();
    for _ in 0..8 {
        routes.push(pool.bind().await.unwrap());
    }
    assert_eq!(pool.bind().await.err().unwrap().code, "route_limit");
    let mut leases = std::collections::HashSet::new();
    for (index, route) in routes.iter().enumerate() {
        let mut ticket = route.submit(open(&format!("t{index}"))).unwrap();
        let reply = ticket.take().await.unwrap();
        let value: Value = serde_json::from_slice(reply.bytes()).unwrap();
        assert_eq!(value["status"], "ok");
        assert_eq!(value["body"]["sources"][0]["revision"], 1);
        assert_eq!(value["body"]["sources"][0]["counters"]["tail_calls"], 1);
        assert!(leases.insert(
            value["body"]["sources"][0]["lease"]
                .as_str()
                .unwrap()
                .to_string()
        ));
        reply.commit();
    }
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 8);
    assert_eq!(pool.stats().credits.jobs, 0);
    assert_eq!(pool.stats().workers, 2);
    drop(routes.pop());
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 7);
    drop(routes);
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().credits.bytes, 0);
    pool.shutdown().await.unwrap();
}
#[tokio::test]
async fn worker_expiry_runs_without_new_requests_or_an_idle_poll() {
    let pool = ActorPool::with_limits(
        "boot".into(),
        1,
        occipital::semantic_engine::Limits {
            // This test exercises the nearest-expiry receive, not a sub-cold-parse
            // TTL. A 10ms lease can validly expire before the first acknowledgement.
            idle_ms: 500,
            ..Default::default()
        },
    )
    .unwrap();
    let route = pool.bind().await.unwrap();
    let mut ticket = route.submit(open("t")).unwrap();
    ticket.take().await.unwrap().commit();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    // Expiry and publication run on a separate worker; passive reads do not wake it.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while pool.stats().leases != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("idle worker must publish lease expiry without another request");
    assert_eq!(pool.stats().leases, 0);
    drop(route);
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().credits.bytes, 0);
    pool.shutdown().await.unwrap();
}
#[tokio::test]
async fn dropping_ready_and_pending_work_wakes_cleanup_and_shutdown_settles() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let mut ticket = route.submit(open("t")).unwrap();
    let reply = ticket.take().await.unwrap();
    drop(reply);
    drop(ticket);
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 0);
    assert_eq!(pool.stats().credits.jobs, 0);
    let mut value: Value = serde_json::from_slice(&open("large")).unwrap();
    value["sources"][0]["text"] = json!("echo x\n".repeat(5000));
    let pending = route.submit(serde_json::to_vec(&value).unwrap()).unwrap();
    drop(pending);
    drop(route);
    pool.shutdown().await.unwrap();
}
#[tokio::test]
async fn shutdown_invalidates_retained_route_facades_and_late_handoff() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let mut ticket = route.submit(open("t")).unwrap();
    let ready = ticket.take().await.unwrap();
    pool.shutdown().await.unwrap();
    assert_eq!(route.submit(open("late")).err().unwrap().code, "scope_gone");
    drop(ready);
    drop(ticket);
}

#[tokio::test]
async fn await_helper_drops_consumed_ticket_without_cancelling_returned_delivery() {
    async fn delivery(route: &occipital::actor::Route) -> occipital::scheduler::Delivery {
        let mut ticket = route.submit(open("local-ticket")).unwrap();
        ticket.take().await.unwrap()
    }
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let route = pool.bind().await.unwrap();
    let ready = delivery(&route).await;
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    ready.commit();
    pool.barrier().await.unwrap();
    assert_eq!(pool.stats().leases, 1);
    assert_eq!(pool.stats().credits.jobs, 0);
    drop(route);
    pool.shutdown().await.unwrap();
}

#[tokio::test]
async fn retained_transport_handles_do_not_keep_the_worker_owner_alive() {
    let pool = ActorPool::new("boot".into(), 1).unwrap();
    let handle = pool.handle();
    let route = handle.bind().await.unwrap();
    assert_eq!(handle.stats().unwrap().routes, 1);
    pool.shutdown().await.unwrap();
    assert_eq!(handle.bind().await.err().unwrap().code, "scope_gone");
    assert_eq!(handle.stats().err().unwrap().code, "scope_gone");
    drop(route);
}
