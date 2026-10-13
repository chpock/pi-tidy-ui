# Shiki, Pierre and Hunk

Research snapshot: 2026-10-06.

## Pins and actual dependency chain

- Shiki [`f7d0167873fd676fe4e190bc9b53832fba9ee01d`](https://github.com/shikijs/shiki/commit/f7d0167873fd676fe4e190bc9b53832fba9ee01d), **4.5.0**.
- Pierre [`76be81111d743aee4137036dbe35f5e62ab6f21b`](https://github.com/pierrecomputer/pierre/commit/76be81111d743aee4137036dbe35f5e62ab6f21b), `@pierre/diffs` **1.5.2**.
- Hunk [`a3321c829d8bd8b39fe1c41e1b2537e41e82354c`](https://github.com/modem-dev/hunk/commit/a3321c829d8bd8b39fe1c41e1b2537e41e82354c), `hunkdiff` **0.23.0**. Its workspace pins Pierre **1.3.5** and Shiki **3.23.0**: latest independent heads are not its actual dependency versions.

The proposed chain is real, but its boundaries matter:

```text
Hunk highlighting worker
  → Pierre headless diff/file highlighting
  → Shiki
  → HAST (structured HTML nodes)
  → Hunk text/color/word-diff projection
  → Hunk terminal renderer
```

Hunk's [worker runtime](https://github.com/modem-dev/hunk/blob/a3321c829d8bd8b39fe1c41e1b2537e41e82354c/packages/hunk/src/ui/diff/worker/highlightWorkerRuntime.ts) imports Pierre's shared highlighter and rendering helpers; its [HAST projection](https://github.com/modem-dev/hunk/blob/a3321c829d8bd8b39fe1c41e1b2537e41e82354c/packages/hunk/src/ui/diff/worker/highlightHast.ts) flattens their output into terminal-oriented runs. This is headless Pierre reuse, **not** placing Pierre's browser DOM component in a terminal.

Hunk explicitly selects **`shiki-wasm`**, even though current Pierre defaults to the JS engine. Hunk's [Bun WASM adapter](https://github.com/modem-dev/hunk/blob/a3321c829d8bd8b39fe1c41e1b2537e41e82354c/packages/hunk/src/lib/shikiWasm.ts) is not portable Node 22 code. Taking the entire Hunk renderer would also introduce OpenTUI/Bun dependencies unrelated to tokenization.

## What Shiki provides

Shiki uses **TextMate grammars**, based on regexes and per-line grammar state. It is not Tree-sitter and does not run LSP semantic-token analysis. Its maintained language bundle is broad, includes embedded-language support and is designed around VS Code-style scopes/themes.

Relevant direct APIs:

- [`codeToTokens`](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/packages/core/src/highlight/code-to-tokens.ts): tokens/foreground/background/theme/grammar state.
- [`codeToTokensBase`](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/packages/primitive/src/highlight/code-to-tokens-base.ts): arrays of line tokens with content, UTF-16 string offsets, colors and font-style bits.
- [`@shikijs/cli` codeToANSI](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/packages/cli/src/code-to-ansi.ts): useful ANSI serialization reference, but its appended line endings and bundled-theme interface are not exact pi-tidy-ui row behavior.

Prefer **direct tokens**, not HTML/HAST parsing, when integrating solely syntax highlighting into existing pi-tidy-ui rows. `lang: 'ansi'` means parsing existing ANSI input, not source-to-ANSI highlighting. Token offsets are not terminal-cell widths; grapheme/wide-character layout remains pi-tidy-ui's responsibility.

## Host-theme integration

A custom TextMate theme can map selectors to Pi's current roles:

- comments → `syntaxComment`
- keywords/storage → `syntaxKeyword`
- type/class names → `syntaxType`
- function names → `syntaxFunction`
- variables/properties/attribute names → `syntaxVariable`
- strings/numbers/operators/punctuation → their corresponding roles

Use actual active-theme colors or deliberately interpreted role labels; do not install a global VS Code theme. Preserve token foreground separately from diff/background paint. Mapping many scopes into Pi's few roles is a product choice: adding grammars does not make comments/operators/punctuation visibly distinct when the host palette assigns them the same color.

Language-specific selectors are sometimes necessary. The tested Python grammar uses `meta.function-call.generic.python` for the call name and leaves ordinary identifiers largely without variable scopes. Painting every `meta`/`source.python` span as a variable would disguise missing classification rather than solve it.

`includeExplanation: 'scopeName'` is useful for diagnostics, but the tokenizer runs both `tokenizeLine` and `tokenizeLine2` for explanatory output. Keep it out of the routine hot path; a proper custom theme resolves scopes during tokenization without per-frame explanation parsing.

## Bash and embeddings

The [shellscript grammar](https://cdn.jsdelivr.net/npm/@shikijs/langs@4.5.0/dist/shellscript.mjs) has aliases `bash`, `sh`, `shell`, `zsh`; Fish is separate. The local command example gained real variable/command classification, not just generic keyword coloring.

HTML supplies JS/CSS embeddings. The [registry](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/packages/primitive/src/textmate/registry.ts) and [resolver](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/packages/primitive/src/textmate/resolver.ts) support embedded grammars and `injectTo`/`getInjections`; missing dependencies and lazy loading need deliberate handling. Shiki does not automatically discover installed VS Code extensions.

Shell syntax is a credible future reuse target. Highlight the command **without** its synthetic `$ ` prompt and carry state across command lines/heredocs before wrapping. Do not color arbitrary command output as Bash source. Native user Markdown replacement is also outside this research's implementation scope.

## Engines, startup and compatibility

[Official engine guide](https://shiki.style/guide/regex-engines):

| Engine | Mechanism | Relevant trade-off |
|---|---|---|
| Oniguruma | C regex engine compiled to WASM | Strong grammar compatibility; async WASM initialization; no platform `.node` addon |
| JavaScript | Oniguruma regexes translated to JS RegExp | No Oniguruma WASM; translator startup/compatibility and runtime RegExp features matter |

Shiki 4.5.0 declares Node >=20. Node 22's RegExp UnicodeSets support satisfies the documented modern JS target, but minimum-Node behavior was **not executed** in the local probes.

Strict JS rejects unsupported grammar patterns. `forgiving: true` can hide conversion failures and produce mismatched highlighting; it is not a correctness fix. **Precompiled JS grammars were excluded**: the engine guide explicitly warns of a known issue despite their mention in the performance guide.

The official prose that all built-ins are supported is broader than the pinned [compatibility report](https://github.com/shikijs/shiki/blob/f7d0167873fd676fe4e190bc9b53832fba9ee01d/docs/references/engine-js-compat.md): Shiki **4.4.3**, Node **24.16.0**, 2026-09-11, **237/238 sampled languages**, zero output mismatches, `ahk2` unsupported. That is not proof of all grammars or Node 22 parity. The seven local sample outputs match across both engines, also not universal proof.

Loaded instance token methods are synchronous; initialization/language loading can be asynchronous. Reuse one owned instance and explicitly dispose it. Do not initialize a highlighter per row/card. A render callback must not receive a Promise disguised as a synchronous token result.

## Missing-context limitations

[Grammar-state APIs](https://shiki.style/guide/grammar-state) preserve state derived from **supplied** context. They cannot infer delimiters in absent historical lines. Old/new states can differ; disjoint hunks must not be treated as one contiguous file. Independent fragments remain best-effort if their enclosing context is unknown. Do not reread today's disk file as historical truth.

The pinned tokenizer's per-line default 500 ms time limit is not a whole-document latency guarantee. A maximum-line-length skip can also lose later lexical state. Any large-input fallback needs explicit tests and documented limitations, not silent truncation.

## What the local controls actually show

See [experiments.md](experiments.md) for source, raw output and precise caveats.

- TS expression: ordinary-color count **44/49 → 9/49**; actual type/function/property/variable scopes were added.
- Rust expression: **35/38 → 10/38**.
- Shell command: **19/42 → 7/42**.
- Python: **45/53 → 47/53** under the tested generic Pi-role theme; no automatic identifier-coloring cure.
- HTML also had slightly more base-colored cells; counts are not a correctness score.
- For the tested 1000-line TS input, Shiki tokenization medians were about **116–117 ms**, versus native Pi HTML-to-ANSI about **21–23 ms** in these single-run controls. Different classification/output work; no universal speed claim or UI-latency estimate follows.

Thus Shiki is a credible **quality/breadth** option, not a justified performance optimization. Existing warm rendered-layout hits should still make zero tokenization calls. Source-token caching or workers require measured justification and ownership/accounting, not adoption of Hunk's entire infrastructure.

## Packaging and licenses

[Selective imports](https://shiki.style/guide/best-performance) reduce imported/bundled work. In this unbundled extension, importing `shiki/core` through the umbrella dependency does **not** remove other packages from the installed dependency tree. Direct scoped dependencies and deliberate local asset packaging are separate deployment decisions. Individual npm package sizes are in [experiments.md](experiments.md#package-sizes-observed-from-npm); they are not total disk/heap figures.

Shiki and Hunk root licenses are MIT; [Pierre diffs](https://github.com/pierrecomputer/pierre/blob/76be81111d743aee4137036dbe35f5e62ab6f21b/packages/diffs/LICENSE.md) is Apache-2.0. Preserve notices and inspect actual selected grammar/transitive assets. A complete license/installed-footprint audit was not performed.

## Decision relevance

Shiki has the most convenient broad maintained grammar/theme ecosystem among the JS-first candidates studied, and direct tokens fit terminal rendering well. It is the strongest alternative if broad TextMate/VS Code-compatible coverage and simpler deployment outweigh matching OpenCode's identifier classification. For the stated sparse-code complaint, retain the Python negative control and do not choose it on reputation alone. Pierre/Hunk are useful design references, not necessary production dependencies for pi-tidy-ui syntax highlighting.
