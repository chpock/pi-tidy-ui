# Other credible engines and terminal implementations

Research snapshot: 2026-10-06. Integration/selection judgments below are recommendations, not benchmark-derived universal rankings.

## 1. Lezer + @lezer/highlight

**The strongest lower-integration pure-JS structural alternative found.** Lezer is the parser system used by CodeMirror, but a terminal integration need not import a browser editor. Its `highlightTree` callback yields ordered source ranges; `tagHighlighter` maps tags to presentation roles. Parsers support incomplete syntax and mixed-language configuration.

Useful classification includes ordinary variables, definitions, called variables/properties, class/type names and operator kinds. Official grammars cover JS/TS/JSX, Python, Rust, C++, Java, HTML/CSS, JSON, Markdown, PHP, XML, YAML and others. The official catalog is smaller than Shiki/Prism; **no official Lezer Bash parser was identified in this inspection**. CodeMirror's legacy shell mode is a separate stream tokenizer, not proof of a Lezer Bash grammar. Third-party grammars were not exhaustively audited.

Local current-version controls demonstrate useful TS/Python role spans and exact source reconstruction: TS default-role count 9/49; Python name roles cover 41 cells with only six operator/punctuation cells ordinary. The same TS input's parse-plus-span median was 30.25 ms, versus the separate Shiki controls' 116–117 ms. This is a **bounded diagnostic**, not equivalent-work, end-to-end or all-language performance proof. See [experiments](experiments.md#lezer-and-modern-highlightjs-controls).

Trees are JS/GC-managed and module imports need no WASM/native addon. Compact parse tables/trees are design goals, not a measured memory budget. Incremental parsing requires retained fragments and edit mapping; finalized immutable cards do not get incremental speedups for free. Avoid retaining raw source/trees merely to advertise incremental parsing.

Sources: [official guide](https://lezer.codemirror.net/docs/guide/), [catalog](https://lezer.codemirror.net/), [JS highlighting declarations at 1.5.1](https://github.com/lezer-parser/javascript/blob/1.5.1/src/highlight.js), [highlight range API at 1.2.1](https://github.com/lezer-parser/highlight/blob/1.2.1/src/highlight.ts), [legacy shell mode](https://github.com/codemirror/legacy-modes/blob/6.5.1/mode/shell.js). Current local probes use JS **1.5.6**, Python **1.1.19**, highlight **1.2.5**. Inspected package licensing is MIT. Project moves/archived GitHub mirrors do not by themselves prove abandonment; the project points to `code.haverbeke.berlin`.

**Fit:** excellent if common-language quality and avoiding WASM/asset management dominate. The strongest alternative to Tree-sitter, not a discarded toy. Broader grammar/embedding selection and Bash/long-tail behavior must be explicit. Choosing multiple engines to fill holes is an additional maintenance decision, not the simplest initial design.

## 2. Modern highlight.js / lowlight

The current host baseline is **10.7.3**, not modern 11.x. Current website documentation advertises **193 languages**; the observed release is **11.12.0**. Counts describe the ecosystem, not immediately registered Pi grammars or dense identifier classification.

The local 11.12.0 control materially improves TS: `result` gains `attr`, `User` gets `title class_`, `fetch` gets `title function_`, and `id` gets `property`. Plain object/argument/fallback identifiers and operators remain. The Python expression is still sparse. Thus "highlight.js cannot do better" would be false, but "upgrade it and the whole complaint is solved" is also unsupported.

Standalone adoption introduces a second highlighter/version beside Pi. Do **not** modify the installed host dependency. Its modern multi-class HTML needs correct decoding; Pi's old mapper drops secondary class information and lacks a modern property mapping. Lowlight is a related highlight.js token-tree/HAST adapter; it changes representation, not underlying grammar coverage.

Pure JS, selective core/language imports, synchronous highlighting and broad grammars are deployment advantages. The original project uses BSD-3-Clause. No global speed or quality advantage is established. The local same-TS HTML median was 30.14 ms, with different output work from other candidates.

Sources: [official site](https://highlightjs.org/), [10.7.3 JS grammar](https://github.com/highlightjs/highlight.js/blob/10.7.3/src/languages/javascript.js), [modern release](https://github.com/highlightjs/highlight.js/releases/tag/11.12.0), [local control](probes/pure-js-highlight-output.jsonl).

**Fit:** keep the public Pi implementation as native fallback/control. A standalone modern version is a smaller replacement candidate, but weaker than structural parsers for the desired ordinary-name distinction in the inspected Python example.

## 3. Prism

Prism 1.30's official catalog advertises **297 languages**. `Prism.tokenize` yields nested tokens/strings with types/aliases and can be recursively serialized to ANSI without HTML/DOM. Selective component loading is possible, with dependency/load-order requirements.

Its JS grammar recognizes calls, operators and template interpolation; Bash recognizes assignments, parameters, substitutions/heredocs and a fixed command vocabulary. Neither implies that every ordinary identifier is classified. The TS component explicitly deletes `parameter` and `literal-property` rules because they do not work reliably for TS. A larger language count is not higher-quality TS typing.

The README says v2 is in progress and only security-relevant PRs are accepted meanwhile, limiting v1 grammar fixes. MIT. No local Prism benchmark/terminal prototype was run.

Sources: [catalog](https://prismjs.com/#supported-languages), [token model](https://prismjs.com/extending.html), [JS 1.30](https://github.com/PrismJS/prism/blob/v1.30.0/components/prism-javascript.js), [TS](https://github.com/PrismJS/prism/blob/v1.30.0/components/prism-typescript.js), [Bash](https://github.com/PrismJS/prism/blob/v1.30.0/components/prism-bash.js), [maintenance notice](https://github.com/PrismJS/prism/blob/master/README.md).

**Fit:** broad, small-integration comparator; not the strongest answer to the demonstrated classification gaps.

## 4. syntect, delta, bat and Codex

Syntect provides stateful Sublime/TextMate-style grammar scopes and theme styles in Rust. Rich scopes are still syntactic, not cross-file symbol/type resolution. Default syntect assets, bat assets and Codex's `two_face` set differ; one bundle's language count cannot be attributed to another.

Taking it into a Node extension needs a maintained native binding, custom WASM bridge or subprocess. No production-ready Node 22 bridge was validated in this research. Default Oniguruma adds a C dependency; `default-fancy` changes the regex backend, not the Rust bridge requirement. Do not shell out to bat/delta once per synchronous card render.

Relevant patterns:

- **Codex** at [`7aa8f510496316b86a91a75ed0a71598ef03c640`](https://github.com/openai/codex/commit/7aa8f510496316b86a91a75ed0a71598ef03c640): [syntect + two_face highlighter](https://github.com/openai/codex/blob/7aa8f510496316b86a91a75ed0a71598ef03c640/codex-rs/tui/src/render/highlight.rs), documented ~250 languages, shared syntax/theme state with theme revision invalidation, plain fallbacks at 512 KiB/10,000 lines and 4 KiB per line. [Diff](https://github.com/openai/codex/blob/7aa8f510496316b86a91a75ed0a71598ef03c640/codex-rs/tui/src/diff_render.rs) highlights hunk blocks rather than individual lines, without cross-hunk lexical state. The thresholds are Codex's choices, not proposed silent pi-tidy-ui truncation.
- **delta 0.18.2**: [composes syntax and emphasis/diff ranges](https://github.com/dandavison/delta/blob/0.18.2/src/paint.rs), handles side-by-side and limits long-line syntax work, acknowledging state inaccuracies after truncation; [hunk handler](https://github.com/dandavison/delta/blob/0.18.2/src/handlers/hunk_header.rs) resets state.
- **bat 0.25.0**: [printer](https://github.com/sharkdp/bat/blob/v0.25.0/src/printer.rs) highlights hidden preceding source before dropping out-of-range lines, preserving state when full source exists. Lines above 16 KiB substitute a newline for highlighting. Whole-file availability is stronger context than a saved partial diff.

Syntect's [performance notes](https://github.com/trishume/syntect/blob/v5.3.0/Readme.md) include 2012/2019 hardware and stopwatch comparisons. They are not modern Node 22 rankings. Shared syntax/theme state amortizes initialization; spawning per-card processes discards that advantage. Syntect/delta are MIT; bat declares MIT OR Apache-2.0. Selected embedded assets need their own audit.

**Fit:** mature terminal composition/robustness reference, but a Rust integration is not justified solely by those agents using it.

## 5. Gemini CLI and Aider

### Gemini CLI

Pinned [`fb972b2f87fe7d5b06d37eac711490162d98de2c`](https://github.com/google-gemini/gemini-cli/commit/fb972b2f87fe7d5b06d37eac711490162d98de2c): [CodeColorizer](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/cli/src/ui/utils/CodeColorizer.tsx) uses `createLowlight(common)`, maps `hljs-*` token classes to Ink colors and auto-detects unknown languages. Its [DiffRenderer](https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/cli/src/ui/components/messages/DiffRenderer.tsx) highlights line by line.

Transfer the idea of token-tree-to-terminal mapping, **not** React/Ink, unreliable prose autodetection or per-line tokenization that loses multiline state pi-tidy-ui already retains.

### Aider

Pinned [`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/commit/5dc9490bb35f9729ef2c95d00a19ccd30c26339c): [IO](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py) uses Prompt Toolkit/Pygments input and Rich Markdown `code_theme` output. [Diff helper](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/diffs.py) builds fenced `diff` text with `difflib`, context five.

This path does not establish embedded edited-language tokenization inside changes. Adding Python/Rich/Pygments is an unnecessary runtime boundary for this TypeScript extension. It is not a preferred integration candidate.

## Shared limits and selection implications

- Error recovery is not missing-context recovery. No engine reconstructs an omitted comment/heredoc opener or today's file as historical truth.
- Highlight supplied contiguous old/new source before hiding context; do not join disjoint hunks into invented adjacency.
- No inspected engine requires an LSP simply to distinguish many variable/type/call **syntactic positions**; semantic tokens are separate, higher-scope work.
- Split initialization, uncached parsing, retained-layout zero-work hits and transient/retained memory. No reproducible cross-engine Node 22 terminal benchmark was found.
- For matching OpenCode and sharing the same parser with Bash, **Tree-sitter** has the clearest architectural alignment. For common-language coverage and low integration, **Lezer** deserves equal seriousness; its local TS/Python results are stronger than merely relying on documentation.
- Shiki remains the strongest convenient broad TextMate bundle; modern highlight.js/Prism are smaller migration options with classification limitations. None should be chosen by star count, marketing language totals or unsupported universal speed claims.
