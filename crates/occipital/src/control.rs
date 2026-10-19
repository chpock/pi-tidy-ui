//! Process-lifetime catalogue publication and bounded source-free negotiation.
//! Source work remains on the fixed worker actors; only explicit refresh reads files.
use crate::{
    actor::PoolHandle,
    catalogue::{Catalogue, Diagnostic, Snapshot},
    ingress::{Control, ControlDelivery},
    protocol::Fault,
    runtime_request::Operation,
    semantic_description,
    semantic_engine::Limits,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

struct Published {
    snapshot: Arc<Snapshot>,
    diagnostic: Option<Diagnostic>,
}
pub struct Authority {
    pool: PoolHandle,
    instance: String,
    limits: Limits,
    alive: AtomicBool,
    published: Mutex<Published>,
    catalogue: Arc<Mutex<Catalogue>>,
    refresh: tokio::sync::Mutex<()>,
}
impl Authority {
    pub fn new(
        pool: PoolHandle,
        instance: String,
        limits: Limits,
        catalogue: Catalogue,
    ) -> Result<Self, Fault> {
        let snapshot = catalogue.snapshot();
        pool.publish_snapshot(snapshot.clone())?;
        let diagnostic = catalogue.diagnostic();
        Ok(Self {
            pool,
            instance,
            limits,
            alive: AtomicBool::new(true),
            published: Mutex::new(Published {
                snapshot,
                diagnostic,
            }),
            catalogue: Arc::new(Mutex::new(catalogue)),
            refresh: tokio::sync::Mutex::new(()),
        })
    }
    pub fn instance(&self) -> &str {
        &self.instance
    }
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && self.pool.stats().is_ok()
    }
    pub fn retire(&self) {
        self.alive.store(false, Ordering::Release);
    }

    pub async fn control(&self, control: Box<Control>) -> Result<ControlDelivery, Fault> {
        if !self.is_alive() {
            return control.error(&self.instance, Fault::not_started("scope_gone"));
        }
        if control.request().op == Operation::ThemesRefresh {
            // Admission already bounds this queue to eight held route controls.
            let _serial = self.refresh.lock().await;
            if !self.is_alive() {
                return control.error(&self.instance, Fault::not_started("scope_gone"));
            }
            let catalogue = Arc::clone(&self.catalogue);
            let candidate = tokio::task::spawn_blocking(move || {
                let mut catalogue = catalogue.lock().expect("catalogue poisoned");
                let _ = catalogue.refresh();
                (catalogue.snapshot(), catalogue.diagnostic())
            })
            .await;
            if !self.is_alive() {
                return control.error(&self.instance, Fault::not_started("scope_gone"));
            }
            let (snapshot, diagnostic) = match candidate {
                Ok(value) => value,
                Err(_) => {
                    return control.error(&self.instance, Fault::not_started("control_failed"))
                }
            };
            let mut published = self.published.lock().expect("publication poisoned");
            if snapshot.revision() != published.snapshot.revision() {
                self.pool.publish_snapshot(snapshot.clone())?;
            }
            *published = Published {
                snapshot,
                diagnostic,
            };
        } else if control.request().op != Operation::Describe {
            return control.error(&self.instance, Fault::not_started("invalid_request"));
        }
        let stats = self.pool.stats()?;
        let published = self.published.lock().expect("publication poisoned");
        control.reply(
            &self.instance,
            semantic_description::describe(
                &published.snapshot,
                published.diagnostic,
                &self.limits,
                stats,
            ),
        )
    }
}
