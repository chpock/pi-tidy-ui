//! One property scorer for validated semantic rules and caller-compiled selectors.
//! This module never interns caller text; the owner validates names through the
//! trusted grammar vocabulary before constructing rules.
use crate::semantic::{Expression, Ink};
use std::mem::size_of;
use std::sync::Arc;
use syntect::{
    highlighting::ScopeSelector,
    parsing::{MatchPower, Scope, ATOM_LEN_BITS},
};

/// Public Syntect selectors multiply a zero-based u16 index by ATOM_LEN_BITS.
pub const MAX_CONTEXT_DEPTH: usize = (u16::MAX / ATOM_LEN_BITS) as usize + 1;

#[derive(Clone, Copy, Debug)]
pub struct AttributePatch {
    pub value: u8,
    pub mask: u8,
}
#[derive(Clone, Debug)]
pub struct ContextQualifier {
    pub owner: Scope,
    pub boundaries: Vec<Scope>,
}
impl ContextQualifier {
    fn nearest_owner(&self, path: &[Scope], counters: &mut Counters) -> Option<usize> {
        for (index, scope) in path.iter().enumerate().rev() {
            for boundary in &self.boundaries {
                counters.context_scopes_tested += 1;
                if boundary.is_prefix_of(*scope) {
                    return None;
                }
            }
            counters.context_scopes_tested += 1;
            if self.owner.is_prefix_of(*scope) {
                return Some(index);
            }
        }
        None
    }
}
#[derive(Clone, Debug)]
pub struct Rule {
    pub selector: ScopeSelector,
    pub context: Option<ContextQualifier>,
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
    pub attributes: [Option<Declaration>; 5],
}
#[derive(Clone)]
struct Scored {
    resolution: Resolution,
    scores: [MatchPower; 7],
}
impl Scored {
    fn new(default: Expression) -> Self {
        Self {
            resolution: Resolution {
                expression: default,
                foreground: None,
                background: None,
                attributes: [None; 5],
            },
            scores: [MatchPower(-1.0); 7],
        }
    }
    fn apply(&mut self, rule: &Rule, index: usize, score: MatchPower) {
        let owner = Some(Declaration {
            rule_index: index,
            explicit_path: !rule.selector.path.is_empty(),
        });
        let wins = |previous: Option<Declaration>, current: MatchPower| {
            score > current || score == current && previous.is_none_or(|old| index < old.rule_index)
        };
        let expression = &mut self.resolution.expression;
        if let Some(value) = &rule.foreground {
            if wins(self.resolution.foreground, self.scores[0]) {
                self.scores[0] = score;
                expression.foreground = value.clone();
                self.resolution.foreground = owner;
            }
        }
        if let Some(value) = &rule.background {
            if wins(self.resolution.background, self.scores[1]) {
                self.scores[1] = score;
                expression.background = value.clone();
                self.resolution.background = owner;
            }
        }
        if let Some(patch) = rule.attributes {
            for i in 0..5 {
                let bit = 1 << i;
                if patch.mask & bit != 0 && wins(self.resolution.attributes[i], self.scores[i + 2])
                {
                    self.scores[i + 2] = score;
                    expression.attribute_mask |= bit;
                    expression.attributes = (expression.attributes & !bit) | (patch.value & bit);
                    self.resolution.attributes[i] = owner;
                }
            }
        }
    }
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
            if rule.context.is_none() {
                if let Some(scope) = rule.selector.extract_single_scope() {
                    singles.push((scope, index, rule));
                } else {
                    multis.push((index, rule));
                }
            } else {
                multis.push((index, rule));
            }
        }
        // Each property keeps the globally earliest declaration on exact-score ties, even across this cache partition.
        singles.sort_by_key(|a| std::cmp::Reverse(a.0.len()));
        Self {
            definition: Arc::new(Definition {
                default,
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
    pub contextual_rules: usize,
    pub context_scopes_tested: usize,
    pub anchored_path_scopes_tested: usize,
    pub exclusion_selector_calls: usize,
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
                let score = if let Some(context) = &rule.context {
                    self.counters.contextual_rules += 1;
                    let Some(anchor) = context.nearest_owner(path, &mut self.counters) else {
                        continue;
                    };
                    let mut excluded = false;
                    for exclusion in &rule.selector.excludes {
                        if exclusion.is_empty() {
                            excluded = true;
                            break;
                        }
                        self.counters.exclusion_selector_calls += 1;
                        if exclusion.does_match(path).is_some() {
                            excluded = true;
                            break;
                        }
                    }
                    if excluded {
                        None
                    } else {
                        let mut selector_index = 0usize;
                        let mut score = 0.0;
                        for (depth, scope) in path.iter().enumerate().skip(anchor) {
                            self.counters.anchored_path_scopes_tested += 1;
                            let required = rule.selector.path.as_slice()[selector_index];
                            if required.is_prefix_of(*scope) {
                                score += f64::from(required.len())
                                    * f64::from(ATOM_LEN_BITS * depth as u16).exp2();
                                selector_index += 1;
                                if selector_index == rule.selector.path.len() {
                                    break;
                                }
                            }
                        }
                        (selector_index == rule.selector.path.len()).then_some(MatchPower(score))
                    }
                } else {
                    self.counters.selector_calls += 1;
                    rule.selector.does_match(path)
                };
                if let Some(score) = score {
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
