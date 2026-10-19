//! Test-only extraction oracle adapted from the independently reviewed E1 prototype.
//! Original: unified_vocabulary_gate.rs, SHA-256
//! c05da99fb690287bf4d43749820137896b91954e8128626d93b0940f64d2407a.
//! Retains Scan (original lines 65–151), prefix enumeration (160–168), and
//! public linked-context extraction (212–277). Only the result interface changes;
//! allocator/timing, handle materialization, fingerprint and CLI reporting are omitted.
//! The historical file is provenance, not an include or runtime dependency.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use syntect::parsing::syntax_definition::{Context, ContextReference, MatchOperation, Pattern};
use syntect::parsing::{Scope, SyntaxSet};

#[derive(Default)]
struct Scan {
    scopes: BTreeSet<String>,
    counts: BTreeMap<&'static str, usize>,
}
impl Scan {
    fn count(&mut self, field: &'static str) {
        *self.counts.entry(field).or_default() += 1;
    }
    fn scope(&mut self, field: &'static str, scope: Scope) {
        self.count(field);
        assert!(!scope.is_empty(), "empty scope in bundled static field");
        self.scopes.insert(scope.build_string());
    }
    fn reference<'a>(
        &mut self,
        reference: &ContextReference,
        set: &'a SyntaxSet,
        pending: &mut Vec<&'a Context>,
    ) {
        if let Ok(context) = reference.resolve(set) {
            self.count("direct_references");
            pending.push(context);
        } else if let ContextReference::ByScope { scope, .. } = reference {
            self.scope("unresolved_by_scope", *scope);
        } else {
            // Named/Inline/Direct tuple variants are non-exhaustive and cannot be matched.
            assert!(reference.id().is_err(), "broken direct context reference");
            self.count("unresolved_other_references");
        }
    }
    fn context<'a>(
        &mut self,
        context: &Context,
        set: &'a SyntaxSet,
        pending: &mut Vec<&'a Context>,
    ) {
        self.count("contexts");
        if context.prototype.is_some() {
            self.count("prototype_links");
        }
        if context.clear_scopes.is_some() {
            self.count("clear_scopes");
        }
        for scope in &context.meta_scope {
            self.scope("meta_scope", *scope);
        }
        for scope in &context.meta_content_scope {
            self.scope("meta_content_scope", *scope);
        }
        for pattern in &context.patterns {
            match pattern {
                Pattern::Include(reference) => {
                    self.count("include_patterns");
                    self.reference(reference, set, pending);
                }
                Pattern::Match(pattern) => {
                    self.count("match_patterns");
                    for scope in &pattern.scope {
                        self.scope("match_scope", *scope);
                    }
                    if let Some(captures) = &pattern.captures {
                        for (_, scopes) in captures {
                            for scope in scopes {
                                self.scope("capture_scope", *scope);
                            }
                        }
                    }
                    if let Some(reference) = &pattern.with_prototype {
                        self.count("with_prototype");
                        self.reference(reference, set, pending);
                    }
                    match &pattern.operation {
                        MatchOperation::Push(refs) | MatchOperation::Set(refs) => {
                            self.count("push_or_set");
                            for reference in refs {
                                self.reference(reference, set, pending);
                            }
                        }
                        MatchOperation::Pop => self.count("pop_patterns"),
                        MatchOperation::None => self.count("no_operation_patterns"),
                    }
                }
            }
        }
    }
}

fn finite_names(full: &BTreeSet<String>) -> Vec<String> {
    let mut prefixes = BTreeSet::new();
    for name in full {
        for (index, _) in name.match_indices('.') {
            prefixes.insert(name[..index].to_owned());
        }
        prefixes.insert(name.clone());
    }
    prefixes.into_iter().collect()
}

pub(super) fn extract(set: &SyntaxSet) -> (Vec<String>, Value) {
    let builder = set.clone().into_builder();
    let mut seed = Scan::default();
    let mut pending = Vec::new();
    let mut prototype_ids = HashSet::new();
    for syntax in builder.syntaxes() {
        seed.scope("root_scope", syntax.scope);
        assert!(syntax.contexts.contains_key("__start"));
        for (name, context) in &syntax.contexts {
            if name == "prototype" {
                seed.count("named_prototypes");
            }
            if name.starts_with("#anon_") {
                seed.count("anonymous_contexts");
            }
            if let Some(id) = context.prototype {
                // build() links these only to this syntax's named `prototype`.
                assert!(syntax.contexts.contains_key("prototype"));
                prototype_ids.insert(id);
            }
            seed.context(context, set, &mut pending);
        }
    }
    let mut linked = Scan::default();
    let mut seen = HashSet::new();
    while let Some(context) = pending.pop() {
        // Pointer identity is local visitation only; it never becomes an ID or fingerprint.
        if !seen.insert(context as *const Context) {
            continue;
        }
        if let Some(id) = context.prototype {
            assert!(prototype_ids.contains(&id), "unexpected hidden prototype");
        }
        linked.context(context, set, &mut pending);
    }
    let linked_only: Vec<_> = linked.scopes.difference(&seed.scopes).cloned().collect();
    assert!(
        linked_only.is_empty(),
        "linked contexts lost scopes: {linked_only:?}"
    );
    let names = finite_names(&seed.scopes);
    let report = json!({
        "syntaxes": builder.syntaxes().len(),
        "seed_fields": seed.counts,
        "resolved_linked_fields": linked.counts,
        "linked_only_scopes": linked_only,
        "full_scopes": seed.scopes.len(),
    });
    (names, report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finite_names_include_unique_sorted_dotted_prefixes() {
        let full = BTreeSet::from([
            "source.ts".to_owned(),
            "source".to_owned(),
            "text.html.basic".to_owned(),
        ]);
        assert_eq!(
            finite_names(&full),
            [
                "source",
                "source.ts",
                "text",
                "text.html",
                "text.html.basic"
            ]
        );
    }
}
