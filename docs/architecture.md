# Architecture

pi-tidy-ui changes the presentation of an interactive Pi session. It does not change tool execution, model requests, arguments, results or saved conversation data. Pi loads `src/index.ts` directly as a TypeScript extension. The extension supplies cards, a projection of the existing input editor, session metadata, terminal-default colors and diagnostics. **Occipital** is a separate native syntax service: it parses supplied text into semantic scope contexts and resolves those contexts into styles. It does not know about Pi components, terminal layout or tool execution.

Start with the [manual index](README.md). This chapter explains how the parts cooperate; the linked chapters own the detailed algorithms, state machines and references. [Host integration](host-integration.md) explains attachment to Pi. [Occipital's own manual](occipital/README.md) can be read independently of the extension.

## Components and dependencies

```text
Pi: session, native components, public lifecycle and terminal
 |
 src/index.ts — application composition and public events
 |       |                         |
 |       |                         +-- settings/menu, Git, terminal defaults,
 |       |                             diagnostics and runtime health
 |       +-- src/presentation/ — typed intents, weak sessions,
 |       |                       tool/user/queued presenters
 |       +-- src/host/pi/ — native session and concrete bindings
 |                         public footer policy stays application-side
 |
 supplied tool data -> adapters -> presentation policy/router -> presenters
                                     |                           |
                                     +-- prepared display and source demand
                                      |                   |
                                color-free geometry       v
                                      |          SourceExecution / providers
                                      |                   |
                                      |          validated stdio or shared RPC
                                      |                   |
                                      |             Occipital process
                                      |          /                    \
                                      |    SOURCE parser        STYLE resolver
                                      |    semantic contexts    rules/expressions
                                      |          \                    /
                                      |           validated local storage
                                      |                   |
                                      +----------- complete ready card paint
                                                          |
                                   reflow -> literal paint -> frame -> latest rows
```

Expanded pending/error file details have a separate presentation owner in `src/presentation/file-details.ts`. The native session in `src/host/pi/` supplies opaque component identities, narrow current facts and native renderer capabilities to entry composition; `ToolProducerPresenter` supplies shared saved-call observations and derived facts through `ToolCallStates`, `ToolPresentationPolicy` selects a typed intent, and `ToolRoutingPresenter` queries native visibility only through the supplied host ports. `ToolPresentationSessions` owns the weak call records and latest-layout handles. Call facts and manual view choices outlive a layout, but not the call's attachment. The rolling window carries only weak owner membership. The summary, file-detail, prepared-layout, user and queued presenters own their corresponding projections. The tool-view presenter coordinates current render, spacing, hit and update decisions; the cold tool-preparation presenter owns revision/currentness, useful/paused-view transitions and coalesced refresh. Native sibling identities, shell recognition and rendered image rows are scoped host borrows, not copied component observations or cached visibility proof. `PreparedLayoutPresenter` remains the single owner of the prepared scene validity/stage/adopt/release transaction. These owners do not install host hooks, own native images or gain source-execution authority. Expanded pending/error details retain funded text/measurement, check input identities, lend readonly render flags and project rows. They receive an opaque owner key and operation-scoped numeric funding, not a component shape, provider or independent resource pool. Their [borrow and release contract](render-cache-spec.md#pending-and-failed-file-details) is separate from successful syntax-card preparation.

Factory-lived `FooterSession` and `TerminalColorSession` in `src/application/` own their public slot/semantic and observer-widget lifetimes over narrow current-fact readers. They do not receive preference, diagnostic, native-session or source-runtime service objects. Footer formatting/aggregation and terminal channel/projection algorithms retain their existing modules; the terminal binding borrows only a lifecycle capability for the existing weak terminal hooks. [Host integration](host-integration.md#composition-and-lifetime-boundaries) explains installation versus current-context reads and release ordering.

The arrows denote responsibility and data flow, not a requirement to perform an RPC on every frame. Cached source, styles, geometry and ready rows have distinct reuse rules. When native highlighting is unavailable, eligible ordinary files may use cached public Pi highlighting converted to the same flat style representation; Bash never calls Pi's classifier. An owned palette never silently borrows missing syntax colors from Pi.

Host libraries require Pi and pi-tui 1.0.1 or later; development copies are pinned to the supported minimum 1.0.1. Runtime imports use the public installed host packages, not bundled duplicate classes or private package paths. The Pi host adapter nevertheless inspects some private component **shapes** to establish safe integration. That narrower compatibility dependency and its fail-closed behavior are explicit in [host capture](host-integration.md#startup-and-attachment).

The native process uses Syntect/two-face assets and its own trusted vocabulary. Owned stdio uses bounded length-framed JSON, not JSON-lines. The optional shared path uses the public Subconscious service transport and the same v4 application contract. Source version `0.0.0` uses only the colocated helper; real-version delivery has a separate exact acquisition contract. Current v4 source compatibility must not be confused with the published v3 binaries. See [providers](syntax/providers.md), [daemon runtime](occipital/runtime.md) and [delivery](releases.md).

## One card from result to terminal

Consider a newly completed successful **full-view** `write` with path `demo.ts`, submitted content `const answer = 42;`, and no persisted diff. Assume appearance is enabled, the host is compatible, native highlighting is enabled and a compatible provider is available. This is a control/data-flow example, not a claim about captured parser output.

1. **Select a presentation.** Pi updates its existing tool component normally. The host observes that semantic update and evaluates the current guards. A compatible successful `write` data shape qualifies for a custom file card whether its renderer pair is stock or third-party; absent diff metadata selects the plain **Wrote** representation from submitted content. Third-party callbacks/state remain untouched, and only the exact deferred stock pair receives lazy-renderer ownership and its native-work savings. Expanded/image/hidden/opt-out cases obey their separate routing rules. No file is reread and no tool result is rewritten.
2. **Prepare the selected display once.** The [producer adapter](tool-adapters.md) validates the supplied shape under the construction grant and chooses the selected file view before constructing logical rows: newly completed live successes may be full, while restored or explicitly bounded cards use a raw-prefix preview. `CardSources` owns that selected display, its source slots and reusable measurements; the preview does not turn its hidden suffix into display rows or send it for syntax highlighting. File-result validation may read that suffix to determine the title. Display normalization is separate from source identity. This full-view example fits without a prefix cutoff. See [edit](edit-card-spec.md#metadata-and-scope) and [write](write-card-spec.md#saved-source-and-classification) for the view rules.
3. **Register useful work.** One chronological weak registry visits the source owner under existing preparation and physical-capacity limits. The owner key, source version, prepared display revision and desired rules are distinct identities. `workStatus` decides whether Occipital source work is outstanding and whether Pi fallback is permitted; a missing ready color is not by itself permission to classify again. Preparation, request encoding and dispatch are outside terminal `render()`.
4. **Parse on the native side.** A finite SOURCE request carries admitted text and language/path selection, not the Pi theme. The daemon validates the request, reserves physical credits and runs bounded parser turns on the route's worker. It returns complete scope-stack contexts and source ranges qualified by the trusted vocabulary. The consumer validates correlation, acknowledgement, ranges and storage costs before retaining them. Computation completion, transport delivery and client publication are different events.
5. **Resolve the desired appearance.** Missing contexts are resolved for one immutable rules identity. The common semantic rules are matched in Rust. Follow Pi binds their regions to public Pi colors; an owned palette binds the same regions to local validated palette data and supplies its complete card roles. Existing styles need no repeat STYLE request. The same source result and glyph measurements serve both choices. Concrete paint is not inferred from a partial dictionary or from another card's success.
6. **Publish one coherent card.** Once the selected palette input and all source styles required by this card are available, `CardSources` exposes an accepted ready presentation. The common layout/painter combines it with color-free measurements, fits rows for the current width and adds the frame. A final borrowed-visit validity check precedes publication of the candidate rows. An obsolete source/palette/owner cannot commit a partly valid view. Multi-source edit panes use the same rule for the whole card, without blocking independent cards.
7. **Reuse or release the right layer.** An unchanged terminal visit returns the latest body rows. A width change reflows stored measurements; a palette change reuses source and geometry and rematerializes retained styles locally, requesting STYLE only for missing expressions. Switching between bounded preview and full file view changes the selected source/display and can require cold preparation of newly exposed text; a same-view hidden-suffix replacement does not. Removal releases component presentation ownership and unregisters source work; outstanding physical work still settles according to its transport/cleanup contract.

Read uses the same file pipeline, but begins body preparation only on explicit expansion and takes source from saved result text rather than submitted write arguments. It has no diff or latest-ten membership. Collapse releases its derived full representation while retaining the saved result. Host-owned images are borrowed as opaque rows outside the text/geometry cache, not reconstructed by the syntax service. See the [read contract](read-card-spec.md).

The selected-file-view and complete representation paths are in [rendering](rendering.md), [edit](edit-card-spec.md#metadata-and-scope), [write](write-card-spec.md#saved-source-and-classification), and [prepared cards](syntax/prepared-cards.md). [Client requests](syntax/requests.md) and [native requests/resources](occipital/requests-and-resources.md) explain the two sides of step 4. [Follow Pi](syntax/follow-pi.md), [owned palette preparation](syntax/palettes.md) and the [color model](color-model.md) own step 5's exact algorithms.

## Why these boundaries exist

| Principle | Consequence and reason |
|---|---|
| Presentation is not execution | Tool execution, definitions, saved/model data and results stay authoritative. For an exact deferred stock read/write/edit pair, a supported owned file view may defer stock presentation-only highlighting, diff/preflight and result formatting until a genuine native path; it never changes execution or reads a file. Foreign callbacks remain untouched and have no zero-work guarantee. |
| Source is theme-independent | SOURCE returns semantic contexts, not final terminal colors. Recoloring must not reopen parser leases or reparse unchanged text. |
| One full-stack style resolver | Rust resolves one shared semantic definition and independent font properties. TypeScript binds either public Pi inputs or owned palette data and paints validated literal styles instead of implementing a second scope matcher. |
| Desired work is not ready paint | One complete ready card generation can remain visible during a replacement. This avoids mixed edit panes and unnecessary neutral flashes; it proves nothing about an unsettled parser job. |
| Geometry is color-free | Stored glyph widths permit local resize/reflow and repaint without another parse, style request or width measurement. The terminal frame is not the place to classify, encode RPC or acquire files. |
| One client work authority | Preparation, SOURCE and STYLE use one weak chronological registry and the same physical job/byte authority. Execution compares admitted target, parser progress, qualified attempts and live obligations; the registry supplies ordering/cursor/quota mechanics, not a second work policy. |
| One preference decision owner | `ApplicationPreferences` admits confirmations and interprets persistence outcomes; the existing settings store validates/serializes/publishes. Syntax composition receives choices and native-lifetime callbacks, never store access or an indirect save capability. |
| Physical settlement is explicit | Cancelling a caller wait does not prove native work never started. Safe fallback and bounded recovery depend on typed no-start, validated completion or actual owned-helper cleanup evidence. |
| Ownership determines retention | Component row caches, local semantic/geometry storage and native request credits protect different lifetimes. An accounting entry disappearing is not necessarily physical storage becoming free. |
| Extension hooks are borrowed | Restore only still-owned descriptors and slots. A later extension owner must never be overwritten by cleanup. Weak maps alone are insufficient if a shared closure still captures the first component. |
| Shared protocol, different schedulers | Both transports use bounded JSON v4 envelopes and decoded admission. The client prioritizes useful cards; the daemon fairly rotates routes and retains per-route ordering. No private binary carrier or second painter is needed. |

These are design constraints, not claims that every constant is uniquely optimal. Exact chosen limits and their protected costs are documented at their owning layer. Where historic rationale is recorded, the manual explains it; source behavior alone is not presented as evidence of an unrecorded motive.

## Identities and lifetimes

| Owner/lifetime | State it owns | Important boundary |
|---|---|---|
| Pi process | Local appearance/logging flags; two applied terminal-default values and owner-free exit cleanup | No component, UI adapter or session runtime survives reload through these process cells |
| Application preference owner | Factory-lived confirmed choices, one initial read, validated publications and all persistence admissions | Shares one existing settings writer; theme requests borrow native-incarnation facts, shared-switch requests borrow the application epoch |
| Session diagnostic binding | Factory-lived selector with ID-qualified health/sink, optional run-bound journal and separate strongly owned context cells | Observer edges are weak; health retirement, journal close/reference release and final cell release have distinct phases |
| Footer binding | Factory-lived public slot/name/generation/deferred state plus per-view semantic snapshot | Narrow current facts, exact public disposal and post-measurement coalescing; no native controller, preference or history owner |
| Terminal-color binding | Current public widget/controller and terminal detach operation | Widget-time sink/default selection; actual channels/query/projection stay in `TerminalColors`, terminal hooks hold weak owners |
| Application currentness scope | Generation and switch-save abort controller, with readonly paired signal/predicate projections | Equality admits startup/menu-open continuations; actions also require a non-aborted signal. It owns no UI, native lifetime or teardown |
| Session runtime | Scoped settings subscription/effects, Git snapshot, selected diagnostic observers, popup owner, syntax service composition | Old callbacks retain their old epoch/observer and cannot publish into a successor session |
| Installed presentation composition | One native session's hooks/weak attachment records plus separately owned presenters and `CardSources` consumer | Full removal/reinstallation may allocate fresh source keys and occasionally repeat classification; ordinary redraw/Off-within-source does not erase execution evidence |
| Tool presentation sessions | Weak per-component session facts, latest summary/file-layout handles and prepared-layout references; `tool-preparation.ts` owns cold currentness and useful/paused-view decisions | Latest rows follow component lifetime; the consumer-owned preparation port does not transfer card publication or source/job authority |
| File-detail presentation owner | Expanded pending/error text, measurement and detached weak cleanup records | Native updates supply freshness; rendering borrows flags/rows without retaining a producer or gaining cleanup/funding authority |
| Card/source owner | Current selected preview/full display (no body for compact read), classification demand/version, measured geometry, ready presentation | Current demand and historical display are separate; appearance changes do not prove SOURCE completion |
| Local syntax storage | Budget grants and shared charges, text/range captures, context leases, styles, concrete ready payloads | Attribution, last reference and actual funded-storage release are separate events |
| Occipital process | Bundled grammar assets/vocabulary, workers, process credits and generic rule preparation | It owns no palette catalogue, selected theme or palette-file access |
| Native route | Worker affinity and route-scoped source leases | Client UI owner identity is not the route or the external parser lease token |
| Occipital DATA request | Reservation, parser/style progression, result and encoded reply until delivery settlement | Worker completion alone does not release all credit or commit the transport's lease transition |

The detailed local ownership graph is in [syntax storage](syntax/storage.md); the daemon graph is in [requests/resources](occipital/requests-and-resources.md). Transcript latest-row retention deliberately has **no fixed entry/byte eviction budget**: evicting still-live layouts would make Pi's repeated whole-document visits rebuild them. It uses weak component lifetime and one latest layout, not a recency cache. Syntax storage and native admission remain bounded independently.

## Facts, decisions and release authority

A stored observation is not an independent policy authority. Keep the native fact,
its derived decision and the accepted display distinguishable: copying a flag into
another owner does not transfer the right to change it. In particular, source
execution, desired appearance and historical ready paint have different validity
and release boundaries.

| Fact / identity | Authoritative owner | Decision and effect | Invalidation or release |
|---|---|---|---|
| Tool arguments/result and native partial, expanded and hidden state | Pi's existing component | The host adapter selects a borrowed presentation; producers decode only supplied data | The actual native update or detach; no rewritten execution or saved result |
| Actual-width native visibility | The current native render, borrowed by the installed adapter | Routing, spacing, mouse and useful demand follow the same current facts | Recheck at the width/visit required by the guard; do not retain visibility proof across visits |
| Hook and descriptor ownership | The installed adapter's still-owned hook-family descriptors | Borrow native behavior without replacing a later extension owner | Restore exact prior descriptors only while the adapter still owns each hook |
| Selected preview/full view and logical display/source/service revisions | File-preview selection or Pi's read expansion; `CardSources`' explicit lifecycle update | Construct only the selected logical body and canonical source segments | A real view/source change or removal; read collapse releases its derived full view |
| Admitted source, parser progress, qualified attempt/refusal and execution history | `SourceExecution` owns flat source facts; storage owns validated progress; actual jobs own physical obligations | Pure SOURCE/STYLE decisions choose admissible next work; `workStatus` is the Pi-permission projection, not historical paint | Cancellation ends the old attempt's veto over new work without erasing execution evidence or refunding credit; validated completion and exact owned cleanup have separate effects |
| Outstanding physical DATA slots/bytes | Reserved jobs and module-incarnation physical accounting | All source/style work shares the existing admission capacity | Actual job settlement releases credit; abort, GC and fallback permission are not refunds |
| Retained source/context/range/Pi data and shared charges | Local syntax storage and its existing pressure owner | Fund storage, borrow synchronously and release through the last holder | Exact receipts, eviction and owner lifetime; extracted stores get no new capacity |
| Numeric grants and charges | `DataBudget`/`DataGrant`/`DataCharge` | Admit an operation's peak and transfer its numeric charge, never store its payload | Refund unused grant capacity; release the final charge owner |
| Measured glyph widths and reflow coordinates | Measured text/layout storage | Resize reflows; recolor reuses source and geometry | Source/view replacement and the exact geometry receipt, not a theme change |
| Desired palette/rules versus a complete accepted card | Desired style selection; ready group and `CardSources` publication | Resolve missing styles and publish all source/service/frame regions coherently | Final current-visit check; refusal retains only an eligible prior view |
| Latest completed rows versus layout accounting | Component-owned cache entry; `RenderCache`'s weak numeric record | Reuse one latest body without live-entry count/byte eviction | Replacement, explicit clear, detach and GC release their owned receipts |
| Confirmed preferences versus temporary preview | Factory-lived `ApplicationPreferences` owns confirmed intent and admissions; `ExtensionSettings` validates persistence; `TidyMenu` owns visit rollback and `SyntaxClient` applies decided choices | Apply validated state and preview/rollback; derive the effective palette without a second writer | Theme confirmations follow the native incarnation; shared-switch effects follow the application epoch; ready paint is not confirmation |
| Session callbacks versus process-only values | Session epoch and existing focused services; separate primitive process cells | Reject obsolete callbacks while preserving only approved local flags/default channels | Syntax cleanup precedes journal closure; no UI/runtime survives through process cells |

For a pending owned SOURCE job, confirmed helper cleanup can discard validation
payload and permit fallback **without freeing its outstanding DATA credit**. A
shared unknown outcome cannot borrow that owned-stop proof. Likewise, a refused
full-to-preview transition releases the old full display, paint and measurements
but keeps source keys and execution evidence; a late full reply cannot restore it.
See [work authority](syntax/work.md), [storage lifetimes](syntax/storage.md),
[accepted prepared views](syntax/prepared-cards.md) and [settings publication](settings-menu-spec.md).

## Changes and invalidation

| Change | Work that changes | Work deliberately reused |
|---|---|---|
| Unchanged host frame | Identity and validity checks; compose transient spinner rows or a missing [separated projection](render-cache-spec.md#work-per-frame) | Ready source/style/geometry and latest completed body rows |
| Real width change | Reflow, projection and final rows | Source scopes, styles and measured glyph widths |
| Palette preview/rollback | Local bindings/palette and coherent repaint; STYLE only for missing expressions | Theme-independent source and geometry; retained expressions allow local rollback |
| File preview/full selection | Selected source/display identity and any newly exposed source preparation | Still-valid selected source fragments and measurements only under their exact view/prefix identities |
| Read full/compact selection | Prepare or release its owned saved-result body, geometry, paint and demand | Original Pi result and independently host-owned images |
| New source text | Current source/version and useful demand; changed display measurement | Valid immutable prefix/storage and ready display only under their exact prefix/identity proofs |
| Terminal `stop` / successful `start` | Release/reconcile terminal channels; stop card work, end current waits and close our route even when idle; reactivate through ordinary acquisition and useful-work rules | Session, draft, cards and eligible local ready data; already-sent requests still settle their actual resource obligations without late publication |
| Appearance Off or adapter replacement | Remove/restore owned presentation and its source consumer | Tool/session data and native editing engine; process-only flags/default-channel cells have their own lifetime |
| Session shutdown/reload | Retire outgoing services, await source cleanup, close its journal and restore owned hooks | No outgoing UI/runtime object is handed into the new runtime |

Native-highlighting Off, frozen/hidden sources, explicit cache clearing, transport loss and uncertain timeouts have distinct rules; they are not aliases for deleting every cache. Follow the [provider lifecycle](syntax/providers.md), [source work](syntax/work.md), [render-cache contract](render-cache-spec.md) and [terminal channels](terminal-colors-spec.md).

## Modules and dependencies

| Module family | Canonical explanation |
|---|---|
| `src/index.ts`, `git-branch.ts` | Application composition, public lifecycle sequencing and [Git service](host-integration.md#directory-metadata-service) |
| `src/host/pi/` | One native installation/restoration authority, private tool/user/editor hook families, tree/native widget observation, exact native renderer/image borrows and public classification/Text bindings. No source client, funding pool or presenter implementation. See [native binding owners](host-integration.md#concrete-native-binding-owners) |
| `src/presentation/` | Typed tool intents and native-visibility routing; weak component sessions, latest tool/user/queued layouts and the one compact-spinner fallback deadline. `PreparedLayoutPresenter` owns the existing prepared-scene transaction; these presenters do not own native capture or source work. See [host dispatch](host-integration.md#presentation-dispatch), [rendering](rendering.md) and [retained layouts](render-cache-spec.md) |
| `src/tool-adapters/summary.ts`, `src/summary-args.ts`, `display-path.ts`, `plain-text.ts`, `card-frame.ts`, `card-theme.ts` | [Producer-selected compact arguments](tool-adapters.md), [shared summary formatting](tool-summary-spec.md), [rendering representations](rendering.md), [frame contracts](card-frame-spec.md) |
| `src/tool-adapters/` | [Producer formats, selection and source identity](tool-adapters.md), [Bash preparation](bash-card-spec.md), [edit representation](edit-card-spec.md), [write selection](write-card-spec.md), [read saved-result selection](read-card-spec.md) |
| `user-card.ts`, `queued-card.ts`, `editor-card.ts`, `editor-status.ts`, `footer.ts` | [Message projections](user-queued-cards.md), [editor](editor.md), [footer accounting/composition](footer-spec.md) |
| `render-cache.ts` | [Latest-layout ownership and animation](render-cache-spec.md) |
| `src/cards/` | Import-free logical file models, saved-result validation and bounded logical decoding, shebang interpretation, topology-only segment traversal, display cleaning/context selection and deferred Bash/file construction through caller-owned measurement capabilities. Cold coordinates and useful SOURCE joining share side/continuity/ordinal/key rules without a retained segment graph or eager source join. No lifecycle, provider or scheduler ownership. See [prepared cards](syntax/prepared-cards.md#prepare-the-full-display-classify-an-explicit-prefix) |
| `src/rendering/` | Prepared display/service/paint values, numeric measurement and append storage, distinct Bash/file reflow policies, separate Bash/file scene composition, shared funded scene construction and monotonic literal painting. Geometry has one numeric owner and scenes have one adoption/release owner; neither imports card preparation or source-work policy. See [rendering](rendering.md) |
| `src/syntax/` | `cards.ts` alone accepts a card's logical display, slots, palette lease and terminal paint, checks whether each result still belongs to the owner, and notifies presentation. `card-display.ts` stages display and measurement work, `card-palette.ts` owns consumer-wide selection and STYLE binding, and `card-read.ts` checks and borrows paid values without work or compilation. Each is used by the owner, not by the other two. [Highlighting pipeline](syntax-highlighting-spec.md), [prepared cards](syntax/prepared-cards.md), [Follow Pi](syntax/follow-pi.md) |
| `src/highlighting/` | `source-execution.ts` owns SOURCE facts, all physical jobs and refunds, the explicit preparation/STYLE/SOURCE visit, lifecycle and the canonical Pi-permission projection. Its one private `style-publication.ts` owner contains STYLE selection/attempts/cache, semantic source/group publication and reader validity; erased `execution-records.ts` views restrict writes over the same flat records without runtime wrappers. Import-free `source-state.ts` and `style-state.ts` compare qualified facts without owning state or performing effects; `work-registry.ts` owns chronological membership/cursor/pass/quota and weak continuation, not source/style policy. `pi-fallback.ts` owns the keyed Pi source records and funded classifier-to-flat-projection transaction while using that same execution root and retention pool. `card-publication.ts` supplies group seal/ready records and weak borrow/drop lifetimes; `StylePublication` owns live display validity and publication sequencing, while execution retains synchronous receipt processing, notices and superseded SOURCE-basis release. `style-preparation.ts` calculates under caller-held scratch, and `source-ports.ts` defines consumer capabilities. `storage/` owns retained semantic holders and the synchronous ready-display transaction, while the root retains the sole index, funding, pressure and release-receipt authority. Workload limits remain with their existing owners. See [work](syntax/work.md), [storage](syntax/storage.md), [prepared cards](syntax/prepared-cards.md) |
| `src/application/` | Application generation/save-currentness, footer slot/per-view semantic lifetime, terminal observer-widget attachment, session diagnostic selection/reference lifetime, preference admission/load/watch policy, pure outcome models, canonical fixed-menu data contracts/projections and separate stateless action policy. Menu rows carry typed intentions, not last-frame action values; status/cache formatting consumes borrowed facts without collecting them or owning popup state. `menu-actions.ts` interprets admitted commands and scoped completion results through the existing preference interface and narrow effects, never raw native, layout or journal owners. Separately composed native/data client, runtime and Pi acquisition options consume decided choices, not persistence capabilities. `diagnostic-session.ts` owns health/journal selection and separate context cells, not aggregate snapshots or native failure mapping. `scope.ts` owns only generation/save-currentness, not teardown: composition's named session/presentation startup, quiesce and shutdown functions retain explicit ordering and actual owner assembly. See [providers](syntax/providers.md), [settings and menu](settings-menu-spec.md), [observer lifetimes](debug-logging-spec.md#observation-flow-and-owners) |
| `src/appearance/` | Pure theme-choice values, shared card roles, concrete style conversion and `style-ansi.ts` literal ANSI encoding. Generic Occipital style shapes are the only permitted type-only native dependency. See [preferences and persistence](settings-menu-spec.md) and [palette roles](syntax/palettes.md) |
| `src/resources/data-budget.ts` | Numeric budget, grants/charges and the operation-scoped funding capability. See [syntax storage](syntax/storage.md) |
| `src/occipital/style-types.ts` | Import-free shared wire-expression and style-identity types; runtime decoding remains in the Occipital protocol/client modules. See the [highlighting pipeline](syntax-highlighting-spec.md) and [protocol reference](occipital/protocol.md) |
| `src/occipital/` | Native acquisition, [providers](syntax/providers.md), typed JSON operations, [request adapters](syntax/requests.md), generic decoding with explicit consumer bounds and the DATA carrier ceiling. It owns protocol/transport validation, not Pi/application/highlighting policy. See also the [daemon manual](occipital/README.md); this is not an independently isolated SDK package |
| `src/themes/`, syntax palette adapters | [Palette ownership](syntax/palettes.md), [Follow Pi binding](syntax/follow-pi.md), [shared color mathematics](color-model.md) |
| `settings.ts`, `tidy-menu.ts` | Persistence boundary and native popup/navigation/gesture/preview lifetime. Canonical menu contracts, pure fixed-menu projections and scoped action policy are in `src/application/`; the pure theme-selection model is in `src/appearance/`. See [preferences, popup ownership and persistence](settings-menu-spec.md) |
| `terminal-colors.ts`, `terminal-lifecycle.ts` | [Terminal defaults and lifecycle](terminal-colors-spec.md) |
| `src/application/diagnostic-session.ts`, `debug-log.ts`, `session-logging.ts`, `diagnostics.ts`, `runtime-health.ts` | [Observation, text journals and runtime health](debug-logging-spec.md) |
| `crates/occipital/` | [Standalone daemon manual](occipital/README.md): runtime, requests, parser, generic resolver, assets and protocol |
| `scripts/release/`, `packages/native/`, workflows | [Build/delivery/publication](releases.md), not evidence of already published availability |
| Test/performance harness | [Measurement framework](performance-testing.md) and [complete test procedures](testing.md) |

## Host-driven spinner and fallback

Compact execution animation uses the existing native redraw stream first, with one shared fallback clock only when native document draws stop. It does not replace Pi's activity indicator. The complete clock, invalidation and fallback rules are in [retained-layout animation](render-cache-spec.md#why-host-driven-animation-needs-a-fallback).

## Related contracts

The [index](README.md) supplies subsystem and task-oriented reading routes. Start with [host integration](host-integration.md) for an unexpected native/custom component, [client work](syntax/work.md) for missing colors, [the daemon overview](occipital/README.md) for service internals, and [diagnostics](debug-logging-spec.md) for evidence. The exact [wire reference](occipital/protocol.md) is separate from those explanations; it is not a substitute for them.
