//! Resumable style execution. Uses the caller's existing data-job credit.
use crate::{
    credit::Credit,
    native_definitions::PreparedDefinition,
    native_palette,
    protocol::Fault,
    resolver::{self, Cursor, Resolver},
    semantic::{Expression, Palette, StyleKind, Styles, CARD_SLOTS},
    vocabulary::{self, ScopeId},
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, mem::size_of};
use syntect::parsing::Scope;

use crate::limits::STYLE_UNITS;
const RESULT_UNITS: usize = 512;

pub fn native_fingerprint(definition: &str, palette: bool) -> Result<String, Fault> {
    if definition.len() != 64
        || !definition
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Fault::not_started("invalid_rules"));
    }
    let domain = if palette { "palette" } else { "rules" };
    let mut hash = Sha256::new();
    hash.update(format!("occipital-native-{domain}/2\0"));
    hash.update(definition.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

pub struct StyleFailure {
    pub fault: Fault,
    pub credit: Credit,
}
impl std::fmt::Debug for StyleFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StyleFailure")
            .field("fault", &self.fault)
            .finish_non_exhaustive()
    }
}

pub struct StyleWork {
    contexts: Vec<Vec<u32>>,
    position: usize,
    cursor: Cursor,
    path: Vec<Scope>,
    result: Styles,
    interned: HashMap<Expression, u32>,
    decoded_bytes: usize,
    // Drop cursor/payloads before the last native allocation owner.
    _native_definition: Option<PreparedDefinition>,
    credit: Credit,
}
impl StyleWork {
    pub fn native(
        contexts: Vec<Vec<u32>>,
        definition: PreparedDefinition,
        credit: Credit,
    ) -> Result<Self, StyleFailure> {
        definition.start(contexts, credit)
    }
    pub(crate) fn retain_native(mut self, definition: PreparedDefinition) -> Self {
        self._native_definition = Some(definition);
        self
    }
    /// Descriptors and compiled definition are already preflighted and charged.
    /// Their credit must survive this job; the actor can keep a cache-owned
    /// definition charge separately, or include it in the supplied job credit.
    /// A native palette is immutable, source-independent and already derived.
    pub fn new(
        contexts: Vec<Vec<u32>>,
        resolver: &Resolver,
        rules: String,
        native: Option<(&native_palette::Palette, String)>,
        mut credit: Credit,
    ) -> Result<Self, StyleFailure> {
        let prepared = (|| {
            let words = contexts
                .iter()
                .try_fold(0usize, |total, path| total.checked_add(path.len()))
                .ok_or(Fault::not_started("context_limit"))?;
            let policy = contexts
                .len()
                .checked_mul(crate::limits::CONTEXT_ROW_UNITS)
                .and_then(|n| {
                    words
                        .checked_mul(crate::limits::CONTEXT_WORD_UNITS)
                        .and_then(|words| n.checked_add(words))
                })
                .ok_or(Fault::not_started("context_limit"))?;
            if words > crate::limits::CONTEXT_WORDS || policy > crate::limits::DECODED_BYTES {
                return Err(Fault::not_started("context_limit"));
            }
            let depth = contexts.iter().map(Vec::len).max().unwrap_or(0);
            let workspace =
                Cursor::workspace_bytes(depth).map_err(|_| Fault::not_started("context_limit"))?;
            let index_bytes = contexts
                .len()
                .checked_mul(size_of::<u32>())
                .ok_or(Fault::not_started("data_limit"))?;
            let bytes = depth
                .checked_mul(size_of::<Scope>())
                .and_then(|n| n.checked_add(index_bytes))
                .and_then(|n| n.checked_add(workspace))
                .and_then(|n| n.checked_add(RESULT_UNITS))
                .and_then(|n| n.checked_add(credit.bytes()))
                .ok_or(Fault::not_started("data_limit"))?;
            credit.resize(bytes)?;
            let cursor = resolver
                .cursor(depth)
                .map_err(|_| Fault::not_started("context_limit"))?;
            Ok((depth, cursor, Vec::with_capacity(contexts.len())))
        })();
        let (depth, cursor, indices) = match prepared {
            Ok(prepared) => prepared,
            Err(fault) => return Err(StyleFailure { fault, credit }),
        };
        let mut work = Self {
            decoded_bytes: contexts.len() * 4,
            contexts,
            position: 0,
            cursor,
            path: Vec::with_capacity(depth),
            result: Styles {
                kind: StyleKind::Styles,
                vocabulary: vocabulary::FINGERPRINT.to_owned(),
                rules,
                styles: Vec::new(),
                indices,
                palette: None,
            },
            interned: HashMap::new(),
            _native_definition: None,
            credit,
        };
        if let Some((palette, fingerprint)) = native {
            if let Err(fault) = work.install_palette(palette, fingerprint) {
                return Err(work.fail(fault));
            }
        }
        work.credit.started();
        Ok(work)
    }
    fn install_palette(
        &mut self,
        palette: &native_palette::Palette,
        fingerprint: String,
    ) -> Result<(), Fault> {
        self.charge_result(crate::limits::CONTEXT_ROW_UNITS + 5 * CARD_SLOTS)?;
        self.grow(128 + 5 * CARD_SLOTS)?;
        let mut slots = [0; CARD_SLOTS];
        for (id, expression) in slots.iter_mut().zip(&palette.slots) {
            *id = self.intern(expression)?;
        }
        self.result.palette = Some(Palette {
            revision: 1,
            fingerprint,
            slots,
            origins: palette.origins,
        });
        Ok(())
    }
    fn charge_result(&mut self, additional: usize) -> Result<(), Fault> {
        let total = self
            .decoded_bytes
            .checked_add(additional)
            .filter(|&n| n <= crate::limits::DECODED_BYTES)
            .ok_or(Fault::started("style_limit"))?;
        self.decoded_bytes = total;
        Ok(())
    }
    fn grow(&mut self, additional: usize) -> Result<(), Fault> {
        let total = self
            .credit
            .bytes()
            .checked_add(additional)
            .ok_or(Fault::started("data_limit"))?;
        self.credit
            .resize(total)
            .map_err(|_| Fault::started("data_limit"))
    }
    fn intern(&mut self, value: &Expression) -> Result<u32, Fault> {
        if let Some(&id) = self.interned.get(value) {
            return Ok(id);
        }
        let id = self
            .result
            .styles
            .len()
            .checked_add(1)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(Fault::started("style_limit"))?;
        self.charge_result(STYLE_UNITS)?;
        self.grow(STYLE_UNITS)?;
        // One allowance covers the expression vector and its deduplication key.
        self.result.styles.reserve(1);
        self.interned.reserve(1);
        self.result.styles.push(value.clone());
        self.interned.insert(value.clone(), id);
        Ok(id)
    }
    /// One context is one existing scheduler-yield boundary. No source mutation
    /// or parser/lease authority is involved, even when this computation fails.
    pub fn step(&mut self) -> Result<bool, Fault> {
        let Some(context) = self.contexts.get(self.position) else {
            return Ok(true);
        };
        self.path.clear();
        self.path.extend(context.iter().map(|&id| {
            ScopeId::from_raw(id)
                .expect("preflighted context ID")
                .scope()
        }));
        let expression = self
            .cursor
            .resolve(&self.path)
            .map_err(|_| Fault::started("context_limit"))?
            .expression;
        let id = self.intern(&expression)?;
        self.result.indices.push(id);
        self.position += 1;
        Ok(self.position == self.contexts.len())
    }
    pub fn counters(&self) -> resolver::Counters {
        self.cursor.counters()
    }
    /// The returned credit is still required by bounded encoding and transport
    /// settlement. Publishing/dropping just the body must not free it early.
    pub fn finish(self) -> Result<(Styles, Credit), StyleFailure> {
        if self.position != self.contexts.len() {
            return Err(self.fail(Fault::started("style_pending")));
        }
        Ok((self.result, self.credit))
    }
    pub fn fail(self, fault: Fault) -> StyleFailure {
        StyleFailure {
            fault,
            credit: self.credit,
        }
    }
    /// Destroy partial payloads without releasing the physical slot. The actor
    /// settles this credit with an error delivery or authoritative cancellation.
    pub fn into_credit(self) -> Credit {
        self.credit
    }
}

#[cfg(test)]
mod volume_tests {
    use super::*;
    use crate::{credit::Budget, semantic::Ink};

    #[test]
    fn result_charge_stops_style_interning_before_owned_growth_and_preserves_slot() {
        let budget = Budget::new(crate::limits::DATA_BYTES, 1, 1);
        let default = Expression {
            foreground: Ink::Inherit {},
            background: Ink::Inherit {},
            attributes: 0,
            attribute_mask: 0,
        };
        let resolver = Resolver::compile(default.clone(), vec![]);
        let mut work = StyleWork::new(
            vec![],
            &resolver,
            "a".repeat(64),
            None,
            budget.reserve(Some("r"), 0).unwrap(),
        )
        .unwrap();
        // Exercise the real producer at the final policy-unit boundary without
        // allocating thousands of unrelated selector definitions.
        work.decoded_bytes = crate::limits::DECODED_BYTES - STYLE_UNITS;
        work.intern(&default).unwrap();
        let before = budget.snapshot().bytes;
        let different = Expression {
            foreground: Ink::TerminalDefault {},
            ..default.clone()
        };
        assert_eq!(
            work.intern(&different).unwrap_err(),
            Fault::started("style_limit")
        );
        assert_eq!(budget.snapshot().bytes, before);
        assert_eq!(work.result.styles, vec![default]);
        let failure = work.fail(Fault::started("style_limit"));
        assert_eq!(budget.snapshot().jobs, 1);
        drop(failure);
        assert_eq!(budget.snapshot().jobs, 0);
        assert_eq!(budget.snapshot().bytes, 0);
    }
}
