# Syntax highlighting

This is the entry to the **extension-side highlighting pipeline**. Occipital performs theme-independent SOURCE parsing and separate STYLE resolution; Bash/edit/write share one prepared renderer. Follow Pi and native themes are inputs to that renderer, not competing painting implementations.

For the native program itself, start with the [Occipital manual](occipital/README.md). For a first end-to-end example, follow [one card from result to terminal](architecture.md#one-card-from-result-to-terminal). The exact [wire protocol](occipital/protocol.md) is a reference, not a prerequisite for understanding a card.

## Surfaces and source text

Only Bash **commands** and successful edit/write **source bodies**, including Markdown files, enter this pipeline. Bash output, ordinary tool summaries, native user-message Markdown, the editor and delegated native cards do not. A native card palette owns the custom card interior, not Pi's global theme or editor.

Display uses complete supplied text; useful classification may use a bounded normalized prefix. Parsing sees logical normalized source before tab expansion, wrapping, gutters and paint. Saved diff sides are separate logical sources, and a gap in supplied context begins a new fragment rather than inventing missing file text. No tool/source file is reread and no result or session entry is modified.

Live Bash argument formation, `setArgsComplete`, tool execution and restored history have distinct lifetimes. A command can be syntactically finalized while the process is still running. A restored interrupted card may receive one finite classification of its saved text; that does not claim the old call executed or its arguments completed. The exact live/frozen/restored rules are in [source work](syntax/work.md#surfaces-and-source-text) and the [Bash streaming contract](bash-streaming-contract.md).

## Syntax pipeline and ownership

```text
host semantic update
  -> supplied display model and source slots
  -> weak useful-work registry
  -> admitted SOURCE -> validated contexts/ranges
  -> missing STYLE or local Pi bindings
  -> complete accepted palette + source styles
  -> stored measurements -> reflow -> common literal painter -> latest rows
```

| Boundary | Owner/result | Read next |
|---|---|---|
| Runtime selection | Syntax runtime, provider broker, selected/effective theme and compatible available transport | [Providers](syntax/providers.md) |
| Physical requests | Adapter correlation, descriptor/byte validation, caller waits and actual settlement | [Request adapters](syntax/requests.md) |
| Useful source/style work | `SourceController` and `SourceWork`; one chronological registry, per-source authority and card-group publication | [Work controller](syntax/work.md) |
| Retained data | Grants/charges, text and semantic captures, context leases, styles and ready payloads | [Storage](syntax/storage.md) |
| Card preparation and paint | `CardSources`, measured geometry, display signatures and borrowed accepted visits | [Prepared cards](syntax/prepared-cards.md) |
| Follow Pi | Public color sampling, complete binding/semantic-rule tables, role-specific derivatives and typography | [Follow Pi reference](syntax/follow-pi.md) |
| Native palette | Common resolver plus complete native card roles and their provenance | [Native styles/palettes](occipital/styles-and-palettes.md) |
| Color mathematics | Color representations, quantization, contrast and differentiated diff-surface algorithms | [Color model](color-model.md) |

These are owned results, not a fixed number of RPCs. Cached contexts/styles and local bindings can restore ready paint while all native slots are busy. Parsing and preparation happen outside terminal rendering; render only borrows already prepared data and never waits for the daemon.

## Independent identities

| Identity | Changes when | Is not |
|---|---|---|
| Owner/source key and version | A source owner or its current text demand changes | A parser lease token or theme name |
| Native assets/vocabulary | The negotiated parser/portable scope interpretation changes | A display color revision |
| Rules identity | Immutable native or client rule definitions change | A mutable selected menu row |
| Local Pi input/palette identity | Effective sampled inputs or derived concrete roles change | A different source grammar |
| Ready presentation revision | A complete compatible style/palette set can publish | Proof that newer SOURCE work completed |
| Geometry/display identity | Logical display and its measured representation change | Current terminal width or final RGB |
| Scene/latest-row signature | Width, padding, expansion, display or accepted paint changes | Another semantic source version |

The [storage chapter](syntax/storage.md) defines vocabulary-qualified contexts and style lifetime. The [prepared-card chapter](syntax/prepared-cards.md) defines exact display, geometry and final-publication guards. A retained historical Bash prefix is only a display proof; it does not revive a parser checkpoint or authorize another classifier.

## Changes, reuse and fallback

- **Warm frame:** reuse ready rows/data; no SOURCE/STYLE request, classifier, prefix verification or glyph measurement.
- **Width:** reflow existing measured glyphs and rebuild terminal rows; no new parse, style resolution or measurement of unchanged text.
- **Theme:** retain source and geometry; resolve only missing contexts/rules or local palette input. Publish all sources and card roles together. Retained styles support rollback without recomputing them.
- **Text:** prepare current complete display, update bounded demand and measure genuinely changed geometry. Valid immutable prefix data is reusable only with its exact continuity proofs.
- **Pending or unavailable native work:** preserve compatible ready display; otherwise display full text in the ready palette's neutral roles. A usable native palette does not borrow Pi syntax colors. Without one, whole-card Follow Pi is explicit; an ordinary file may use a permitted exact public Pi fallback, but Bash never does.

`SourceController.workStatus` is the authority for fallback. Queued, running or uncertain native work prohibits duplicate Pi classification in the same installed owner. Missing colors, a successful STYLE result, cancellation, timeout or absent provider do not prove no parsing occurred. Read the full [fallback table](syntax/work.md#rendering-and-fallback), [request failure distinctions](syntax/requests.md) and [publication rules](syntax/prepared-cards.md).

## Lifecycles that must not be conflated

| Transition | Governing rule |
|---|---|
| Hidden/zero-width card | Pause new useful work under the explicit pause rules; this is not owner removal |
| Live interrupted/frozen Bash | Retain a display basis and permit allowed recoloring/reflow; do not reopen SOURCE |
| Restored card | A new finite saved-source owner, not continuation of the old live parser lease |
| Native-highlighting Off | Provider/payload release with canonical source-execution evidence preserved as specified; not blanket permission for Pi fallback |
| Transport loss | Bounded provider recovery only for the typed ending causes and unspent allowances |
| Ordinary uncertain request timeout | Preserve conservative execution authority; do not silently classify through another path |
| Terminal suspension | Explicitly retire unfinished work and replay only still-useful current demand after actual cleanup/reconnect |
| Full adapter removal/reinstallation | Fresh source keys may occasionally repeat classification; avoiding that rare repeat was explicitly not worth cross-adapter ownership machinery |

[Providers](syntax/providers.md) owns the transition matrix and budgets. [Work](syntax/work.md) owns each source's progress/uncertainty. [Storage](syntax/storage.md) owns what retains or releases bytes. [The daemon](occipital/source-engine.md) owns parser checkpoints and route leases. None of these lifetimes can substitute for another.

## Intentional terminal suspension

Pi's owned public terminal `stop`/successful `start` boundary preserves the session and draft while syntax admission is paused. Unfinished work is deliberately retired; resume uses the existing bounded queue, latest useful source text and actual owned cleanup or shared reconnection. Idle healthy providers need not restart. Late old work cannot publish, although already-started shared work can briefly finish independently.

The complete interruption/replay rules, accepted bounded duplicate, failed-start behavior and repeated-stop recovery are in [intentional terminal suspension](syntax/providers.md#intentional-terminal-suspension). This exception does not authorize recovery from ordinary uncertain timeouts. Terminal OSC defaults have their separate [channel lifecycle](terminal-colors-spec.md).

## Navigation and validation

- **Colors or Markdown look wrong:** [Follow Pi rules/derivatives/fonts](syntax/follow-pi.md), [native role derivation](occipital/styles-and-palettes.md), [color mathematics](color-model.md).
- **A card stays neutral or work repeats:** [work and fallback authority](syntax/work.md), then [requests](syntax/requests.md) and [providers](syntax/providers.md).
- **Memory does not fall after removal:** [local storage and captures](syntax/storage.md), [transcript row ownership](render-cache-spec.md), then [native delivery credit](occipital/requests-and-resources.md).
- **Protocol or source limits:** [wire reference](occipital/protocol.md), [client prefix policy](syntax/work.md#highlighting-volume-policy), [native parser](occipital/source-engine.md).
- **Build/compatibility:** [daemon assets and identities](occipital/assets.md), [delivery](releases.md), [testing](testing.md#syntaxnative-checks).
