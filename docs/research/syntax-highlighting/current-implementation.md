# Current implementation: root causes

Research date: 2026-10-06. This is a research snapshot, not a specification or an implementation approval.

## Inspected state

Repository HEAD at initial inspection was `5a238ae22ced17501179e0d4adc55a635c7fc4e6`, with pre-existing uncommitted edit/write-card changes. The actual working implementation is [`src/file-card.ts`](../../../src/file-card.ts), not the deleted `src/edit-card.ts`. Concurrent work committed these cards as `dcd18497faac0348d086896e5e81e265d3cac88a` before publication. The adapter's public Pi-highlighter dispatch and the file-card source assembly/foreground guard were freshly checked again at publication and still match the analyzed pipeline. No pre-existing source, tests, dependencies or specifications were changed, and no commits were made, by this research.

Installed versions: Pi 1.0.0, highlight.js **10.7.3**, Node **26.7.0**. The project minimum is Node 22.19.0; this probe does not establish Node 22 compatibility for future libraries.

## Actual pipeline

1. [`src/index.ts:262–268`](../../../src/index.ts) passes `(code, path) => highlightCode(code, getLanguageFromPath(path))` when the active theme exposes `colors` and `style`.
2. [`src/file-card.ts:238–254`](../../../src/file-card.ts) assembles supplied old and new source separately, calls that highlighter, carries ANSI state through logical lines and checks exact stripped-text equality. A mismatch falls back to ordinary source rather than displaying corrupted text.
3. Highlighting happens **before** display-only context projection. The display context limit of three therefore does not remove supplied lexical context from highlighting.
4. Plain graphemes determine wrapping; styled fragments are partitioned monotonically. Diff tint is background-only. Existing rendered-layout caching avoids repeated custom highlighting on unchanged warm frames; width/theme changes rebuild it.
5. Pi's public `highlightCode` uses highlight.js HTML output, converts recognized scopes into ANSI and splits lines. It does not run Tree-sitter, TextMate or LSP semantic tokens.

Installed SDK evidence: `node_modules/@earendil-works/pi-coding-agent/dist/utils/syntax-highlight.js:1–63,79–175`; `dist/modes/interactive/theme/theme.js:719–847`. These are inspection references, not production private-import recommendations.

## Cause 1: the grammar often emits no token at all

The installed TypeScript grammar returns this for a commonplace expression:

```html
<span class="hljs-keyword">const</span> result: User = client.fetch(user.id) ?? fallback;
```

There is no variable, user-defined type, member, call, operator or punctuation scope for the remainder. Adding more color mappings cannot color nonexistent tokens. The absence of syntax scopes is not proof that semantic analysis is required: richer TextMate grammars or syntax-tree queries can recognize many of these positions without knowing what `User` resolves to.

The diagnostic [`probes/current-highlight.mjs`](probes/current-highlight.mjs) inspects raw grammar HTML and actual xterm cells, then compares all source-cell foregrounds against the actual pi-tidy-ui file card at width 100. It uses Pi's actual theme, not a mock.

Recorded output: [`probes/current-highlight-output.jsonl`](probes/current-highlight-output.jsonl).

| Sample | Ordinary/terminal-default foreground, non-whitespace | Total non-whitespace |
|---|---:|---:|
| TypeScript expression | 44 | 49 |
| TypeScript interface + function | 31 | 90 |
| Python expression | 45 | 53 |
| Rust expression | 35 | 38 |
| HTML element | 11 | 54 |
| Bash command | 19 | 42 |

These are deliberately small diagnostic examples, **not** language-wide quality scores or performance benchmarks. Ordinary-color cells include recognized roles intentionally sharing the ordinary palette. A separate Vue sample falls back to one `mdCodeBlock` color: zero ordinary-color cells there does **not** mean any syntax was recognized.

All **419 source cells** across seven samples matched the corresponding Pi reference foreground inside the pi-tidy-ui card. Thus these examples do not support blaming split layout, diff tint or wrapping for dropped token foregrounds. They do not prove correctness for every language, width or malformed input.

## Cause 2: supported grammar and filename dispatch are different things

Pi eagerly registers 21 languages, then its normal interactive startup asynchronously loads the remaining highlight.js languages and invalidates the UI (`interactive-mode.js:794–801`). HTML was not registered before this step in the probe. The saved results wait for this initialization, so HTML's initial fallback is not confused with a permanent lack of support.

Even after all grammars load, the public path resolver has a fixed extension/basename lookup. Current observations:

| Path | Resolver output |
|---|---|
| `component.vue`, `component.svelte` | none |
| `module.mts`, `module.cts` | none |
| `CMakeLists.txt`, `.bashrc` | none |
| `main.tsx` | `typescript` |
| `Dockerfile`, `dockerfile` | `dockerfile` |
| `Makefile` | `makefile` |
| `script.sh` | `bash` |

Do not claim Dockerfile/Makefile fail: this implementation lowercases the final dot-separated segment, so these exact basenames work. TSX dispatches to TypeScript; that fact alone does not establish correct embedded JSX coverage. `.zsh` also dispatches to Bash, which is a compatibility approximation rather than native Zsh grammar selection.

Unknown or unregistered languages are painted uniformly with `mdCodeBlock`; auto-detection is intentionally disabled to avoid coloring prose as code. A broader engine without a broader resolver still leaves these files unresolved.

## Cause 3: several distinct roles have the same visible color

Pi's installed dark and light themes assign `syntaxComment`, `syntaxOperator`, `syntaxPunctuation` and `toolOutput` the same `muted` color. A correctly recognized comment, delimiter or operator can therefore look ordinary. More recognized scopes do not automatically produce a more differentiated palette.

Pi maps scopes into approximately nine syntax roles, with some additional general/diff styles. That is a deliberately smaller palette than an editor's many TextMate scopes. `function`/`title` map to function color, `class`/`type`/built-ins to type color, `params` to variable color. A newer parser should preserve finer classification until the presentation mapping, rather than irreversibly merging it inside parsing.

There is also an explicit reset detail: Pi `Theme.fg` is a shallow wrapper ending in SGR 39 (`theme.js:201–205`). pi-tidy-ui wraps a highlighted row in `toolOutput`, but inner token SGR 39 restores terminal-default foreground, **not the enclosing toolOutput color**. Raw unclassified text after a token can consequently use the terminal default, whereas preceding unclassified text uses toolOutput. The probe counts both states as ordinary/default. This is a real foreground-composition limitation; changing only that reset behavior would normalize the base foreground, not supply missing syntax tokens.

## Cause 4: a saved diff is not a complete source file

Old/new separation is correct and prevents removed strings/comments from coloring added text. However, `highlight` removes gaps and joins **all** supplied hunks into one source stream per side. Parsed hunk IDs survive for layout, but are not used to reset lexical state for highlighting.

The recorded two-hunk probe shows the actual inputs:

```text
/* old opening
const oldValue = 1;
```

and an equivalent new stream. If the omitted lines contain the closing comment, that state cannot be recovered. A comment/string opening before the first supplied row is also unavailable. Merely adding newlines for omitted lines does not recover delimiters, and no proposed engine can guarantee whole-file correctness from absent source.

The existing contract explicitly prohibits rereading edited files or reconstructing a proposal. The correct design must acknowledge incomplete context and keep noncontiguous segments independent. Highlight full **available contiguous** source before projecting visible context; do not invent continuity across gaps. Even independent segment parsing starts with unknown enclosing state and is best-effort, not a promise of full-file semantics.

## Other safeguards and non-causes

- Exact-text checks in `highlight` and `cell` can intentionally remove styling when a highlighter changes text. No such fallback was observed in these seven samples.
- A theme without `colors`/`style` receives no highlighter callback. This is a compatibility guard, not evidence that the normal Pi theme lacks syntax support.
- Existing multiline tests prove preservation of Pi's output and state opened in supplied hidden context. They do not require dense identifier/type/operator recognition or equivalence to OpenCode's parser.
- Bash command cards currently do **not** use any syntax highlighter: [`src/bash-card.ts:58–65`](../../../src/bash-card.ts) paints the prompt `dim` and the command `toolTitle`. Highlighting `.sh` source in a file card is a separate capability. Bash output should not be automatically treated as shell source.

## Conclusion

The primary quality limit is the installed highlighter's tokenization, reinforced by restricted dispatch and a compressed palette. Diff layout faithfully reproduces that sparse output in the examined examples. An architectural replacement must address **engine + language resolution + token/foreground mapping + incomplete-context boundaries**, not add ad hoc regexes to the diff renderer.

## Verification limits

This was diagnostic research, not an implementation test pass. No production code changes, dependency changes, full regression suite or real CLI replay run were made. The physical comparison is an actual native-highlighter/card/xterm control at width 100 with ASCII samples; it is not end-to-end replay, a Unicode test or a speed measurement.
