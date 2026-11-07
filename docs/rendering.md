# Rendering: representations, geometry and retained rows

The presentation pipeline converts already supplied Pi data into terminal rows without changing tool execution, model text or session records. Its central rule is to keep **source meaning, geometry, paint and surrounding composition separate**. A change in one need not invalidate the others.

[Host integration](host-integration.md#presentation-dispatch) selects a presenter and owns hooks. [Producer adapters](tool-adapters.md) interpret tool-specific fields and provide deferred, funded inputs to that presenter; the shared pipeline does not decode each extension's wire format. This chapter explains the common representation and reuse model. Exact visible behavior belongs to [summaries](tool-summary-spec.md), [Bash](bash-card-spec.md), [read](read-card-spec.md), [edit](edit-card-spec.md), [write](write-card-spec.md), [user/queued messages](user-queued-cards.md), [editor](editor.md) and [footer](footer-spec.md).

## The representation pipeline

```text
Pi arguments / result / saved metadata / native rendered rows
  |
  +-- bounded description ------------------------> summary spans
  |
  +-- complete latest command ----------------------> complete Bash display
  |
  +-- saved file arguments/result -> select preview/full -> selected file display
                                                   |
                     useful syntax preparation <---+--> measured glyphs
                     scopes -> styles -> ready paint     |
                                                   width-dependent scene
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

Not every arrow runs on every render. Write/edit preview/full selection happens before the chosen view is normalized or admitted for syntax preparation; compact read contributes no body, while explicit expansion supplies its saved result text; a usable Bash frame displays the complete latest command, while unavailable command/context or preparation uses the ordinary bounded summary. File/Bash input and syntax preparation happen through owned useful-work updates outside render; a normal warm visit consumes their prepared state. User/editor projection deliberately calls the native renderer on the appropriate cold/live path because native Markdown and editing behavior remain authoritative.

The stored representations have distinct purposes:

| Representation | What it means | What it does not prove |
| --- | --- | --- |
| Supplied text/metadata | Original tool or native message facts | Availability of source omitted by a producer |
| Logical display text | Sanitized Bash text or the selected full/bounded saved-file view, with source boundaries/positions preserved | Already expanded tabs or viewport rows; a bounded file view does not include its hidden suffix |
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
| Saved file rows | Select the requested full or bounded raw source window, then normalize line endings while iterating selected rows; sanitize text and keep logical tabs/positions | Supplied hunk boundaries and omitted-source gaps; no file reread; preview rows beyond the selected prefix |
| Expanded read text | Prepare saved result text parts as one plain file-code view, starting at the supplied valid offset | Returned notices and text; no reconstruction of missing source, no body preparation while compact |
| Read image rows | Borrow current public host Image output at useful content width, preserving opaque protocol/empty reservation rows | Host image IDs, conversion and width-cache ownership; no syntax measurement or retained payload copy |
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

## Shared fragment wrapping

Compact tool descriptions and read/write/edit headings use the single fragment algorithm in `src/text-wrap.ts`. A fragment is bounded by spaces or CJK characters; the summary adapter additionally marks commas inside named parameters as soft boundaries. Paths are not parsed into a separate wrapping grammar.

- A fragment that fits a whole content row moves intact when the current remainder is too small. A fragment longer than a whole row instead starts in the current remainder and continues across rows. A following space cannot evict a word that already fits.
- At a necessary cut, take the farthest whole grapheme that fits. Prefer the nearest boundary after a standalone ASCII `/`, `\`, `.`, `-`, `_`, `:`, `,`, `;`, `?`, `!`, `&`, `=`, `+`, `@`, `#` or `%`, at most **20 graphemes** before that hard boundary and using at least **half the current row's free columns**. Otherwise retain the hard boundary. Do not rebalance the suffix. A separator combined with a mark is not standalone.
- Only standalone U+0020 graphemes are disposable layout spaces; a space joined to a combining mark or Unicode Prepend character remains part of a complete visible grapheme. Leading/trailing standalone spaces do not create whitespace-only rows. Cuts do not insert source characters, split graphemes, truncate a heading or alter saved paths. JSON escape eligibility and parameter boundaries are supplied only by the summary adapter; a literal heading path is not JSON.

`wrapUnits` consumes measured widths and boundary flags and emits source-unit intervals. Fragment traversal is linear with a bounded 20-unit lookback per cut. `wrapText` is the string adapter: it segments/measures once per cold layout and restores strings from those intervals. Summaries and the standalone `measureFileCard` height helper use that adapter; summary color spans remain outside wrapping.

Prepared headings instead annotate their existing numeric measurements once, using spare flag bits without enlarging glyph records. Only headings pay for that classification. The file-heading layout and inline predecessor-height paths select the same fragment policy; resize does no segmentation, width calculation or UTF-8 measurement. A policy marker rejects fragment reflow of an unannotated measurement. The existing painter consumes the resulting numeric spans; no second string-row painter or persistent cache is added. Impossible-width headings keep file replacement-cell semantics, whereas summaries retain their existing indivisible over-wide character behavior.

Source/diff rows, Bash bodies, native renderers, editor and user messages retain their own preservation and wrapping contracts. Warm retained layouts invoke neither adapter nor the shared algorithm.

## Shared frame geometry

`cardGeometry` in `src/card-frame.ts` floors/clamps the component width, then allocates a possible stripe, up to two inner padding cells, exterior Output-padding margins and the remaining content width. It reserves useful content before all decorations can fit. `panelX`/`panelWidth` delimit the painted hit region; `contentX`/`contentWidth` delimit the caller's text area. Exact narrow-width allocations and paint roles are in [frame geometry](card-frame-spec.md).

Transcript Output padding is independent of native user Markdown padding, Editor padding and full-width footer placement. The adapter passes effective Output padding; presenters do not read global settings. The frame has no tool names, lifecycle, parser or theme-policy knowledge.

### Two framing APIs, two input contracts

| API | Input | Work |
| --- | --- | --- |
| `frameRows` | Styled strings whose cell width still needs checking, plus panel/stripe paint callbacks | Add top/bottom rows, measure visible widths, reject overflow, frame each row and restore enclosing panel paint after standalone SGR 0/49 resets |
| `frameMeasuredRow` | A fully painted child row and an already known valid cell count | Frame/pad that one row without scanning its ANSI or reopening parent paint across its explicit child resets |

User/queued projections use the first contract. Prepared Bash/read/edit/write output in `src/syntax/card-layout.ts` uses the second, explicitly producing top/bottom and body rows with prepared roles. Its child painter already paints complete cells, including diff/neutral surfaces. Reinterpreting that ANSI in the frame would duplicate work and could overwrite intentional child backgrounds.

Neither API truncates oversized body text to make a caller error disappear. Measured framing validates a safe integer cell count within its allocation; generic framing checks actual visible width. The common outer shell resets inherited background before the stripe and leaves exterior spaces unpainted. Panel hit tests are component-local and require the adapter to subtract any outside transcript separator.

`CardTheme` is the shared lightweight theme interface. The exported `toolCardPaint` helper is not the production prepared Bash/file painter; that path compiles roles before `frameMeasuredRow`. Likewise the exported standalone `measureFileCard` helper is not the current neighbor-spacing path. Their existence must not be mistaken for runtime call flow.

## Latest-layout identities

There are two related retention paths, not one monolithic cache key.

### Compact and native-projection rows

A component's weak-keyed state owns its latest layout entry. The summary memo includes semantic card kind (or the shared summary kind for other names), width, Output padding, theme/callback identity, argument/result identity, expansion/partial state and relevant directory. It does not create a layout-accounting category for every actual tool name. Existing host update/invalidation methods also release layouts, covering mutation inside an otherwise identical argument/result object.

User rows additionally depend on native text, padding, Markdown-child identity/theme/transformers and paint callbacks. Queued preparation depends on text, width, Output padding, paint and the last-card hint; screen height only selects already-prepared rows. The editor does not participate in these retained-row caches.

### Prepared Bash/read/edit/write scenes

The live adapter reads `syntax.visit(...)`, which validates the current prepared display and paint. It compares the previous retained scene against width, padding, expansion and `geometryStamp`:

1. If geometry is still retained and all geometry inputs match, reuse the scene.
2. If its output is still valid and `paintStamp` also matches, return the existing rows: a warm hit.
3. If only paint changed, paint the same scene with the new complete ready publication.
4. If geometry changed, construct a new scene from measured data and paint it.
5. Publish a candidate only after the outer prepared-card visit succeeds and the adapter remains active.

Read image blocks are composed outside the retained prepared text rows. Their opaque protocol and literal empty reservation rows bypass text framing/measurement, with only safe anchor positioning. Pi's current Image instances own their data/cache; the block can change after public image settings without invalidating or rebuilding saved text. See [read images](read-card-spec.md#images-a-host-owned-opaque-block).

A scene is the width-dependent layout, not a retained parser. Source/style/geometry funding can be refused or genuinely evicted under the separate logical-data authority even though rendered-layout accounting has no LRU policy. If a valid selected file view cannot be funded, it remains an owned bounded limitation presentation rather than falling through to hidden stock preparation; genuine unsupported full metadata and other documented native exceptions still use the native renderer. Missing syntax within an accepted view uses the ready palette's neutral role and does not fabricate permission for duplicate classification.

### Transactional replacement and cleanup

A retained prepared entry has detached cleanup receipts for its scene and output. When new paint reuses the old scene, the new entry takes over its geometry receipt and the old cleanup packet relinquishes that receipt **before** old-entry removal. Otherwise dropping the old entry would release geometry still used by the replacement.

Unadopted newly painted output and newly created geometry are disposed in `finally`. Reused old geometry is not disposed merely because a candidate failed. This makes publication atomic at the representation level: stale visits and exceptions cannot leave half-new palette/rows installed.

The complete source/palette atomicity rules remain in [prepared cards](syntax/prepared-cards.md); this section describes how the host adopts their layout/paint result.

## Neighbor spacing without another body build

Outside transcript separators are not retained inside a body. Parent/index edges are recorded during attachment; a visit first checks its recorded index and lazily repairs it after structural changes. It then walks backward to the previous visible sibling.

- Owned Bash can be compact or framed. A current compact entry or unavailable prepared display uses bounded-summary height; a usable prepared display needs only the multiline frame classification. A successful frame adoption releases the interim summary. Spacing never builds hidden Bash output merely to classify it.
- A compact sibling uses its latest bounded summary layout.
- User projection supplies cached body metadata rather than recursively invoking predecessor spacing.
- Unknown/native renderers may still have to render at the actual width to establish visibility.
- File spacing prefers the **already prepared file display**; when no prepared scene is available, it derives height from the same selected owned fallback used by rendering, not from a one-row compact approximation.

For files, `fileMeasure` in `src/index.ts` first uses an exact retained scene when available. Otherwise it derives fallback height from the same owned selected layout as `fileCard`: bounded preview, full view, unavailable-preview row, funded pending/error detail, or a bounded limitation after funding refusal. Only genuine native cases (including unsupported explicitly full metadata) call native rows for visibility. A non-inline accepted file mode needs only the framed/multiline classification; no source rows need reflow. An inline heading needs an exact height, so the adapter temporarily reflows its existing heading measurement and disposes that temporary result immediately. Failed/currentness-rejected visits do not publish a measurement.

This is not an extra height cache, a source-classification retry or another body admission. It exists because separation needs “one row versus multiline” and sometimes heading height, not a freshly painted diff.

Read's stock constructor spacer is not an image spacer and is not borrowed into the owned body. A hidden foreign read is skipped like any other hidden predecessor, whether compact or explicitly expanded. Its unknown self-shell visibility can still require native rendering; exact stock read does not need that probe.

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

### Palette change

The source identity and measured glyphs remain. The syntax layer resolves only missing style dependencies and prepares the complete selected palette. Until it can publish the replacement atomically, retained ready paint remains visible. A matching geometry scene can then be repainted without remeasurement, diff reparsing or source parsing. [Follow Pi](syntax/follow-pi.md), [owned palette preparation](syntax/palettes.md) and [color provenance](color-model.md) define the actual colors.

### New Bash suffix

The full latest normalized command becomes current display geometry. Only a validated scalar-prefix-compatible historical basis can color its matching prefix; the proof uses UTF-8 source bytes and belongs to the current revision. New text remains visible even while classification is waiting. That historical paint is display continuity, never evidence that a parser checkpoint or lease can be resumed. See [Bash streaming](bash-streaming-contract.md).

### Read collapse

Full read and compact summary are different representations, not a clipping flag over a retained full source. Collapse releases owned full display/geometry/paint and demand while keeping the original result in Pi. Warm compact frames neither scan that saved body nor render its images. Reopening prepares current saved text; host image lifetime remains independent.

### Removal or failed candidate

Native removal releases that owner's rows and useful syntax work, unless it is already attached elsewhere or in the specific synchronous renderer-transfer check. A failed unpublished candidate releases its temporary allocations without replacing the old valid presentation. Neither path rewrites the session result to manufacture a new source owner.

## Implementation map

- `src/index.ts`: presenter dispatch, latest-row adoption, predecessor spacing, transient prefix/separator composition and host ownership.
- `src/card-frame.ts`, `src/card-theme.ts`: geometry/framing and paint interfaces.
- `src/tool-adapters/summary.ts`, `src/summary-args.ts`: producer-selected compact arguments and the shared bounded-description formatter; `src/plain-text.ts` owns plain-block normalization.
- `src/tool-adapters/`: producer-specific saved-field interpretation and reader identities; `src/bash-card.ts`, `src/file-card.ts`: shared producer-neutral logical display/service models. Source and presentation responsibilities are explained in their respective chapters.
- `src/user-card.ts`, `src/queued-card.ts`: native Markdown projection and prepared plain queue rows.
- `src/syntax/cards.ts`, `measured-rows.ts`, `card-layout.ts`, `flat-paint.ts`: prepared source models, measured geometry, scenes and monotonic literal painting.
- `src/render-cache.ts`: weak row accounting and detached release receipts.
- `src/editor-card.ts`, `src/editor-status.ts`, `src/footer.ts`: separate input/status/footer projection and fitting, not another tool-card parser.
