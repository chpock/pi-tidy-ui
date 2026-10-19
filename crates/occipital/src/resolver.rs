//! One property scorer for admitted native themes and caller-compiled trusted selectors.
//! This module never interns caller text. The caller validates generic declarations
//! and resolves their paths through the trusted vocabulary before constructing rules.
use crate::semantic::{Expression, Ink};
use std::mem::size_of;
use std::sync::Arc;
use syntect::{
    highlighting::{Color, FontStyle, ScopeSelector, Style, Theme},
    parsing::{MatchPower, Scope, ScopeStack, ATOM_LEN_BITS},
};

pub const BOLD: u8 = 1;
pub const ITALIC: u8 = 2;
pub const UNDERLINE: u8 = 4;
pub const FAINT: u8 = 8;
pub const ALL_ATTRIBUTES: u8 = BOLD | ITALIC | UNDERLINE | FAINT;
/// Public Syntect selectors multiply a zero-based u16 index by ATOM_LEN_BITS.
pub const MAX_CONTEXT_DEPTH: usize = (u16::MAX / ATOM_LEN_BITS) as usize + 1;

pub fn native_ink(color: Color) -> Ink {
    match color.a {
        0 => Ink::Indexed { index: color.r },
        1 => Ink::TerminalDefault {},
        _ => Ink::Rgb {
            r: color.r,
            g: color.g,
            b: color.b,
        },
    }
}

pub fn native_attributes(font: FontStyle) -> u8 {
    (u8::from(font.contains(FontStyle::BOLD)) * BOLD)
        | (u8::from(font.contains(FontStyle::ITALIC)) * ITALIC)
        | (u8::from(font.contains(FontStyle::UNDERLINE)) * UNDERLINE)
}

#[derive(Clone, Copy, Debug)]
pub struct AttributePatch {
    pub value: u8,
    pub mask: u8,
}
#[derive(Clone, Debug)]
pub struct Rule {
    pub selector: ScopeSelector,
    pub foreground: Option<Ink>,
    pub background: Option<Ink>,
    pub attributes: Option<AttributePatch>,
}
/// The winning declaration, not merely a matching rule. Empty/global selectors
/// are deliberately distinguishable from authored semantic hints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Declaration {
    pub rule_index: usize,
    pub explicit_path: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub expression: Expression,
    pub foreground: Option<Declaration>,
    pub background: Option<Declaration>,
    pub attributes: [Option<Declaration>; 4],
}
#[derive(Clone)]
struct Scored {
    resolution: Resolution,
    scores: [MatchPower; 6],
}
impl Scored {
    fn new(default: Expression) -> Self {
        Self {
            resolution: Resolution {
                expression: default,
                foreground: None,
                background: None,
                attributes: [None; 4],
            },
            scores: [MatchPower(-1.0); 6],
        }
    }
    fn apply(&mut self, rule: &Rule, index: usize, score: MatchPower) {
        let owner = Some(Declaration {
            rule_index: index,
            explicit_path: !rule.selector.path.is_empty(),
        });
        let expression = &mut self.resolution.expression;
        if let Some(value) = &rule.foreground {
            if score > self.scores[0] {
                self.scores[0] = score;
                expression.foreground = value.clone();
                self.resolution.foreground = owner;
            }
        }
        if let Some(value) = &rule.background {
            if score > self.scores[1] {
                self.scores[1] = score;
                expression.background = value.clone();
                self.resolution.background = owner;
            }
        }
        if let Some(patch) = rule.attributes {
            for i in 0..4 {
                let bit = 1 << i;
                if patch.mask & bit != 0 && score > self.scores[i + 2] {
                    self.scores[i + 2] = score;
                    expression.attribute_mask |= bit;
                    expression.attributes = (expression.attributes & !bit) | (patch.value & bit);
                    self.resolution.attributes[i] = owner;
                }
            }
        }
    }
}

/// Syntect 5.3 Highlighter::get_default, without constructing unused selector tables.
/// Differential coverage includes absent settings and explicit font reset.
pub fn native_default(theme: &Theme) -> Style {
    Style {
        foreground: theme.settings.foreground.unwrap_or(Color::BLACK),
        background: theme.settings.background.unwrap_or(Color::WHITE),
        font_style: FontStyle::empty(),
    }
}
fn native_counts(theme: &Theme) -> Result<(usize, usize), Error> {
    let mut singles = 0usize;
    let mut multis = 0usize;
    for selector in theme.scopes.iter().flat_map(|item| &item.scope.selectors) {
        if selector.extract_single_scope().is_some() {
            singles = singles.checked_add(1).ok_or(Error::WorkspaceOverflow)?;
        } else {
            multis = multis.checked_add(1).ok_or(Error::WorkspaceOverflow)?;
        }
    }
    Ok((singles, multis))
}

struct Definition {
    default: Expression,
    singles: Vec<(Scope, usize, Rule)>,
    multis: Vec<(usize, Rule)>,
}
pub struct Resolver {
    definition: Arc<Definition>,
}
impl Resolver {
    /// Inputs are already admitted/validated; no parsing or interning occurs here.
    pub fn compile(default: Expression, rules: Vec<Rule>) -> Self {
        let (mut singles, mut multis) = (Vec::new(), Vec::new());
        for (index, rule) in rules.into_iter().enumerate() {
            if let Some(scope) = rule.selector.extract_single_scope() {
                singles.push((scope, index, rule));
            } else {
                multis.push((index, rule));
            }
        }
        // Stable ordering and strict > reproduce RangedHighlightIterator ties.
        singles.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
        Self {
            definition: Arc::new(Definition {
                default,
                singles,
                multis,
            }),
        }
    }
    pub fn native(theme: &Theme) -> Self {
        Self::native_with_default(theme, native_default(theme))
    }
    /// Controlled native definition storage, excluding the borrowed immutable asset.
    pub fn native_bytes(theme: &Theme) -> Result<usize, Error> {
        let (singles, multis) = native_counts(theme)?;
        let mut bytes = size_of::<Definition>() + 2 * size_of::<usize>();
        for (count, width) in [
            (singles, size_of::<(Scope, usize, Rule)>()),
            (multis, size_of::<(usize, Rule)>()),
        ] {
            bytes = bytes
                .checked_add(count.checked_mul(width).ok_or(Error::WorkspaceOverflow)?)
                .ok_or(Error::WorkspaceOverflow)?;
        }
        for selector in theme.scopes.iter().flat_map(|item| &item.scope.selectors) {
            bytes = bytes
                .checked_add(
                    selector
                        .excludes
                        .len()
                        .checked_mul(size_of::<ScopeStack>())
                        .ok_or(Error::WorkspaceOverflow)?,
                )
                .ok_or(Error::WorkspaceOverflow)?;
            for path in std::iter::once(&selector.path).chain(&selector.excludes) {
                bytes = bytes
                    .checked_add(
                        path.len()
                            .checked_mul(size_of::<Scope>())
                            .ok_or(Error::WorkspaceOverflow)?,
                    )
                    .ok_or(Error::WorkspaceOverflow)?;
            }
        }
        Ok(bytes)
    }
    pub(crate) fn native_with_default(theme: &Theme, base: Style) -> Self {
        let (single_count, multi_count) = native_counts(theme).expect("native selector count");
        let mut singles = Vec::with_capacity(single_count);
        let mut multis = Vec::with_capacity(multi_count);
        for (index, (item, selector)) in theme
            .scopes
            .iter()
            .flat_map(|item| {
                item.scope
                    .selectors
                    .iter()
                    .map(move |selector| (item, selector))
            })
            .enumerate()
        {
            let mut excludes = Vec::with_capacity(selector.excludes.len());
            excludes.extend(
                selector
                    .excludes
                    .iter()
                    .map(|path| ScopeStack::from_vec(path.as_slice().to_vec())),
            );
            let selector = ScopeSelector {
                path: ScopeStack::from_vec(selector.path.as_slice().to_vec()),
                excludes,
            };
            let rule = Rule {
                selector,
                foreground: item.style.foreground.map(native_ink),
                background: item.style.background.map(native_ink),
                attributes: item.style.font_style.map(|font| AttributePatch {
                    value: native_attributes(font),
                    mask: ALL_ATTRIBUTES,
                }),
            };
            if let Some(scope) = rule.selector.extract_single_scope() {
                singles.push((scope, index, rule));
            } else {
                multis.push((index, rule));
            }
        }
        // Same stable depth/order result, with an in-place allocation-free sort.
        singles.sort_unstable_by_key(|(scope, index, _)| (std::cmp::Reverse(scope.len()), *index));
        Self {
            definition: Arc::new(Definition {
                default: Expression {
                    foreground: native_ink(base.foreground),
                    background: native_ink(base.background),
                    attributes: native_attributes(base.font_style),
                    attribute_mask: ALL_ATTRIBUTES,
                },
                singles,
                multis,
            }),
        }
    }
    pub fn default_expression(&self) -> &Expression {
        &self.definition.default
    }
    pub fn cursor(&self, max_depth: usize) -> Result<Cursor, Error> {
        Cursor::workspace_bytes(max_depth)?;
        let mut ancestors = Vec::with_capacity(max_depth + 1);
        ancestors.push(Scored::new(self.definition.default.clone()));
        Ok(Cursor {
            definition: Arc::clone(&self.definition),
            ancestors,
            previous: Vec::with_capacity(max_depth),
            max_depth,
            counters: Counters::default(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    ContextTooDeep,
    WorkspaceOverflow,
    WorkspaceDepth,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub contexts: usize,
    pub scored_scopes: usize,
    pub single_tests: usize,
    pub selector_calls: usize,
}
/// Request-local cursor. Each resolve is one scheduler-yield boundary; retained
/// ancestor scores reuse adjacent context prefixes, but multi rules see the full path.
/// Parsed-empty is a real context here; unclassified context 0 is not submitted.
/// The job keeps its definition's allocation credit until this cursor is dropped;
/// sharing the immutable rules permits scheduler yields without a self-reference.
pub struct Cursor {
    definition: Arc<Definition>,
    ancestors: Vec<Scored>,
    previous: Vec<Scope>,
    max_depth: usize,
    counters: Counters,
}
impl Cursor {
    /// Controlled workspace, separate from borrowed descriptors and returned styles:
    /// all scored ancestors, previous context, cursor header and current scratch.
    /// The caller reserves this checked amount before allocating the cursor.
    pub fn workspace_bytes(max_depth: usize) -> Result<usize, Error> {
        if max_depth > MAX_CONTEXT_DEPTH {
            return Err(Error::ContextTooDeep);
        }
        max_depth
            .checked_add(1)
            .and_then(|n| n.checked_mul(size_of::<Scored>()))
            .and_then(|n| {
                max_depth
                    .checked_mul(size_of::<Scope>())
                    .and_then(|m| n.checked_add(m))
            })
            .and_then(|n| n.checked_add(size_of::<Self>()))
            .and_then(|n| n.checked_add(size_of::<Scored>()))
            .ok_or(Error::WorkspaceOverflow)
    }
    pub fn counters(&self) -> Counters {
        self.counters
    }
    pub fn resolve(&mut self, path: &[Scope]) -> Result<Resolution, Error> {
        // Guard before every external selector call (including exclusions).
        if path.len() > MAX_CONTEXT_DEPTH {
            return Err(Error::ContextTooDeep);
        }
        if path.len() > self.max_depth {
            return Err(Error::WorkspaceDepth);
        }
        let shared = self
            .previous
            .iter()
            .zip(path)
            .take_while(|(a, b)| a == b)
            .count();
        self.ancestors.truncate(shared + 1);
        for (depth, scope) in path.iter().enumerate().skip(shared) {
            let mut state = self.ancestors.last().unwrap().clone();
            for (candidate, index, rule) in &self.definition.singles {
                self.counters.single_tests += 1;
                if candidate.is_prefix_of(*scope) {
                    state.apply(
                        rule,
                        *index,
                        MatchPower(
                            f64::from(candidate.len())
                                * f64::from(ATOM_LEN_BITS * depth as u16).exp2(),
                        ),
                    );
                }
            }
            self.ancestors.push(state);
            self.counters.scored_scopes += 1;
        }
        let mut state = self.ancestors.last().unwrap().clone();
        if !path.is_empty() {
            for (index, rule) in &self.definition.multis {
                self.counters.selector_calls += 1;
                if let Some(score) = rule.selector.does_match(path) {
                    state.apply(rule, *index, score);
                }
            }
        }
        self.previous.clear();
        self.previous.extend_from_slice(path);
        self.counters.contexts += 1;
        Ok(state.resolution)
    }
}
