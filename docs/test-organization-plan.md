# Contract-scoped test organization: historical plan

Status: **earlier CI policy and per-file membership superseded; approved five-root implementation in progress, not final execution acceptance**. The operator initially approved contract-scoped ordinary CI and an explicit file catalogue, then rejected those policies in favor of fixed-trigger complete CI and recursive structural discovery. This document preserves the earlier rationale, local-work principles, measurements and decision history; it is not current CI or test-registration instructions. Use [testing.md](testing.md) for commands, [structural roles](testing.md#test-layers) for discovery and [fixed CI obligations](testing.md#fixed-ci-obligations) for current cadence. The [baseline map](test-organization-map.md) retains historical case IDs and costs, not current paths.

## 1. Original goal and retained local boundary

The original proposal sought complete necessary acceptance of a localized feature near **2–3 minutes**, including source refresh, dependency/artifact preparation and cleanup. That practical target now applies **only to the local feature loop**, with justified variation, not a full-CI budget or timeout. Cold native/toolchain preparation, platform/ABI changes and broad harness work can require longer checks; their costs and unrun requirements must remain explicit.

The retained local distinction is relevant logic/SDK checks during editing, then the feature's actual integrations and coupled contracts before delivery. It does not replace required real integration with mocks, shrink inputs/assertions, shorten observation windows, or hide missing inputs behind skips. Coherent selected Pi, actual GC, neutral source/environment, source/commit/native identity, offline execution and explicit public-delivery authority remain unchanged.

No historical plan or local test success authorizes commit, push, remote CI or publication.

## 2. Historical findings

The baseline audit found:

1. Focused footer SDK execution still required a daemon; focused editor CLI execution still required the third-party profile. Splitting filenames alone could not fix admission/preparation.
2. Most syntax/controller/protocol/range/source/work/cache tests did not require Rust. Real pipe transport controls used a Node peer, distinct from an actual daemon.
3. Actual helper, shared-host and installed-profile controls were mixed with unrelated cases and needed separate capability boundaries, not removal or mocks.
4. SDK/CLI jobs waited for an entire six-platform native workflow including consumers. The current graph instead lets Linux x64 production unlock SDK/CLI independently, while every ordinary event still requires all enabled platform branches.
5. Shared frame geometry, settings/theme, cache invalidation and owner lifecycle couple multiple features. These remain local validation considerations, not a CI impact engine.
6. Complete unions were useful regression evidence but unsuitable as a mandatory per-edit local loop.

## 3. Organization decisions and supersession

| Earlier proposal | Current disposition |
| --- | --- |
| Explicit lists of files assigned to feature owners | Superseded. Executable tests auto-discover recursively by structural role, with feature subdirectories for local groups. No per-file discovery registry or list edit for a new test. |
| Common baseline plus affected groups on ordinary CI | Rejected. Every main push, PR and ordinary manual dispatch has the same complete enabled-platform/Node/Pi obligations. |
| Coarse source-path routing and reviewed hotspot narrowing tied to HEAD | Rejected. No diff/impact routing, approval block, scope-decision gate or manual feature narrowing exists. |
| Compatibility/platform expansion selected from changed contracts | Retained only as local validation reasoning; CI runs its fixed event obligations regardless of the diff. |
| Future periodic compatibility undecided | Superseded by the implemented best-effort 03:23 UTC latest-only nightly graph; see the execution guide for its distinct result/concurrency and exclusions. |
| Separate real native/shared/profile admission | Retained. Prerequisites derive from discovered structural categories; enabling a required service does not select tests out. |
| Strict source, payload, data/replay and release authority | Retained. Exact source SHA/bytes, same-run transfers, public admission and provenance are not timing trade-offs. |

The previous baseline file lists and reviewed-scope procedure have been removed here to avoid contradictory normative instructions. Historical case inventories remain in the baseline map solely as audit evidence.

The approved implementation uses five execution roots: `product/` (including pure native contracts), `integration/` (`native/`, `profile/`), `cli/` (ordinary feature directories plus `native/`, `shared/`, `profile/`), `harness/` (including distinct `packaging/` and inert `delivery/`) and `native-build/`. The existing runner reads all test files recursively; feature groups remain local. The existing Pi-free native descriptor/bootstrap feeds Node's test runner, not a second Pi installation or a new testing framework. See the [current folder guide](testing.md#test-layers). Implementation and documentation do not establish a passing new CI graph; parent validation and independent review remain required.

## 4. Retained execution distinctions

| Boundary | Evidence it supplies | Not established by that evidence |
| --- | --- | --- |
| Logic/local fixtures | Formatting, state machines, exact counters, failure handling, controlled pipes/files | Physical Pi painting or Rust parsing |
| Selected SDK + GC | Native Pi class/API/component behavior and ownership | Interactive transport/render loop or daemon process |
| Actual Pi/PTY | Physical cells/colors/input, lifecycle, sessions and replay | Native parsing when acquisition deliberately fails |
| Actual current-source Occipital | Parser/protocol/process behavior and source counters | Shared host routes, public npm delivery or all platforms |
| Actual shared host | Routes/peers, loss/owned return and custom profiles | Platform package/ABI acceptance |
| Consumer/platform/release | Actual install/import/ABI and byte admission as applicable | Unrelated feature geometry |

Local groups retain coherent test files and non-registering support, not one process per assertion. They use the same prepared runner and discovery as complete execution. Missing required helper/shared/profile/GC inputs remain setup failures.

## 5. Local feature recipes

Current command syntax is maintained only in [testing.md](testing.md#ordinary-feature-work). `test:feature` runs types, the common product baseline and smoke plus the selected real feature integrations; `test:group` supports a tighter edit loop. `--affected-only`, file filters and name filters are local composition/debugging tools, never CI selection.

Useful local closure considerations from the proposal remain:

- Shared geometry/paint can affect summaries, Bash/edit/write/user/queued cards and editor projection; inspect actual consumers, not every similarly named file.
- Adapter/entry ownership spans install/off/on/reload/session/foreign-owner/GC boundaries; preserve first-installer ownership checks and actual entry integration.
- Common settings persistence/precedence can affect all stored switches/themes. Code-theme preview adds actual native colors, rollback and late replies; an unrelated label does not.
- Layout cache, source/fallback authority, native parser checkpoints and test compilation cache have different owners and evidence.
- TS/Rust wire changes require both-side contracts and a real round trip. A synthetic successful response is not daemon compatibility.
- Harness synchronization changes require actual notifier/waiter and packaged-fixture crossings, not just one fake helper.
- SDK identity/hooks/session/loader dependence can require affected local checks across minimum/resolved-latest Pi; Node timer/ESM/subprocess/GC dependence can require both Node runtimes. If both interact, use both dimensions.

Preserve mode pairs, physical color/width, exact traffic/session/replay, late-result and error/cleanup assertions. A focused happy-path pattern is not a full required group. Report exclusions and longer required work instead of weakening coverage. These are local reasoning aids; they neither narrow nor expand the fixed CI event contract.

## 6. Historical measurements

These are saved observations from the original accepted local receipts, **not current benchmarks, CI guarantees or additive savings estimates**. The original source snapshots and detailed parent cases are identified in the [baseline map](test-organization-map.md#baseline-scope-and-evidence).

| Original observation | Recorded cost |
| --- | --- |
| Broad mixed unit union | 51–62 s |
| Strict type-check wrapper | About 7–8 s |
| Footer physical T33–T37 sum | About 42 s |
| Editor physical T27–T32 sum | About 49 s |
| Complete syntax physical cases | About 63–70 s |
| Complete main physical union | About 336–363 s |
| Small CLI baseline T02 + T04 | About 6.7 s together |

Case sums excluded preparation and can change after file/process restructuring. The original proposal recommended measuring the broad no-daemon product baseline before considering further local narrowing; those measurements did not justify dropping complete CI obligations.

Measure source identity/refresh, graph install/copy, tools, native/shared/profile/consumer preparation, execution and cleanup separately. Distinguish cold/restore/warm stores, wall time and runner-minutes. Owned-cache reuse never relabels a different commit's helper or replaces real clean installs/cold-warm native controls.

## 7. Historical review and implementation record

The initial read-only review prioritized capability admission/preparation, removing unrelated native dependency barriers and preserving cross-contract closure. Later review asked for an explicit common baseline and revision-bound hotspot authority; both were approved for the earlier proposal. The operator's subsequent fixed-trigger decision supersedes that CI scope approval and its file-list mechanism, not the underlying strict data/source contracts.

Parent source inspection corrected the original shared-host inventory: both S07 (transition) **and S10 (structured RGB)** start a real host. S04 is a real Pi acquisition/published-state gate, not a synthetic helper. Those corrections remain historical coverage facts.

Historical timing and source review are not execution acceptance of the current graph. Parent integration must verify recursive discovery/shard completeness, native-build admission and real Cargo control, required result propagation, all affected harness/real integration boundaries and independent fresh-file review. Hosted execution and required-check deployment require separate evidence and authorization. The current guide records the reproducible contract, not a claim that a new hosted run passed.
