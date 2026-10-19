//! Build-only public-API extraction; the frozen E1 example is the independent test oracle.
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use syntect::parsing::syntax_definition::{Context, ContextReference, MatchOperation, Pattern};
use syntect::parsing::{Scope, SyntaxSet};

// This identifies the FULL pinned asset revision, not just its set of scope names.
// Bump on asset/parser revision changes even when the vocabulary stays identical.
pub const ASSET_REVISION: &str =
    "two-face/0.5.2+bat-0.26.1/extra_newlines/syntect-onig;asset-revision=1;syntect/5.3.0";
pub const SCHEMA: &str = "occipital-vocabulary/1";

fn add(scopes: &mut BTreeSet<String>, scope: Scope) {
    assert!(!scope.is_empty(), "empty bundled grammar scope");
    scopes.insert(scope.build_string());
}

fn reference<'a>(
    reference: &ContextReference,
    set: &'a SyntaxSet,
    pending: &mut Vec<&'a Context>,
    scopes: &mut BTreeSet<String>,
) {
    if let Ok(context) = reference.resolve(set) {
        pending.push(context);
    } else if let ContextReference::ByScope { scope, .. } = reference {
        add(scopes, *scope);
    } else {
        assert!(reference.id().is_err(), "broken direct context reference");
    }
}

fn visit_context<'a>(
    context: &Context,
    set: &'a SyntaxSet,
    pending: &mut Vec<&'a Context>,
    scopes: &mut BTreeSet<String>,
) {
    for scope in context.meta_scope.iter().chain(&context.meta_content_scope) {
        add(scopes, *scope);
    }
    for pattern in &context.patterns {
        match pattern {
            Pattern::Include(target) => reference(target, set, pending, scopes),
            Pattern::Match(pattern) => {
                for scope in &pattern.scope {
                    add(scopes, *scope);
                }
                if let Some(captures) = &pattern.captures {
                    for (_, capture) in captures {
                        for scope in capture {
                            add(scopes, *scope);
                        }
                    }
                }
                if let Some(target) = &pattern.with_prototype {
                    reference(target, set, pending, scopes);
                }
                match &pattern.operation {
                    MatchOperation::Push(targets) | MatchOperation::Set(targets) => {
                        for target in targets {
                            reference(target, set, pending, scopes);
                        }
                    }
                    MatchOperation::Pop | MatchOperation::None => (),
                }
            }
        }
    }
}

pub fn extract(set: &SyntaxSet) -> Vec<String> {
    let builder = set.clone().into_builder();
    let mut scopes = BTreeSet::new();
    let mut pending = Vec::new();
    let mut prototype_ids = HashSet::new();
    for syntax in builder.syntaxes() {
        add(&mut scopes, syntax.scope);
        assert!(syntax.contexts.contains_key("__start"));
        for context in syntax.contexts.values() {
            if let Some(id) = context.prototype {
                assert!(syntax.contexts.contains_key("prototype"));
                prototype_ids.insert(id);
            }
            visit_context(context, set, &mut pending, &mut scopes);
        }
    }
    let mut linked_scopes = BTreeSet::new();
    let mut visited = HashSet::new();
    while let Some(linked) = pending.pop() {
        // Local traversal identity only; never a generated ID or fingerprint input.
        if !visited.insert(linked as *const Context) {
            continue;
        }
        if let Some(id) = linked.prototype {
            assert!(prototype_ids.contains(&id), "unaccounted linked prototype");
        }
        visit_context(linked, set, &mut pending, &mut linked_scopes);
    }
    // Syntect 5.3 retains the linked generated contexts in into_builder(). If an
    // upgrade breaks that proof, fail the build rather than silently omit scopes.
    assert!(
        linked_scopes.is_subset(&scopes),
        "linked contexts lost static scopes"
    );
    let mut names = BTreeSet::new();
    for name in scopes {
        for (index, _) in name.match_indices('.') {
            names.insert(name[..index].to_owned());
        }
        names.insert(name);
    }
    assert!(names.len() < u32::MAX as usize);
    names.into_iter().collect()
}

fn field(digest: &mut Sha256, bytes: &[u8]) {
    digest.update(u64::try_from(bytes.len()).unwrap().to_be_bytes());
    digest.update(bytes);
}

pub fn asset_fingerprint(revision: &str) -> String {
    let mut digest = Sha256::new();
    field(&mut digest, b"occipital-grammar-assets/1");
    field(&mut digest, revision.as_bytes());
    format!("{:x}", digest.finalize())
}

pub fn fingerprint(revision: &str, names: &[String]) -> String {
    let mut digest = Sha256::new();
    field(&mut digest, SCHEMA.as_bytes());
    field(&mut digest, asset_fingerprint(revision).as_bytes());
    digest.update(u64::try_from(names.len()).unwrap().to_be_bytes());
    for name in names {
        field(&mut digest, name.as_bytes());
    }
    format!("{:x}", digest.finalize())
}
