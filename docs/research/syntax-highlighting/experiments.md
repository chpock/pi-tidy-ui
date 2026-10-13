# Local diagnostic experiments

Date: 2026-10-06. These research probes do not alter production dependencies or the renderer. They are not an implementation acceptance run.

## Environment and reproduction

- Repository working tree, including pre-existing file-card changes; HEAD `5a238ae22ced17501179e0d4adc55a635c7fc4e6`.
- Node 26.7.0, Pi 1.0.0, highlight.js 10.7.3.
- Shiki 4.5.0, web-tree-sitter 0.27.0, @vscode/tree-sitter-wasm 0.3.1, Lezer JavaScript 1.5.6/Python 1.1.19/highlight 1.2.5 and highlight.js 11.12.0 installed with scripts disabled in an isolated temporary directory outside the repository. The historical temporary pathname is omitted during branding normalization; the reproduction commands below use the current name. No repository package manifest/lockfile modification by this research. A concurrent manifest change adding the existing write specification to the package file list was observed and left untouched.
- No model requests, CLI replay, renderer replacement or file rereads.

```sh
node docs/research/syntax-highlighting/probes/current-highlight.mjs
npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 \
  --no-package-lock --ignore-scripts --no-audit --no-fund shiki@4.5.0
node --expose-gc docs/research/syntax-highlighting/probes/shiki-highlight.mjs oniguruma
node --expose-gc docs/research/syntax-highlighting/probes/shiki-highlight.mjs javascript
```

`SHIKI_RESEARCH_ROOT` can override the isolated install directory. The current-Pi probe uses installed private SDK files **only for diagnostic initialization/inspection**, never as a proposed production import.

## What was tested

1. Raw highlight.js grammar HTML, actual native foregrounds in xterm, and pi-tidy-ui's actual file-card foregrounds: **419 compared source cells, all equal** across seven ASCII samples, width 100.
2. Shiki core with nine explicitly requested grammar modules and a custom TextMate theme derived from **Pi's actual syntax roles**, rather than a hardcoded VS Code palette. The core also registered internal embedded languages/aliases; those are not nine more independent language families.
3. Both Oniguruma and strict JavaScript regex engines: **7/7 exact reconstructed-source assertions** per engine; exact token/color/scope output equal between engines for all seven samples.
4. Tokenization-only timing for the same 1000-line / 58,889-UTF-16-unit TypeScript source, with 21 calls per highlighter per process (first + 20 repeats). Shiki timing disables explanatory scope output.

## Quality observations

| Sample | Native ordinary/default cells | Shiki ordinary-color cells | Non-whitespace total |
|---|---:|---:|---:|
| TS expression | 44 | 9 | 49 |
| TS interface/function | 31 | 13 | 90 |
| Python expression | 45 | 47 | 53 |
| Rust expression | 35 | 10 | 38 |
| HTML element | 11 | 15 | 54 |
| Shell command | 19 | 7 | 42 |
| Vue embedded TS | no resolved language; uniform fallback | 11 | 48 |

This is not a universal ranking. The count measures **visible differentiation under the chosen host-role theme**, not parser correctness. Operators/punctuation/comments intentionally sharing `toolOutput` count as ordinary even when recognized. Native foreground resets can restore terminal default; both ordinary/default states are counted in its column. Shiki does not exhibit that composition behavior because these results are structured tokens, not ANSI-wrapped rows.

In the TS expression, Shiki actually supplies `variable.other.constant.ts` for `result`, `entity.name.type.ts` for `User`, `variable.other.object.ts` for `client` and `user`, `entity.name.function.ts` for `fetch`, and `variable.other.property.ts` for `id`. That is directly useful extra syntax information, not just brighter paint.

**Negative result worth retaining:** the shipped Python TextMate grammar leaves ordinary identifiers largely unscoped in this sample and uses `meta.function-call.generic.python` around the call name rather than the generic `entity.name.function` family. Our generic host-role theme does not add a language-specific rule for it. Shiki is therefore not an automatic all-language cure. Neither recoloring every generic `source.python` span nor treating every `meta` scope as a variable is a valid correction: that would hide classification gaps. A production mapping can add accurate documented language-specific scope rules, but ordinary identifier scopes still cannot be invented by theme rules.

For HTML the base-colored count rises slightly even though names, attributes and strings remain recognized. More colors or fewer base cells alone is not an acceptance criterion. Preserve grammatical distinctions and evaluate intended examples visually.

## Timings observed, not a speed guarantee

| Process | Shiki module/engine/grammar initialization | Pi first / median / p95, ms | Shiki first / median / p95, ms |
|---|---:|---|---|
| Oniguruma | 95.96 ms | 51.56 / 22.59 / 30.76 | 128.02 / 117.26 / 134.69 |
| JavaScript | 37.40 ms | 37.71 / 21.29 / 24.97 | 129.40 / 115.72 / 119.60 |

The native calls include HTML-to-ANSI conversion, while Shiki returns tokens and would still need terminal serialization. Grammar detail is different; this is not equal work. Both engines had already processed the diagnostic samples before the large-source call, so "first" means first large-input call, not fresh-process engine startup. Oniguruma and JavaScript processes ran sequentially once, not in randomized repeated trials.

The result rejects a convenient assumption that replacing Pi with Shiki will necessarily be faster. It does **not** predict actual diff UI latency or compare Tree-sitter. An unchanged retained pi-tidy-ui layout should call either engine **zero times**, independent of tokenizer speed. Width/theme invalidation currently rebuilds source; adding another source-token cache would be an explicit architecture/memory decision, not a free optimization.

The raw outputs include RSS/heap/external deltas measured after initialization and **both** native and candidate workloads. They include allocator/JIT/process effects and can contain negative deltas after GC. They cannot be attributed to retained engine memory or used to prove an engine memory budget. A later implementation gate must isolate post-init engine/grammar retention, transient peak and retained rendered layouts separately.

## Portable Tree-sitter Python control

A separate probe uses web-tree-sitter 0.27.0, the Python WASM grammar from @vscode/tree-sitter-wasm 0.3.1, and the **complete upstream** Python highlights query pinned at [`26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64`](https://github.com/tree-sitter/tree-sitter-python/blob/26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64/queries/highlights.scm). The archived query retains its upstream MIT license. No handcrafted identifier regex was substituted.

```sh
npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 \
  --no-package-lock --ignore-scripts --no-audit --no-fund \
  web-tree-sitter@0.27.0 @vscode/tree-sitter-wasm@0.3.1
node docs/research/syntax-highlighting/probes/tree-sitter-python.mjs
```

The same Python expression parses without errors and yields `variable` captures for `result`, `client`, `user`, `fallback`, `function.method` for `fetch`, and `property` for `id`/`active`. **41 of 53 non-whitespace positions** are covered by variable/property/function captures. That is a raw classification observation, not a final-color comparison against the Shiki table. Captures overlap: `fetch` is simultaneously captured as variable, method and property. A complete renderer must resolve overlap/priority correctly; the probe deliberately does not pretend raw query execution is a finished highlighting library.

Initialization including one grammar/query was 35.52 ms in this one process. A separate 1000-line Python input (62,889 UTF-16 units) took 78.29 ms first, 44.18 ms median and 54.04 ms p95 across 21 parse-plus-capture calls. Those numbers are **not comparable** to the TypeScript Shiki workload, and omit overlap resolution, injections, ANSI serialization and UI. The control establishes portable-runtime feasibility and richer Python name recognition, not universal speed superiority or OpenCode equivalence.

## Lezer and modern highlight.js controls

A late pure-JS comparison tests current `@lezer/javascript@1.5.6`, `@lezer/python@1.1.19`, `@lezer/highlight@1.2.5` and `highlight.js@11.12.0` without an editor/DOM runtime. Lezer uses `highlightTree` + `tagHighlighter` to produce Pi-role spans. All three TS/Python examples reconstruct their source exactly.

```sh
npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 \
  --no-package-lock --ignore-scripts --no-audit --no-fund \
  @lezer/javascript@1.5.6 @lezer/python@1.1.19 @lezer/highlight@1.2.5 highlight.js@11.12.0
node docs/research/syntax-highlighting/probes/pure-js-highlight.mjs
```

For the first TS expression Lezer assigns variables to `result`/`client`/`user`/`id`/`fallback`, type to `User`, and function to `fetch`. Ordinary-role non-whitespace count is **9/49**. For the interface/function example it is **13/90**. For Python it classifies ordinary names/properties/call name, with **41 name-role cells** and **6/53 ordinary-role cells** (operators/punctuation share the ordinary host color). This is a structured role projection, **not a physical candidate terminal-cell test**.

Modern highlight.js 11.12.0 is materially better than Pi's 10.7.3 on the TS expression: its HTML adds `attr` for `result`, `title class_` for `User`, `title function_` for `fetch`, and `property` for `id`. `client`, `user`, `fallback` remain plain. Its Python example stays sparse. Therefore the old-version finding must not be attributed unchanged to all versions of highlight.js. Pi's 10.x HTML mapper reads only the first `hljs-*` class and does not understand the modern secondary `class_`/`function_` discriminator: dropping modern HTML into that mapper is not a correct upgrade.

Lezer module/two-grammar/style initialization was **19.70 ms** in this process. On the same 1000-line/58,889-unit TS source as the Shiki control, Lezer parse-plus-role-span median was **30.25 ms** (first 49.55, p95 36.41); modern highlight.js HTML median **30.14 ms** (first 37.72, p95 41.80). These numbers strengthen Lezer as an efficient **candidate** on the observed workload, not a universal speed guarantee: different output representations, grammar coverage, separate runs and no terminal serialization/UI remain important limits. No Bash or multi-language Lezer embedding control was run.

## Package sizes observed from npm

For version 4.5.0, registry `dist.unpackedSize`:

| Package | Bytes |
|---|---:|
| `shiki` | 602,495 |
| `@shikijs/langs` | 8,650,980 |
| `@shikijs/engine-oniguruma` | 643,892 |
| `@shikijs/engine-javascript` | 12,108 |

These are **individual unpacked packages**, not total dependency size, a tree-shaken bundle, downloaded bytes or loaded heap. The JS engine's small own package excludes its translator dependencies. Shiki declares Node >=20 and MIT; that declaration does not replace testing on pi-tidy-ui's minimum Node 22.19.0.

## Recorded evidence

- [`current-highlight-output.jsonl`](probes/current-highlight-output.jsonl)
- [`shiki-oniguruma-output.jsonl`](probes/shiki-oniguruma-output.jsonl)
- [`shiki-javascript-output.jsonl`](probes/shiki-javascript-output.jsonl)
- [`current-highlight.mjs`](probes/current-highlight.mjs)
- [`shiki-highlight.mjs`](probes/shiki-highlight.mjs)
- [`tree-sitter-python.mjs`](probes/tree-sitter-python.mjs)
- [`tree-sitter-python-output.jsonl`](probes/tree-sitter-python-output.jsonl)
- [`python-highlights.scm`](probes/python-highlights.scm) and [upstream license](probes/python-query-LICENSE.txt)
- [`pure-js-highlight.mjs`](probes/pure-js-highlight.mjs)
- [`pure-js-highlight-output.jsonl`](probes/pure-js-highlight-output.jsonl)

## Remaining gates

No multi-language Tree-sitter comparison, minimum-Node run, semantic-token service, corpus-wide ranking, terminal ANSI candidate adapter, real CLI/replay check, hostile-input timeout test or integration memory test was performed. The official Shiki docs warn about precompiled JS grammars; those were deliberately not used. These experiments establish feasibility and limitations, not implementation approval.
