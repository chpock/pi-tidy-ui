# Historical syntax-highlight/v3 conformance inputs

These files preserve the previous v3 wire contract for historical comparison only. The active coordinated contract is [syntax-highlight/v4](../syntax-v4/README.md), documented in [docs/occipital/protocol.md](../../docs/occipital/protocol.md). V4 removes the native-theme catalogue/palette payload and adds required-nullable context qualification to generic style definitions; v3 inputs are not active compatibility controls.

This checkout directory contains conformance inputs; their wire semantics are not changed by the reference's documentation location:

- [vectors.json](vectors.json) — application/semantic payload cases.
- [context-number-vectors.json](context-number-vectors.json) — context numeric boundaries.
- [rule-vectors.json](rule-vectors.json) — client rules and resolved interpretation.
- [rule-number-vectors.json](rule-number-vectors.json) — rule numeric boundaries.
- [highlighting-limits.json](highlighting-limits.json) — shared limit expectations.
- [source-hint-vectors.json](source-hint-vectors.json) — SOURCE language-selection revision, optional/null/empty language semantics, curated shebang-to-language aliases and detector boundaries exercised by both TypeScript and Rust.

The JSON files remain repository-only historical inputs. They do not establish compatibility of the v4 implementation or any released v3 binaries.
