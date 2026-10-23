# Grammar assets, vocabulary and compatibility

Occipital’s portable scope identifiers are generated from its shipped grammar assets at build time. They are not Syntect’s process-local atom numbers, and they are not a dictionary accumulated from client traffic.

This chapter explains generation and change impact. The [protocol reference](protocol.md) owns exact wire identities, revisions and expression interpretation. Build and release procedures remain in [testing](../testing.md) and [releases](../releases.md).

## Build inputs and dependency roles

`crates/occipital/Cargo.toml` selects Syntect’s parsing, dump-loading, plist-loading and Oniguruma backend, together with the matching two-face grammar/theme assets. Syntect and two-face also appear as build dependencies with matching versions and features. The generator must inspect the same grammar family that the runtime parser uses.

`build.rs` loads `two_face::syntax::extra_newlines()` and calls `vocabulary_build.rs`. Cargo reruns this step when the build script, extractor, crate manifest or workspace lockfile changes. Its output is a Rust source file under `OUT_DIR`, containing the sorted names, count and fingerprints. `crates/occipital/src/vocabulary.rs` includes that generated file in the executable.

Other dependencies serve different boundaries: SHA-256 provides identities; plist and quick-xml support custom-theme admission; the OS-directory resolver selects configuration location; Tokio and the public Subconscious crates support runtime/carrier ownership. They do not supply a second syntax classifier.

The newline-aware grammar choice matters to the source engine’s line processing. Replacing assets or parser features is therefore a semantic compatibility change to investigate, not merely a build-size adjustment.

## Extracting all static grammar scopes

The extractor uses public Syntect structures rather than inspecting the binary dump format.

It begins with a cloned syntax set converted to a builder. For every syntax, it collects the root scope and visits all builder contexts, including the generated contexts retained by the pinned parser version.

Within a context it collects:

- Meta scopes and meta-content scopes.
- Scopes attached to match patterns.
- Capture scopes.
- Referenced contexts reached through includes, prototypes and push/set operations.

Resolvable references are queued for traversal. An unresolved by-scope reference still contributes its named scope. A broken direct context reference fails the build rather than being silently skipped.

### Checking linked-context coverage

The extractor also walks the resolved linked contexts. Pointer addresses are used only to avoid visiting the same in-memory context repeatedly; they never enter generated IDs or hashes.

This second traversal verifies two assumptions about the pinned public API:

- Linked prototypes are among the prototypes accounted for in the builder view.
- Every static scope found through linked contexts was already found in that builder view.

The generated vocabulary uses the complete collected set, and the linked set must be a subset. If an upstream change stops retaining generated or linked contexts in the builder representation, the assertion fails. It does not silently produce a smaller vocabulary and hope runtime parsing never reaches the missing branch.

This is a structural argument for the pinned assets and APIs. It is not a claim that every lazy regex branch was executed during generation, nor a proof for arbitrary replacement grammar packages.

## Prefixes, ordering and build fingerprints

For each collected dotted scope name, the extractor also adds its nonempty dotted prefixes. A caller can then refer to a trusted broader selector such as `comment` without introducing an arbitrary new atom merely because the grammar emits a longer name.

A sorted set removes duplicate strings and determines stable UTF-8 name order. A portable ID is the one-based position in that table; zero is reserved. IDs depend on the complete ordered vocabulary, not on which source happened to be parsed first.

`vocabulary_build.rs` maintains an explicit full asset revision string. The asset fingerprint hashes that declared revision under the `occipital-grammar-assets/1` domain using length-framed fields. It is not a runtime digest of the grammar dump’s raw bytes. The revision string must therefore change when parser/assets interpretation changes, even if extracted scope names happen to remain identical.

The vocabulary fingerprint uses the `occipital-vocabulary/1` schema domain, the asset fingerprint, the name count and every sorted framed name. Including asset identity prevents equal name sets from implying equal grammar semantics.

Generation at build time avoids cloning and traversing the complete grammar graph in each running helper. Runtime initialization still has finite work to convert generated names into native handles; it does not repeat extraction.

## Portable IDs and native handles

Syntect’s `Scope` values contain process-local interned atom identifiers. Their numeric values can depend on earlier interning and cannot safely become cross-process wire IDs.

`crates/occipital/src/vocabulary.rs` keeps the two representations separate:

- `ScopeId::from_raw` validates a positive ID against the generated count.
- `ScopeId::from_name` performs binary search in generated strings. It does not initialize or modify the native interner.
- `ScopeId::scope` lazily initializes the finite native-handle table from generated names once, then indexes it by portable ID.
- `ScopeId::from_scope` lazily builds a sorted reverse mapping for parser output.

Some different generated spellings can produce an equal native handle, such as a trailing-dot alias. Reverse initialization sorts by handle and portable ID, then keeps the smallest portable ID for each equal handle. Reverse lookup is consequently deterministic rather than dependent on insertion order.

Caller rule inspection uses name lookup before native-handle construction. An unknown name rejects without interning it. Custom native themes enter through the separate cumulative admission gate; they do not extend the wire vocabulary.

The source engine checks that pushed parser scopes have a portable representation. A mismatch is an error, not an opportunity to send process-local values or invent IDs dynamically.

## Identities answer different questions

Several fingerprints coexist because they invalidate different reusable results:

- **Asset identity:** which parser/grammar revision produced SOURCE semantics?
- **Vocabulary identity:** how are portable scope IDs interpreted under those assets?
- **Native definition identity:** which immutable native theme definition was selected? Custom definitions use their content hash; bundled definitions use the stable bundled asset/name identity in `profile.rs`.
- **Effective rule identity:** how should that native definition or generic caller declaration be interpreted by the resolver?
- **Native palette identity:** how should the selected native definition be interpreted as a complete native palette?

A custom catalogue ID answers a different question again: where was the theme found? It identifies a location, not content. Editing the file can preserve its catalogue ID while changing its definition fingerprint.

`style_rules.rs` computes caller-rule identity from validated canonical semantics, not JSON whitespace or object-member order. Rule order, path/exclusion order, binding slots and explicit property presence remain meaningful. A missing override is not interchangeable with an explicit inherit or font clear. The exact canonical hash fields and interpretation domains are defined in the [protocol](protocol.md).

Native effective-rule and palette identities are derived from the definition fingerprint under distinct interpretation domains. This permits interpretation to change without falsely claiming that the original theme bytes changed. Neither identity includes source text, process/lease identity, current Pi binding colors or geometry.

## Maintaining compatibility

When changing the implementation, identify which layer’s meaning changed before deciding what can be reused.

### Parser, grammar or feature changes

Keep runtime and build-time parser/assets dependencies aligned. Update the declared full asset revision when semantics change, regenerate the vocabulary through the normal build, and check the linked-context assumptions against the new public API.

A stable set of scope names does not establish stable parsing. Conversely, adding a name can shift later sorted IDs even when many grammar rules are unchanged. Consumers must negotiate the generated identity rather than infer compatibility from an executable version or a familiar source language.

### Resolver and expression changes

A change to selector precedence, inheritance, font masks or expression interpretation can invalidate STYLE results without requiring new source parsing. Review the advertised resolver revision and effective-rule interpretation domains together with the cross-language validators and vectors.

Do not silently accept an older interpretation because its outer JSON version is unchanged. The descriptor’s sub-revisions exist to make those semantic boundaries explicit.

### Native palette changes

A change to role construction or provenance can invalidate the prepared native palette independently of theme bytes. Review its interpretation identity and shared role/encoding contract, while leaving source identity separate.

Changes to shared numerical color behavior must be reconciled with the [canonical color model](../color-model.md), not documented as an alternate algorithm in this chapter.

### Limits and accounting changes

`crates/occipital/src/limits.rs` centralizes native policy constants. The corresponding consumer table and `protocol/syntax-v3/highlighting-limits.json` provide the cross-language policy boundary. The fixture is a conformance input, not another runtime configuration store.

Increasing a source bound alone does not ensure that the corresponding context expansion, decoded result, encoded reply or physical ownership can be admitted. Review the affected stages together. Consumer full-display retention is a separate authority from the native classification prefix.

### Verification locations

Use [the testing guide](../testing.md) for prepared inputs, focused contract groups and required real integrations. The checkout’s `protocol/syntax-v3/` directory contains the shared JSON vectors; they are checkout-only engineering inputs, not an additional packaged runtime dependency.

Changes to source parsing should cover finite/incremental equivalence, checkpoint and frozen-tail behavior, counters, cancellation and retained-state accounting. Resolver changes need native-reference comparisons, empty-context behavior, tie/exclusion/font semantics and cross-language expression identity. Vocabulary changes need generation coverage and process-independent identity checks. Native cache/accounting changes also affect failure and delivery ownership, not only the successful compiled result.

These boundaries guide change selection; detailed commands and acceptance procedures remain in the testing guide.
