# Internal architecture and implementation

This manual explains **how pi-tidy-ui is built and why its boundaries work this way**. It covers the Pi extension and the independent Occipital daemon: normal execution, data representations, ownership/lifetimes, algorithms, failure paths, limits and recorded design reasons. The repository [README](../README.md) is the user-facing guide: [installation](../README.md#install), [tool and conversation features](../README.md#see-the-work-without-the-noise), [the ten-request cache chart](../README.md#read-the-cache-chart), [settings](../README.md#make-it-yours) and [compatibility](../README.md#compatibility-and-boundaries). Start there for everyday use; this manual supplies the exact contracts and implementation detail.

## Start here

1. [System architecture](architecture.md) — components, dependencies, principles, state lifetimes and one complete `write`-card walkthrough.
2. [Pi host integration](host-integration.md) — startup, borrowed hooks, presentation selection, semantic events, shared services and teardown.
3. [Rendering](rendering.md) — logical text, byte/scalar/grapheme/cell coordinates, measurement, layout, paint and retained rows.
4. [Highlighting pipeline](syntax-highlighting-spec.md) — how the extension prepares work, obtains semantic/style data and publishes coherent cards.

If you are interested in **Occipital as a daemon**, start directly with its [standalone overview](occipital/README.md), then [runtime](occipital/runtime.md) and [one request's lifecycle](occipital/requests-and-resources.md). Pi cards and menus are not prerequisites.

## Extension host and presentation

| Chapter | What it explains |
|---|---|
| [Host integration](host-integration.md) | Composition root, actual host capture, public API versus inspected shapes, exact routing/visibility, descriptor/slot ownership, renderer transfer, events, Git metadata and shutdown |
| [Rendering](rendering.md) | Representation pipeline, normalization, coordinate systems, framing responsibilities, reuse and worked width/theme/removal paths |
| [Shared frame](card-frame-spec.md) | Exact geometry, Output padding, narrow widths, generic versus measured framing, ANSI boundaries and hit regions |
| [Compact summaries](tool-summary-spec.md) | Field selection, bounded serialization, secret masking, wrapping/span recoloring and execution-prefix composition |
| [Bash cards](bash-card-spec.md) | Command/service/output/reminder decomposition, complete supplied text, previews and exact terminal-tail conventions |
| [Bash streaming](bash-streaming-contract.md) | Current text versus historical prefix colors, incomplete calls, frozen/restored sources and work authority |
| [Edit cards](edit-card-spec.md) | Saved patch/numbered formats, full and visible views, continuous old/new source regions, unified/split pairing and coordinate projection |
| [Write cards](write-card-spec.md) | Saved-metadata precedence, Created/Edited/Replaced/Wrote classification and reuse of the file pipeline |
| [User and queued cards](user-queued-cards.md) | Native Markdown reframing versus full plain queue preparation, native traversal, geometric stripping and height-only selection |
| [Editor](editor.md) | Stock-instance projection, paired widths, sentinels, cursor/mouse coordinates, native activity and below-editor metadata |
| [Footer](footer-spec.md) | Semantic snapshots, usage/cache/context/title calculation, opaque producer-status packing and layout reuse |
| [Retained layouts and animation](render-cache-spec.md) | One latest component-owned body, weak accounting versus real storage, invalidation/removal and host-driven spinner fallback |

## Extension-side highlighting

| Chapter | What it explains |
|---|---|
| [Pipeline entry](syntax-highlighting-spec.md) | Surfaces, source/style/geometry/paint identities and lifecycle/reuse map |
| [Providers](syntax/providers.md) | Construction/activation, discovery, exact runtime acquisition, selected/effective/ready palette state, bounded recovery and intentional suspension |
| [Request adapters](syntax/requests.md) | Stdio/shared correlation, admission and decoding, caller wait versus physical settlement, failure origin and cleanup proof |
| [Work controller](syntax/work.md) | Single weak chronological registry, SOURCE/STYLE scheduling, useful-prefix policy, fallback authority and atomic per-card publication |
| [Storage](syntax/storage.md) | Numeric grants and shared charges, source captures/range blocks, context arena, style groups, pins, pressure and release receipts |
| [Prepared cards](syntax/prepared-cards.md) | Prepared source slots, full display versus classification, measured geometry, coherent paint, Pi ANSI conversion and accepted borrowed visits |
| [Shebang hints](syntax/shebang-hints.md) | Curated interpreter map, exact line-1 provenance, `env` subset, generic language selector, optional-path fallback, source identity and per-side diff painting |
| [Follow Pi](syntax/follow-pi.md) | Public Pi binding and semantic-rule tables, role-specific derived colors, provenance, contrast/quantization, font composition and rationale |
| [Palette ownership](syntax/palettes.md) | Common 44-slot classifier, bundled local palette data, funded input leases, complete card roles and diff-surface derivation |
| [Color model](color-model.md) | Shared color representations and diff-surface math with distinct Follow Pi/owned-palette authored inputs |

`src/occipital/` contains the extension's client mechanisms; it is not the Rust daemon and is not claimed to be an independently isolated SDK package. Native computation belongs to the next section.

## Occipital daemon

| Chapter | What it explains |
|---|---|
| [Overview](occipital/README.md) | Program purpose, dependency boundary, modes, components, lifetimes and standalone consumer routes |
| [Runtime](occipital/runtime.md) | CLI/startup, Tokio/I/O/parser threads, route assignment, stdio/shared frontends, control authority, backpressure and shutdown |
| [Requests and resources](occipital/requests-and-resources.md) | Borrowed probing versus authoritative validation, CONTROL/DATA queues, credited admission, turns, encoding, delivery acknowledgment and failure release |
| [Source engine](occipital/source-engine.md) | Language selection, route/lease/state identities, finite batching, committed/checkpoint/provisional/frozen text, scope-stack emission and annotated append |
| [Assets and identities](occipital/assets.md) | Build inputs, vocabulary extraction, linked contexts, native handles versus portable IDs, hashes/revisions and compatibility consequences |
| [Protocol reference](occipital/protocol.md) | Exact carrier framing, operations/fields, correlations, source acknowledgments, contexts/styles, errors, numeric limits and counters |

The protocol reference ships with this manual. Its six current conformance JSON files and executable harness remain checkout-only engineering inputs under `protocol/syntax-v4/`; historical v3 inputs are kept separately for comparison. The reference identifies their locations without depending on a different version of GitHub main.

## Common services and engineering reference

| Chapter | What it explains |
|---|---|
| [Settings and menu](settings-menu-spec.md) | Popup/service boundaries, preview/confirmation, file/token validation, serialized rename, cross-process watches and local versus persisted switches |
| [Terminal defaults](terminal-colors-spec.md) | Fixed/automatic source eligibility, desired/applied OSC channels, concrete RGB projection, source failure, stop/start and process-exit ownership |
| [Diagnostics and health](debug-logging-spec.md) | Independent observation/health/journal owners, safe metadata, bounded writer, retention, incidents, recovery and explicit controls |
| [Delivery and releases](releases.md) | CI graph, supported targets, version/native-byte admission, staging, notices and exact-tag OIDC/provenance npm publication |
| [Performance framework](performance-testing.md) | Workload/input identities, subprocess containment, metrics, diagnostics, comparison and artifact semantics |
| [README screenshots](screenshots.md) | Tracked offline demo, immutable Working frame, real Git workspace and terminal colors, actual foot/grim PNG capture on Hyprland, signal cleanup, prerequisites and explicit preview replacement |
| [Testing](testing.md) | Fresh-clone provisioning, prepared inputs, bounded file jobs, diagnostic duration/RAM results, real integrations, containment and affected contract checks |

## Find an explanation by question

| Question | Reading route |
|---|---|
| Why is this component native, hidden or custom? | [Host dispatch](host-integration.md#presentation-dispatch) → [native visibility](host-integration.md#native-visibility) → the relevant presenter |
| What happens between a tool result and terminal pixels? | [Worked card](architecture.md#one-card-from-result-to-terminal) → [rendering](rendering.md) → [prepared cards](syntax/prepared-cards.md) |
| How do I run or use Occipital without Pi? | [Daemon overview](occipital/README.md) → [runtime modes](occipital/runtime.md#executable-entry) → [protocol negotiation and requests](occipital/protocol.md) |
| Why does a request stay pending after a caller stops waiting? | [Client request lifetime](syntax/requests.md) → [native request/delivery ownership](occipital/requests-and-resources.md) |
| Why do appended command colors differ from final colors? | [Bash display proof](bash-streaming-contract.md) → [source checkpoints and tails](occipital/source-engine.md) → [exact source acknowledgments](occipital/protocol.md) |
| What is recomputed on resize, recolor or preview rollback? | [Identity/change map](syntax-highlighting-spec.md#independent-identities) → [prepared-card reuse](syntax/prepared-cards.md) → [latest row signatures](rendering.md#latest-layout-identities) |
| How are theme roles, Markdown and structural delimiters colored? | [Follow Pi adapter](syntax/follow-pi.md) or [owned palette](syntax/palettes.md) → [shared color mathematics](color-model.md) |
| Why did a saved palette preference not appear? | [Preference publication/preview](settings-menu-spec.md) → [selected/effective/ready](syntax/providers.md#selected-effective-and-ready-palettes) → [local palette identity and assets](syntax/palettes.md) |
| Why was memory not freed by removing a card or clearing layouts? | [Component rows](render-cache-spec.md) → [local grants/captures](syntax/storage.md) → [native delivery credit](occipital/requests-and-resources.md) |
| How do reload, appearance Off, native Off and terminal stop differ? | [Host lifetimes](host-integration.md) → [provider transitions](syntax/providers.md) → [terminal channels](terminal-colors-spec.md) |
| Where can I observe a failure, and what does that evidence prove? | [Extension health/journals](debug-logging-spec.md) or [daemon runtime/descriptor/counters](occipital/README.md) → the owning request/recovery contract |
| How does an extension identify a script without a useful filename? | [Shebang provenance and aliases](syntax/shebang-hints.md) → [SOURCE grammar precedence](occipital/source-engine.md#language-selection) → [source-hint protocol revision](occipital/protocol.md#descriptor-and-metadata-operations) |
| What must change when grammar, vocabulary or rule interpretation changes? | [Native assets/identities](occipital/assets.md) → [wire compatibility](occipital/protocol.md) → [delivery](releases.md) → [validation](testing.md) |

## Boundaries of this manual

The code is the authority for current behavior. Historical plans/reviews in `.test-artifacts` supply recorded decisions and explanations, not proof that an old implementation or acceptance run is still current. Plans, work stages, review reports and test results are not chapters of this manual. Exact technical policies are maintained at one canonical home and linked from broader explanations.

The separately maintained [`research/syntax-highlighting/`](research/syntax-highlighting/README.md) directory is operator research, not the implemented contract. It is preserved unchanged and excluded from the npm documentation payload. The full [testing guide](testing.md) is the agreed procedural exception.
