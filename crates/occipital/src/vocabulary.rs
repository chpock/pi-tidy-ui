//! Finite shipped-grammar vocabulary. Unknown caller input is rejected without interning.
//! ASSET_FINGERPRINT identifies the full pinned grammar revision; FINGERPRINT also
//! frames the vocabulary schema and sorted names. Neither is a process atom ID.
use std::num::NonZeroU32;
use std::sync::OnceLock;
use syntect::parsing::Scope;

include!(concat!(env!("OUT_DIR"), "/vocabulary.rs"));

static SCOPES: OnceLock<Box<[Scope]>> = OnceLock::new();
static REVERSE: OnceLock<Box<[(Scope, ScopeId)]>> = OnceLock::new();

/// Sorted UTF-8 names, including every finite dotted prefix. ID = index + 1.
pub fn names() -> &'static [&'static str] {
    NAMES
}

/// A validated portable ID. Zero is reserved and cannot construct a ScopeId.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ScopeId(NonZeroU32);

impl ScopeId {
    pub fn from_raw(raw: u32) -> Option<Self> {
        NonZeroU32::new(raw)
            .filter(|id| id.get() as usize <= SCOPE_COUNT)
            .map(Self)
    }

    /// Lookup only; this never initializes the process-local scope repository.
    pub fn from_name(name: &str) -> Option<Self> {
        NAMES
            .binary_search(&name)
            .ok()
            .map(|index| Self(NonZeroU32::new(index as u32 + 1).unwrap()))
    }

    /// Parser-only reverse lookup. Equal native handles (for example trailing-dot
    /// aliases) use the smallest portable ID, hence the first sorted asset name.
    /// Initialization interns only the finite generated table; from_name stays lookup-only.
    pub fn from_scope(scope: Scope) -> Option<Self> {
        let reverse = REVERSE.get_or_init(|| {
            let mut entries: Vec<_> = (1..=SCOPE_COUNT as u32)
                .map(|raw| {
                    let id = Self::from_raw(raw).unwrap();
                    (id.scope(), id)
                })
                .collect();
            entries.sort_unstable();
            entries.dedup_by_key(|entry| entry.0);
            entries.into_boxed_slice()
        });
        reverse
            .binary_search_by_key(&scope, |entry| entry.0)
            .ok()
            .map(|index| reverse[index].1)
    }

    pub fn get(self) -> u32 {
        self.0.get()
    }

    pub fn name(self) -> &'static str {
        NAMES[self.get() as usize - 1]
    }

    /// Intern the finite generated table once, never a caller-supplied string.
    /// Native atom numbers are process-local and must not be used as wire IDs.
    pub fn scope(self) -> Scope {
        SCOPES.get_or_init(|| {
            NAMES
                .iter()
                .map(|name| Scope::new(name).expect("invalid build-generated scope"))
                .collect()
        })[self.get() as usize - 1]
    }
}
