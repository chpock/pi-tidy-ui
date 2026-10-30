# Architecture

pi-tidy-ui changes the presentation of an interactive Pi session. It does not change tool execution, model requests, arguments, results or saved conversation data. Pi loads `src/index.ts` directly as a TypeScript extension. The extension supplies cards, a projection of the existing input editor, session metadata, terminal-default colors and diagnostics. **Occipital** is a separate native syntax service: it parses supplied text into semantic scope contexts and resolves those contexts into styles. It does not know about Pi components, terminal layout or tool execution.

Start with the [manual index](README.md). This chapter explains how the parts cooperate; the linked chapters own the detailed algorithms, state machines and references. [Host integration](host-integration.md) explains attachment to Pi. [Occipital's own manual](occipital/README.md) can be read independently of the extension.

## Components and dependencies

```text
Pi: session, native components, public lifecycle and terminal
 |
 src/index.ts — host capture, ownership, presentation selection, events
 |       |                         |
 |       |                         +-- settings/menu, Git, terminal defaults,
 |       |                             diagnostics and runtime health
 |       +-- native user/editor/footer integration
 |
 supplied tool data -> presenters -> prepared display and source demand
                                      |                   |
                                color-free geometry       v
                                      |          SourceController / providers
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

The arrows denote responsibility and data flow, not a requirement to perform an RPC on every frame. Cached source, styles, geometry and ready rows have distinct reuse rules. When native highlighting is unavailable, eligible ordinary files may use cached public Pi highlighting converted to the same flat style representation; Bash never calls Pi's classifier. An owned palette never silently borrows missing syntax colors from Pi.

Host libraries are wildcard peer dependencies; development copies are pinned to Pi/pi-tui 1.0.0. Runtime imports use the public installed host packages, not bundled duplicate classes or private package paths. The adapter nevertheless inspects some private component **shapes** to establish safe integration. That narrower compatibility dependency and its fail-closed behavior are explicit in [host capture](host-integration.md#startup-and-attachment).

The native process uses Syntect/two-face assets and its own trusted vocabulary. Owned stdio uses bounded length-framed JSON, not JSON-lines. The optional shared path uses the public Subconscious service transport and the same v4 application contract. Source version `0.0.0` uses only the colocated helper; real-version delivery has a separate exact acquisition contract. Current v4 source compatibility must not be confused with the published v3 binaries. See [providers](syntax/providers.md), [daemon runtime](occipital/runtime.md) and [delivery](releases.md).

## One card from result to terminal

Consider a newly completed successful `write` with path `demo.ts`, submitted content `const answer = 42;`, and no persisted diff. Assume appearance is enabled, the host is compatible, native highlighting is enabled and a compatible provider is available. This is a control/data-flow example, not a claim about captured parser output.

1. **Select a presentation.** Pi updates its existing tool component normally. The host observes that semantic update and evaluates the current guards. The exact successful `write` qualifies for a custom file card; absent diff metadata selects the plain **Wrote** representation from the submitted content. Expanded/image/hidden/opt-out cases obey their separate routing rules. No file is reread and no tool result is rewritten.
2. **Prepare display once.** `file-card.ts` validates the supplied shape and constructs the logical source/visible-row representation. `CardSources` owns the card's prepared display, source slots and reusable measurements. Display normalization is separate from source identity. The entire display is retained even when a larger source would receive only a bounded classification prefix. This example fits without a prefix cutoff.
3. **Register useful work.** One chronological weak registry visits the source owner under existing preparation and physical-capacity limits. The owner key, source version, prepared display revision and desired rules are distinct identities. `workStatus` decides whether Occipital source work is outstanding and whether Pi fallback is permitted; a missing ready color is not by itself permission to classify again. Preparation, request encoding and dispatch are outside terminal `render()`.
4. **Parse on the native side.** A finite SOURCE request carries admitted text and language/path selection, not the Pi theme. The daemon validates the request, reserves physical credits and runs bounded parser turns on the route's worker. It returns complete scope-stack contexts and source ranges qualified by the trusted vocabulary. The consumer validates correlation, acknowledgement, ranges and storage costs before retaining them. Computation completion, transport delivery and client publication are different events.
5. **Resolve the desired appearance.** Missing contexts are resolved for one immutable rules identity. The common semantic rules are matched in Rust. Follow Pi binds their regions to public Pi colors; an owned palette binds the same regions to local validated palette data and supplies its complete card roles. Existing styles need no repeat STYLE request. The same source result and glyph measurements serve both choices. Concrete paint is not inferred from a partial dictionary or from another card's success.
6. **Publish one coherent card.** Once the selected palette input and all source styles required by this card are available, `CardSources` exposes an accepted ready presentation. The common layout/painter combines it with color-free measurements, fits rows for the current width and adds the frame. A final borrowed-visit validity check precedes publication of the candidate rows. An obsolete source/palette/owner cannot commit a partly valid view. Multi-source edit panes use the same rule for the whole card, without blocking independent cards.
7. **Reuse or release the right layer.** An unchanged terminal visit returns the latest body rows. A width change reflows stored measurements; a palette change reuses source and geometry and rematerializes retained styles locally, requesting STYLE only for missing expressions. A text change creates new source/display demand and measures changed text as appropriate. Removal releases component presentation ownership and unregisters source work; outstanding physical work still settles according to its transport/cleanup contract.

The complete representation path is in [rendering](rendering.md), [file preparation](edit-card-spec.md#internal-flow) and [prepared cards](syntax/prepared-cards.md). [Client requests](syntax/requests.md) and [native requests/resources](occipital/requests-and-resources.md) explain the two sides of step 4. [Follow Pi](syntax/follow-pi.md), [owned palette preparation](syntax/palettes.md) and the [color model](color-model.md) own step 5's exact algorithms.

## Why these boundaries exist

| Principle | Consequence and reason |
|---|---|
| Presentation is not execution | Native updates, tool definitions, edit preflight and saved/model data stay authoritative. A display fix cannot introduce another tool/file read or suppress native work to improve a counter. |
| Source is theme-independent | SOURCE returns semantic contexts, not final terminal colors. Recoloring must not reopen parser leases or reparse unchanged text. |
| One full-stack style resolver | Rust resolves one shared semantic definition and independent font properties. TypeScript binds either public Pi inputs or owned palette data and paints validated literal styles instead of implementing a second scope matcher. |
| Desired work is not ready paint | One complete ready card generation can remain visible during a replacement. This avoids mixed edit panes and unnecessary neutral flashes; it proves nothing about an unsettled parser job. |
| Geometry is color-free | Stored glyph widths permit local resize/reflow and repaint without another parse, style request or width measurement. The terminal frame is not the place to classify, encode RPC or acquire files. |
| One client work authority | Preparation, SOURCE and STYLE use one weak chronological registry and the same physical job/byte authority. Independent queues must not disagree about capacity or fallback permission. |
| Physical settlement is explicit | Cancelling a caller wait does not prove native work never started. Safe fallback and bounded recovery depend on typed no-start, validated completion or actual owned-helper cleanup evidence. |
| Ownership determines retention | Component row caches, local semantic/geometry storage and native request credits protect different lifetimes. An accounting entry disappearing is not necessarily physical storage becoming free. |
| Extension hooks are borrowed | Restore only still-owned descriptors and slots. A later extension owner must never be overwritten by cleanup. Weak maps alone are insufficient if a shared closure still captures the first component. |
| Shared protocol, different schedulers | Both transports use bounded JSON v4 envelopes and decoded admission. The client prioritizes useful cards; the daemon fairly rotates routes and retains per-route ordering. No private binary carrier or second painter is needed. |

These are design constraints, not claims that every constant is uniquely optimal. Exact chosen limits and their protected costs are documented at their owning layer. Where historic rationale is recorded, the manual explains it; source behavior alone is not presented as evidence of an unrecorded motive.

## Identities and lifetimes

| Owner/lifetime | State it owns | Important boundary |
|---|---|---|
| Pi process | Local appearance/logging flags; two applied terminal-default values and owner-free exit cleanup | No component, UI adapter or session runtime survives reload through these process cells |
| Session runtime | Settings/watch services, Git snapshot, health and journal observers, popup owner, syntax service composition | Old callbacks retain their old epoch/observer and cannot publish into a successor session |
| Installed presentation adapter | Hooks/slots, weak component records, `CardSources` consumer | Full removal/reinstallation may allocate fresh source keys and occasionally repeat classification; ordinary redraw/Off-within-source does not erase execution evidence |
| Card/source owner | Current full display, classification demand/version, measured geometry, ready presentation | Current demand and historical display are separate; appearance changes do not prove SOURCE completion |
| Local syntax storage | Budget grants and shared charges, text/range captures, context leases, styles, concrete ready payloads | Attribution, last reference and actual funded-storage release are separate events |
| Occipital process | Bundled grammar assets/vocabulary, workers, process credits and generic rule preparation | It owns no palette catalogue, selected theme or palette-file access |
| Native route | Worker affinity and route-scoped source leases | Client UI owner identity is not the route or the external parser lease token |
| Occipital DATA request | Reservation, parser/style progression, result and encoded reply until delivery settlement | Worker completion alone does not release all credit or commit the transport's lease transition |

The detailed local ownership graph is in [syntax storage](syntax/storage.md); the daemon graph is in [requests/resources](occipital/requests-and-resources.md). Transcript latest-row retention deliberately has **no fixed entry/byte eviction budget**: evicting still-live layouts would make Pi's repeated whole-document visits rebuild them. It uses weak component lifetime and one latest layout, not a recency cache. Syntax storage and native admission remain bounded independently.

## Changes and invalidation

| Change | Work that changes | Work deliberately reused |
|---|---|---|
| Unchanged host frame | Cheap identity/validity checks, transient separator/spinner composition if needed | Ready source/style/geometry and latest completed body rows |
| Real width change | Reflow, projection and final rows | Source scopes, styles and measured glyph widths |
| Palette or preview change | Local bindings/palette and coherent repaint; STYLE only for missing expressions | Theme-independent source and geometry; retained expressions allow local rollback |
| New source text | Current source/version and useful demand; changed display measurement | Valid immutable prefix/storage and ready display only under their exact prefix/identity proofs |
| Terminal `stop` / successful `start` | Release/reconcile terminal channels; deliberately interrupt unfinished syntax and resume useful work | Session, draft, cards and eligible local ready data; idle healthy providers need not restart |
| Appearance Off or adapter replacement | Remove/restore owned presentation and its source consumer | Tool/session data and native editing engine; process-only flags/default-channel cells have their own lifetime |
| Session shutdown/reload | Retire outgoing services, await source cleanup, close its journal and restore owned hooks | No outgoing UI/runtime object is handed into the new runtime |

Native-highlighting Off, frozen/hidden sources, explicit cache clearing, transport loss and uncertain timeouts have distinct rules; they are not aliases for deleting every cache. Follow the [provider lifecycle](syntax/providers.md), [source work](syntax/work.md), [render-cache contract](render-cache-spec.md) and [terminal channels](terminal-colors-spec.md).

## Modules and dependencies

| Module family | Canonical explanation |
|---|---|
| `src/index.ts`, `git-branch.ts` | [Host integration, routing, events and Git service](host-integration.md) |
| `summary-args.ts`, `plain-text.ts`, `card-frame.ts`, `card-theme.ts` | [Rendering representations](rendering.md), [summary algorithms](tool-summary-spec.md), [frame contracts](card-frame-spec.md) |
| `bash-card.ts`, `file-card.ts` | [Bash preparation](bash-card-spec.md), [stream lifetime](bash-streaming-contract.md), [edit representation](edit-card-spec.md), [write selection](write-card-spec.md) |
| `user-card.ts`, `queued-card.ts`, `editor-card.ts`, `editor-status.ts`, `footer.ts` | [Message projections](user-queued-cards.md), [editor](editor.md), [footer accounting/composition](footer-spec.md) |
| `render-cache.ts` | [Latest-layout ownership and animation](render-cache-spec.md) |
| `src/syntax/` | [Highlighting pipeline](syntax-highlighting-spec.md), [prepared cards](syntax/prepared-cards.md), [Follow Pi](syntax/follow-pi.md) |
| `src/occipital/` | [Providers](syntax/providers.md), [request adapters](syntax/requests.md), [work controller](syntax/work.md), [storage](syntax/storage.md); a module directory, not an independently isolated SDK package |
| `src/themes/`, syntax palette adapters | [Palette ownership](syntax/palettes.md), [Follow Pi binding](syntax/follow-pi.md), [shared color mathematics](color-model.md) |
| `settings.ts`, `tidy-menu.ts` | [Preferences, popup ownership and persistence](settings-menu-spec.md) |
| `terminal-colors.ts`, `terminal-lifecycle.ts` | [Terminal defaults and lifecycle](terminal-colors-spec.md) |
| `debug-log.ts`, `session-logging.ts`, `diagnostics.ts`, `runtime-health.ts` | [Observation, text journals and runtime health](debug-logging-spec.md) |
| `crates/occipital/` | [Standalone daemon manual](occipital/README.md): runtime, requests, parser, generic resolver, assets and protocol |
| `scripts/release/`, `packages/native/`, workflows | [Build/delivery/publication](releases.md), not evidence of already published availability |
| Test/performance harness | [Measurement framework](performance-testing.md) and [complete test procedures](testing.md) |

## Host-driven spinner and fallback

Compact execution animation uses the existing native redraw stream first, with one shared fallback clock only when native document draws stop. It does not replace Pi's activity indicator. The complete clock, invalidation and fallback rules are in [retained-layout animation](render-cache-spec.md#why-host-driven-animation-needs-a-fallback).

## Related contracts

The [index](README.md) supplies subsystem and task-oriented reading routes. Start with [host integration](host-integration.md) for an unexpected native/custom component, [client work](syntax/work.md) for missing colors, [the daemon overview](occipital/README.md) for service internals, and [diagnostics](debug-logging-spec.md) for evidence. The exact [wire reference](occipital/protocol.md) is separate from those explanations; it is not a substitute for them.
