//! Public Subconscious internal-service frontend, no router/bootstrap/private sender.
use crate::{
    actor::{PoolHandle, Route},
    control::Authority,
    ingress::{self, Incoming},
    protocol::{Fault, SERVICE},
    semantic::CAPABILITY,
    semantic_reply,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::SystemTime,
};
use subc_client_rs::{
    async_trait, BindDecision, ConnectionEnd, HandlerOutcome, ModuleHandler, RequestCtx,
    RouteBindRequest, RouteCloseReason, RouteHandle,
};
use subc_protocol::{
    manifest::{CapabilityDeclarations, InternalTransport, ModuleManifest, ProviderRole},
    RouteTarget,
};

struct Handler {
    pool: PoolHandle,
    authority: Arc<Authority>,
    routes: Arc<Mutex<HashMap<RouteHandle, Route>>>,
}
impl Handler {
    fn close_all(&self) {
        self.authority.retire();
        let routes = std::mem::take(&mut *self.routes.lock().expect("module routes poisoned"));
        for route in routes.into_values() {
            route.close();
        }
    }
    fn fault(&self, ticket: Option<&str>, fault: Fault) -> HandlerOutcome {
        match ticket {
            Some(ticket) => {
                match semantic_reply::error::<()>(ticket, self.authority.instance(), fault).encode()
                {
                    Ok(bytes) => HandlerOutcome::Response(bytes),
                    Err(_) => HandlerOutcome::Error {
                        code: "reply_limit".into(),
                        message: "highlight response unavailable".into(),
                    },
                }
            }
            None => HandlerOutcome::Error {
                code: fault.code.into(),
                message: "highlight request rejected".into(),
            },
        }
    }
}
#[async_trait]
impl ModuleHandler for Handler {
    async fn on_bind(&self, request: &RouteBindRequest) -> BindDecision {
        if !matches!(&request.target, RouteTarget::InternalService { service_id, .. } if service_id == SERVICE)
            || !self.authority.is_alive()
        {
            return BindDecision::reject("scope_gone", "highlight service unavailable");
        }
        let route = match self.pool.bind().await {
            Ok(route) => route,
            Err(fault) => return BindDecision::reject(fault.code, "highlight route unavailable"),
        };
        let mut routes = self.routes.lock().expect("module routes poisoned");
        if !self.authority.is_alive() || routes.contains_key(&request.handle) {
            route.close();
            return BindDecision::reject("scope_gone", "highlight route unavailable");
        }
        routes.insert(request.handle, route);
        BindDecision::accept()
    }
    async fn on_route_gone(&self, handle: &RouteHandle) {
        if let Some(route) = self
            .routes
            .lock()
            .expect("module routes poisoned")
            .remove(handle)
        {
            route.close();
        }
    }
    async fn on_draining(&self, _reason: RouteCloseReason, _deadline: SystemTime) {
        self.close_all();
    }
    async fn on_connection_end(&self, _end: ConnectionEnd) {
        self.close_all();
    }
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let correlation = ingress::routing_ticket(&body);
        if !self.authority.is_alive() {
            return self.fault(correlation.as_deref(), Fault::not_started("scope_gone"));
        }
        let route = self
            .routes
            .lock()
            .expect("module routes poisoned")
            .get(&ctx.route_handle())
            .cloned();
        let Some(route) = route else {
            return self.fault(correlation.as_deref(), Fault::not_started("scope_gone"));
        };
        if ctx.cancellation_token().is_cancelled() {
            return self.fault(correlation.as_deref(), Fault::not_started("cancelled"));
        }
        match route.receive(body) {
            Ok(Incoming::Control(control)) => match self.authority.control(control).await {
                // The actual SDK owning enum exists before the native guard drops.
                // SDK ingress/egress retention is a separate measured transport allowance.
                Ok(reply) => reply.handoff(HandlerOutcome::Response),
                Err(fault) => self.fault(correlation.as_deref(), fault),
            },
            Ok(Incoming::Data(mut ticket)) => {
                let mut cancelled = false;
                let reply = loop {
                    tokio::select! {
                        biased;
                        _ = ctx.cancelled(), if !cancelled => { ticket.cancel(); cancelled = true; },
                        reply = ticket.take() => break reply,
                    }
                };
                match reply {
                    Ok(reply) => {
                        if ctx.cancellation_token().is_cancelled() {
                            ticket.cancel();
                        }
                        reply.handoff(HandlerOutcome::Response)
                    }
                    Err(fault) => self.fault(correlation.as_deref(), fault),
                }
            }
            Err(rejection) => self.fault(rejection.ticket.as_deref(), rejection.fault),
        }
    }
}
pub async fn run(authority: Arc<Authority>, pool: PoolHandle) -> Result<(), Fault> {
    // SDK verifies the user supervisor's launch contract using its cached reader.
    // The executable reads that descriptor before spawning its runtime/actors.
    // Never locate/start a supervisor here.
    let handler = Handler {
        pool,
        authority,
        routes: Arc::new(Mutex::new(HashMap::new())),
    };
    let routes = Arc::clone(&handler.routes);
    let authority = Arc::clone(&handler.authority);
    let manifest = ModuleManifest::builder("occipital", env!("CARGO_PKG_VERSION"))
        .capabilities(Some(CapabilityDeclarations {
            provides: vec![CAPABILITY.into()],
            requires: vec![],
            must_never_reach: vec![],
        }))
        .provides(vec![ProviderRole::InternalService {
            service_id: SERVICE.into(),
            transport: InternalTransport::Bulk,
            agent_facing: false,
            operations: vec![
                "describe".into(),
                "themes.refresh".into(),
                "highlight".into(),
                "stream.open".into(),
                "stream.append".into(),
                "stream.close".into(),
                "styles.resolve".into(),
            ],
        }])
        .build();
    let result = subc_client_rs::serve(manifest, handler).await;
    // SDK error exits need not invoke on_connection_end. Retire and close every
    // route even while retained handler callbacks still own their weak facades.
    authority.retire();
    for route in std::mem::take(&mut *routes.lock().expect("module routes poisoned")).into_values()
    {
        route.close();
    }
    result.map_err(|_| Fault::not_started("shared_transport"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{actor::ActorPool, catalogue::Catalogue, semantic_engine::Limits};
    use serde_json::json;

    fn source(ticket: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"v":3,"ticket":ticket,"op":"stream.open","instance":"boot","admission":"bounded_queue","queue_wait_ms":1000,"sources":[{"key":ticket,"generation":1,"source_version":1,"hint":{"language":"bash"},"text":"echo 'local fixture'"}]})).unwrap()
    }

    #[tokio::test]
    async fn draining_releases_scopes_before_connection_end_without_releasing_held_bytes() {
        let pool = ActorPool::new("boot".into(), 1).unwrap();
        let authority = Authority::new(
            pool.handle(),
            "boot".into(),
            Limits::default(),
            Catalogue::from_os_root(None),
        )
        .unwrap();
        let route = pool.bind().await.unwrap();
        let routes = Arc::new(Mutex::new(HashMap::from([(
            RouteHandle::detached(1, 1),
            route.clone(),
        )])));
        let handler = Handler {
            pool: pool.handle(),
            authority: Arc::new(authority),
            routes,
        };
        let Incoming::Data(mut acknowledged) = route.receive(source("acknowledged")).unwrap()
        else {
            panic!("data")
        };
        acknowledged.take().await.unwrap().flushed();
        pool.barrier().await.unwrap();
        assert_eq!(pool.stats().leases, 1);
        let Incoming::Data(mut pending) = route.receive(source("pending")).unwrap() else {
            panic!("data")
        };
        let held = pending.take().await.unwrap();
        assert_eq!(pool.stats().credits.jobs, 1);

        // Invoke the actual SDK lifecycle hook, without Goodbye, connection-end,
        // losing handler clones or assuming that a response has been transferred.
        handler
            .on_draining(RouteCloseReason::Restart, SystemTime::now())
            .await;
        assert!(!handler.authority.is_alive());
        assert!(handler.routes.lock().unwrap().is_empty());
        let rejected = route.receive(source("after-drain")).err().unwrap();
        assert_eq!(rejected.fault.code, "scope_gone");
        pool.barrier().await.unwrap();
        assert_eq!(pool.stats().routes, 0);
        assert_eq!(pool.stats().leases, 0);
        assert_eq!(pool.stats().credits.jobs, 1);
        assert!(pool.stats().credits.bytes > 0);
        drop(held);
        drop(pending);
        handler
            .on_draining(RouteCloseReason::Restart, SystemTime::now())
            .await;
        pool.barrier().await.unwrap();
        assert_eq!(pool.stats().credits.jobs, 0);
        assert_eq!(pool.stats().credits.bytes, 0);
        pool.shutdown().await.unwrap();
    }
}
