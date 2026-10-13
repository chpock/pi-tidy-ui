# Evidence audit: syntax-highlighting research and final synthesis

**Scope:** three external reports; finalized `README.md`, `current-implementation.md`, `opencode.md`, `shiki-pierre-hunk.md`, `alternatives.md`, `experiments.md`; selected probe sources/raw outputs; fresh upstream sources. No executions or project edits.

## 1. Verified claims

**Final synthesis: supported as a weighted architectural recommendation, not proven superiority.**

The [README](README.md) explicitly prioritizes OpenCode alignment, name classification and future Bash reuse while acknowledging operational complexity, competitive Lezer results and unpassed implementation gates. No material factual correction is required.

Supporting evidence includes:

- OpenCode’s pinned Edit path uses Tree-sitter-based OpenTUI highlighting, with separate syntax/theme and diff-background handling.
- [Tree-sitter Bash’s pinned query](https://github.com/tree-sitter/tree-sitter-bash/blob/v0.25.0/queries/highlights.scm) captures commands, variables, strings/heredocs, substitutions and operators. This supports a shared parser-family proposal—not completed Bash integration.
- The freshly inspected [official Lezer catalog](https://lezer.codemirror.net/#grammars) lists no Bash grammar. This supports the README’s qualified wording, not an assertion that no third-party grammar exists.
- The new [pure-JS probe source](probes/pure-js-highlight.mjs) and [output](probes/pure-js-highlight-output.jsonl) substantiate Lezer’s useful TS/Python roles, source-reconstruction assertions and recorded 30.25 ms TS median. They do not establish physical terminal colors or general speed superiority.

**Confidence:** high within these stated boundaries.

## 2. Contradicted claims

No material assertion in the finalized reports was contradicted.

The potential shortcut **“feed modern highlight.js into Pi’s unchanged HTML mapper” is contradicted**. The finalized reports correctly reject it:

- [Official scope documentation](https://highlightjs.readthedocs.io/en/latest/css-classes-reference.html) and [11.12.0 renderer source](https://github.com/highlightjs/highlight.js/blob/11.12.0/src/lib/html_renderer.js) encode hierarchical scopes as multiple classes: `title.class` → `hljs-title class_`; deeper components receive additional underscores.
- Installed Pi’s `dist/utils/syntax-highlight.js:66–77` extracts only the first `hljs-*` class.
- Its `dist/modes/interactive/theme/theme.js:719–746` maps `title` to function color and lacks `property`.
- The recorded modern TS output uses these distinctions for `User`, `fetch` and `id`.

**Required correction for any future adapter:** preserve complete hierarchical scope information before role selection, including deeper scopes; map modern properties explicitly. Adding theme entries alone cannot recover classes discarded by decoding.

## 3. Weak / unclear / unsupported claims

**Broad engine superiority remains unclear.** “Strongest alternative” and “closest match” are selection judgments, not experimentally established overall rankings.

The final README already qualifies them appropriately:

- Lezer has demonstrated TS/Python role spans; Tree-sitter’s local control has Python raw, overlapping captures.
- No equivalent Tree-sitter TS control or shared terminal serializer was compared.
- Lezer/Shiki TS timing uses the same source, but different classification/output work and separate runs.
- Shiki’s Python negative result includes both grammar limitations and the chosen generic theme mapping; it is not proof that every Python syntactic distinction is unavailable.

**Implication:** no wording blocker remains when these labels retain their explicit weighting. Proven universal superiority is unnecessary for a recommendation, but cannot be claimed as its evidence.

## 4. Material source-quality concerns

- **Actual Hunk versions verified:** [pinned lockfile](https://github.com/modem-dev/hunk/blob/a3321c829d8bd8b39fe1c41e1b2537e41e82354c/bun.lock), worker source and [published Pierre 1.3.5 code](https://cdn.jsdelivr.net/npm/@pierre/diffs@1.3.5/dist/highlighter/shared_highlighter.js) support Pierre 1.3.5 → Shiki 3.23.0 with explicit WASM selection. Independent latest repository versions must not replace that evidence.
- **OpenCode source pins do not pin remote queries:** its parser configuration contains mutable URLs. Deterministic local assets are therefore a necessary deployment choice.
- **Language totals are inventories:** Prism/highlight.js catalog counts and Shiki’s versioned compatibility samples do not measure equivalent quality or pi-tidy-ui coverage.
- Audit `source_check` calls returned **unclear** because automated semantic assessment was unavailable. Conclusions rely on manually inspected primary passages.

## 5. Missing evidence

All remain **missing evidence**, not established defects:

1. **Minimum Node 22.19.0 execution.** Probes used Node26. Native OpenTUI’s [Node26.4 requirement](https://opentui.com/docs/getting-started/runtime-support/) excludes that rendering stack, not standalone `web-tree-sitter`.
2. **Selected grammar/query matrix:** Bash predicates, aliases, embeddings, TSX, Rust and broader Python cases. OpenCode’s `shellscript`/`bash` mismatch is real; end-to-end registration and rendering remain unverified.
3. **Candidate terminal adapter:** resolved capture precedence, exact source preservation, Unicode/tabs, foreground resets, both themes and existing diff backgrounds.
4. **Actual performance/ownership:** initialization, event-loop blocking, long inputs, isolated retained memory, transient peaks, disposal and zero highlighting on unchanged cached layouts.
5. **Historical-context policy:** independent contiguous segments avoid invented adjacency but cannot recover unknown incoming state. No parser guarantees full-file-equivalent colors from omitted source.
6. **Production acceptance:** real CLI/native/replay equality, offline packaging, asset provenance and complete selected-license inventory.

The README explicitly carries these gates; none is falsely reported as passed.

## 6. Material contradictions

None established in the final synthesis.

This audit supersedes the earlier missing-Lezer-control finding: the late control closes the documentation-only gap, not the broader deployment/comparison gaps.

Shiki’s historical “all built-ins supported as of 3.9.1” and later 4.4.3 unsupported `ahk2` result are version-dependent evidence—not universal parity.

## 7. Implications for the original conclusion

**No material evidence blocker to the final research recommendation.** Standalone Tree-sitter/WASM with pinned assets is defensible under the stated priorities. Lezer remains a serious lower-integration alternative; Shiki remains a broad TextMate alternative.

This is **research acceptance only**. It does not authorize implementation or attest that the chosen runtime, assets, terminal adapter or performance gates have passed.