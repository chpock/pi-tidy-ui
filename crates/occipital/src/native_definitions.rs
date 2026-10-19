//! Selected native definitions only. No source/parser state or client-rule registry.
use crate::{
    catalogue::Snapshot,
    credit::{Budget, Credit},
    native_palette::{HintPaths, NativeTheme, Palette},
    profile::Profile,
    protocol::Fault,
    style_rules::{fingerprint_native_palette, fingerprint_native_rules},
    style_work::{StyleFailure, StyleWork},
    vocabulary::ScopeId,
};
use std::{mem::size_of, sync::Arc};

struct Definition {
    id: Box<str>,
    fingerprint: Box<str>,
    rules: Box<str>,
    palette_fingerprint: Box<str>,
    native: NativeTheme,
    // Declared last: destroy compiled payload before releasing its allowance.
    credit: Credit,
}
/// The only outward native handle; never exposes a detachable resolver/cursor.
#[derive(Clone)]
pub struct PreparedDefinition(Arc<Definition>);
impl PreparedDefinition {
    pub fn id(&self) -> &str {
        &self.0.id
    }
    pub fn fingerprint(&self) -> &str {
        &self.0.fingerprint
    }
    pub fn palette(&self) -> &Palette {
        &self.0.native.palette
    }
    pub fn bytes(&self) -> usize {
        self.0.credit.bytes()
    }
    pub(crate) fn start(
        self,
        contexts: Vec<Vec<u32>>,
        mut credit: Credit,
    ) -> Result<StyleWork, StyleFailure> {
        let Some(bytes) = credit
            .bytes()
            .checked_add(self.0.rules.len())
            .and_then(|n| n.checked_add(self.0.palette_fingerprint.len()))
        else {
            return Err(StyleFailure {
                fault: Fault::not_started("data_limit"),
                credit,
            });
        };
        if let Err(fault) = credit.resize(bytes) {
            return Err(StyleFailure { fault, credit });
        }
        let work = StyleWork::new(
            contexts,
            &self.0.native.resolver,
            self.0.rules.as_ref().to_owned(),
            Some((
                &self.0.native.palette,
                self.0.palette_fingerprint.as_ref().to_owned(),
            )),
            credit,
        )?;
        Ok(work.retain_native(self))
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Preparation {
    pub definition_bytes: usize,
    pub scratch_bytes: usize,
    pub cache_growth_bytes: usize,
    pub additional_bytes: usize,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Counters {
    pub compilations: usize,
    pub palette_derivations: usize,
    pub hits: usize,
    pub entries: usize,
    pub metadata_bytes: usize,
    pub cached_definition_bytes: usize,
}
pub struct NativeDefinitions {
    snapshot: Arc<Snapshot>,
    entries: Vec<PreparedDefinition>,
    budget: Budget,
    counters: Counters,
    metadata: Credit,
}
impl NativeDefinitions {
    pub fn new(snapshot: Arc<Snapshot>, budget: Budget) -> Result<Self, Fault> {
        let metadata = budget.reserve(None, size_of::<Self>())?;
        Ok(Self {
            snapshot,
            entries: Vec::new(),
            budget,
            counters: Counters::default(),
            metadata,
        })
    }
    /// Metadata-only publication. Live work owns obsolete entries independently.
    pub fn publish(&mut self, snapshot: Arc<Snapshot>) {
        self.entries.retain(|entry| {
            snapshot
                .descriptors()
                .any(|d| d.id == entry.id() && d.fingerprint == entry.fingerprint())
        });
        self.snapshot = snapshot;
        // Vec capacity intentionally survives pruning and remains fully charged.
    }
    pub fn counters(&self) -> Counters {
        Counters {
            entries: self.entries.len(),
            metadata_bytes: self.metadata.bytes(),
            cached_definition_bytes: self.entries.iter().map(PreparedDefinition::bytes).sum(),
            ..self.counters
        }
    }
    fn profile(&self, id: &str, fingerprint: &str) -> Result<Arc<Profile>, Fault> {
        let descriptor = self
            .snapshot
            .descriptors()
            .find(|d| d.id == id)
            .ok_or(Fault::not_started("profile_unavailable"))?;
        if descriptor.fingerprint != fingerprint {
            return Err(Fault::not_started("profile_changed"));
        }
        let profile = self
            .snapshot
            .profile(id)
            .ok_or(Fault::not_started("profile_unavailable"))?;
        profile
            .native_theme()
            .ok_or(Fault::not_started("profile_unavailable"))?;
        Ok(profile)
    }
    fn cached(&self, id: &str, fingerprint: &str) -> Option<&PreparedDefinition> {
        self.entries
            .iter()
            .find(|entry| entry.id() == id && entry.fingerprint() == fingerprint)
    }
    pub fn preparation(&self, id: &str, fingerprint: &str) -> Result<Preparation, Fault> {
        let profile = self.profile(id, fingerprint)?;
        if self.cached(id, fingerprint).is_some() {
            return Ok(Preparation::default());
        }
        self.measure(&profile, id, fingerprint)
    }
    fn measure(
        &self,
        profile: &Profile,
        id: &str,
        fingerprint: &str,
    ) -> Result<Preparation, Fault> {
        let fault = || Fault::not_started("data_limit");
        let allocation =
            NativeTheme::allocation(profile.native_theme().expect("native profile"), 2)
                .map_err(|_| fault())?;
        let definition_bytes = (size_of::<Definition>() + 2 * size_of::<usize>())
            .checked_add(id.len())
            .and_then(|n| n.checked_add(fingerprint.len()))
            .and_then(|n| n.checked_add(2 * 64))
            .and_then(|n| n.checked_add(allocation.definition_bytes))
            .ok_or_else(fault)?;
        // Two fixed-length SHA-256 hex outputs; include formatting/compaction overlap.
        let scratch_bytes = allocation
            .scratch_bytes
            .checked_add(4 * 64)
            .ok_or_else(fault)?;
        let cache_growth_bytes = if self.entries.len() == self.entries.capacity() {
            self.entries
                .len()
                .checked_add(1)
                .and_then(|n| n.checked_mul(size_of::<PreparedDefinition>()))
                .ok_or_else(fault)?
        } else {
            0
        };
        size_of::<Self>()
            .checked_add(cache_growth_bytes)
            .ok_or_else(fault)?;
        let additional_bytes = definition_bytes
            .checked_add(scratch_bytes)
            .and_then(|n| n.checked_add(cache_growth_bytes))
            .ok_or_else(fault)?;
        Ok(Preparation {
            definition_bytes,
            scratch_bytes,
            cache_growth_bytes,
            additional_bytes,
        })
    }
    /// Borrow a real admitted data-job credit. Neither failure nor state ownership
    /// consumes/releases its route slot. All controlled growth is prepaid together.
    pub fn prepare(
        &mut self,
        id: &str,
        fingerprint: &str,
        credit: &mut Credit,
    ) -> Result<PreparedDefinition, Fault> {
        credit.transfer_to(&mut self.metadata, 0)?; // Same global budget, no job transfer.
        let profile = self.profile(id, fingerprint)?;
        if let Some(entry) = self.cached(id, fingerprint) {
            let owner = entry.clone();
            self.counters.hits += 1;
            return Ok(owner);
        }
        let plan = self.measure(&profile, id, fingerprint)?;
        let original = credit.bytes();
        credit.resize(
            original
                .checked_add(plan.additional_bytes)
                .ok_or(Fault::not_started("data_limit"))?,
        )?;
        let mut ownership = self.budget.reserve(None, 0)?;
        credit.transfer_to(&mut ownership, plan.definition_bytes)?;
        let prepared = (|| {
            // These finite process-global handles are the pre-existing asset authority,
            // not derived-cache payload. No caller text reaches the scope interner.
            let scope = |name| {
                ScopeId::from_name(name)
                    .expect("shipped hint scope")
                    .scope()
            };
            let comment = [scope("comment")];
            let invalid = [scope("invalid")];
            let changed = [scope("source.diff"), scope("markup.changed.diff")];
            let inserted = [scope("source.diff"), scope("markup.inserted.diff")];
            let deleted = [scope("source.diff"), scope("markup.deleted.diff")];
            let native = NativeTheme::compile(
                profile.native_theme().expect("native profile"),
                HintPaths {
                    comment: &comment,
                    invalid: &invalid,
                    changed: &changed,
                    inserted: &inserted,
                    deleted: &deleted,
                },
            )
            .map_err(|_| Fault::not_started("data_limit"))?;
            let rules = fingerprint_native_rules(fingerprint)
                .map_err(|e| e.fault())?
                .into_boxed_str();
            let palette_fingerprint = fingerprint_native_palette(fingerprint)
                .map_err(|e| e.fault())?
                .into_boxed_str();
            Ok(PreparedDefinition(Arc::new(Definition {
                id: id.into(),
                fingerprint: fingerprint.into(),
                rules,
                palette_fingerprint,
                native,
                credit: ownership,
            })))
        })();
        let owner = match prepared {
            Ok(owner) => owner,
            Err(fault) => {
                credit.resize(original).expect("shrinking job allowance");
                return Err(fault);
            }
        };
        if plan.cache_growth_bytes != 0 {
            let mut entries = Vec::with_capacity(self.entries.len() + 1);
            entries.append(&mut self.entries);
            let old = std::mem::replace(&mut self.entries, entries);
            // Old and new buffers coexist under separate prepaid allowances.
            credit
                .transfer_to(&mut self.metadata, plan.cache_growth_bytes)
                .expect("same budget");
            drop(old);
            self.metadata
                .resize(
                    size_of::<Self>()
                        .checked_add(plan.cache_growth_bytes)
                        .expect("preflighted metadata"),
                )
                .expect("shrinking metadata allowance");
        }
        self.entries.push(owner.clone());
        credit
            .resize(original)
            .expect("release preparation scratch only");
        self.counters.compilations += 1;
        self.counters.palette_derivations += 1;
        Ok(owner)
    }
}
