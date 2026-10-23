# Rendering: representations, geometry and retained rows

The presentation pipeline converts already supplied Pi data into terminal rows without changing tool execution, model text or session records. Its central rule is to keep **source meaning, geometry, paint and surrounding composition separate**. A change in one need not invalidate the others.

[Host integration](host-integration.md#presentation-dispatch) selects a presenter and owns hooks. This chapter explains the common representation and reuse model. Exact visible behavior belongs to [summaries](tool-summary-spec.md), [Bash](bash-card-spec.md), [edit](edit-card-spec.md), [write](write-card-spec.md), [user/queued messages](user-queued-cards.md), [editor](editor.md) and [footer](footer-spec.md).

## The representation pipeline

```text
Pi arguments / result / saved metadata / native rendered rows
  |
  +-- bounded description ------------------------> summary spans
  |
  +-- complete logical text + metadata ------------> Bash/file display model
  |                                                   |
  |                   useful syntax preparation <-----+--> measured glyphs
  |                   scopes -> styles -> ready paint      |
  |                                                   width-dependent scene
  |                                                       |
  +-- native user/editor rows ----------------------> geometric projection
  |
  +-- queued plain text ----------------------------> prepared full/ending rows
                                                          |
                                               component-owned latest rows
                                                          |
                                           outside separators / spinner prefix
                                                          |
                                                native Pi composition/output
```

Not every arrow runs on every render. Bash/file input and syntax preparation happen through owned useful-work updates outside render; a normal warm visit consumes their prepared state. User/editor projection deliberately calls the native renderer on the appropriate cold/live path because native Markdown and editing behavior remain authoritative.

The stored representations have distinct purposes:

| Representation | What it means | What it does not prove |
| --- | --- | --- |
| Supplied text/metadata | Original tool or native message facts | Availability of source omitted by a producer |
| Logical display text | Sanitized text with source boundaries/positions preserved for that presenter | Already expanded tabs or viewport rows |
| Semantic source ranges | Validated byte ranges and context identities for a source version | Current theme or row breaks |
| Measured glyph data | Color-free grapheme widths and coordinate mapping | A width-specific layout or active colors |
| Scene/reflow | Rows/cells for width, padding, expansion and logical geometry | Current style readiness |
| Ready paint | One compatible palette and source-style publication | That an unrelated/new source was parsed |
| Painted rows | Complete terminal strings for the current scene/paint | Ownership of native/parser work that produced an earlier display |

[Prepared syntax cards](syntax/prepared-cards.md) explains source grouping, measurement and flat-range painting; [syntax storage](syntax/storage.md) explains bounded logical-data ownership.

## Text domains and coordinate systems

There is no universal “sanitize and wrap” operation. Each input has a different preservation contract.

| Input | Preparation | Preserved or excluded |
| --- | --- | --- |
| Compact arguments | Select bounded raw grapheme prefixes, sanitize and serialize a bounded logical description | Structural punctuation and selected argument meanings; not complete source/output |
| Bash / queued plain blocks | Strip terminal sequences, normalize CR/CRLF to LF, remove unsafe terminal/bidi controls; retain logical newlines and indentation | Complete supplied text, joining marks and tabs until display layout |
| Saved file rows | Normalize line endings while iterating source rows; sanitize individual source text; keep logical tabs and old/new positions | Supplied hunk boundaries and omitted-source gaps; no file reread |
| Native user rows | Ask native Markdown to render at a paired width, then remove known padding | Native transformations, syntax/link ANSI and interior blank rows |
| Native editor rows | Native wrapping first, sentinel-delimited projection and cursor-safe column slices | Editing state, semantic inverse/selection and cursor marker; not a replacement editor |
| Footer producer statuses | Keep opaque producer ANSI and fit/pack whole entries, isolating boundaries | Producer content, not parsed native-footer output |

Summary sanitization collapses whitespace **before** removing remaining controls. Removing a control between spaces can therefore leave adjacent spaces. This is a documented implementation limitation, not a claimed canonical whitespace normalization or a deliberate new formatting policy; see [summary limits](tool-summary-spec.md).

### Units must not be interchanged

| Unit | Use |
| --- | --- |
| JavaScript UTF-16 code units | String slicing and logical-description span indexes |
| Unicode scalars | Historical Bash prefix comparison; never split a surrogate pair |
| UTF-8 bytes | SOURCE/range coordinates and eligibility prefixes |
| Grapheme clusters | Indivisible displayed characters and preview limits |
| Terminal columns/cells | Wrapping, padding, cursor borrowing, hit bounds |

For example, before `e` in `a😀é`, the JS offset is 3 code units and the UTF-8 offset is 5 bytes, while the usual Pi cell-width result is 3 columns. The final `é` is two scalars but one grapheme. Expanded tab cells are neither source bytes nor new source characters.

Files use four-column tab stops from the original logical-line origin; soft wrapping does not restart that file origin. Plain Bash/queued wrapping uses eight-column display stops. An overwide grapheme in a narrow plain-text content area becomes a replacement cell rather than a split grapheme. Native user/editor projections instead delegate impossible projections to native rendering at the real width. These policies are intentionally different preservation boundaries, not interchangeable helpers.

## Shared frame geometry

`cardGeometry` in `src/card-frame.ts` floors/clamps the component width, then allocates a possible stripe, up to two inner padding cells, exterior Output-padding margins and the remaining content width. It reserves useful content before all decorations can fit. `panelX`/`panelWidth` delimit the painted hit region; `contentX`/`contentWidth` delimit the caller's text area. Exact narrow-width allocations and paint roles are in [frame geometry](card-frame-spec.md).

Transcript Output padding is independent of native user Markdown padding, Editor padding and full-width footer placement. The adapter passes effective Output padding; presenters do not read global settings. The frame has no tool names, lifecycle, parser or theme-policy knowledge.

### Two framing APIs, two input contracts

| API | Input | Work |
| --- | --- | --- |
| `frameRows` | Styled strings whose cell width still needs checking, plus panel/stripe paint callbacks | Add top/bottom rows, measure visible widths, reject overflow, frame each row and restore enclosing panel paint after standalone SGR 0/49 resets |
| `frameMeasuredRow` | A fully painted child row and an already known valid cell count | Frame/pad that one row without scanning its ANSI or reopening parent paint across its explicit child resets |

User/queued projections use the first contract. Prepared Bash/edit/write output in `src/syntax/card-layout.ts` uses the second, explicitly producing top/bottom and body rows with prepared roles. Its child painter already paints complete cells, including diff/neutral surfaces. Reinterpreting that ANSI in the frame would duplicate work and could overwrite intentional child backgrounds.

Neither API truncates oversized body text to make a caller error disappear. Measured framing validates a safe integer cell count within its allocation; generic framing checks actual visible width. The common outer shell resets inherited background before the stripe and leaves exterior spaces unpainted. Panel hit tests are component-local and require the adapter to subtract any outside transcript separator.

`CardTheme` is the shared lightweight theme interface. The exported `toolCardPaint` helper is not the production prepared Bash/file painter; that path compiles roles before `frameMeasuredRow`. Likewise the exported standalone `measureFileCard` helper is not the current neighbor-spacing path. Their existence must not be mistaken for runtime call flow.

## Latest-layout identities

There are two related retention paths, not one monolithic cache key.

### Compact and native-projection rows

A component's weak-keyed state owns its latest layout entry. The summary memo includes presentation kind, width, Output padding, theme/callback identity, argument/result identity, expansion/partial state and relevant directory. Existing host update/invalidation methods also release layouts, covering mutation inside an otherwise identical argument/result object.

User rows additionally depend on native text, padding, Markdown-child identity/theme/transformers and paint callbacks. Queued preparation depends on text, width, Output padding, paint and the last-card hint; screen height only selects already-prepared rows. The editor does not participate in these retained-row caches.

### Prepared Bash/edit/write scenes

The live adapter reads `syntax.visit(...)`, which validates the current prepared display and paint. It compares the previous retained scene against width, padding, expansion and `geometryStamp`:

1. If geometry is still retained and all geometry inputs match, reuse the scene.
2. If its output is still valid and `paintStamp` also matches, return the existing rows: a warm hit.
3. If only paint changed, paint the same scene with the new complete ready publication.
4. If geometry changed, construct a new scene from measured data and paint it.
5. Publish a candidate only after the outer prepared-card visit succeeds and the adapter remains active.

A scene is the width-dependent layout, not a retained parser. Source/style/geometry funding can be refused or genuinely evicted under the separate logical-data authority even though rendered-layout accounting has no LRU policy. If the path cannot produce a valid prepared card, its presenter uses the defined native/ready fallback; it never fabricates permission for duplicate classification.

### Transactional replacement and cleanup

A retained prepared entry has detached cleanup receipts for its scene and output. When new paint reuses the old scene, the new entry takes over its geometry receipt and the old cleanup packet relinquishes that receipt **before** old-entry removal. Otherwise dropping the old entry would release geometry still used by the replacement.

Unadopted newly painted output and newly created geometry are disposed in `finally`. Reused old geometry is not disposed merely because a candidate failed. This makes publication atomic at the representation level: stale visits and exceptions cannot leave half-new palette/rows installed.

The complete source/palette atomicity rules remain in [prepared cards](syntax/prepared-cards.md); this section describes how the host adopts their layout/paint result.

## Neighbor spacing without another body build

Outside transcript separators are not retained inside a body. Parent/index edges are recorded during attachment; a visit first checks its recorded index and lazily repairs it after structural changes. It then walks backward to the previous visible sibling.

- Eligible Bash is already known to be a multiline framed presentation; spacing need not format its output.
- A compact sibling uses its latest bounded summary layout.
- User projection supplies cached body metadata rather than recursively invoking predecessor spacing.
- Unknown/native renderers may still have to render at the actual width to establish visibility.
- File spacing reads the **already prepared file display**, not saved metadata through `measureFileCard`.

For files, `fileMeasure` in `src/index.ts` first requires an applied prepared presentation. An exact retained scene supplies its row count. A non-inline file mode supplies only the needed multiline-frame classification; no source rows need reflow. An inline heading needs an exact height, so the adapter temporarily reflows its existing heading measurement and disposes that temporary result immediately. Failed/currentness-rejected visits do not publish a measurement.

This is not an extra height cache, a source-classification retry or another body admission. It exists because separation needs “one row versus multiline” and sometimes heading height, not a freshly painted diff.

The next tool owns any required outside separator. A completed compact body with no separator can return its retained array directly; adding a separator or replacing an animated prefix can allocate a small composition array. Exact separation/interaction rules are in [summaries](tool-summary-spec.md#6-separation-and-visibility) and [frame hit testing](card-frame-spec.md).

## Retention, accounting and pressure are different

`RenderCache` in `src/render-cache.ts` is a weak accounting registry. Component state owns an entry and its value; the registry keeps only a weak entry reference, fixed presentation kind, numbers and a detached cleanup receipt. `drop` clears the entry value immediately and releases accounting/receipts once. Finalization cleans dead accounting; requested statistics also sweep dead weak references because finalizer timing is not guaranteed.

Two groups, `ordinary` and `cards`, attribute latest rendered layouts; neither imposes byte/count/recency eviction. They are not global strong row stores. The reason is Pi's repeated whole-document visitation: evicting still-live rows to fit a small global count makes the same long transcript rebuild on every visit. Component lifetime and replacement bound each individual retained body; a growing live transcript still grows retained presentation.

Logical source/context/style/geometry data use the separate bounded [syntax storage](syntax/storage.md) authority. Do not infer unlimited semantic admission from uncapped row accounting, or claim a whole-Pi heap bound from either mechanism. Native caches, signatures/raw source and transient allocations are not all represented by the row-byte estimate.

The [cache reference](render-cache-spec.md#memory-accounting-and-controls) owns the exact estimator, diagnostics, invalidation and clear controls. Native removal/collection releases owners; synchronous renderer transfer follows the [host exception](host-integration.md#tree-removal-versus-renderer-transfer).

## Animation is transient composition

The compact spinner selects its glyph from elapsed monotonic time; the stored logical summary has no animation phase. One sample per normal document pass makes parallel calls agree. Native `Working` usually supplies frames, so a second periodic timer would repeat history traversals without changing body data.

A single inactivity deadline requests one ordinary frame only after successful document visits stop arriving, then waits for the next successful visit before rearming. The observer sees document layout, not actual terminal presentation. Details, weak participation and the accepted lack of an after-present API are in the [spinner contract](render-cache-spec.md#execution-spinner).

## Worked change paths

### Width change

For an already prepared file, source scopes/styles remain valid. Stored glyph widths are reflowed into a new scene at the real width, then painted. The component replaces its one latest scene/output; it does not keep the old width as a history entry or issue another SOURCE/STYLE request just for geometry. Native/editor projections retain their own host rendering obligations.

### Theme change

The source identity and measured glyphs remain. The syntax layer resolves only missing style dependencies and prepares a complete card palette. Until it can publish the replacement atomically, retained ready paint remains visible. A matching geometry scene can then be repainted without remeasurement, diff reparsing or source parsing. [Follow Pi](syntax/follow-pi.md), [native palette resolution](occipital/styles-and-palettes.md) and [color provenance](color-model.md) define the actual colors.

### New Bash suffix

The full latest normalized command becomes current display geometry. Only a validated scalar-prefix-compatible historical basis can color its matching prefix; the proof uses UTF-8 source bytes and belongs to the current revision. New text remains visible even while classification is waiting. That historical paint is display continuity, never evidence that a parser checkpoint or lease can be resumed. See [Bash streaming](bash-streaming-contract.md).

### Removal or failed candidate

Native removal releases that owner's rows and useful syntax work, unless it is already attached elsewhere or in the specific synchronous renderer-transfer check. A failed unpublished candidate releases its temporary allocations without replacing the old valid presentation. Neither path rewrites the session result to manufacture a new source owner.

## Implementation map

- `src/index.ts`: presenter dispatch, latest-row adoption, predecessor spacing, transient prefix/separator composition and host ownership.
- `src/card-frame.ts`, `src/card-theme.ts`: geometry/framing and paint interfaces.
- `src/plain-text.ts`, `src/summary-args.ts`: distinct plain-block and bounded-description policies.
- `src/bash-card.ts`, `src/file-card.ts`: logical display models; source/presentation algorithms are explained in their respective chapters.
- `src/user-card.ts`, `src/queued-card.ts`: native Markdown projection and prepared plain queue rows.
- `src/syntax/cards.ts`, `measured-rows.ts`, `card-layout.ts`, `flat-paint.ts`: prepared source models, measured geometry, scenes and monotonic literal painting.
- `src/render-cache.ts`: weak row accounting and detached release receipts.
- `src/editor-card.ts`, `src/editor-status.ts`, `src/footer.ts`: separate input/status/footer projection and fitting, not another tool-card parser.
