//! Immutable admitted native theme definitions.
use crate::protocol::Fault;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use syntect::highlighting::Theme;
use two_face::theme::{EmbeddedLazyThemeSet, LazyThemeSet};

#[derive(Clone)]
pub struct Profile {
    pub name: String,
    pub fingerprint: String,
    pub theme: Option<Arc<Theme>>,
}
// Keep bundled definition fingerprints stable across the internal v2 removal.
pub(crate) const ASSETS: &str =
    "syntect/5.3.0:two-face/0.5.2+bat-0.26.1:roles/v1:line-prefix/65536/v1";
static THEMES: OnceLock<LazyThemeSet> = OnceLock::new();
static PROFILES: OnceLock<Mutex<HashMap<String, Arc<Profile>>>> = OnceLock::new();

impl Profile {
    /// Native definition view.
    pub fn native_theme(&self) -> Option<&Theme> {
        self.theme.as_deref()
    }
    pub fn resolve(name: &str) -> Result<Arc<Self>, Fault> {
        if name.len() > 128 || name.chars().any(char::is_control) {
            return Err(Fault::not_started("profile_unavailable"));
        }
        let cache = PROFILES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache
            .lock()
            .map_err(|_| Fault::not_started("profile_unavailable"))?;
        if let Some(profile) = cache.get(name) {
            return Ok(profile.clone());
        }
        let theme = {
            let native = name
                .strip_prefix("syntect:")
                .ok_or(Fault::not_started("profile_unavailable"))?;
            let themes = THEMES.get_or_init(|| two_face::theme::extra().into());
            let theme = themes
                .get(native)
                .ok_or(Fault::not_started("profile_unavailable"))?;
            validate_theme(theme)?;
            Arc::new(theme.clone())
        };
        let profile = Arc::new(Self {
            name: name.into(),
            fingerprint: format!(
                "{:x}",
                Sha256::digest(format!("{ASSETS}:{name}").as_bytes())
            ),
            theme: Some(theme),
        });
        cache.insert(name.into(), profile.clone());
        Ok(profile)
    }
    pub fn native(
        name: String,
        fingerprint: String,
        theme: Arc<Theme>,
    ) -> Result<Arc<Self>, Fault> {
        validate_theme(&theme)?;
        Ok(Arc::new(Self {
            name,
            fingerprint,
            theme: Some(theme),
        }))
    }
    pub fn bundled_names() -> Vec<String> {
        EmbeddedLazyThemeSet::theme_names()
            .iter()
            .map(|name| format!("syntect:{}", name.as_name()))
            .collect()
    }
}

/// Bound native selector preparation.
/// Foreground conversion follows the bat0.26.1 conventions used by the bundled assets.
pub const THEME_SELECTORS: usize = 512;
pub const THEME_PATHS: usize = 4096;
pub const THEME_TERMS: usize = 4096;
pub(crate) fn validate_theme(theme: &Theme) -> Result<(), Fault> {
    let fault = || Fault::not_started("theme_limit");
    if theme.scopes.len() > 512 {
        return Err(fault());
    }
    let (mut selectors, mut paths, mut terms) = (0usize, 0usize, 0usize);
    for item in &theme.scopes {
        selectors = selectors
            .checked_add(item.scope.selectors.len())
            .filter(|n| *n <= THEME_SELECTORS)
            .ok_or_else(fault)?;
        for selector in &item.scope.selectors {
            paths = paths
                .checked_add(1)
                .and_then(|n| n.checked_add(selector.excludes.len()))
                .filter(|n| *n <= THEME_PATHS)
                .ok_or_else(fault)?;
            for path in std::iter::once(&selector.path).chain(&selector.excludes) {
                terms = terms
                    .checked_add(path.len())
                    .filter(|n| *n <= THEME_TERMS)
                    .ok_or_else(fault)?;
            }
        }
    }
    Ok(())
}
