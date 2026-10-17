# CI runner-budget reduction plan

Status: operator-approved matrix and coverage trade-offs implemented; local validation completed. Hosted execution and net runner-hour measurement remain unperformed. Commit, push, hosted CI and publication require separate authorization.

Baseline: `7af17b7418ea1731b9f67ba16e9adf1ed03b3972`, ordinary automatic main-push run [38961567400](https://github.com/chpock/pi-tidy-ui/actions/runs/38961567400). This plan changes the frequency/depth of compatibility checks, not test behavior or production code. The updated obligations are documented in [testing.md](testing.md#fixed-ci-obligations); workflow definitions and local validation are not hosted acceptance.

## Goal and boundaries

Reduce aggregate runner execution and repeated setup on each ordinary push/PR. End-to-end duration is not the optimization target; no 2–3-minute CI promise or hard budget is introduced.

- Keep fixed coverage by event, independent of changed files, prior failures, paths or approval comments. No mandatory manual dispatch, per-file registry or impact classifier.
- Keep complete Node/SDK/GC and type coverage on both Node versions × minimum/latest Pi on Linux x64. Existing `unit` includes real SDK and integrations, not only isolated algorithm tests.
- Run every existing physical CLI test on the reference profile. Add no broad test rewrite, new execution engine or directory migration.
- Reuse existing smoke/editor scenarios as the fixed shorter physical compatibility set on the other profiles; do not weaken their assertions, timing or cleanup.
- Preserve native-source/raw-byte admission, all enabled native targets, both installation optionality modes, cold/warm and incremental-work assertions, cleanup and real GNU/glibc 2.28 execution.
- Keep Windows ARM64 disabled but reenableable through the existing switch, one-day transfer-only artifacts and diagnostics in logs.
- Keep latest Pi resolution once per run, exact version propagation, existing pinned Node versions and exact-source/PR HEAD policy. This does not introduce a moving `latest` Node selector.
- Preserve existing nightly and release obligations. No publication-authority or npm trusted-publisher changes.
- Investigate macOS x64 performance separately. No runner/image/disk/cache/compiler tuning, dependency-closure optimization or service-removal work belongs here. Parked follow-up #72 has the existing evidence; a platform defect is not established.

## Fixed event matrix

Reference profile: Linux x64, minimum Node **22.19.0**, exact resolved latest Pi. The second configured Node remains **26.7.0**, minimum Pi **1.0.0**. These are test baselines, not a claim about measured user population.

| Event | Node/SDK/types | Physical CLI | Native consumers | Other gates |
| --- | --- | --- | --- | --- |
| Main push, PR, ordinary manual dispatch | Complete current `unit` and types on all distinct Node × Pi profiles | Complete suite on reference profile, four existing shards; shorter compatibility suite once on each other profile | Every enabled target once on minimum Node + minimum Pi | Existing native producers and both-Node inert delivery |
| Nightly | Unchanged: `compatibility` and types on both Nodes / latest Pi | Unchanged: complete suite on both Nodes / latest Pi | Unchanged: none | Linux helper producer prerequisite only; separate nightly result/concurrency |
| Occipital push tag | Unchanged daemon/native packaging regressions on both Nodes/minimum Pi; no UI matrix | None, unchanged | Unchanged: both Nodes/minimum Pi on every enabled target | Existing producers, delivery, GitHub Release then automatic native npm publication |
| Extension push tag | Unchanged complete Node/SDK/types matrix | Unchanged complete CLI on every distinct Node × Pi profile | Unchanged both Nodes/minimum Pi, including public-delivery admission | Existing full delivery and admitted package preparation; extension npm publishing stays commented |

Ordinary manual dispatch follows ordinary coverage, even at a tag ref; it cannot publish. The existing clean-native-build switch changes cache restoration only, not test membership. No new coverage override switch is needed.

### Why retain the SDK cross-product

Runtime loading/class identity, GC ownership and deferred callbacks involve both Node and Pi. Keeping all four comparatively inexpensive SDK/type profiles avoids inventing a fragile division between “JavaScript tests” and “Pi-core tests.” No new per-test compatibility labels are introduced.

### Shorter physical compatibility suite

Define one small, named selection in the existing catalogue/runner: `cli-compatibility`. Its membership is the union of **all physical test files under the existing `tests/cli/lifecycle/smoke/` and `tests/cli/editor/` directories**, read recursively and deduplicated by the existing discovery mechanism. No list of filenames and no new directory tree. At the baseline this is two existing modules / eight declared test cases; this count is evidence about the snapshot, not an execution limit or registration requirement.

These existing scenarios cover actual Pi execution/persistence equivalence, compact/expanded tool output, appearance off/on, reload, replay, resizing, physical editor/cursor/paste/undo/autocomplete, below-editor metadata and native activity in the currently exercised terminal modes. Their scope remains exactly what their existing assertions establish: not every scenario individually covers every mode or feature.

- Run the union in **one unsharded runner invocation per secondary profile**, reusing that job's normal isolated compile cache. Do not split smoke and editor into separately prepared jobs or keep an otherwise idle fourth full-CLI shard.
- Reject file/name/group/skip/layer filtering or shard arguments for this CI suite. It is a fixed role, not a generic configurable subset mechanism. Local developer filters keep their existing behavior outside this role.
- New tests under either selected directory automatically join compatibility checks. All other new CLI tests still join the complete reference suite and existing complete nightly/release lanes automatically.
- Log/report the role, exact Node/Pi, selected files and the discovered full CLI membership. Mark the role explicitly **Physical compatibility**, never “complete CLI.” Do not mislabel its shorter coverage as zero skipped full-suite cases.
- The existing complete `cli` selection and exhaustive four-way partitioning remain unchanged. There is no test-source relocation or duplicated scenario implementation.

### Platform consumer choice

Choose minimum Node + **minimum Pi** for the single ordinary consumer on every target, including Linux x64. It preserves the supported installation floor while the full Linux SDK/CLI lanes exercise current Pi. The existing consumer workflow already uses minimum Pi; changing its selected Pi adds work and changes a second guarantee without being necessary for this reduction.

Retain the consumer body intact: both fresh npm installations, with/without optional dependencies; exact dependency/archive and SDK identity checks; native acquisition, UTF-8/incremental work, cold/warm counters and reaping. A version-print or one request/response is not an acceptable replacement. Native builds and native-build controls remain once per target.

The deliberate loss is ordinary **Node 26 × platform** consumer coverage. It remains mandatory on the existing release conditions. Do not add a new platform × Pi cross-product.

## Implementation scope

Use existing modules and jobs; no replacement harness or general policy framework.

1. **Catalogue and focused tests** — add the named structural `cli-compatibility` union and its fixed-selection restrictions in `scripts/test/catalog.mjs`, with only the runner changes needed to preserve role/report identity and reject narrowing. Test new nested file inclusion, duplicate-free membership, empty selection failure, unchanged full CLI and invalid filters/shards. Do not re-enumerate product tests or change execution prerequisites.
2. **Planner and focused tests** — `scripts/test/ci-plan.mjs` retains the complete SDK profiles. Ordinary CLI rows explicitly carry `coverage: complete | compatibility`; only reference rows have four shard indices. Ordinary native consumers expand across one Node, releases across both, nightly across none. Latest=min deduplication must produce one full reference profile and one secondary Node compatibility profile, not duplicate/empty rows. ARM64 opt-in follows the same event rules.
3. **Reusable execution and orchestration** — `.github/workflows/ci-checks.yml` validates the planned CLI role, runs complete shards or the single compatibility union, and provisions only existing structurally derived prerequisites. `.github/workflows/ci.yml` passes the explicit role and displays it in job names. Preserve read-only permissions, exact sources, per-target fan-out, fail-fast=false and final-result dependencies. The final CLI matrix branch includes both roles; failure/cancellation/skip of any planned row is a failure. `occipital-consumer.yml` should need no behavioral change; update descriptions in delegators only if required by the one-or-two-Node matrix.
4. **Documentation and acceptance** — update implemented matrix/coverage/cost claims in `docs/testing.md` and relevant release documentation after source changes; keep this plan as the decision record. Reuse existing CI/planner/workflow tests, adding executed-step and discovery controls rather than source-shaped assertions. Obtain independent review before delivery.

## What is intentionally not optimized

- All five native builds and their real Rust correctness/lint/ABI/ancestry gates stay.
- SDK checks are not split into guessed “core” and “non-core” lists; harness tests are not selectively dropped in this work.
- Do not reduce complete reference CLI assertions, sizes, animation windows, watchdogs, GC requirements or integration fixtures.
- Do not introduce cache/node_modules sharing, cross-run native reuse, historical-failure state, dynamic duration-based sampling or a new sharding service.
- Do not add OS-terminal rendering suites or a new OS-I/O suite in this change. Cross-OS interactive rendering was not covered by the baseline; this plan does not claim to establish it. Native/consumer smoke does not establish settings/Git filesystem-watch or every terminal-emulator behavior.
- No macOS x64 investigation, dependency upgrades, artifact deletion, remote settings, commits, pushes or hosted runs are implied by approval of this document alone.

## Known coverage trade-offs

1. Ordinary full physical coverage goes from four Node/Pi profiles to one. On secondary profiles the smoke/editor union does not cover every dedicated streaming, native/shared, color, theme-rollback or installed-extension CLI scenario. Their SDK coverage remains; that is not a substitute for the omitted physical scenarios.
2. Existing nightly fully exercises latest Pi on both Nodes, but cannot certify an earlier commit and does not recover complete minimum-Pi CLI coverage. Full minimum-Pi physical coverage remains at extension-release gates.
3. Ordinary consumer coverage no longer certifies the newer Node/npm on every OS/architecture. Complete release consumers retain that cross-product. Native bootstrap on Node 26 remains covered on Linux by existing SDK/integration checks, not by an ordinary clean consumer installation on every platform.
4. A green ordinary result certifies the explicitly reduced fixed matrix, not the full release matrix. Maintain visible full/compatibility job names and exact profile summaries. Nothing is selected from commit diffs or omitted because a prior test failed.

These intentional scope/frequency compromises were explicitly accepted by the operator, not hidden with reruns or fallback.

## Budget and measurement

The successful baseline had 39 active jobs (five native, ten consumers, four SDK, sixteen CLI, two delivery, metadata and final result) and **5,156 aggregate job-seconds = 85m56s ≈ 1.43 runner-hours**. This is the sum of observed job start→completion intervals, including job setup; it is not a GitHub invoice, CPU-time measurement or normalized machine-capacity metric. Primary evidence is `.test-artifacts/ci-fixed-triggers/hosted-main/job-pages.json`.

With five targets and distinct minimum/latest Pi, the proposal has **25 active ordinary jobs**: five native, five consumers, four SDK, four full CLI shards, three compatibility CLI, two delivery, metadata and final result. Unused tag-only jobs remain explicitly inapplicable, not failed required coverage. If minimum=latest, profiles deduplicate; with Windows ARM64 enabled, its producer and one ordinary consumer are added. Do not freeze 25 as an all-events invariant.

Historical execution removed from the ordinary graph:

- Three non-reference complete CLI profiles: **1,881 job-seconds**.
- Five Node 26 consumer jobs: **590 job-seconds**.
- Together: **2,471 seconds = 41m11s ≈ 0.69 runner-hours**, before adding the three compatibility jobs.

This is removed work in one historical run, **not a forecast or guaranteed saving**. The reference full CLI consumed 674 aggregate seconds in that run, while the new compatibility union has not been measured. Setup, cache, runner provisioning and queue conditions can change. Do not claim “48% saved”: the three new jobs are not free, and comparable total execution has not yet been observed.

After explicitly authorized implementation/execution, inspect one normal automatic push run; do not add a permanent A/B flag or run an extra old full matrix solely to produce a percentage. Record:

- Event/source/latest identity and actual required job/profile/role counts.
- Actual selected files, full CLI coverage/partition union and secondary compatibility membership.
- Aggregate start→completion seconds by native, consumer, SDK, full CLI, compatibility CLI, delivery and metadata/result; report active job counts and wall time separately.
- Sum of the three compatibility job durations versus the historical 1,881 seconds of their former full-CLI counterparts; total runner-time comparison with explicit cache/runner/source caveats.
- One full native build per enabled target, both consumer optionality modes, exact source/bytes, cleanup/reaping, safe logs and transfer-only artifacts.

Success requires demonstrably less repeated execution and passing required checks, not a particular wall time or percentage. If the compatibility role is unexpectedly expensive enough to erase the intended budget reduction, report that evidence and reconsider scope with the operator; do not silently delete assertions or guess another test subset.

## Validation and rollout gates

1. Run focused catalogue/planner/actual-workflow-step regressions on both configured Nodes in prepared hermetic inputs. Exercise ordinary push, PR and manual, nightly, both release kinds, latest=min, failed latest acquisition and ARM64 enabled/disabled. Reject malformed roles and attempts to narrow a planned role.
2. Demonstrate reference full-CLI membership is unchanged and secondary membership equals the complete structural smoke/editor union. Add a new nested test in each eligible directory without any registry edit and prove selection. A deliberate failing compatibility test must fail its runner and the mandatory join; a later commit with the same trigger cannot omit it by changed paths.
3. Check all existing SDK/type and release matrices are preserved; both-Node release consumers and complete extension-release CLI must not inherit ordinary reductions. Execute extracted workflow/result scripts to verify the real role propagation and failure behavior. Keep publication tests inert; do not create release tags to test selection.
4. Use focused real CLI execution for the new compatibility role on secondary profiles as needed, and workflow lint. Do not repeat all four old complete CLI runs locally merely because the planner changed. After separately authorized push, the ordinary automatic CI provides real SDK four-profile, reference complete CLI, secondary compatibility and five-platform consumer acceptance.
5. Independent source/evidence review must verify actual counts, unchanged test bodies/native controls, approved omissions and honest role names. Hosted ordinary success is not nightly/release/publication execution acceptance. Scheduled execution and real publication remain governed by their separate authorizations.

## Independent planning review

Oracle freshly inspected this plan and the relevant existing catalogue, runner, planner, reusable workflow and consumer boundaries. No material omissions, inconsistencies or excess work were found. The reviewer confirmed the 25-job ordinary matrix, unchanged nightly/release guarantees and distinction between removed historical execution and unmeasured net savings. Review artifact: `.test-artifacts/ci-runner-budget/oracle-plan-review.md` (local ignored evidence, not a hosted acceptance claim).

The operator authorized implementation of this plan. macOS investigation was briefly reconsidered, then explicitly deferred again after verifying the public-repository standard-runner exemption; no macOS cache/build/preparation changes belong to this implementation. Final local and independent acceptance, and later separately authorized hosted measurement, remain distinct gates.
