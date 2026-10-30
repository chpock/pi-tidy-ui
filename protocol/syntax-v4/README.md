# Occipital syntax-highlight/v4 conformance inputs

The canonical application contract is [docs/occipital/protocol.md](../../docs/occipital/protocol.md). It describes the coordinated v4 producer/consumer revisions, carriers, operations, identities, acknowledgments, context-qualified rules, errors, limits and accounting. The standalone [Occipital manual](../../docs/occipital/README.md) explains the daemon and its responsibilities.

This directory contains repository-only conformance inputs for the current wire contract:

- [vectors.json](vectors.json) — application and semantic payload cases.
- [context-number-vectors.json](context-number-vectors.json) — context numeric boundaries.
- [rule-vectors.json](rule-vectors.json) — canonical generic-rule definitions and independently framed fingerprints, including nearest-owner qualification. Runtime resolver behavior is exercised by Occipital's context-qualification tests: global first-declaration tie-breaking for null and qualified rules, property-specific foreground/background/font-bit winners, explicit zero-mask inheritance, empty/global selectors, cursor-local prefix reuse, workspace/depth admission and cursor lifetime independent of the resolver owner.
- [rule-number-vectors.json](rule-number-vectors.json) — rule numeric boundaries.
- [highlighting-limits.json](highlighting-limits.json) — shared admission and accounting limits.
- [source-hint-vectors.json](source-hint-vectors.json) — SOURCE language-selection revision, optional/null/empty language semantics, curated shebang aliases and detector boundaries exercised by TypeScript and Rust.

The extension manual ships the protocol reference; these JSON files and their executable harness are checkout-only engineering inputs. V4 resolver revision 3 selects the earliest declaration in original rule order on exact score ties for foreground, background, and each font bit, regardless of null versus qualified context or single/multi cache partition. See [syntax/protocol validation](../../docs/testing.md#syntax-and-palette-validation) for prepared test requirements.
