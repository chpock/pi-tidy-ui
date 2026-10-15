# Existing test coverage and dependency map

Status: **baseline audit plus approved migration map**. The inventory below preserves original case IDs, filenames and measured costs for traceability; those historical filenames are not current entry points. Current ownership/prerequisites live in the explicit [catalogue](../scripts/test/catalog.mjs), the [approved organization](test-organization-plan.md) and [execution guide](testing.md).

## Current entry points

- SDK declarations now live in domain `*.sdk.test.ts` files; shared SDK support registers no tests.
- Main physical cases now live in domain `*.cli.test.mjs` files, with the original T02/T04 as `smoke`. T24 argument-preview coverage has one physical owner and is selected by both summaries and edit contracts.
- Syntax cases are separated into owned, shared, menu, fallback logging and native logging CLI files. **S04 is a real Pi acquisition-gate case**, not a synthetic helper; the initial audit classification below is corrected.
- Real-helper node controls are `occipital-native.test.ts`, `occipital-controller.native.test.ts` and `occipital-factories.native.test.ts`; the remaining controller/factory logic no longer acquires that capability. The POSIX fake-executable control has explicit platform applicability, not a missing-input skip.
- The installed third-party profile case is `integration-profile.compat.test.mjs`; schema/profile fixture controls remain independent of installation. Shared CLI cases alone additionally require the supplied host.
- New catalogue/feature/routing regressions exercise selected prerequisites, source refresh and reviewed CI scope. Every root test and the two fixed consumer entries must be owned; discovery validates ownership rather than assigning unknown tests to a catch-all unit suite.

## Baseline scope and evidence

Audited on 2026-10-15, against HEAD `5d97a8b` **plus the uncommitted optimized harness**, not against HEAD alone. The preceding accepted local matrix is documented in `.test-artifacts/terminal-performance/final-report.md`; its execution receipts identify the exact tested snapshots. This documentation audit did not rerun tests, change test selection, or change CI.

The inventory accounts for:

- **65 root `*.test.ts` / `*.test.mjs` entries:** 56 discovered by today's broad `unit`, six by `native-release`, one by `rust-harness`, and two physical-CLI entries.
- Two additional consumer script entries, not ordinary Node test files.
- All 17 Rust integration targets, inline Rust tests, the allocator control, and CI-only build/ABI/consumer gates.
- All 49 main-terminal parent cases and 24 syntax-terminal cases. Main reports 56 tests because seven nested controls remain attached to their parent cases.

Saved timing analysis: `.test-artifacts/test-organization/existing-costs.json`, extracted from accepted receipts and original TAP, not new runs. Individual unit-file and preparation durations are **not established** by this audit. Timing numbers below are observations on one local machine, not CI guarantees or additive savings estimates.

### Execution requirements used in this map

| Code | Actual execution requirement |
|---|---|
| `N` | Selected Node, owned temporary files; possibly local Git/npm/Make or controlled Node subprocesses as explicitly noted. No Rust daemon. |
| `S` | Coherent selected Pi SDK/TUI, sometimes xterm and real GC. Does **not** mean a live interactive Pi or Occipital. |
| `P` | Actual selected interactive Pi through the Python PTY bridge and xterm. |
| `O` | Actual verified same-commit/current-native-source Occipital executable. Building it is a separate preparation cost. |
| `H` | Actual pinned Subconscious host as well as Occipital; not just a fake shared SDK. |
| `I` | Prepared locked 11-package third-party integration profile. |
| `R` | Prepared pinned Rust toolchain and offline Cargo inputs. |
| `C` | Local consumer installation, prepared package archives/metadata, loopback registry and npm. |
| `X` | Authorized published-release validation requiring public network access. |

Requirements describe the **test body**, not today's oversized runner envelope. All existing Node entries additionally pass through the selected-host hermetic bootstrap and GC guard. Thus `N` is not permission to run bare ambient `node --test` today. Files labelled `N` can still indirectly load SDK imports through `src/index.ts` or the bootstrap; only the absence of daemon/PTY requirements is asserted.

## Measured cost and current selection

| Existing execution | Accepted local observation | Important qualification |
|---|---:|---|
| Strict types | wrapper about 7–8 s | Includes runner overhead, not dependency provisioning. |
| Broad `unit` | 1,391 passing; 51–62 s | Mixes SDK/contracts, transport subprocesses, harness and actual daemon controls. Not 1,391 isolated pure units. |
| `native-release` | 109 passing; 23.36 s in the recorded baseline | Primarily inert-payload/local packaging and policy regressions, **not** six real native builds. |
| Main terminal | 56 passing; 335.64–362.57 s | 49 parent cases. First profile had 210 interactive launches: 209 trace-observed plus one nested isolated launch. |
| Syntax terminal | 24 passing; 63.19–70.47 s | Real daemon controls, two actual shared-host cases, some fallback-only observation cases; all 24 parents actually launch Pi. |
| Rust build/check/tests, consumers, clean preparation | No comparable end-to-end cost established here | Must be measured separately, including cold/warm stores and artifact acquisition. |

### Structural coupling in the current harness

Source: `scripts/test/run.mjs:31–47,87–101`, `scripts/test/prepare.mjs:147–200,202–268`, `scripts/test/bootstrap.mjs:8–14`.

1. `unit` is discovery by exclusion, not a declared functional group. It requires `validateNative()` even when `--files` selects only a footer test.
2. `terminal` requires `inputs.integration` even for a physical editor/footer test that never loads the third-party profile.
3. `syntax-terminal` requires both native and shared-host inputs at suite admission, including when filtering to a provider-readiness observation control.
4. The separate `native` selector includes only `occipital-native.test.ts` and `occipital-factories.test.ts`; it omits three actual-daemon controls embedded in `occipital-controller.test.ts`. These files also run in broad `unit`, so simply concatenating suites repeats coverage.
5. Name filters do not remove module-level requirements: `occipital-factories.test.ts:80` validates the binary while loading the file, before selecting its many non-native cases.
6. Preparation always materializes a new neutral snapshot, runs owned `npm ci/install`, and copies the dependency tree. Integration packages, archives, Rust inputs and helper builds are optional flags, but callers frequently request unrelated capabilities together. A source edit requires refreshing the snapshot; a name filter does not avoid that preparation.
7. Generic physical presentation deliberately denies native acquisition through `tests/fixtures/presentation-driver.ts`. Main-terminal geometry/streaming/replay assertions do not thereby prove real daemon integration; the separate syntax cases do.

### Current CI cost is not just test duration

`.github/workflows/ci.yml` currently calls the reusable **six-platform** native workflow on ordinary pushes/PRs. Both four-profile extension/SDK jobs and four-profile syntax jobs wait for that reusable workflow (`native`, `extension.needs`, `terminal.needs`). The reusable workflow includes same-commit consumers on both Node versions on every target. Each extension matrix job prepares `--integration`; two repeat the inert release suite and all four pack the development extension.

The full main-terminal entry is already extension-release-only. Therefore changing only that trigger would not remove ordinary CI's six native builds, consumer matrix, repeated preparation, or dependency barriers. Runner wall time, the critical path, charged runner-minutes, and preparation time are different measurements. No remote run of the proposed organization exists.

## Complete Node entry-file inventory

Paths in these tables are relative to `tests/`. “When affected” identifies contracts, not a filename-only change detector. Cross-domain closure rules are in the proposal.

### UI, cards and shared feature contracts

| Current file | Protected contract; actual requirement | When affected |
|---|---|---|
| `unit.test.ts` | 243 parent declarations spanning cards, lifecycle, layout/GC, editor/status, real Git, footer and terminal colors; `S`, some real Git/Node subprocesses, no Rust daemon | Split by the ranges below; do not run all physical domains merely because this file is named unit. |
| `component-layouts.test.ts` | Component-owned caches, ordinary/large retained layouts, no eviction, detached owners/GC; actual SDK and large allocations, `S` | Render-cache ownership/accounting and adapter lifetime. |
| `queued-cards.test.ts` | Actual SDK steering/follow-up queue projection, input/delivery, framing, widths and ownership; `S` | Queued cards, queue/session integration, shared geometry. |
| `spinner-scheduler.test.ts` | Fallback clock installation, renderer replacement, cancellation and scheduling; controlled clocks/SDK seams, not native daemon, `S` | Spinner scheduler and adapter/render lifecycle. |
| `footer-session-name.test.ts` | Width quotas, separators, whole-name versus truncation, Unicode; `S` | Footer formatting/session-name allocation. |
| `footer-session-title.test.ts` | First-message/name semantics compared with actual SDK `SessionManager.list()` on real session files; `S` | Footer titles and session metadata interpretation. |
| `settings.test.ts` | Settings load/update, malformed/oversized files, safe failures, preserved fields, persistence/concurrency; owned filesystem and subprocess controls, `N` | Persisted settings format, defaults, update semantics. A theme discriminator is not a daemon dependency. |
| `tidy-menu.test.ts` | Navigation, geometry, switches, theme preview/rollback, late actions and persistence owner protocol; fake owner plus TUI widths, `S` | Menu state machine and its public actions. Native colors must additionally be checked by syntax integration when changed. |
| `session-logging.test.ts` | Run-bound asynchronous sinks, pause/resume, retries and stale ownership; actual journal I/O, `N` | Logging lifetime and session/reload transitions. |
| `debug-log.test.ts` | Journal formatting, safe cleanup, retention, observable I/O counts and failure handling; `N` | Journal writer/cleanup and sensitive-data boundaries. |
| `naming.test.ts` | Public development identity, command/flag registration and retired-argument behavior; selected SDK entry, `S` | Package identity and extension entry/registration contracts. |

#### `unit.test.ts` split map

Ranges are audit anchors, not stable selector APIs. A moved test keeps its assertions and lifecycle sequence, including tests whose names mention another domain.

| Current lines (approximately) | Proposed functional owner | Extra obligations |
|---|---|---|
| 104–229,416–1200 | Summary/argument formatting, policy, Unicode and mouse geometry | Native safeguard delegation and exact failure paint. |
| 230–415,508–666 | Activity/adapter lifecycle | Global install/off/shutdown/foreign-owner integration; some ranges overlap the summaries above because concerns are interleaved. |
| 1222–1652 | Bash presentation | Timeout/exit metadata, normalized output, streaming and clicks; no re-execution or source mutation. |
| 1653–1920 | Shared frame, input ownership, renderer replacement | Cross-card and editor consumers of shared frame/paint. |
| 1957–2104,3079–3214 | Cache, layout working set, weak ownership/GC | First installed/executing tool and user ownership must remain tested, not only later nodes. |
| 2117–2244 | User cards/Markdown | Selected native Markdown, image fallback and exact restoration. |
| 2261–3078 | Edit cards/diff/policy | Dense 400/800/1600/3200 algorithmic regression remains here; syntax fallback projection is not a real daemon test. |
| 3228–3346 | Bounded summary arguments | Large omitted values, Unicode quotas, masking and no unnecessary reads. |
| 3373–3639 | Write cards | Stock SDK tool results, metadata guards and whole-source presentation. |
| 3666–3910,4251–4434 | Editor frame, padding and widget gap | Cursor, paste/undo, popup and foreign-owner identity. |
| 3933–4197,4689 | Native status and metadata | Preserve native Working object/clock; no extra input rows or autocomplete interference. |
| 4457–4745,5660 onward | Cwd/Git projection and live discovery | Real repositories, watches, atomic replacement, cancellation, zero warm queries. |
| 4817–5299 | Footer, accounting, history/name and ownership | Native session accounting and editor-dependent footer eligibility. |
| 5315–5410 | Output padding | Summaries and every transcript card's geometry/invalidation. |
| 5436–5643 | Terminal-default colors | OSC ownership, automatic-mode release, RGB projection, read errors and warm-work constraints. |

These are coverage areas, **not permission to select only an approximate line range**. Implementation must assign every original declaration, including interleaved lifecycle tests, to an explicit destination and verify the union.

### Syntax and Occipital logic versus actual processes

Most files below do not require `O`. Controlled transports and real Pi SDK objects serve different contracts from actual daemon execution and must not be conflated.

| Current file | Protected contract; actual requirement | When affected / separation needed |
|---|---|---|
| `occipital-bootstrap.test.ts` | Provider-option construction and host lifecycle/fallback with controlled factories, `S` | Extension/native discovery boundary and configuration. |
| `occipital-client.test.ts` | Client lifecycle, retained profiles, menu actions/preview/rollback, no duplicate source work; controlled transport, `S` | Client state machine, settings/theme contract, teardown. |
| `occipital-controller.test.ts` | Source authority, queues/credits, coalescing, restart/fallback, uncertainty, retention; mostly controlled peers; **three `O` cases** at 243,581,804 | Split actual-product stdio/coalescing, post-restart pressure, and two-restart recovery into an actual-daemon file. Remaining source-authority tests stay cheap. |
| `occipital-discovery.test.ts` | Candidate ordering, socket/config validation and safe discovery; files/platform inputs, `N` | Shared discovery and configuration selection, not daemon parsing. |
| `occipital-factories.test.ts` | Acquisition cancellation/deadlines/shared negotiation; mostly controlled peers, **two actual `O` cases** at 81,140 | Move actual helper ownership/close-guard cases and module-level binary admission separately; missing-binary no-spawn checks remain runnable without a valid daemon. |
| `occipital-native-delivery.test.ts` | Explicit local/native release acquisition and negative missing/foreign path controls; inert payloads, `N/S` | Development-only local-helper policy and release delivery, not actual parsing. |
| `occipital-native.test.ts` | Real protocol/engine acceptance through stdio, counters, incremental/open/append behavior, cleanup; `O` | Native implementation or TS/Rust interface changes. Validate executable unconditionally. |
| `occipital-pi-bridge.test.ts` | Exact Pi fallback/highlighter use and caching/permission, `S` | Pi classification fallback and duplicate-work authority. |
| `occipital-profiles.test.ts` | File/profile loading, limits, fingerprints, malformed data, last-good behavior; `N` | Profile catalogue and admission contracts; matching Rust tests when wire semantics change. |
| `occipital-protocol.test.ts` | Decoder/version/description/source structure, malformed data and bounds; `N` | Public TS/Rust wire contract; add both-side and actual protocol controls. |
| `occipital-provider.test.ts` | Broker readiness, reconnect/loss, bounded restarts and authority transitions; controlled transports, `N/S` | Provider selection/restart/uncertainty policy. |
| `occipital-ranges.test.ts` | UTF-8/scalar/style validation, interval bounds, text fidelity; `N/S` | Range decoding and card painting contract. |
| `occipital-retention.test.ts` | Source budgets, lifetime/weak retention and controlled dispatch; GC/SDK, `S` | Retention/admission and owner cleanup. |
| `occipital-shared.test.ts` | Public shared SDK behavior, route lifecycle, failure classification, credit and metadata; fake transport plus **real SDK import**, `S`, not real host | Shared transport/API compatibility; actual route/host behavior separately. |
| `occipital-stdio.test.ts` | Real pipe fragmentation, backpressure, correlation, cancellation, kill/reap and frame budgets against a **Node fixture process**, `N` | Stdio transport; not Rust correctness and not a reason to require a Rust build. |
| `shared-fixture-ownership.test.ts` | GC ownership through actual optional shared SDK load in a Node child, `S` | Shared fixture/transport weak ownership; not actual Subconscious host. |
| `syntax-card-display.test.ts` | Color/display projection, completed/error states, no work in render, `S` | Source-to-card display stamps and render boundaries. |
| `syntax-card-lifecycle.test.ts` | Source owner lifetime, disable/reinstall/late results/GC, `S` | Adapter/source ownership and native-off transitions. |
| `syntax-cards.test.ts` | Retained cards, preparation, theme revision/batching/order and demand, `S` | Card source scheduler and all-card theme renewal. |
| `syntax-entry.test.ts` | Actual extension entry handlers, native/fallback options, session origin, settings/logging/theme behavior with controlled providers, `S` | Cross-domain entry integration; no actual daemon required for these assertions. |
| `syntax-host.test.ts` | Host/source side-work and invalidation with SDK components, `S` | Wiring, display stamps and dispatch independence from rendering. |
| `syntax-observation.test.mjs` | Pending JSON and coverage-before-fresh-counter observation ordering, `N` | Syntax physical-test oracle; not product parsing. |
| `syntax-paint.test.ts` | Validated style projection across actual SDK/card rows, `S` | Native color/text-to-layout boundary and graphemes. |
| `syntax-pi.test.ts` | Public Pi classifier and fallback cache/authority, `S` | Pi-specific classification and no-duplicate-work guarantees. |
| `syntax-runtime.test.ts` | Runtime source acquisition/freezing/disposal and owner interfaces, `S` | Runtime and tool lifecycle. |
| `syntax-sources.test.ts` | Bash/edit/write normalization, source keys and stable cache identity, `N/S` | Input interpretation and source preparation shared with Rust/client. |
| `syntax-stock-reference.test.mjs` | Immutable lazy per-mode stock evidence, isolation and corruption rejection, `N` | Syntax test reference helper, not feature integration. |
| `syntax-work.test.ts` | Source dispatch, uncertainty, profile compatibility, held work, fallback permission, `S` | Controller/work/display shared authority. |
| `syntax-terminal.test.mjs` | Actual UI+daemon and fallback/provider observation; `P/O`, **`H` for S07 and S10** below | Needs capability split, not blanket removal from UI development. |

Important anchors: real binary calls in `occipital-native.test.ts:22–29`, `occipital-factories.test.ts:80–156`, `occipital-controller.test.ts:243–270,581–609,804 onward`; Node transport peer in `occipital-stdio.test.ts:10–17`; optional SDK/GC child in `shared-fixture-ownership.test.ts:10–26`. Historical environment-based native skips in the mixed controller file were not exercised in accepted runs because inputs were mandatory. The proposed split must make native-group prerequisites explicit failures, not turn those skips into a selection mechanism.

### Harness, delivery and compatibility entries

| Current file | Protected contract; actual requirement | When affected |
|---|---|---|
| `consumer-preparation.test.mjs` | Consumer metadata/lock rewrite, npm replay and platform/CRLF/path behavior; local npm/tar fixtures, `N/C`-preparation logic | Registry capture and consumer preparation; not actual daemon parsing. |
| `installed-consumer.test.mjs` | Safe npm consumer reports, versions and observation boundaries, `N` | Consumer diagnostics. The actual install/execute entry is listed separately below. |
| `local-registry.test.mjs` | Loopback HTTP, exact metadata/archive serving and refusal of unknown requests, `N` | Local registry fixture; no public internet. |
| `npm-preparation.test.ts` | Real npm launcher behavior, log handling, Windows arguments and safe summaries, controlled/real Node subprocesses, `N` | npm subprocess seam, platform paths and diagnostic privacy. |
| `integration-profile.test.mjs` | Locked package inventory, real prepared-package resolution, builder isolation/missing-input rejection; `N/I` mixed | Third-party profile preparation. Its lock/missing-input controls can be separated from positive real-package resolution. |
| `menu-driver.test.ts` | Test driver's actual completion, menu sizing and errors, `S` | SDK menu observation helper. |
| `pty-bridge.test.mjs` | Large exact output, graceful termination, unchanged 2s escalation and real reaping; Python/PTTY + child processes, not Pi, `N` | Bridge transport and shutdown. POSIX-specific controls retain their explicit platform scope. |
| `terminal-cleanup.test.mjs` | Sequential/parallel release ordering, continued cleanup and exact/aggregate error propagation; `N` | Cleanup helper and process lifetime. |
| `terminal-harness.test.mjs` | Import isolation, xterm width, failed-profile cleanup, negative missing-native control, selected editor paint; `N/S` | Shared terminal harness and SDK observation, not a positive real-helper requirement. |
| `terminal-helper.test.mjs` | Complete JSONL records, replay comparator, cache pagination, popup state, scenario/reload frame completion; `N/S` | Physical-test observation helpers; these cases no longer launch Pi. |
| `terminal-observer.test.mjs` | Input/command/render/autocomplete fences, replacement, selected CLI graph/hash and physical parser observations; `N/S` | Injected test observer and actual selected CLI implementation shape; most cases use synthetic mode objects. |
| `terminal-output.test.mjs` | Complete-write-before-notify for journals/JSON, original failures, actual foreign-editor shortcut wakeup; `N/S` | Every publisher/reader pairing in drivers. |
| `terminal-progress.test.mjs` | Event-driven wait counts, fresh resize receipts, errors/no polling; prototype receivers, `N/S` | Harness event/resize/diagnostic waits. |
| `terminal-rows.test.mjs` | Actual xterm FIFO, per-row callback/wrap/color/cursor checks, fragmented UTF-8 and frame/receipt order; `N/S` | Row validator and PTY-to-parser queue. |
| `test-filtering.test.ts` | Actual Node test filtering and nested-body exclusion; child Node, `N` | Selection semantics; not proof of all required feature coverage. |
| `test-fixtures.test.ts` | Bounded async fixture waits, native Node interval semantics and actual GC guard, `N` | Shared test wait/GC setup. “Native interval” means Node's real timer, not Occipital. |
| `test-harness.test.mjs` | Environment/source/host/native admission, neutral ancestry, process groups, reporting, source refresh/deletions, offline preparation, URL/CRLF paths; many Node/Git/npm/OS controls, `N/S` | Context/prepare/bootstrap/runner; capability/discovery changes must extend these tests. |
| `rust-harness.test.mjs` | Real pinned Cargo positive poisoned-parent control and neutral isolation, `R` | Rust environment/toolchain/ancestor isolation, not ordinary UI feature validation. |
| `terminal.test.mjs` | Main physical cases T01–T49, normally fallback provider; `P`, T13 additionally `I` | Product-domain split below; third-party packages are not needed for every physical case. |
| `native-release.test.mjs` | Templates, checksums/notices, exact inert bytes, local npm pack/admission, no publication; `N` | Native artifact packaging, not engine parsing. |
| `npm-release.test.mjs` | Native package metadata, archive contents, npm identity and safe publication preparation; inert/local inputs, `N` | npm native delivery and policy. |
| `extension-release.test.mjs` | Generated-only six dependency pins, exact artifact admission/refusal, packing and source immutability; inert fixtures/local npm/Git, `N` | Extension package/release assembly. No public validation implied by synthetic gates. |
| `release-ci.test.mjs` | Workflow routing, version/staging/ABI/Windows import tools, checked outputs and stop-on-failure; controlled tools/real small commands, `N` | CI/release contracts. Current tests intentionally enforce old ordinary-run syntax/native policy; update only after policy approval. |
| `release-version.test.mjs` | Real Git topology/nearest-tag selection and independent product stamping; `N` | Version ancestry and stamp rules. |
| `makefile.test.ts` | Actual Make/Docker wrapper routing with controlled tools, safe env and failure propagation; `N` | Build/test entry points. This is not the real GNU container acceptance. |

#### Additional script and platform entries

| Entry | Actual dependency and contract |
|---|---|
| `tests/fixtures/installed-occipital.mjs` (`consumer`) | `O/C`: actually install from owned archives/loopback registry, resolve selected SDK and native package, exercise real helper, fallback/cache/hash/install-script boundaries. Version/commit/nativeTree/npm/Node authority is mandatory. |
| `tests/fixtures/published-occipital.mjs` (`published-consumer`) | `X`: exact extension release ref, public npm/GitHub artifacts and admission; remains extension-release-only, never ordinary tests or daemon release substitution. |
| GNU container checks | `R/O`: actual glibc 2.28 toolchain/container, tests, allocator, lint, release build, ABI inspection and local consumers. Wrapper unit checks are not substitutes. |
| Six target builds | Linux/macOS/Windows × x64/ARM64; actual compile, target-specific imports/ABI/reproducibility/staging and both-Node consumer behavior. Not necessary for a localized footer formatter edit. |
| Workflow lint / package / release jobs | Current `.github/workflows/ci.yml` and release workflows. Static policy regressions and actual hosted execution provide different evidence. No publish is authorized by this documentation proposal. |

## Main physical-CLI case map

T identifiers refer to **current TAP order** in the accepted Pi 1.0 / Node 26 main run, not invented test names. Each label below abbreviates the actual unique case; the full names are in the saved timing analysis. Times are case durations, not projected savings. All these cases require `P`; only T13 loads `I` itself. Exact traffic/persistence/replay, physical colors and geometry remain required wherever the original case asserts them.

| ID | Existing protected integration | Seconds | Functional owner / special coupling |
|---|---|---:|---|
| T01 | Compilation-cache code reuse, separate sessions and changed-source rejection | 4.93 | Harness/startup, not every UI feature. |
| T02 | Isolated offline stock transport | 1.08 | Harness/CLI baseline. |
| T03 | Delayed PTY resize and actual Pi dimensions, repeated sizes | 13.80 | Harness/geometry; deliberate delay control. |
| T04 | Appearance policy, native input/lifecycle and same-session stock replay | 5.59 | Shared adapter baseline. |
| T05 | Complete multiline summaries, spacing, continuation click and replay | 8.91 | Summary geometry. |
| T06 | Comma/array wrapping in live and replay | 2.66 | Summary arguments. |
| T07 | Long-word/punctuation wrapping | 5.68 | Summary arguments. |
| T08 | Failure summary full error color, hidden body/badge, native expansion | 2.99 | Summary state/policy. |
| T09 | Width-21 colored boundary and indentation | 1.63 | Shared wrapping/summary paint. |
| T10 | Working clock, fallback only during host silence, regular | 11.56 | Activity; explicit temporal checks, not ordinary snapshots. |
| T11 | Same clock contract, fullscreen | 11.72 | Activity; preserve both modes. |
| T12 | Gated arguments/streaming, image/hidden safeguards and exact flags | 3.19 | Adapter/policy. Includes seven nested controls listed below. |
| T13 | Locked installed-profile registration and actual task renderers | 18.94 | Third-party compatibility; `P/I`. |
| T14 | Real Bash command/output, resize/theme and saved session | 18.63 | Bash presentation, not native Bash parsing. |
| T15 | Real built-in Bash streaming/pending | 1.05 | Bash formation and execution. |
| T16 | Opt-in Bash metadata/comments/output boundaries | 4.86 | Bash presentation. |
| T17 | Bash presentation exceptions preserve traffic | 4.93 | Bash state/data invariants. |
| T18 | Bash exceptions partial→final | 1.44 | Bash streaming/state invariants. |
| T19 | Complete command physical width regression | 5.57 | Bash/wrapping. |
| T20 | Layout work counters and released retained memory | 13.14 | Cross-card cache/ownership. |
| T21 | User cards, custom labels and native Markdown | 4.69 | User card/frame. |
| T22 | Edit numbered/unified/split/colors/error and replay | 7.21 | Edit presentation/Pi fallback. |
| T23 | 16k sparse minified edit, ANSI, warm work and exact replay | 4.01 | Edit integration; dense algorithmic inputs remain SDK tests. |
| T24 | Bounded summaries, path-only edit, visible payload/data/replay | 5.81 | Summary + file-card state. |
| T25 | Actual stock writes and lifecycle/native view/replay | 6.69 | Write SDK/result boundary. “Native view” is Pi, not daemon. |
| T26 | Saved write diff shapes and lifecycle/replay | 7.85 | Write metadata/display. |
| T27 | Main editor draft/cursor/menu identity and lifecycle | 4.83 | Editor. |
| T28 | Metadata plus separate status, physical half-blocks and popup/activity | 7.92 | Editor/status ownership. |
| T29 | Low-height clipping preserves native Working placement | 0.97 | Editor/status geometry. |
| T30 | Editor padding moves whole panel in both modes | 15.15 | Editor/settings geometry. |
| T31 | Above-editor widget gap follows live zero-height layout | 7.54 | Editor/layout. |
| T32 | Foreign editor, widgets, mouse/replay, both load orders | 12.37 | Editor/footer eligibility + extension ownership. |
| T33 | Cwd/Git physical colors, padding and zero warm queries | 9.69 | Directory/status and real Git. |
| T34 | Footer fitting, colors, data, ownership and replay, both modes | 5.21 | Footer. |
| T35 | Session name allocation and saved metadata | 6.97 | Footer/name. |
| T36 | Per-request cache history: equal values, cold/unknown, colors/replay | 12.47 | Footer/accounting/session. |
| T37 | Working animation and clipping without scans/replacement | 7.93 | Footer/status/activity; temporal. |
| T38 | Output padding across summaries/cards, live/native/replay | 11.40 | Shared geometry/settings. |
| T39 | Project output-padding override after user padding changes | 2.58 | Settings/geometry precedence. |
| T40 | OSC channels, reload/errors/RGB/native traffic/replay, both modes | 8.20 | Terminal-default colors. |
| T41 | Project override, fixed→auto ordering, reload/renderer inactivity | 1.38 | Terminal-default colors. |
| T42 | Initially automatic and first production late load inactivity | 3.71 | Terminal-default colors/lifecycle. |
| T43 | Exact Bash timeout tails and traffic, regular | 4.49 | Bash timeout contract. |
| T44 | Same timeout contract, fullscreen | 4.94 | Bash timeout contract. |
| T45 | Queued card height/dequeue/delivery/replay, regular | 9.43 | Queue/session integration. |
| T46 | Same queue contract, fullscreen | 8.95 | Queue/session integration. |
| T47 | Selected CLI despite hostile outer CLI/Python customizers | 2.07 | Harness isolation, separate nested Node process. |
| T48 | Settings popup, saved switches, reload and fresh replay, regular | 3.91 | Menu/settings; includes compact popup controls. |
| T49 | Same settings/compact controls, fullscreen | 3.85 | Menu/settings. |

T12's seven nested controls remain: live width-zero rows; widths 1–5 glyphs; fullscreen; regular; same-session image fallback; intentionally hidden live renderer; hidden safeguard over replay flags. The physical layer cannot be replaced wholesale by row-only tests: it validates real parsing, native restoration and persisted behavior. Conversely, every formatter edge does not need a new full CLI launch.

## Syntax physical-CLI case map

S identifiers follow TAP order in the accepted Pi 1.0 / Node 26 syntax run. The current file validates `O/H` before any case; this table separates actual case needs. Generic stock references remain immutable per mode; feature-bearing processes and replay remain independent.

| ID | Existing protected integration | Seconds | Actual additional dependency / owner |
|---|---|---:|---|
| S01 | Fullscreen startup, complete args, warm/resize/off and traffic/replay | 6.79 | `P/O`, owned syntax baseline. |
| S02 | Same startup, regular | 3.93 | `P/O`. |
| S03 | Real theme picker, explicit RGB, persistence and fresh default | 2.57 | `P/O`, menu↔syntax. |
| S04 | Provider readiness awaits acquired/published state, not silence | 0.64 | **Corrected during migration:** real Pi acquisition/published-state gate; retained as owned CLI with its native prerequisite, not moved to helper tests. |
| S05 | Fullscreen input/tool progress with held file replies and no duplicate Pi classify | 1.99 | `P/O`, async authority/input. |
| S06 | Same held reply control, regular | 1.98 | `P/O`. |
| S07 | Shared discovery/refresh/status/menu, real loss and owned→shared return | 5.16 | `P/O/H`, real peers and host. |
| S08 | Gradual argument abort preserves prefix, traffic/warm work, fullscreen | 2.15 | `P/O`, Bash lifecycle. |
| S09 | Same gradual abort, regular | 1.68 | `P/O`. |
| S10 | Structured RGB/font attributes on both diff sides/frame/warm work | 3.45 | `P/O/H`, real custom-profile shared host, not just owned stdio. |
| S11 | Logging fallback decisions/unchanged frames/reload/replay, regular | 3.07 | `P`, deliberately unavailable provider; does not need actual daemon for its body. |
| S12 | Same logging, native regular | 3.51 | `P/O`. |
| S13 | Same logging, fallback fullscreen | 2.87 | `P`, no positive daemon work. |
| S14 | Same logging, native fullscreen | 3.44 | `P/O`. |
| S15 | Historical Bash tail, held append/new grapheme/abort, fullscreen | 2.35 | `P/O`, display history is not parser-current proof. |
| S16 | Same historical tail, regular | 2.32 | `P/O`. |
| S17 | Online wait resumes restored/connection-loss demand, fullscreen | 1.87 | `P/O`, source authority/recovery. |
| S18 | Same online wait, regular | 1.82 | `P/O`. |
| S19 | Restored backlog colors newest first, fullscreen | 1.53 | `P/O`, bounded scheduler. |
| S20 | Same backlog order, regular | 1.51 | `P/O`. |
| S21 | Theme renewal recolors every Bash/write/edit, fullscreen | 1.93 | `P/O`, all-card integration. |
| S22 | Same theme renewal, regular | 1.94 | `P/O`. |
| S23 | Preview before confirmation, rollback rejects late colors, fullscreen | 1.96 | `P/O`, settings/menu/source phases. |
| S24 | Same preview rollback, regular | 1.97 | `P/O`. |

The shared host is constructed twice in source (`tests/syntax-terminal.test.mjs:360,496`). Counting only the transition case would miss S10. Source counters/credit, exact traffic, physical colors, persisted files and late-reply rejection are separate obligations even when one process can serve several assertions.

## Rust map

All paths below are under `crates/occipital/`. Rust logic tests need `R` but usually execute library code, **not** an interactive Pi or separately delivered executable. This distinction matters for targeted `cargo test --test ...` and compile reuse.

| Integration target (`tests/<name>.rs`) | Contract |
|---|---|
| `actor` | Async source actor ordering, cancellation, disposal and held work. |
| `admission` | Theme/source admission, safe resource accounting and bounds before parser work. |
| `admission_no_intern` | Rejected definitions do not intern even an earlier valid prefix. |
| `admission_structural` | Binary/XML/ASCII definition structure, malformed/deep/DAG inputs before Syntect. |
| `catalogue` | Real catalogue/profile discovery, refresh/fingerprint/definition admission. |
| `control` | Describe/refresh control lane, profile publication/last-good and shutdown. |
| `engine` | Actual Syntect syntax selection/style ranges, append/checkpoint/diff, cancellation/counters. |
| `frame` | UTF-8 wire framing, arbitrary fragmentation, EOF versus truncation and bounded allocation. |
| `ingress` | Routed control/data credit, decoding, closure, malformed input and delivery lifetime. |
| `long_lines` | Real parser long-line windows, exact coverage, append/cancel behavior and bounds. |
| `payload_lifetime` | Allocation/payload destruction before credit release. |
| `reply` | Wire reply encoding and budgets, not just TS decoder acceptance. |
| `request` | Wire operations, source/append fields, limits before work and batch budgets. |
| `resource_policy` | Derived limits and ordinary large-source support without repeated parsing. |
| `scheduler` | Fair quanta, admitted peers, bounded queue/credit and no priority bypass. |
| `service` | Full service/facade lifecycle, dispatch and actual response behavior. |
| `stdio` | Actual compiled executable pipe/service boundary (Cargo's test binary artifact). |

Inline tests also exist in `src/{admission,engine,main,reply,request,scheduler,shared}.rs`. The separate `examples/engine_probe.rs` allocator test validates the actual glibc allocator API; it is not replaced by a platform-independent unit. `rust-check` runs fmt plus strict Clippy/all-targets; `rust` is offline workspace tests (optionally selected integration targets); `rust-allocator` is the named allocator control. Release builds/ABI and consumer checks are additional, not implied by `cargo test`.

## Selection conclusions from the map

- Keep fast syntax/controller/transport contracts available without a Rust build; do **not** remove syntax from ordinary cheap testing merely because it has an Occipital prefix.
- Keep actual daemon, shared, file/RGB and wire controls mandatory whenever their contracts change. Moving them is not replacing them with mocks.
- Separate live Pi from daemon: footer/editor/card geometry often needs `P` but no `O/H/I`; a Rust engine unit needs `R` but no Pi.
- Separate package-policy fixtures from real consumer installs and from public-release admission.
- Preserve ownership, cross-feature geometry, theme/settings and lifecycle closure; a single source filename cannot always identify that closure.
- The proposal must fix preparation/admission **and** file organization; otherwise a focused footer command still pays for unrelated native/profile inputs.
