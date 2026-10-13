# Tree-sitter versus Shiki: measured selection

Date: 2026-10-06. Status: research and advisory review complete. Research only; no production renderer, dependency, or cache-contract change is approved here.

This study supersedes the initial recommendation in README.md. It compares Tree-sitter native and WASM bindings with Shiki's JavaScript and Oniguruma engines, including growing source, rather than inferring performance from OpenCode or from parser architecture.

## Recommended decision

**Select Shiki as the shared highlighting technology, with Oniguruma as the preferred engine.** Do not import an editor or diff-rendering framework. Use structured color tokens, not HTML. Preserve the distinction between a preferred technology and acceptance of an implementation.

Reasons, in order:

1. The verified Shiki 4.5.0 registry supplies 242 canonical IDs (104 aliases excluded), with integrated grammar dependencies and embeddings. Tree-sitter has viable assets for all 21 investigated language entries, but requires a highlighting layer and several non-turnkey distribution/query adaptations.
2. Both support reuse for growing source. Saved line state is particularly effective for append-heavy source; Shiki/Oniguruma wins the tested Bash and growing-function append adapters. Tree-sitter's incremental parsing alone does not make the complete highlighter incremental.
3. The tested Shiki adapters have lower stress-process resident memory and substantially less capture-materialization overhead. This is not an engine-only byte count or a universal memory ranking.
4. Classification quality depends on grammars/queries, not simply regex versus syntax tree. Shiki's ordinary Python names remain a confirmed limitation; the bundled Tree-sitter Rust query has the inverse ordinary-name limitation. Neither is universally richer.
5. Oniguruma is preferred over JavaScript RegExp because the real pi-tidy-ui TypeScript source and tested growing Bash/function workloads cost substantially less. Pure JS has cheaper initialization and wins some complete Python/Rust workloads, not the overall measured use case.

**Main counterargument:** Tree-sitter/WASM is markedly faster on complete unembedded sources, the real TypeScript source snapshot, and local edits in this study. A project prioritizing these costs over integrated breadth and append behavior could reasonably select Tree-sitter. This advantage is retained in the tables, not explained away.

No silent workaround for Python names is approved. A theme cannot invent missing classifications. Loading a different maintained grammar/query is a separate quality decision with its own provenance, not proof that the engine's default bundle solved the problem.

## What incrementality actually means

### Tree-sitter

[The editing API](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html) adjusts the retained old tree with an edit, then reparses with that tree. Unchanged structure can be reused. Appending text is a supported edit, not a special exclusion.

That does not automatically cache or update colors. The host still executes highlight queries, resolves overlapping captures, handles locals/injections, and creates terminal spans. Later input can change earlier syntax. `getChangedRanges` alone is insufficient: a same-shape identifier edit can alter text-based highlighting predicates without altering tree shape.

Two measured adapters:

- `full`: incremental parse, full-tree highlight query/projection.
- `range`: incremental parse, query from the conservatively affected top-level construct through the suffix; retain the earlier spans. Actual full/incremental equality is checked at every tested revision. A growing function intentionally invalidates its top-level construct, demonstrating the cost of this safe policy. More precise structural invalidation is possible, but was neither implemented nor assumed free.

These are research Node/web binding adapters, **not the complete Rust `tree-sitter-highlight` engine**. They omit locals and injections and use an explicit overlap policy. Do not generalize their costs to every native Tree-sitter integration or promise OpenCode parity.

### Shiki

[GrammarState](https://shiki.style/guide/grammar-state) carries the preceding grammar state. Obtain it from the returned token array, without separately tokenizing the source again. Keep checkpoints for completed lines; on append, retokenize the unfinished last line from its preceding checkpoint and process the new lines. An arbitrary mid-line chunk is not a new independent line.

The measured adapter uses public token/state APIs, not private stack equality. A middle edit retokenizes the suffix; no state-convergence optimization is assumed. This is less efficient than the tested Tree-sitter range adapter for several middle-edit cases.

Both require an explicitly owned live-source state. That is separate from pi-tidy-ui's current rendered-only LRUs. No new production AST/token cache or lifecycle is authorized by this research.

## Reproducible method

- Official Linux x64 **Node 22.19.0**, verified archive SHA256 **`c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2`**.
- CPU: Intel Core Ultra 5 125H. Host Node 26 is not used for these results.
- Shiki 4.5.0; native tree-sitter 0.25.1; web-tree-sitter 0.27.0; TS/TSX 0.23.2, Python 0.25.0, Bash 0.25.1, Rust 0.24.0; exact transitive dependencies in the archived lockfile.
- Parser grammars and queries come from the pinned published grammar packages, including their own WASM artifacts. TypeScript uses JavaScript plus TypeScript highlight queries; TSX additionally uses the JSX query. Installed CSS requires asynchronous ESM loading, handled outside highlighting.
- Four language families loaded for measured timing/memory processes: TypeScript, Python, Bash, Rust. Shiki also registers required embedded languages/aliases. Nine language entries are tested for quality/text/equivalence.
- **48 final retained measurement records, each from a fresh process:** 20 timing (5 per configuration, rotated execution order), 12 memory (3 per configuration, separately executed), 16 phase profiles (one each for 1k/10k TS/Bash and each configuration).
- Each full-input timing takes 9 calls (first reported separately; aggregate uses the median of 8 later calls). Results below are medians of the 5 process medians. This is not a universal throughput score or a statistically powered all-language benchmark.
- All timing adapters return contiguous normalized category spans, then use the same foreground-only ANSI serializer. Different grammars produce different spans; equal inputs/output format are not equal classification work. No diff tint, wrapping, frame, TUI scheduling or real candidate CLI replay is timed.
- Shiki diagnostic explanations are disabled in timing. Diagnostic scope output is separately captured for quality; it runs an additional tokenizer pass. Time/line caps are disabled so truncation cannot masquerade as a speed win.
- Exact source/ANSI reconstruction includes tabs/newlines and Unicode comments; every tested incremental revision must equal a fresh full highlight under the same engine. Both runtimes within each family must produce equal role spans for the nine samples. Repeated identical source updates explicitly require zero parse/query/tokenization work.
- Real input: archived, hash-identified pi-tidy-ui `src/file-card.ts` snapshot, **20,001 UTF-16 units, 363 lines**; the SHA256 is recorded in every timing result.
- Stress sources: 10,000 generated statements per language; Rust wraps them in a function so the full source is syntactically valid. Twenty active sessions contain 1,000 statements each. These are stress controls, not evidence of ordinary pi-tidy-ui traffic size or concurrency.

The complete harness, dependency metadata, source snapshot, controls and raw results are in [probes/head-to-head](probes/head-to-head/). `summary.json` is generated from `results.jsonl`, not independently edited.

### Reproduction

```sh
# Outside the project: use the archived dependencies.json as package.json and
# dependencies-lock.json as package-lock.json in HIGHLIGHT_RESEARCH_ROOT.
# npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
export HIGHLIGHT_RESEARCH_ROOT=/tmp/pi-tidy-ui-head-to-head
export RESEARCH_NODE="$HIGHLIGHT_RESEARCH_ROOT/node-v22.19.0-linux-x64/bin/node"
for kind in shiki-js shiki-onig tree-native tree-wasm; do
  "$RESEARCH_NODE" --expose-gc docs/research/syntax-highlighting/probes/head-to-head/run.mjs "$kind" check \
    > "docs/research/syntax-highlighting/probes/head-to-head/check-$kind.json"
done
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/head-to-head/driver.mjs
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/head-to-head/summarize.mjs
```

Native packages loaded without build scripts on this Linux x64/Node22 host. This is not an all-platform prebuild guarantee; selected packages have inconsistent peer version ranges. No root package manifest/lockfile was changed.

## Full highlighting: spans plus common ANSI, ms

| Input | Native Tree-sitter | Tree-sitter WASM | Shiki JS | Shiki Oniguruma |
|---|---:|---:|---:|---:|
| TypeScript, 1,000 statements | 94.8 | **61.5** | 161.3 | 146.0 |
| Python, 1,000 statements | 82.1 | 61.2 | **44.7** | 139.2 |
| Bash, 1,000 statements | 36.5 | **23.9** | 45.0 | 59.6 |
| Rust, 1,000 statements in function | 73.6 | **41.9** | 46.2 | 135.0 |
| Actual pi-tidy-ui TS source snapshot | 25.9 | **14.6** | 257.9 | 68.3 |
| TS single line, 26,902 units | 47.4 | **27.1** | 77.1 | 125.7 |

The actual TS input exposes a much larger JS/Oniguruma difference than the original repetitive TypeScript probe. Shiki's JS regex path is not simply a universally faster WASM replacement. Native Tree-sitter's per-node binding/marshalling costs also make it slower than its WASM counterpart here; cache repeated node getter reads rather than timing accidental repeated crossings.

Cold import/engine/4-language initialization medians: native Tree-sitter **87.1 ms**, WASM Tree-sitter **106.0 ms**, Shiki JS **41.7 ms**, Shiki Oniguruma **77.4 ms**. This is engine/grammar readiness, not first render or first-use compilation; grammar/regex warm-up is separately reflected in raw first-call and memory data.

## Growing source: total work over 32 chunks, ms

Each chunk can end mid-line, quote or Unicode sequence. Source ends with about 120 generated statements plus quality controls; the same source/chunks are used for all configurations. These are measured adapters, not theoretical best possible implementations.

| Input | Tree WASM full query | Tree WASM range query | Shiki JS state | Shiki Oniguruma state |
|---|---:|---:|---:|---:|
| TypeScript statements | 79.5 | **28.3** | 90.1 | 30.4 |
| Python statements | 80.1 | 27.0 | 49.1 | **23.7** |
| Bash command source | 34.2 | 19.0 | 26.3 | **11.9** |
| Rust growing function | 50.1 | 48.0 | **18.3** | 25.7 |
| TypeScript growing function | 79.7 | 81.8 | 30.7 | **24.8** |

Maximum-update medians for streamed Bash: Tree WASM range **2.2 ms**, Shiki JS **1.6 ms**, Shiki Oniguruma **0.7 ms**. Growing TS function: **5.7 / 1.9 / 1.8 ms** respectively. These are medians of each process's maximum update, not a worst-case responsiveness guarantee.

Native Tree-sitter is slower here too; all native rows and raw counters are retained in the summary. The contrast between full and range query demonstrates that tree reuse alone leaves substantial recoloring work. The function case demonstrates a limitation of this conservative invalidation policy, not impossibility of more precise Tree-sitter invalidation.

Middle equal-length edit around statement 500 of 1,000 (rebuild suffix; common ANSI included):

| Language | Tree WASM range | Shiki JS suffix | Shiki Oniguruma suffix |
|---|---:|---:|---:|
| TS | **25.9** | 98.9 | 79.5 |
| Python | 30.9 | **24.6** | 72.3 |
| Bash | **13.8** | 25.6 | 32.5 |
| Rust | 33.5 | **27.1** | 74.9 |

Shiki's append advantage must not be claimed as an arbitrary-edit advantage. A state-convergence implementation could improve middle edits, but is not the public-API adapter measured here.

## Memory: resident process, live heap and high-water are different

Memory processes run one engine only; each phase forces two GCs. Baseline is the same runner/helper/source-snapshot environment before engine import. RSS includes allocator/JIT/native buffers; `heapUsed` excludes much native/WASM allocation. `external` is not added to `arrayBuffers`, because these overlap. Forced GC/disposal is not an RSS-shrink guarantee.

| Phase: RSS increase from baseline, MiB | Native Tree | Tree WASM | Shiki JS | Shiki Oniguruma |
|---|---:|---:|---:|---:|
| Initialize 4 requested languages | 18.5 | 27.2 | **14.6** | 21.4 |
| Warm each grammar with small source | **18.7** | 42.8 | 66.0 | 50.1 |
| 20 active 1k-statement sessions, before large sources | 294.2 | 189.1 | **117.4** | 128.6 |
| After four 10k-statement full-source workloads | 581.3 | 364.7 | **131.3** | 149.7 |

These final memory rows were refreshed after explicit release of cached session spans; timing/profile paths were unchanged. They describe this adapter/process history, not a retained-byte price per grammar/AST. In particular, active-session deltas include query/projection high-water allocations and cannot be divided by 20 as live AST size.

After the large workloads, Tree WASM live JS heap is about **5.5 MiB**, external about **57 MiB**, while RSS is about **416 MiB**. Thus attributing all 416 MiB to WASM linear memory is demonstrably wrong. Native Tree has still higher resident memory in this adapter despite containing no WASM.

Phase-isolated single-source controls identify where costs arise, before any assertion:

| Fresh process, TS 10k statements, RSS MiB | Native Tree | Tree WASM | Shiki JS | Shiki Oniguruma |
|---|---:|---:|---:|---:|
| After input, before processing | 70.9 | 74.4 | 66.7 | 74.7 |
| After parse / TextMate tokenization | 93.5 | 97.9 | 121.0 | 130.7 |
| After materializing query captures (Tree only) | 230.5 | 215.1 | — | — |
| After normalized-span projection | 271.8 | 257.0 | 125.9 | 136.5 |
| After common ANSI serialization | 272.0 | 257.1 | 150.1 | 160.5 |

`assertText` adds additional allocations after these phases; it is excluded from timed calls and final large-workload memory phases. The profile records its contribution separately. The substantial Tree increase already exists during JS capture materialization and projection, not only during assertion and not only in the parser.

Live-session JS heap points in the other direction: before the large workloads, twenty active sessions add about **53 MiB above the warm heap for Shiki Oniguruma**, versus **26 MiB for Tree WASM**. These figures exclude relevant native/WASM memory. Lower Shiki stress RSS must not be rewritten as universally lower live heap or smaller per-session state.

This does **not** prove an inherent Tree-sitter leak or that a custom native full highlighter returning compact spans would have the same footprint. That alternative is a different, unmeasured integration. Native deallocation is partly GC-driven; WASM trees/queries/parsers have explicit deletion. Neither warrants a zero-memory or immediate-RSS-return claim.

## Coverage and quality

The [coverage inventory](head-to-head-coverage.md) pins assets for 21 requested entries. Shiki includes all 21 IDs in its 242-ID bundle; related dialects are not independent language families. Tree has concrete sources for all 21, but its total maintained grammar-plus-compatible-query count was not established. Npm grammar presence is not finished highlighting.

Material Tree integration exceptions:

- TS/TSX and C++ need composed queries, not their own supplemental file alone.
- HTML needs an injection interpreter and child grammars for JS/CSS; Markdown requires block/inline/injection layers.
- Svelte uses query inheritance. Vue's upstream queries include editor-specific directives requiring adaptation for ordinary JS bindings.
- SQL and Markdown need additional build/distribution work for the selected WASM route; the current unscoped npm Dockerfile name is a security holding package, not the actual source grammar.
- Local-scope predicates are metadata in ordinary bindings, not automatically evaluated because locals.scm exists.

Quality controls use TS/TSX/JS, Python, Rust, Bash/heredoc/substitution, HTML with JS/CSS, CSS and JSON. They prove exact text and incremental equivalence for this corpus, not all-language conformance.

**Confirmed asymmetric limitation:** ordinary Python names `result`, `client`, `user`, `fallback` are plain under the generic Shiki theme; previous raw scope evidence shows ordinary-name classification missing. Its function-call scope also needs accurate language-specific theme mapping rather than assuming only `entity.name.function`. Tree Python supplies richer ordinary-name captures. Conversely, bundled Tree Rust queries leave ordinary receiver/argument names plain where Shiki's Rust grammar supplies variable scopes. Therefore a structural parser is not sufficient without appropriate highlight queries, and no universally superior quality result follows.

The Tree research adapter deliberately does not implement injections/locals; its embedded HTML code is not a solved full highlighter. Shiki supplies its embedding dependencies. No simplistic bright-cell count is used as a correctness score; raw scopes/captures and normalized role spans are archived separately.

Neither engine reconstructs unavailable diff context, resolves cross-file symbol types like an LSP, or guarantees stable colors for every arbitrary incoming prefix. Unsupported/partial source must remain exact; no code is reread from disk to manufacture missing context.

## Operational implications

- WASM is compiled by V8 into machine code, not translated into JS source. The [V8 compilation pipeline](https://v8.dev/docs/wasm-compilation-pipeline) and these measurements do not support a blanket inefficiency assumption. Startup, linear-memory growth and boundary materialization remain real costs.
- Shiki JS avoids WASM/native binaries; the measured cost is slower actual TS and several append cases. Strict regex compatibility remains a language/version gate. Do not use forgiving error suppression as a quality guarantee.
- Shiki Oniguruma uses WASM but avoids platform-specific native addons and provides the better measured broad default. This preference is evidence-based, not a request to ignore a hard future no-WASM constraint.
- Tree native avoids WASM but introduces native/platform distribution and the measured per-node binding costs. Tree WASM is the stronger Tree configuration observed here.
- Load selected grammars locally/lazily outside synchronous render callbacks. A 242-ID catalogue is not a recommendation to eagerly load 242 grammars. All resource tables concern four requested families, not the full catalogue.
- Source/highlight state for growing cards needs explicit per-live-source ownership and disposal. Do not retain every historical AST merely because incrementality exists.
- Bash syntax applies to `args.command`. `result.content` is arbitrary stdout/stderr and is not automatically Bash source. This boundary comes from current `src/bash-card.ts:58–65,70–89`, not a narrowing of the user's growing-code requirement.
- Both have limits/cancellation caveats; the coverage report documents Shiki per-line timeout/length behavior and Tree parse/query callbacks. This study contains one long-line control, not hostile-input or hard deadline proof. Main-thread responsiveness still needs actual integration verification.

## Review and remaining gates

A fresh [Oracle advisory review](head-to-head-review.md) inspected the final harness, all 48 recorded measurements, source hashes, equality/no-op controls, scope/capture evidence and phase memory profiles without rerunning measurements. It supports Shiki/Oniguruma as a weighted choice and found no blocker in the final synthesis. Its three material limits are explicitly preserved here: asymmetric grammar quality, adapter-dependent performance and process-versus-live memory attribution. This is not independent implementation acceptance.

The original oracle launch failed before model work with a Magic Context turn refusal; worktree/ref were verified and the same session was revived through the native subagent protocol. No alternate execution mode or model was used.

Before implementing: define language/name-role quality acceptance, Pi theme mapping, immutable versus growing state ownership, packaging/notices and the exact call-counter/cache contract. Before acceptance: real candidate CLI/replay, physical terminal colors/tints, current-spec lifecycle/GC checks and actual representative-card responsiveness/memory. This research selects a technology; it does not claim those implementation gates passed.
