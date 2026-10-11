//! Immutable native profiles; Pi roles never carry the client's mutable theme colors.
use crate::protocol::{Fault, Role, WireStyle, ASSETS};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use syntect::{
    highlighting::{Color, Highlighter, Style, Theme},
    parsing::{Scope, ScopeStack},
};
use two_face::theme::{EmbeddedLazyThemeSet, LazyThemeSet};

#[derive(Clone)]
pub struct Profile {
    pub name: String,
    pub fingerprint: String,
    pub theme: Option<Arc<Theme>>,
}
static THEMES: OnceLock<LazyThemeSet> = OnceLock::new();
static PROFILES: OnceLock<Mutex<HashMap<String, Arc<Profile>>>> = OnceLock::new();

impl Profile {
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
        let theme = if name == "pi" {
            None
        } else {
            let native = name
                .strip_prefix("syntect:")
                .ok_or(Fault::not_started("profile_unavailable"))?;
            let themes = THEMES.get_or_init(|| two_face::theme::extra().into());
            let theme = themes
                .get(native)
                .ok_or(Fault::not_started("profile_unavailable"))?;
            validate_theme(theme)?;
            Some(Arc::new(theme.clone()))
        };
        let profile = Arc::new(Self {
            name: name.into(),
            fingerprint: format!(
                "{:x}",
                Sha256::digest(format!("{ASSETS}:{name}").as_bytes())
            ),
            theme,
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

/// Bound selector preparation. Theme backgrounds never replace Toolview's panel/diff paint.
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

pub fn native_style(style: Style) -> Result<WireStyle, Fault> {
    let Color { r, g, b, a } = style.foreground;
    let attributes = style.font_style.bits();
    Ok(match a {
        0 => WireStyle::Indexed {
            index: r,
            attributes,
        },
        1 => WireStyle::TerminalDefault {
            terminal_default: true,
            attributes,
        },
        _ => WireStyle::Rgb {
            rgb: [r, g, b],
            attributes,
        },
    })
}

pub fn pi_styles() -> Vec<WireStyle> {
    [
        Role::Plain,
        Role::SyntaxComment,
        Role::SyntaxKeyword,
        Role::SyntaxString,
        Role::SyntaxNumber,
        Role::SyntaxType,
        Role::SyntaxFunction,
        Role::SyntaxVariable,
        Role::SyntaxOperator,
        Role::SyntaxPunctuation,
    ]
    .into_iter()
    .map(|role| WireStyle::Pi { role })
    .collect()
}

/// Prefix scopes are interned once. No per-token scope-string construction or regex matching.
pub fn category(stack: &ScopeStack) -> Role {
    static RULES: OnceLock<Vec<(Scope, Role)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            ("punctuation.definition.string", Role::SyntaxString),
            ("punctuation.definition.comment", Role::SyntaxComment),
            ("constant.character.escape", Role::SyntaxString),
            ("keyword.operator", Role::SyntaxOperator),
            ("storage.type.function", Role::SyntaxKeyword),
            ("support.function.builtin", Role::SyntaxType),
            ("comment", Role::SyntaxComment),
            ("string", Role::SyntaxString),
            ("constant.numeric", Role::SyntaxNumber),
            ("constant.language", Role::SyntaxNumber),
            ("constant.character", Role::SyntaxNumber),
            ("entity.name.function", Role::SyntaxFunction),
            ("support.function", Role::SyntaxFunction),
            ("entity.name.type", Role::SyntaxType),
            ("entity.name.class", Role::SyntaxType),
            ("support.type", Role::SyntaxType),
            ("support.class", Role::SyntaxType),
            ("storage.type.primitive", Role::SyntaxType),
            ("storage.type", Role::SyntaxKeyword),
            ("variable", Role::SyntaxVariable),
            ("entity.other.attribute-name", Role::SyntaxVariable),
            ("keyword", Role::SyntaxKeyword),
            ("storage.modifier", Role::SyntaxKeyword),
            ("entity.name.tag", Role::SyntaxPunctuation),
            ("punctuation", Role::SyntaxPunctuation),
            ("meta.preprocessor", Role::SyntaxKeyword),
            ("meta.annotation", Role::SyntaxKeyword),
        ]
        .into_iter()
        .map(|(scope, role)| (Scope::new(scope).expect("static role scope"), role))
        .collect()
    });
    for scope in stack.as_slice().iter().rev() {
        if let Some((_, role)) = rules.iter().find(|(prefix, _)| prefix.is_prefix_of(*scope)) {
            return *role;
        }
    }
    Role::Plain
}

pub fn default_style(profile: &Profile) -> WireStyle {
    profile
        .theme
        .as_ref()
        .map_or(WireStyle::Pi { role: Role::Plain }, |theme| {
            native_style(Highlighter::new(theme).get_default()).expect("validated theme foreground")
        })
}
