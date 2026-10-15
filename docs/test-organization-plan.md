# Contract-scoped test organization

Status: **approved by the operator; executable organization implemented**. Execution acceptance is recorded per source snapshot. The 2–3-minute budget is a practical target with justified variation, not a strict boundary or a timeout. Implementation does not authorize commit, push, remote CI or publication. The factual inventory is [test-organization-map.md](test-organization-map.md); [testing.md](testing.md) remains the current execution guide.

## 1. Goal and non-goals

Make the **complete necessary acceptance of an ordinary localized feature** fit a measured **2–3 minute budget**, including source refresh, dependency/artifact preparation and cleanup. This is not merely an early green job followed by a mandatory unrelated 20-minute matrix.

A tight edit loop should normally be shorter: relevant logic/SDK cases first, then the affected actual integration when behavior reaches that boundary. Do not repeatedly run feature-completion acceptance after each line edit.

Do not:

- eliminate Occipital testing, replace required real integration with mocks, shrink inputs/assertions, shorten observation windows, or hide failures behind missing-input skips;
- weaken coherent selected Pi, actual GC, neutral source/environment, source/commit/native identity, offline execution or explicit public-release authorization;
- claim a cold CI budget from warm local TAP measurements;
- create a test framework, service, scheduling system, generic transitive dependency graph, or one file/job per assertion;
- add daily compatibility scheduling or change production architecture under this reorganization.

Some genuinely relevant work cannot yet be promised within three minutes: a cold Rust/toolchain build, glibc/Windows packaging change, or a broad harness/ABI change may need a separate, explicitly justified budget. This is not a waiver for all ordinary feature work. Preparation time and exceptions must remain visible.

## 2. Findings that determine the design

1. **The existing selectors bundle unrelated capabilities.** A focused footer unit still requires a daemon; a focused editor CLI test still requires 11 third-party packages. Splitting names without fixing admission does not fix feature feedback.
2. **Most syntax logic does not need native code.** Keep controller/protocol/range/source/work/cache/SDK tests available in ordinary cheap coverage. Real stdio transport tests use a small Node peer, not the Rust daemon.
3. **Actual integration remains necessary but is much smaller than the union.** Native tests exist in three files, two mixed; shared and ordinary owned cases are also mixed. Main physical cases already deliberately exercise fallback without native acquisition.
4. **Full native CI is an unrelated dependency barrier for many UI changes.** Four SDK and four syntax profiles currently wait for the six-platform reusable workflow, including both-Node consumers. Removing a Pi/Node dimension alone will not fix this graph.
5. **A few cross-domain contracts matter more than source directories.** Settings/theme, owner lifecycle, cache invalidation and shared frame geometry couple otherwise separate areas. A path-only selector is insufficient for the large entry file and these boundaries.
6. **The optimized full tests are useful acceptance evidence, not the ordinary edit loop.** Keep their union intact and make it explicit when and why it runs.

## 3. Two dimensions, one simple group catalogue

Organize by **feature contract** and record each group's **execution requirements**. A group is a small explicit list of files and prerequisites, composed from existing coverage. No runtime test discovery by an ever-growing exclusion list.

### Functional owners

| Owner | Existing coverage to place together |
|---|---|
| Summaries | Argument ordering/quotas/wrapping/Unicode, exact policy and failure colors; main T05–T09,T24. |
| Bash cards | Commands/output/timeout/streaming/clicks; T14–T19,T43–T44; relevant Bash native/display cases when those contracts change. |
| Edit cards | Diff/geometry/state/metadata and dense algorithmic regression; T22–T24; relevant syntax painting. |
| Write cards | Whole sources/metadata/state and stock tool results; T25–T26; relevant syntax painting. |
| User/queued cards | Native Markdown or native steering/follow-up behavior; T21,T45–T46. |
| Editor/status | Native editor identity, cursor/paste/undo, metadata, widgets, padding, ownership; T27–T32. |
| Footer/directory | Session accounting/name/history, native eligibility and real Git; T33–T37 plus footer SDK files. |
| Menu/settings | Persistence, precedence, switch geometry and compact navigation; T30,T38–T39,T48–T49 only as relevant, plus S03,S23–S24 for code-theme semantics. |
| Terminal colors | OSC channel ownership, fixed/auto/source errors/reload/RGB; T40–T42. |
| Logging | Journals/sinks/run lifetime; fallback S11,S13; actual-native S12,S14 when syntax logging is affected. |
| Syntax contracts | Protocol, controller, broker, source preparation, Pi permission, retained display/ranges, scheduling/theme authority and GC, without Rust unless crossing that boundary. |
| Actual native/shared integration | Real helper protocol, factories/restarts, owned/shared transitions, actual RGB; native file plus extracted mixed cases and the relevant S cases. |
| Delivery/compatibility | Version/staging/archives/registry/consumer, platform ABI, actual third-party profile T13, additional Node/Pi profiles. |
| Harness | Prepare/context/bootstrap/selection, PTY/parser/observer, diagnostics, source snapshots, cleanup and wrapper routing. |

These are logical owners, not 14 mandatory npm scripts or parallel CI jobs. A command may compose several owners and de-duplicate shared baseline files/cases. A smaller initial catalogue can merge closely related owners without merging their unrelated prerequisites.

### Execution boundaries within each owner

| Boundary | What it proves | What it does not prove |
|---|---|---|
| Logic/local fixtures | Formatting, data/state machines, exact counters and failures, controlled pipes/files | Real Pi painting or Rust parsing. |
| Actual selected SDK + GC | Native Pi class/component/API behavior, ownership, classification fallback | Live terminal transport/render loop or daemon process. |
| Actual Pi/PTTY | Physical cells/colors/input/session/lifecycle/replay in the real CLI | Native parsing if the provider deliberately refuses acquisition. |
| Actual Occipital | Rust parser/protocol/process/transport contract with current verified native source | Shared host discovery/peers, npm delivery, all platforms. |
| Actual shared host | Real routes/host/peers, owned↔shared/loss and custom-profile behavior | Platform package/ABI correctness. |
| Consumer/platform/release | Real install, archive, executable platform and public-byte admission as appropriate | Unrelated footer/UI feature semantics. |

Prefer a few coherent files such as `footer.sdk.test.ts`, `footer.cli.test.mjs`, `occipital-controller.logic.test.ts`, `occipital-controller.native.test.ts`. Preserve per-file/process isolation for global SDK theme/mocks. Do not split into hundreds of tiny files that repeatedly load the SDK, or add top-level helper boots merely by importing a group. Every contract file has one owner; acceptance groups may include it more than once conceptually but execute the union once per runtime.

## 4. Selection and input admission must match

Resolve the complete selected file set **before** validating optional native/shared/profile/Cargo/registry requirements. The prepared base still contains the explicit selected Node/Pi graph, tools, hermetic environment/source snapshot and real GC setup. Optional capabilities are a union of selected groups, not a property of the word `unit` or `terminal`.

Concrete required changes:

- Separate the two real-helper factory cases and three real-helper controller cases from cheap contracts. Remove module-level positive binary admission from files that are meant to run without a daemon.
- Keep native groups fail-closed if a verified executable is absent; do not use `skip: !OCCIPITAL_TEST_BIN` as routing.
- Separate S07/S10 shared cases from owned-only and fallback-only entries. Fresh declaration mapping corrected the earlier inventory: S04 starts a real Pi and waits for the acquisition gate; it remains in `syntax-owned.cli.test.mjs`. Existing synthetic observation controls stay at the helper level.
- Keep actual installed-profile resolution/CLI compatibility separate from lock inventory and missing-profile controls; only the positive compatibility group requests `I`.
- Split the SDK and physical monoliths by the owners above, with shared fixtures rather than importing a test-registering module.
- Keep the existing full selectors as explicit unions/compatibility aliases during migration. Do not silently change `npm test` into incomplete feature acceptance.

Add behavioral regressions for selection: a footer SDK or physical command succeeds with no native/shared/third-party inputs; a native command fails without the native input; shared and profile commands fail without theirs; unknown group/empty accidental selection fail explicitly; missing/unknown test ownership is rejected. The full union accounts for every discovered entry and deliberately selected script. Do not require every supported platform to execute POSIX-only controls; maintain explicit platform scope rather than advertising skips as coverage.

## 5. Local workflow: edit loop versus feature completion

Implemented command shape: `npm run test:feature -- --inputs FILE --features footer --refresh --output DIR` (or `bash`, `syntax`, a comma-separated combination). `test:group -- --inputs FILE --groups footer --layer node|cli` selects the tight edit loop. Both reuse the same catalogue/runner and prepared context; see [testing.md](testing.md).

### During editing

1. Identify the affected contract, not merely the changed filename.
2. Run the relevant logic/SDK cases and focused type check/full strict check as needed. Keep regression-first tests for a reproduced defect.
3. Run the relevant real boundary as soon as the change could invalidate it. A mock test is not enough for a changed lifecycle/painting/transport boundary.
4. After another edit, rerun only results it can invalidate; do not repeat completed unrelated checks.

### Before declaring a localized feature complete

Run strict types, the cheap common contract/SDK/GC regressions, and **the selected feature's actual integration**, including its coupled boundaries. Default to one explicit baseline graph: repository Pi `1.0.0` with minimum supported Node `22.19.0` on Linux. Choosing this graph does not import the operator's installed Pi or mutate repository manifests. Local uncommitted work retains the existing source-tree identity in its evidence; HEAD alone does not identify a dirty tree, and no commit is required merely to run a feature group. Other profiles become required when the changed contract depends on their host/runtime behavior, even without a dependency update or an explicitly version-specific fix; see the expansion rule below.

#### Concrete proposed common baseline

Recommendation for the first implementation: retain broad **product-contract/SDK** coverage as the initial common baseline, excluding unrelated harness, delivery and actual-service obligations. This deliberately spends a bounded amount on cheap cross-feature regression rather than designing aggressive per-unit impact selection. Its new exact duration must be measured; today's entire mixed unit union takes 51–62 s, which is context, not a timing guarantee for the reorganized files.

The baseline is the exact union of these current declarations, mapped to their eventual feature files:

| Baseline component | Concrete existing files/cases |
|---|---|
| Product UI/cards/lifecycle | All current `unit.test.ts` declarations, `component-layouts.test.ts`, `queued-cards.test.ts`, `spinner-scheduler.test.ts`, `footer-session-name.test.ts`, `footer-session-title.test.ts`, `settings.test.ts`, `tidy-menu.test.ts`, `session-logging.test.ts`, `debug-log.test.ts`, `naming.test.ts`. |
| Product provider/transport contracts | `occipital-bootstrap.test.ts`, `occipital-client.test.ts`, `occipital-discovery.test.ts`, `occipital-native-delivery.test.ts`, `occipital-pi-bridge.test.ts`, `occipital-profiles.test.ts`, `occipital-protocol.test.ts`, `occipital-provider.test.ts`, `occipital-ranges.test.ts`, `occipital-retention.test.ts`, `occipital-shared.test.ts`, `occipital-stdio.test.ts`, `shared-fixture-ownership.test.ts`; remaining non-daemon declarations of `occipital-controller.test.ts` and `occipital-factories.test.ts` after extraction. Node fixture subprocesses and real shared SDK import stay in this baseline; actual daemon and host do not. |
| Product syntax/source/display contracts | `syntax-card-display.test.ts`, `syntax-card-lifecycle.test.ts`, `syntax-cards.test.ts`, `syntax-entry.test.ts`, `syntax-host.test.ts`, `syntax-paint.test.ts`, `syntax-pi.test.ts`, `syntax-runtime.test.ts`, `syntax-sources.test.ts`, `syntax-work.test.ts`. |
| Strict build contract | Existing selected-host strict type check. |
| Small actual CLI baseline | T02 (isolated offline stock/transport) and T04 (appearance/input/lifecycle/same-session stock replay), about 6.7 s observed together. Preserve their actual assertions and all owned process cleanup; exclude other cases rather than loading their optional capability requirements. |

Everything else in the complete inventory is available through affected feature, harness, native, delivery or compatibility groups; it is not implicitly mandatory because someone calls it “cheap.” In particular, real native files/extracted cases, preparation/consumer/registry tests, helper-oracle controls, Rust and third-party profile are not universal obligations. They are mandatory when affected. During the edit loop only the directly relevant subset of even this common baseline needs rerunning; the common union is a feature-completion/ordinary-CI obligation.

Ordinary CI may compose common + affected acceptance in one baseline job when no additional service inputs are needed, avoiding duplicate setup. Separate affected jobs remain for service prerequisites and additional host/runtime profiles; the baseline profile is not repeated. This does not remove any selected contract.

An alternative is a much smaller cross-cutting baseline plus only affected product contracts. That would reduce irrelevant work further but require finer membership/selection maintenance. **Recommendation: first measure the explicit broad product baseline above; narrow it further only if it prevents the complete relevant 2–3-minute acceptance target.** The operator approved this initial baseline. A further reduction requires evidence and a coverage decision, not a claim that no-daemon means universally necessary.

Examples from the current map:

| Change | Required feature-completion scope | Not automatically required |
|---|---|---|
| Footer status layout/name/history | Footer logic/SDK/session discovery; T34–T37 as relevant, T33 for cwd/Git changes; native editor eligibility/foreign ownership when touched | Rust, shared host, native color replay, consumer installs or six platforms. |
| Editor cursor/padding/popup | Editor/status SDK controls, T27–T32 as relevant; popup/settings T48–T49 for settings/input changes; frame consumers if geometry changes | Real syntax provider or third-party package profile unless those integrations change. |
| Bash timeout display | Dense/Unicode/metadata Bash logic, T43–T44 and affected streaming controls; exact traffic/session unchanged | Rust parser, shared discovery, npm consumer. A native display-history change is a different scope. |
| Edit wrapping/layout | Dense algorithmic SDK regression plus T22–T24, frames/width/color fallback; S10/painting when range-to-cell semantics change | All native lifecycle/recovery/consumer cases solely because it is an edit card. |
| Terminal-default color channel | Resolver/controller SDK and T40–T42; card/RGB projection controls if effective presentation RGB changes | All source admission/shared loss/restart tests. |
| Menu label or ordinary switch | Menu/settings contracts and relevant T48–T49; side-effect group of the changed switch | All code-theme/native tests for an unrelated label. |
| Code-theme preview/rollback | Menu/settings/client/source/theme contracts plus S03,S21–S24; actual native colors, stale replies, persisted/session invariants | Six platform builds or third-party profile. |
| Source/controller/restart authority | Relevant controller/provider/work/retention contracts + extracted actual-helper controls; affected held/recovery S cases | All editor/footer geometry and platform consumers. |
| TS/Rust wire or ranges | Both-side protocol/request/frame/range tests, real helper request/reply, affected painting/card S cases | Third-party profile or unrelated menu layout. |
| Shared discovery/route close | Discovery/shared/factory SDK contracts + S07 and shared backend tests; S10 if profile/style delivery changes | All other-platform ABI/packaging solely for shared logic. |
| Rust engine/large source policy | Rust engine/admission/resource/long-line targets and dependent tests; actual TS helper acceptance, affected native physical sources | Footer/queued card suites. Full build/check scope follows Rust dependency effects. |
| Lock/Pi/Node dependency update | Coherent host/preparation/loader/GC controls; affected SDK/CLI and version/runtime compatibility, including actual shared SDK if changed | A footer-only claim cannot justify narrowing this to footer. |
| Packaging/ABI/platform changes | Relevant inert release regressions **and** actual current-source install/build/import/ABI/consumer checks on affected targets | Repeating every UI geometry scenario on every packaging target. |
| Harness synchronization/cleanup | Harness regressions, real PTY/lifecycle/error-path controls and representative actual Pi/native/shared checks for all affected publishers/owners | A pure parser-unit pass is not enough; other profiles/platforms are relevant if their seams changed. |
| Documentation only | Links/claims/diff checks; applicable executable examples if changed | Product matrix without a behavioral reason. |

These examples are recipes to refine, **not permission to cherry-pick only happy paths**. Preserve both terminal modes whenever the original affected contract distinguishes them, including replay/error/late-result/ownership assertions. Local focused `--pattern` remains useful during debugging, but a required group cannot be reported passed based on one selected happy case.

## 6. Cross-domain closure and uncertainty

Use small explicit rules and human review; do not attempt a generic semantic impact engine.

**Additional host/runtime expansion:** a change to dependence on SDK class identity, method/hooks, editor/render scheduling, session semantics or loader behavior requires the affected contract groups on every supported Pi graph whose behavior can differ (normally Pi 1.0 and 1.2 at the baseline Node). A change to dependence on Node timers/event ordering, ESM/compilation, subprocesses or weak ownership/GC requires the affected groups on Node 22 and 26. If both dimensions interact, run those affected groups across the four graphs. Dependency versions need not have changed. This expands affected groups, not automatically every unrelated feature. Pure text formatting with no changed host/runtime dependence does not, by itself, trigger that matrix.

- **Shared geometry/paint:** changes to frame/theme/plain-text wrapping affect all actual consumers: summaries, Bash/edit/write/user/queued cards and possibly editor projection. Run their SDK checks and representative physical color/width cases; not the daemon lifecycle unless source/style semantics change.
- **Adapter/entry ownership:** install/off/on/reload/session/renderer/foreign-owner/weak-hook changes may affect editor, footer, cards, activity and syntax owner authority. Run the relevant lifecycle/GC controls across owners, plus actual entry integration. Changing a footer branch in `index.ts` does not automatically change all these contracts; changing common installation or teardown does.
- **Settings:** common persistence/schema/precedence changes affect all stored switches/themes and reload/replay. A menu-only label does not. Preview semantics add native theme and stale-reply phases.
- **Caches:** distinguish layout representation, prepared source/permission, native parser checkpoint, and test compilation cache. They have different owners and tests; similar names do not establish dependency.
- **Colors:** distinguish terminal OSC defaults, Pi theme, syntax profile and native source compatibility. Run the actual consumer crossings changed, not every test containing “theme”.
- **Wire/request/response:** TS and Rust contract changes require both sides and a real round trip. A fake successful response cannot establish daemon compatibility.
- **Harness publication:** every switched waiter must have an actual notifier; verify all publishers and actual packaged fixture copies, not just one helper fake.
- **Global locks/dependencies/source admission:** broader host/compatibility checks are relevant. A small diff can have broad effects.

Every implementation/review states the changed contract, selected groups and why other expensive groups are irrelevant. For uncertain impact, expand to the plausible consumer groups; if scope is genuinely global or unknown, run the appropriate full union and disclose the budget exception. Do not silently promote every shared-file edit to the entire Node/Pi/platform matrix, and do not silently narrow it either.

## 7. Proposed CI graph and compatibility cadence

### Ordinary push/PR

Use **one baseline Linux Node/Pi graph** instead of four identical product matrices. Cheap common logic/SDK/GC + types and a small real-entry baseline run without native build dependencies. Run affected physical/native/shared/delivery groups when their contracts are changed, not as mandatory unrelated predecessors.

The default workflow should use a small coarse routing table for unambiguous module/test paths. The same named group catalogue is available locally and in explicit workflow inputs. Record selected groups/reason, prerequisites and tested revision in the job receipt. An automatic path match is only a conservative default, not proof of semantic impact.

#### Reviewed scope for cross-cutting files

Recommend coarse defaults plus reviewed narrowing, rather than forcing a scope declaration for every trivial path:

1. Ordinary module/test paths add their owner groups and explicit closure. Shared hotspots such as `src/index.ts`, common frame, settings, locks or harness boundaries add conservative consumer groups. Unmapped production paths keep a conservative product scope and require classification; no silent empty fast selection.
2. Explicit developer/workflow selections may freely **add** groups. They cannot silently subtract default obligations or any release gate. An authorized revision-bound record may also add `compatibility: "pi"`, `"node"` or `"all"` when a change introduces the dependence described in section 6; `"baseline"` never removes profiles already required by conservative routing. This permits affected compatibility without launching the unrelated full union.
3. Narrowing a shared-hotspot default requires a maintainer's reviewed contract rationale, selected group list and **exact tested HEAD SHA**. The record explains why excluded consumers cannot be invalidated. Missing/stale information retains the conservative default; changing the revision invalidates the narrowing.
4. For ordinary **PR runs**, use an existing maintainer review/comment on that PR containing those fields. The workflow reads the authorized metadata, verifies revision and authority, and records it in the selection receipt. An unreviewed PR-description label or arbitrary group input cannot waive checks. A maintainer can update the scope after a push and rerun the selection/affected check for that same revision; no periodic service or new scope database is needed.
5. For a **push without matching PR approval**, default routing applies. An authorized manual rerun for that exact commit can supply the same reviewed scope/rationale. It does not transfer to a later commit. Ordinary unambiguous changes need neither this override nor an all-feature matrix.
6. If a missing scope decision would launch a known over-budget conservative union, report **scope decision required** before spending that work; retain the default as the unresolved obligation, not as a pass. Cheap checks can complete, but they are not feature acceptance. The maintainer chooses either the conservative execution with a disclosed budget exception or reviewed narrowing. Preserve successful same-revision evidence rather than gratuitously rerun it.
7. Full compatibility/release runs retain their own mandatory union and platform/public-artifact rules. A feature scope record never narrows them.

The operator approved this acceptance policy. Validating comment authority/revision, refusing stale/subtractive inputs and exercising ordinary PR/push behavior are required routing regressions before deployment. Metadata handling must not run untrusted PR code with elevated credentials. The command/block spelling can remain an implementation detail, but the semantics above cannot.

Alternative: reviewed explicit scope for every production change, with a conservative fallback. It is simpler conceptually but adds manual work even for unambiguous edits; not the recommended initial approach.

Remove the ordinary UI job's dependency on the reusable six-platform native workflow. A relevant native integration requests only the required host's verified current-source helper; a relevant shared case requests the pinned host. No cross-commit binary relabelling, public-release substitution or silent missing-helper fallback is allowed. A local same-commit/nativeTree prepared input can be reused only under existing validation. If current provenance requires a build, run it and count it.

Keep three costs separate:

1. required feature tests and actual prerequisites;
2. compatibility expansion across runtimes/platforms;
3. real release byte/install/ABI admission.

A renamed two-minute “fast” job that still waits for all six builds is not acceptance of this proposal. Parallelizing unchanged matrices may reduce wall time while leaving paid runner-minutes intact; it is not the primary optimization.

### Feature completion, compatibility and release

- Ordinary feature completion uses the relevant baseline groups above, not every group on every runtime.
- Run additional supported Node/Pi graphs when dependency/API/version-specific contracts change **or changed dependence on host/runtime behavior requires it under section 6**, and in explicit full compatibility acceptance.
- Run affected-platform build/consumer/ABI checks for native build, platform or delivery changes. Full six-platform acceptance remains available before delivery/release and manually; it is not deleted.
- Preserve extension-release public-byte admission, daemon-release independence and explicit no-publish boundaries. A daemon release is not authority for published-extension checks.
- No daily schedule is introduced. Any later periodic compatibility policy is a separate operator decision.

The operator approved the baseline graph, scoped ordinary CI, hotspot authority, compatibility/platform triggers and full/release obligations. Hosted verification/deployment and required-check settings remain separate from local validation.

## 8. Preparation and the 2–3 minute budget

Measure the **whole path**, not only TAP: source identity/refresh, dependency graph install/copy, tool/bootstrap readiness, optional native/shared/profile/consumer acquisition/build, test execution and cleanup. Record cold/restore/warm separately and runner-minutes separately from wall time.

Existing accepted observations establish useful scale, not a new SLA:

- Broad unit is already only 51–62 s; strict-check wrapper roughly 7–8 s. It is often unnecessary to aggressively shard the cheap baseline before measuring.
- Existing footer physical T33–T37 sum to about 42 s; editor T27–T32 about 49 s; all syntax integration is about 63–70 s. These are observed case sums, **not benchmarks of the proposed groups**; file/process/setup changes can alter cost.
- The heavy unrelated main union is 336–363 s and should not be a prerequisite for every one of these features.

Preparation changes to evaluate after selection is fixed:

1. Do not request unrelated integration packages, shared-host binary, Cargo stores or consumer archives for a group.
2. Separate refreshing the tested source snapshot from reinstalling an unchanged owned host graph where safe. Existing source/lock/runtime authority and deletion cleanup must remain exact. Reuse existing owned npm/Cargo/compile stores rather than add a new cache service.
3. If cached prepared inputs are reused, validate exact selected Node/Pi lock/platform and source/native identity. A cache miss either prepares the required capability or reports an explicit unrun failure; it must not silently downgrade coverage.
4. Do not assume unchanged Rust source permits claiming a different commit's artifact as current. Any provenance relaxation would require separate approval and is not proposed here.
5. Avoid simultaneous duplicate preparations per Pi/Node graph, repeated inert packaging per profile, and consumer archive capture for non-consumer checks. Prepare only what selected checks consume.

Acceptance requires a measured ordinary-feature path near 2–3 minutes under stated conditions, with justified variation rather than a strict limit, not simply setting a 180-second kill timer. Measure at least footer, editor, Bash presentation, terminal colors and native theme/source work; include source refresh after a real edit and strict no-native/no-profile capability controls. Measure fresh CI setup as well as an owned-cache hit. If cold setup or a necessary integration exceeds the target, report the bottleneck and avoid preventable work; modest justified variation is acceptable. Escalate only a material coverage/architecture trade-off, not a small timing fluctuation.

## 9. Coverage-preserving implementation sequence

No phase below is implementation authorization.

1. **Approve policy and freeze the baseline.** Use this map and existing receipts; record any incoming source commits. Preserve the old full group names and requirements during the transition.
2. **Split capabilities at actual execution boundaries.** Extract mixed real-daemon/profile/shared cases; add explicit group membership/input requirements and their positive/negative behavioral controls. First prove a footer group really runs without irrelevant native/profile inputs, and native/shared groups really fail when required inputs are absent.
3. **Split monoliths by feature owner.** Move declarations with their full assertion/lifecycle sequences, retain shared non-registering fixtures and stable names. Prefer coherent files over one-test-per-process. Record old→new mapping for every original case; keep nested scopes and mode pairs.
4. **Expose focused recipes and update documentation.** Existing hermetic runner remains authoritative. Show a developer the contract groups and actual prerequisites selected before execution; wrong/empty/unknown selection is an error.
5. **Validate coverage and selection behavior.** All 65 entries, both consumers and Rust targets have an owner. Full union includes each original required case exactly once per runtime; no lost assertions, changed equality, lost GC/traffic/replay or hidden new skips. Update current suite-discovery/CI policy tests only to the approved new contract, with positive and negative trigger/input tests.
6. **Measure representative feature paths including preparation.** Compare counts/counters and actual physical results, not just timings. Verify dirty-environment/offline, source refresh/deletions and helper/protocol authority on affected harness seams. Do not spend a full matrix on every intermediate edit.
7. **Change ordinary CI graph last.** Prove fast and native jobs no longer wait for unrelated platform consumers; report selected checks and actual billed-job expansion. Preserve a separately invokable full union and release policy.
8. **Final acceptance and independent review.** One appropriate full compatibility/platform verification after integration, not per refactor step, plus before/after coverage inventory, representative end-to-end budget evidence or explicit justified gaps, and source-grounded review. Obtain separate commit/push/remote-run authorization.

## 10. Review dispositions and unresolved decisions

Oracle's initial read-only advice confirmed three priorities: fix admission/preparation rather than names alone; remove the native-workflow dependency barrier rather than merely shrink a matrix; require cross-contract closure and measured end-to-end budgets. These are incorporated above. Its recommendation does not authorize gating changes.

Oracle's concrete-draft follow-up identified two material policy gaps rather than product defects: an unnamed common baseline and unspecified hotspot narrowing. Sections 5–7 now give concrete baseline membership, changed-host/runtime triggers without dependency updates, and revision-bound ordinary PR/push semantics. These corrections were approved; implementation validation is recorded separately, not inferred from proposal review.

Oracle's bounded closure review confirmed both proposal-level findings resolved, with no remaining material contradiction. Its nonblocking request to link the compatibility summary explicitly to the broader host/runtime rule is applied above. Review scope was the changed proposal sections, not independent execution, timing or an exhaustive rereview of every test body; the execution-policy decisions were subsequently approved by the operator. Saved reviews and parent validation are under `.test-artifacts/test-organization/`.

The native inventory correctly distinguished the many no-daemon files and mixed native controls. Parent verification corrected one omission: the structured-RGB physical case also starts a real shared host, so shared scope is S07 **and S10**, not just the transition case. This map uses fresh calls at syntax-terminal lines 360 and 496.

Still to approve/measure:

- Approve the concrete common baseline in section 5 and reviewed hotspot policy in section 7, or choose their stated alternatives; approve additional runtime/platform cadence.
- Cold and warm complete feature-job cost; no hosted 2–3 minute claim exists yet.
- Whether existing preparation-store reuse is enough or a small source-refresh seam is needed; no new cache architecture is authorized.
- Historical Node22 startup/spinner failures remain separate unresolved causal investigations. Splitting suites does not cure them or justify altering their original assertions.

The value of this plan is **less irrelevant work per feature**, not a smaller definition of correctness.
