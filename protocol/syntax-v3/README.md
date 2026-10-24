# Occipital syntax-highlight/v3 conformance inputs

The canonical, complete application contract is [docs/occipital/protocol.md](../../docs/occipital/protocol.md). It describes the current producer/consumer revisions, carriers, operations, identities, acknowledgments, contexts, styles/palettes, errors, limits and accounting. The standalone [Occipital manual](../../docs/occipital/README.md) explains the program and algorithms behind that contract.

This checkout directory contains conformance inputs; their wire semantics are not changed by the reference's documentation location:

- [vectors.json](vectors.json) — application/semantic payload cases.
- [context-number-vectors.json](context-number-vectors.json) — context numeric boundaries.
- [rule-vectors.json](rule-vectors.json) — client rules and resolved interpretation.
- [rule-number-vectors.json](rule-number-vectors.json) — rule numeric boundaries.
- [highlighting-limits.json](highlighting-limits.json) — shared limit expectations.
- [source-hint-vectors.json](source-hint-vectors.json) — SOURCE language-selection revision, optional/null/empty language semantics, curated shebang-to-language aliases and detector boundaries exercised by both TypeScript and Rust.

The complete protocol reference ships in the extension's documentation. These JSON files and their executable harness remain repository-only engineering inputs. See [syntax/protocol validation](../../docs/testing.md#syntax-and-palette-validation) for the prepared test requirements. Current v3 source compatibility does not establish publication or compatibility of historical v2 release binaries.
