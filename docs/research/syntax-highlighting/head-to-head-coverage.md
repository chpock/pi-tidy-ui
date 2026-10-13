# Research: Tree-sitter versus Shiki — actual coverage and integration costs

## Summary

Shiki 4.5.0 supplies **242 canonical bundled IDs, excluding 104 aliases**, including all **21 requested language entries**; these IDs include dialects and are not 242 independent language families. Tree-sitter has concrete grammar-plus-query assets for the requested set, but not one equivalent turnkey bundle: 19 entries have published npm grammar/query packages, Vue needs a pinned source grammar plus query adaptation, and Dockerfile needs a source-distribution route rather than the current unscoped npm package. **Coverage and integration simplicity favor Shiki; structural query control favors Tree-sitter. Neither a WASM recommendation nor a speed/memory winner follows from this evidence.**

Scope: read-only research against local HEAD `1ecdd28ac496b71c82e4c7d98cfa53be1ccec836`. No repository changes, installation, benchmark, tests, staging, or delegation performed. Parent owns Node 22.19 measurements. Existing research was read as a hypothesis, not authority.

## Findings

### 1. Concrete coverage matrix

**Claim:** The table counts usable asset candidates, not repositories, aliases, or successful integration tests. **Support:** direct evidence from versioned npm manifests/file inventories and upstream query files; integration qualifications are interpretation. **Confidence:** high for asset presence; medium for untested end-to-end compatibility.

Conventions: `H` = `queries/highlights.scm`; `I` = injections file shipped; `L` = locals file shipped; `W` = grammar WASM present in the published package, not proof it loads in the selected runtime. Native prebuilds were visible in the ordinary package inventories, but platform coverage varies. Unless qualified, names are npm package names. Every Shiki ID below is in the [v4.5.0 canonical registry](https://github.com/shikijs/shiki/blob/v4.5.0/packages/shiki/src/langs-bundle-full.ts).

| Requested language | Shiki canonical ID | Pinned Tree-sitter grammar + query source | Packaging and material qualification |
|---|---|---|---|
| TypeScript | `typescript` | [tree-sitter-typescript 0.23.2](https://unpkg.com/tree-sitter-typescript@0.23.2/?meta), H + JavaScript H | W; compose JS **0.23.1** queries, not TS H alone; JS I and combined L |
| TSX | `tsx` | Same package, separate TSX grammar; TS H + JS JSX H + JS H | W; JS I/L; JSX is not obtained by TS H alone |
| JavaScript | `javascript` | [tree-sitter-javascript 0.25.0](https://unpkg.com/tree-sitter-javascript@0.25.0/?meta), H | W, I, L; JSX/parameter query files also supplied |
| Python | `python` | [tree-sitter-python 0.25.0](https://unpkg.com/tree-sitter-python@0.25.0/?meta), H | W; no I/L in this package inventory |
| Rust | `rust` | [tree-sitter-rust 0.24.0](https://unpkg.com/tree-sitter-rust@0.24.0/?meta), H | W, I |
| Bash | `shellscript` | [tree-sitter-bash 0.25.1](https://unpkg.com/tree-sitter-bash@0.25.1/?meta), H | W; no I/L shipped; do not promise arbitrary heredoc-language highlighting |
| Go | `go` | [tree-sitter-go 0.25.0](https://unpkg.com/tree-sitter-go@0.25.0/?meta), H | W |
| Java | `java` | [tree-sitter-java 0.23.5](https://unpkg.com/tree-sitter-java@0.23.5/?meta), H | W |
| C++ | `cpp` | [tree-sitter-cpp 0.23.4](https://unpkg.com/tree-sitter-cpp@0.23.4/?meta), C H + C++ H | W, I; add [tree-sitter-c 0.23.1 H](https://unpkg.com/tree-sitter-c@0.23.1/?meta) |
| C# | `csharp` | [tree-sitter-c-sharp 0.23.5](https://unpkg.com/tree-sitter-c-sharp@0.23.5/?meta), H | W (`tree-sitter-c_sharp.wasm`); runtime ABI still needs checking |
| HTML | `html` | [tree-sitter-html 0.23.2](https://unpkg.com/tree-sitter-html@0.23.2/?meta), H | W, I; embedded JS/CSS require their grammars and injection execution |
| CSS | `css` | [tree-sitter-css 0.25.0](https://unpkg.com/tree-sitter-css@0.25.0/?meta), H | W |
| JSON | `json` | [tree-sitter-json 0.24.8](https://unpkg.com/tree-sitter-json@0.24.8/?meta), H | W |
| YAML | `yaml` | [@tree-sitter-grammars/tree-sitter-yaml 0.7.1](https://unpkg.com/@tree-sitter-grammars/tree-sitter-yaml@0.7.1/?meta), H | W |
| TOML | `toml` | [@tree-sitter-grammars/tree-sitter-toml 0.7.0](https://unpkg.com/@tree-sitter-grammars/tree-sitter-toml@0.7.0/?meta), H | W |
| SQL | `sql` | [@derekstride/tree-sitter-sql 0.3.11](https://unpkg.com/@derekstride/tree-sitter-sql@0.3.11/?meta), H | No WASM/prebuild established by inventory; [install script](https://registry.npmjs.org/@derekstride/tree-sitter-sql/0.3.11) invokes `npx tree-sitter-cli@0.24.7 generate` then node-gyp-build; not an offline/no-build drop-in |
| Vue | `vue` | [tree-sitter-grammars/tree-sitter-vue ce8011a414fdf8091f4e4071752efc376f4afb08](https://github.com/tree-sitter-grammars/tree-sitter-vue/tree/ce8011a414fdf8091f4e4071752efc376f4afb08), `queries/vue/*` + `queries/html_tags/*` | **Conditional:** source build and editor-query adaptation required; see below. Unscoped npm 0.2.1 is a different legacy publication |
| Svelte | `svelte` | [@tree-sitter-grammars/tree-sitter-svelte 1.0.2](https://unpkg.com/@tree-sitter-grammars/tree-sitter-svelte@1.0.2/?meta), H | W, I, L; H has `; inherits: html`, I has `; inherits: html_tags`; dependency/inheritance resolution required |
| Markdown | `markdown` | [@tree-sitter-grammars/tree-sitter-markdown 0.3.2](https://unpkg.com/@tree-sitter-grammars/tree-sitter-markdown@0.3.2/?meta), block and inline H/I | Two grammar passes/layers, plus fenced languages; no WASM in this npm inventory |
| Dockerfile | `docker` | [camdencheek/tree-sitter-dockerfile v0.2.0](https://github.com/camdencheek/tree-sitter-dockerfile/tree/v0.2.0), H | **Conditional source route:** [npm latest](https://registry.npmjs.org/tree-sitter-dockerfile/latest) is `0.0.1-security`, a holding package, not a grammar; source has ISC license and native build setup; current maintenance cadence unverified |
| Makefile | `make` | [tree-sitter-make 1.1.1](https://unpkg.com/tree-sitter-make@1.1.1/?meta), H | W; no injection file in package inventory |

The exact TS/TSX and C++ query composition is declared in the published [TypeScript configuration](https://unpkg.com/tree-sitter-typescript@0.23.2/tree-sitter.json) and [C++ configuration](https://unpkg.com/tree-sitter-cpp@0.23.4/tree-sitter.json). JavaScript 0.23.1's required query assets were independently located in its [package inventory](https://unpkg.com/tree-sitter-javascript@0.23.1/?meta).

**Counting boundary:** 19 requested entries correspond to 18 npm packages because TS/TSX share a package. Of those entries, 17 have grammar WASM files in the inspected inventories; SQL and Markdown need another build/distribution route. These counts do **not** certify uniform ABI, query semantics, language-version completeness, or all-platform installation. Tree-sitter's total ecosystem coverage beyond this set was not audited and has no defensible comparison number here.

**242-ID provenance:** independently supplied by the parent from isolated Shiki 4.5.0 on official Node 22.19: `bundledLanguagesInfo.length = 242`, `Object.keys(bundledLanguagesBase).length = 242`, sum of alias lengths = 104. This subagent inspected the versioned canonical registry and all requested IDs, but did not execute the count itself. `bash`, `dockerfile`, and `makefile` are aliases, not extra canonical languages.

### 2. Query presence is not complete highlighting support

**Claim:** A bare Tree-sitter `Query.captures()` integration is not equivalent to Tree-sitter's complete highlighter. **Sources:** [web query implementation 0.25.10](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/src/query.ts), [native binding 0.25.0](https://github.com/tree-sitter/node-tree-sitter/blob/v0.25.0/index.js), [Rust highlighter 0.25.10](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/highlight/src/lib.rs), [official highlighting documentation](https://tree-sitter.github.io/tree-sitter/3-syntax-highlighting.html). **Support:** direct evidence. **Confidence:** high.

- JS bindings apply supported text predicates such as `#eq?`/`#match?`, but expose `#is?`/`#is-not?` and `#set!` as metadata. They do not resolve lexical scopes merely because `locals.scm` exists. `#is-not? local` needs a locals-aware highlighting layer.
- Injection queries identify nested language/ranges; a host must resolve aliases, load the child grammar/query, parse the right ranges, respect combined/include-children semantics, and merge layers. The official Rust highlighter already implements this; the ordinary Node/web parser APIs do not expose that full highlighter automatically.
- The native binding inspected throws on unknown query predicates. The web binding records unrecognized predicates without automatically executing them. Silently ignoring them can produce plausible but wrong colors.
- **Vue is a concrete portability failure, not a theoretical concern:** [Vue H](https://github.com/tree-sitter-grammars/tree-sitter-vue/blob/ce8011a414fdf8091f4e4071752efc376f4afb08/queries/vue/highlights.scm) includes capture-targeted `#set! @_template bo.commentstring`; inherited [HTML injections](https://github.com/tree-sitter-grammars/tree-sitter-vue/blob/ce8011a414fdf8091f4e4071752efc376f4afb08/queries/html_tags/injections.scm) use Lua matching, `#gsub!`, and `#offset!`. These are editor conventions, not directly compatible JS-binding queries. Capture-targeted `set!` also violates the inspected bindings' string-only argument validation.
- Svelte's [H](https://github.com/tree-sitter-grammars/tree-sitter-svelte/blob/774a65aea563accc35f5d45fafa4d96ec5761f57/queries/highlights.scm) and [I](https://github.com/tree-sitter-grammars/tree-sitter-svelte/blob/774a65aea563accc35f5d45fafa4d96ec5761f57/queries/injections.scm) use `; inherits:` comments. Raw query compilation does not implement this inheritance. Its injection query maps less/postcss to scss; that is an approximation, not language identity.

**Researcher inference:** Vue/Svelte/Markdown should be acceptance cases for the actual highlighting adapter, not counted as solved after loading a WASM parser.

### 3. Shiki supplies a substantially more integrated embedding layer

**Claim:** Shiki loads TextMate grammar dependencies and exposes terminal-usable tokens without requiring HTML; scope classification is optional and adds work. **Sources:** [4.5.0 token types](https://github.com/shikijs/shiki/blob/v4.5.0/packages/types/src/tokens.ts), [tokenizer implementation](https://github.com/shikijs/shiki/blob/v4.5.0/packages/primitive/src/highlight/code-to-tokens-base.ts), [registry](https://github.com/shikijs/shiki/blob/v4.5.0/packages/primitive/src/textmate/registry.ts), [published Vue module](https://unpkg.com/@shikijs/langs@4.5.0/dist/vue.mjs). **Support:** direct evidence. **Confidence:** high.

`codeToTokens`/`codeToTokensBase` yield line arrays with exact token content, offsets, color and font style; the result can carry grammar state. A terminal adapter can apply foregrounds directly or supply a custom TextMate theme using Pi colors. No DOM/HTML renderer is necessary. Vue's module imports CSS, JS, TS, JSON, HTML, and Vue-specific embedded/injection grammars. Fine-grained custom registration must still include required dependencies; the registry rejects missing required languages and handles lazy dependencies separately.

For category-oriented output, `includeExplanation: 'scopeName'` gives scopes. In **4.5.0 it calls both `grammar.tokenizeLine` and `grammar.tokenizeLine2` per eligible nonempty line**; the ordinary color-token path calls only the latter. A benchmark comparing scope explanations against raw Tree-sitter capture names must disclose this workload difference. A theme cannot create a scope that a grammar never emits; neither system supplies cross-file semantic type resolution.

### 4. Deployment and licenses differ, but neither is simply “JS versus native”

**Claim:** Both systems offer a WASM route; Shiki also has a pure-JS regex route, while native Tree-sitter has a separate binary/bridge contract. **Sources:** [Shiki engine guide](https://shiki.style/guide/regex-engines), [Shiki 4.5.0 primitive manifest](https://unpkg.com/@shikijs/primitive@4.5.0/package.json), matrix package inventories/manifests, [Tree-sitter MIT license](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/LICENSE), [Dockerfile ISC manifest](https://github.com/camdencheek/tree-sitter-dockerfile/blob/v0.2.0/package.json), [grammar-license policy](https://github.com/shikijs/textmate-grammars-themes#license). **Support:** direct evidence; deployment consequences are interpretation. **Confidence:** high.

- Shiki's default Oniguruma engine uses WASM, not a Node native addon. Its JavaScript engine transpiles Oniguruma expressions to native `RegExp`; Node 22.19 meets the documented Node >=20 requirement and supports the ES2024 `v` flag. This establishes runtime eligibility, not identical results for every grammar/input.
- Tree-sitter's `web-tree-sitter` needs runtime WASM and separate grammar WASM/query assets. Native `tree-sitter` uses native bindings plus language addons. Published package inventories show prebuilds, but unsupported platforms can require build tooling.
- npm peer ranges vary: examples include TypeScript `^0.21.0`, Rust `^0.22.1`, Java/HTML/C++/JSON `^0.21.1`, and current JS/Python/Bash/CSS/C# `^0.25.0`. This is a resolver/install-policy problem to validate, **not proof those binaries are incompatible**. Parent reports TS/Python/Bash/Rust loaded with native 0.25.1 on Linux x64 Node 22.19 without build scripts; no broader platform claim follows.
- Tree-sitter and ordinary selected grammar manifests are MIT; selected Dockerfile source is ISC. Vue's upstream grammar/query source is MIT, so a Helix dependency is unnecessary for this candidate. A separately considered Helix query source is MPL-2.0 and should not be silently substituted into an MIT asset inventory.
- Shiki runtime/package license is MIT, but its own upstream policy says grammars/themes retain their respective permissive licenses, including MIT/Apache-2.0. Preserve asset provenance/notices rather than treating all TextMate content as authored under Shiki's MIT license.

### 5. Long lines and timeouts are explicit behavior, not free safety guarantees

**Claim:** Shiki 4.5.0 has built-in line/time options; Tree-sitter exposes parse/query limits with different semantics. **Sources:** [Shiki token options](https://github.com/shikijs/shiki/blob/v4.5.0/packages/types/src/tokens.ts), [Shiki tokenizer](https://github.com/shikijs/shiki/blob/v4.5.0/packages/primitive/src/highlight/code-to-tokens-base.ts), [web API 0.25.10](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/web-tree-sitter.d.ts), [native API 0.25.0](https://github.com/tree-sitter/node-tree-sitter/blob/v0.25.0/tree-sitter.d.ts). **Support:** direct evidence, with explicitly labeled inference. **Confidence:** high.

- Shiki default `tokenizeMaxLineLength = 0` means no line-length cap. With a positive cap, implementation skips lines whose JS string length is **greater than or equal to** the cap, emitting their content uncolored and **not advancing grammar state** for those lines. This can affect following multiline syntax.
- `tokenizeTimeLimit = 500` is milliseconds **per line/tokenizer call**, not a whole-document 500 ms limit. Scope explanations add another call. The Shiki wrapper inspected does not surface TextMate's `stoppedEarly` flag in the public token result.
- Supporting TextMate source checks elapsed time between scans, not by preempting a currently executing synchronous regex ([implementation, moving branch](https://github.com/shikijs/vscode-textmate/blob/main/src/grammar/tokenizeString.ts)). **Interpretation:** do not advertise the option as a hard wall-clock interruption guarantee. This secondary implementation detail was inspected on the moving source branch, not asserted as an independently executed Shiki 4.5.0 timeout test.
- web-tree-sitter 0.25.10 exposes parse/query progress callbacks; old parser microsecond timeout methods are deprecated. Query options also include timeout/match limits. Native 0.25.0 exposes parser timeout and query timeout/match-limit options. `matchLimit` limits in-progress matches, not total output tokens or memory. Cancelled/timed-out parser reuse can resume old work unless reset before a different document.
- Neither parser package supplies a universal terminal long-line policy. Separate parse, query, predicate/locals/injection, and span conversion costs; a parser deadline is not an end-to-end highlighting deadline.

### 6. “Streaming” means different things

**Claim:** Both can reuse state, but neither guarantees stable append-only colors for arbitrary incoming chunks. **Sources:** [Shiki grammar state](https://shiki.style/guide/grammar-state), [Tree-sitter parser](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/src/parser.ts), [Rust highlighter](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/highlight/src/lib.rs). **Support:** direct API evidence; limitations are interpretation. **Confidence:** high.

Shiki preserves line-oriented grammar state; chunks ending mid-line need the unfinished line retokenized with its preceding state, not simply passed as an independent next line. Its documentation warns that separately calculating state can duplicate highlighting work. Tree-sitter incrementality requires an edited retained old tree and reparsing; input callbacks are source readers, not asynchronous network-token streams. Later input can change parse structure/captures. Rust `HighlightEvent` iteration emits source/highlight events for supplied source, not proof of incremental incoming-text processing.

**Researcher inference for pi-tidy-ui:** neither engine reconstructs unavailable context across disjoint diff hunks. Keeping ASTs to exploit incremental edits adds an ownership/memory policy that is not implied by the current rendered-only caches.

### 7. Native-versus-web API cost pitfalls

**Claim:** A parser-only timing or identical-looking JS loop can compare unequal work. **Sources:** [native node getters/query conversion](https://github.com/tree-sitter/node-tree-sitter/blob/v0.25.0/index.js), [web node getters](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/src/node.ts), [web query conversion](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/src/query.ts), [web C bridge](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/lib/tree-sitter.c). **Support:** direct implementation evidence; benchmark implications are inference. **Confidence:** high.

The web Node object stores `startIndex`/`startPosition`; `endIndex` enters WASM. Native getters marshal nodes and call native methods for start/end indices and positions. Both query implementations construct JS capture/node results and perform text predicates in JS; `.text`, repeated getters, overlap resolution, injections, and locals can change the work substantially. Benchmark the actual needed span conversion, not unused `.text` reads or only parse time. Inspect encoding at the binding boundary: web bridge uses UTF-16LE and converts byte offsets to JS code units despite some API comments saying “bytes”; do not import Rust UTF-8 byte-index assumptions into JS string slicing.

No timing, memory ratio, or winner is claimed here. Grammar file sizes/package unpacked sizes are not retained-process memory measurements.

### 8. Bash source is separate from command output in current code

**Claim:** Future shell syntax highlighting applies to `args.command`, not arbitrary `result.content`. **Source:** fresh local `src/bash-card.ts:58–65,70–89`. **Support:** direct evidence. **Confidence:** high.

The command is rendered with its separate prompt/source styling; result text follows a separate output path. Output can be diagnostics, prose, data, or existing terminal text. Bash grammar coverage does not authorize treating it as Bash code.

## Contradictions

- The live Shiki engine guide says all bundled languages have been supported since 3.9.1, but the [compatibility report](https://shiki.style/references/engine-js-compat) shows an older 238-language run with 237 supported and `ahk2` unsupported. Neither is a complete 4.5.0/Node22.19 compatibility proof; the exact bundle count is 242, independently counted by the parent.
- Search summaries initially reported no Shiki line/time options; pinned 4.5.0 types and implementation directly disprove that.
- Search summaries alternately claimed Vue has no queries and that `queries/highlights.scm` exists. The actual pinned upstream tree has **nested** Vue/HTML-tag queries; Rust constants at the old paths are conditional `cfg` declarations, not proof those files exist. Direct files also expose editor-specific semantics.
- A current npm Dockerfile-name lookup does not identify the upstream v0.2.0 grammar: it is a security holding package. No cause of that holding status is inferred.

## Missing evidence / residual risks

- No all-21 install/load/query-compilation corpus was executed. Vue portability, Svelte inherited query provenance/completeness, SQL/Markdown WASM builds, selected C# grammar ABI, and all-platform native distribution remain integration checks.
- Source/package availability and maintained project families do not prove every release implements the newest language specification or that every upstream is actively maintained today. Dockerfile maintenance freshness remains specifically unverified.
- No complete Tree-sitter ecosystem grammar-plus-compatible-query cardinality was established; no repo-count marketing total should be compared to Shiki's bundled canonical IDs.
- All-21 embedding correctness, locals behavior, exact Unicode source reconstruction, terminal theme output, pathological-input behavior, retained memory and equal-workload timing remain unmeasured here.
- Licensing observations are source evidence, not legal advice or a complete transitive notice audit.
- Registered `source_check` was run for critical API, licensing/distribution and cost claims. All calls returned **unclear** because automated semantic assessment was unavailable. Findings above rely on manual inspection of the fetched primary source, not a claimed automated validation pass.

## Sources

**Kept:** versioned npm package metadata/file inventories linked in the matrix — establish actual distributed grammars, queries, WASM and install contracts; Shiki v4.5.0 source — exact canonical registry/tokenization behavior; Tree-sitter web 0.25.10/native 0.25.0 source — actual API boundary; pinned Vue/Svelte sources — concrete editor-specific query incompatibilities; local HEAD Bash renderer — source/output boundary. Parent's isolated canonical-ID count is separately attributed, not presented as this subagent's execution.

**Rejected/deprioritized:** prior `docs/research/syntax-highlighting/README.md` recommendation — not equal-workload/memory proof; search-generated conclusions — contradicted by primary files; broad Tree-sitter grammar-pack/repository counts — do not certify compatible highlighting queries; live Shiki compatibility totals — older version/runtime; Helix Vue queries — optional extra provider/license, unnecessary to establish upstream asset existence.

## Next steps

Use the parent's equal-workload Node22.19 results before selecting native versus WASM or claiming a resource winner. If Tree-sitter remains the choice, the highest-value remaining coverage gate is one actual Vue/Svelte/Markdown embedding-and-query compatibility test with pinned asset provenance; do not begin by assuming raw query files are portable.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Delivered a 21-entry versioned grammar/query coverage matrix, Shiki canonical-ID comparison, material API/deployment/limit tradeoffs, contradictions and explicit unverified integration risks."
    }
  ],
  "changedFiles": [
    "head-to-head/coverage.md"
  ],
  "artifactRunId": "d63644d9-a074-4632-952b-c06b84fa1c26",
  "artifactNote": "Original artifact-relative path and run identity retained; host-specific session directory omitted during repository branding normalization.",
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Manually inspected versioned upstream source, npm manifests and published file inventories; read local HEAD and Bash renderer.",
    "source_check returned unclear: automated semantic support assessment unavailable; primary passages manually reviewed.",
    "No repository edits, package installation, benchmarks, tests, staging or subdelegation."
  ],
  "residualRisks": [
    "All-21 runtime/query compatibility and highlighting quality not executed; Vue editor predicates and Svelte inheritance require integration work.",
    "SQL/Markdown WASM distribution, Dockerfile source route/maintenance and all-platform native installation remain unverified.",
    "No performance or retained-memory winner established; parent owns equal-workload measurements.",
    "242 canonical IDs and 104 aliases are parent-executed evidence, not a count run by this subagent."
  ],
  "noStagedFiles": true,
  "diffSummary": "External research artifact only; repository files and pre-existing untracked artifacts preserved.",
  "reviewFindings": [
    "Material: bare Tree-sitter Query.captures does not implement full locals/injection semantics.",
    "Material: Vue upstream editor queries are not directly compatible with ordinary JS bindings.",
    "Material: Shiki scopeName explanations execute two tokenization APIs per eligible line."
  ],
  "manualNotes": "Research-only artifact. noStagedFiles describes this worker's actions; no global git-index audit was performed. Primary-source source_check validation limitation and remaining integration risks are explicit."
}
```
