# Hermetic tests and explicit Pi-version compatibility

Status: approved for implementation by the operator on 2026-10-14; implementation and validation are in progress. This plan does not authorize commits, publication or deployment. Current interfaces are documented in `testing.md`; acceptance evidence and finding disposition are recorded under `.test-artifacts/hermetic-tests/`.

## Goal and scope

All repository tests must be independent of the developer's environment and configured/installed Pi. This includes unit/SDK/GC, physical terminal/replay, native/shared integration, Rust and packaging/release tests, not just `test:terminal`.

The harness must run against explicitly selected Pi versions and be reusable by a future daily compatibility workflow. That scheduled workflow, discovering the then-current release, and compatibility fixes in production code are outside this refactor.

Hermetic means: given the same source revision, prepared input bundle and declared platform/runtime profile, ambient configuration, credentials, services, caches and installed Pi cannot change test selection or semantics. It does not mean replacing real CLI/helper/OS integration with mocks, identical timing across machines, or running POSIX PTY cases on Windows.

## Approved operator decision: Occipital source and release boundary

- Ordinary tests must use Occipital built from the same commit as the source being built/tested, including native/shared execution, terminal/replay, clean consumer installation and the future daily Pi-compatibility run. Published Occipital is not an ordinary test input or fallback.
- Tests using published Occipital run **only for a pi-tidy-ui release**. They must not run in ordinary main/PR CI, daily compatibility checks or Occipital release jobs.
- Build the current-source artifacts during preparation and reuse those exact verified artifacts across Pi-version runs. Establish source/build identity as well as target and byte hash; matching `--version` alone does not establish the same source commit. If local source edits are included, the native build must match the tested source snapshot rather than a stale build of HEAD.

This decision supersedes the initial proposal to preserve the public-delivery gate's existing ordinary-CI cadence. The operator subsequently approved implementation of the whole plan.

## Approved implementation decisions

1. Separate **input preparation** from **test execution**. Preparation may fetch explicitly selected packages/artifacts or build a helper. Execution uses only prepared, verified inputs and test-owned files/processes/local endpoints; no public network, installation/resolution of missing harness dependencies, opportunistic helper compilation, live release selection or global Pi discovery. Consumer installation **under test** is allowed only into disposable consumers, using prepared package archives and fixture-local endpoints; it cannot acquire missing inputs from public registries. Declared Rust build/test commands may compile offline using the prepared pinned toolchain/dependencies.
2. Run each selected Pi version in its own disposable dependency environment. The CLI, production extension, SDK assertions, TUI classes, type checks and child probes must resolve to that environment's coherent host dependency graph. Selecting another CLI while retaining the checkout's baseline SDK does not count as a version run.
3. Replace the installed-user-extension profile with a locked test-owned integration profile. Retain real third-party loading/local task execution and documented exclusions; do not replace these controls with registration mocks or silently remove coverage.
4. Replace ordinary `test:installed-native` coverage with a hermetic real-npm consumer test using package archives containing the same-commit Occipital build and a local registry/download fixture. Under the approved boundary above, retain real public npm/GitHub delivery acceptance only in the pi-tidy-ui release path, as explicitly networked external verification rather than a hermetic test or substitute for one. Preserve its release coverage, not its existing ordinary-CI cadence. This boundary is a material change, not a naming-only claim that existing networked tests became hermetic.
5. Required inputs are mandatory for a selected profile. A missing helper, host package, shared-host binary or GC capability is a setup failure, not a passing test with missing coverage. Platform inapplicability and explicit focused selection are separately reported; neither is compatibility acceptance.

Do not implement decision 4 by simply excluding the current consumer test. Both the same-commit hermetic consumer replacement for ordinary tests and the published-Occipital verification restricted to pi-tidy-ui releases are required. The operator has settled this release-only boundary; do not reopen it merely to preserve the old workflow conditions.

## Evidence from the current tree

| Boundary | Current evidence | Consequence |
| --- | --- | --- |
| CLI selection | `tests/terminal.test.mjs:18,105–121`: `PI_TEST_CLI || 'pi'`, inherited PATH | Host CLI is not an explicit prepared input |
| Ordinary CLI isolation | `tests/terminal.test.mjs:57–98,111–119` creates HOME/agent/work/settings and a fresh environment | Reuse this working isolation; extend it rather than replace real CLI execution |
| User extension inventory | `tests/fixtures/integration-profile.mjs:48–92`; `tests/terminal.test.mjs:1386–1401` | Reads the user's settings/packages; missing audited tasks changes coverage |
| SDK and private host imports | `tests/unit.test.ts:9–28`; `tests/fixtures/cache-probe.ts:9–15` | Existing tests bind to the checkout's installed host graph |
| Partial second-host mechanism | `tests/occipital-menu.test.ts:19–50` | Environment-selected single-module recompilation is not suite-wide compatibility |
| Inherited subprocess state | `tests/unit.test.ts:2077,2090,3208,4523`; `tests/settings.test.ts:347–348`; `tests/fixtures/npm-preparation.ts:117–119` | Child probes/Git/npm can read host configuration before individual test setup |
| Native/shared controls | `tests/occipital-native.test.ts:20–27`; `tests/fixtures/shared-syntax-host.mjs:24–39`; `tests/syntax-terminal.test.mjs:333–334,469–470` | Real fixtures already exist, but inputs/env and conditional coverage need a common contract |
| Public consumer | `tests/fixtures/installed-occipital.mjs:24–29,51–66,93–99`; `.github/workflows/occipital.yml:181–217` | Selects published Occipital by repository history and currently runs outside Occipital release tags, including ordinary CI; this conflicts with the approved release-only boundary |
| Release regression subprocesses | `tests/native-release.test.mjs:80`; `tests/extension-release.test.mjs:176–189` | Real npm must have explicit config/cache/executable. The scoped-registry case runs `npm config get`, not a public HTTP test |
| Rust child processes | `crates/occipital/tests/stdio.rs:19–26`; `crates/occipital/tests/catalogue.rs:274–359` | Helper/re-executed test processes inherit state unless isolated at the process boundary |
| Entry points | `package.json:34–40`; `Makefile:66–95`; `.github/workflows/ci.yml:104–124` | npm, Make, direct probes and CI need consistent preparation/execution/reporting |

These are confirmed representative seams, not a claim that every environment/filesystem read has already been exhaustively audited. Phase 1 produces the complete migration inventory. Literal example URLs/paths and fixture-controlled environment mutations are not themselves leaks.

## Target execution contract

### Prepared inputs

Use a small validated run descriptor, supplied explicitly to the runner, containing:

- source revision/tree identity and suite/profile selection;
- exact Pi package identity/version, installation root and lockfile/integrity identity;
- resolved host dependency identities, including TUI/AI/core where used;
- Node executable/version and explicit prerequisite tool paths/versions;
- native/helper/shared-host inputs, target, version and hashes when required, plus source commit/build identity proving Occipital matches the tested sources;
- locked third-party integration-profile identity and prepared consumer archives where required.

Ordinary native artifacts and consumer packages come from the current-source build, not `publishedDeclaration`, public Occipital npm packages, a user-installed helper or a stale colocated executable. Reject mismatched source identity before execution; never fall back to a published binary. Cached build outputs are usable only when they correspond to the same declared source/build inputs.

The baseline is the current locked Pi `1.0.0`. Initial multi-version validation must also execute a second exact Pi release; `1.2.0` is the initial candidate, not a claim of compatibility or the current latest release. Confirm package availability and engines during preparation. Do not assume all Pi-family package versions have identical version strings: use the selected host's actual dependency graph.

For non-baseline preparation, retain the resolved transitive lock/integrities as reproducible run inputs. Exact top-level version alone is insufficient. A future workflow resolves a release once, outside execution, then supplies its exact identity through this same interface. The runner never interprets `latest`, reads a user's installation or changes the source manifest/lockfile to switch hosts.

Dependency preparation has its own clean npm/Cargo configuration and test-owned stores. It must not use user `.npmrc`, registry redirections, auth/proxy settings or Cargo configuration. Explicit infrastructure needs, such as a corporate proxy or trusted registry mirror, must be declared preparation inputs, never silently inherited.

### Environment and resources

- Establish isolation **before importing** Pi or production modules, including the Node test parent, workers, GC probes, Python bridge and native children. The execution boundary must also remove Node startup controls before launching those processes: changing `process.env.NODE_OPTIONS` inside an already-started test process is too late. Do not claim isolation of the caller's npm/shell process; guarantee a fresh sanitized test-process tree.
- Construct environment allowlists; do not spread `process.env` or rely on a denylist of known Pi variables. Explicitly supply platform-required fields, HOME/USERPROFILE, XDG/APPDATA/LOCALAPPDATA locations, temp roots, locale, timezone and terminal/color policy as applicable.
- Resolve executable tools during explicit setup and record them. Invoke Node + the selected CLI entry by absolute paths. Construct controlled PATH only for declared real Bash commands/tool fixtures; never append the user's PATH. Real tools stay real; no universal executable mock layer.
- Isolate Git system/global config, hooks/templates, npm user/global/project config and cache, Cargo home/config and relevant discovery roots. Cases specifically testing configuration receive fixture configuration through their scenario input.
- Use disposable per-run/per-case resources with owned cwd, sessions, config, repositories, ports, sockets and artifact output. Shared syntax cases start their own supplied host/helper and never connect to a user's service.
- Keep cross-platform prerequisite checks explicit, including Windows-required process environment. Validate Rust execution offline with the pinned provisioned toolchain/dependencies; dependency fetching belongs to preparation.
- Required commands fail early with actionable setup errors. Direct invocation of test files must either use the same safe bootstrap or reject missing run context; it must not fall back to ambient Pi/environment.
- Clean up owned processes/listeners/files on success and failure. Preserve safe evidence outside disposed case roots. Do not copy raw npm logs, environment, credentials or opaque network diagnostics into artifacts.

### Version isolation

Prefer a disposable materialized test tree with the selected dependency graph, preserving normal Node/CLI module resolution. Avoid symlinks that resolve source imports back into the checkout's baseline `node_modules`, broad import rewriting and per-module transpilation as a substitute for version isolation.

Use actual host package metadata/module resolution for deep SDK imports; consolidate only existing integration seams that need it. Remove hardcoded baseline-version assertions from compatibility paths and compare against the supplied descriptor instead. Any necessary host-version-specific test adapter must be narrowly justified by actual host source/API differences; missing internals must not silently disable required public/CLI coverage.

Prove both resolved package identities and runtime class identity at the host boundary. CLI extension loading can alias public imports to its own packages; merely comparing version strings or `require.resolve` in the parent does not prove the child uses the intended graph. SDK probes and production code must share the intended class/module identities within each process.

### Coverage and results

Profiles organize inputs and cost, not weaken hermeticity: pure/unit, SDK/GC, native, shared, physical terminal, third-party integration, release/packaging, installed-consumer and Rust/platform checks all obey the same isolation contract.

Record selected/executed/not-applicable/missing/failed coverage and reasons. Preserve real traffic/result/session equality, replay's zero new executions, physical cells, source/cache counters and GC ownership controls. Do not normalize additional semantic output or suppress controls to make a newer host green.

A compatibility run reports separately: preparation/setup failure, harness incompatibility, and observed product assertion failure. All fail the requested run; diagnosis must not turn failure into skip. Tests unrelated to Pi need not repeat for every Pi version, but all Pi-dependent SDK/types/CLI paths must run for each selected version on their declared supported platforms.

## Implementation phases and gates

### 1. Complete the input/coverage inventory

Inspect every test file, fixture, subprocess launcher and entry point, including Rust tests/examples actually invoked by CI and GNU/native scripts. Produce a migration table: test requirement, external read/write/command/network/service, existing isolation, target input/profile, required coverage and affected validation.

Classify ambient reads separately from deliberately supplied input and platform prerequisites. Track direct-file invocation, import-time initialization, global config, parent temp-directory discovery, private SDK paths, local caches, optional packages, Git ancestry and environment-controlled skips. Preserve a before/after coverage mapping; no tests disappear by renaming commands.

Gate: every repository test family and CI-invoked check has an owner/target contract; public-delivery policy and prerequisite/profile coverage are agreed before migration.

### 2. Build the preparation and execution foundation, test-first

Add the smallest common descriptor, preparation and subprocess/environment helpers needed by the inventory. Add failing regressions for ambient Pi/PATH/config leakage, inherited child state, missing-input skips, mismatched host graph, stale/wrong-commit Occipital artifacts (including identical version strings) and cleanup before migrating consumers.

Prepare disposable dependency trees without editing source manifests/lockfiles or user files. Bootstrap isolation before module evaluation and propagate it to child processes. Validate supplied paths/identities at boundaries. Do not build an arbitrary sandbox framework or dependency manager.

Gate: setup failures are explicit; repeated runs work without global Pi, user settings, credentials or services; tests demonstrate the chosen SDK/CLI graph and actual child executable/runtime. Focused isolation regression cases pass.

### 3. Migrate unit/SDK/GC, native/shared and Rust tests

Replace inherited environment and implicit cwd/tool selection across probes, settings/logging children, Git/npm/Make wrappers and real native transports. Route SDK imports and types through the selected environment. Replace the menu-only second-host mechanism with the common version runner. Run ownership profiles with GC enabled by construction.

Keep existing real helpers/shared fixtures, but require their declared prepared inputs and ensure every executed Occipital artifact comes from the same tested commit/source snapshot. Rust subprocesses receive controlled fixture environment/config; Cargo execution uses prepared offline dependencies. Preserve platform-specific real Git/Make/Bash/allocator checks without pretending they are platform-independent.

Gate: focused tests plus applicable broad unit/SDK/GC, Rust and release regressions pass under clean and deliberately polluted parent environments. Missing requested native/shared inputs fail before body execution.

### 4. Migrate terminal and third-party integration controls

Extract reusable terminal harness support from `terminal.test.mjs` so importing `PiTerminal` no longer registers the broad suite (currently imported by `syntax-terminal.test.mjs`). Select only requested suites without environment-driven body omission.

Start the selected CLI with the controlled Node/runtime/environment and retain Python PTY, terminal cells, real tools, native comparisons and same-session replay. Replace installed inventory discovery with locked, prepared real third-party package sources/config. Keep unsafe-package exclusions explicit; failure to prepare a required profile fails that profile, never skips it based on the developer's machine.

Gate: focused physical cases prove selected runtime/SDK identities, zero user-profile access, real third-party task execution and unchanged model/session/replay invariants. Final full terminal and syntax runs remain required after integration is complete, not on every edit.

### 5. Make consumer/release tests hermetic without losing delivery acceptance

Use actual npm with explicit config/cache/executable, prepared tarballs built from the same tested source commit, a test-owned registry/download server and fixture Git histories/release declarations. Both optional-package installation and the cold-download fixture must serve that same current-source Occipital build, never a published older binary. Keep real clean consumer installation, optional-dependency presence/absence, archive/hash checks, actual helper execution, exactly one cold native download/zero warm downloads, classification counters and process reaping. Restrict test network to declared local fixture endpoints, including child npm, not only injected `fetch` calls.

Preserve the genuinely public npm/GitHub equality and delivery check as external verification **only for pi-tidy-ui releases**, with exact source/release/package inputs and sanitized configuration. Remove its invocation from ordinary main/PR CI and keep it out of Occipital releases and future daily compatibility checks. Keep release verification visible in CI/release documentation and results; do not count it toward ordinary offline/hermetic acceptance. Keep registry/publication regression tests inert: no publish, stage, push or deploy.

Gate: hermetic installed-consumer executes the same-commit helper with public egress disabled and no user npm cache/config. A separate disposition records preservation and required validation of public-delivery acceptance exclusively for pi-tidy-ui releases; no claim that a local registry proves public publication.

### 6. Wire entry points and compatibility execution

Update npm/Make/current CI commands to the common harness while preserving platform scopes and required gates, except for the explicitly approved cadence change: published-Occipital verification runs only for pi-tidy-ui releases, while ordinary runs test the same-commit build. Keep a simple interface equivalent to `prepare --pi-version EXACT` then `run --inputs FILE --suite NAME`; exact command names are an implementation detail. Support repeated exact version selections with isolated state and separate machine-readable reports.

Run strict production/test type checks against each selected host as applicable. Run all Pi-sensitive SDK/GC, lifecycle, terminal/replay and integration controls for baseline plus the second exact release. Run Pi-independent release/native logic once per relevant runtime/platform rather than multiplying it artificially.

The future daily workflow only needs to resolve the current published Pi version, prepare inputs including Occipital built from the tested commit, and invoke the same compatibility command. Selecting a published Pi version never authorizes using published Occipital. No schedule, moving-version resolver, notification system or automatic lockfile update is added now.

Gate: two exact hosts execute without source/dependency mutation or global installation; A → B → A runs show no cross-version contamination and reuse the same current-source native build. Workflow regression checks prove that published-Occipital verification is selected for pi-tidy-ui releases and not for main/PR, Occipital release or daily compatibility runs; ordinary native tests select the same-commit artifact. Existing ordinary/release CI still has its required coverage. Update `docs/testing.md` with preparation, profiles, focus commands, version selection and external verification boundaries.

### 7. Adversarial acceptance and independent review

Run each required profile with identical prepared inputs under (a) clean and (b) deliberately polluted parent state: fake HOME/Pi settings/themes/extensions/auth, competing Pi/PATH entries, Node options/module search settings, terminal/locale values, Git/npm configuration, proxies, service-discovery variables and pre-existing caches. Polluted executables/config/extensions use observable sentinels; assert zero unintended execution/access effects and unchanged fixture files.

Prevent public egress during hermetic acceptance using an actual OS/container restriction supported by the verification platform; permit only the fixture endpoints required by that profile. A `globalThis.fetch` mock is not a process-wide network guarantee. Resolve the practical restriction mechanism during foundation work and verify it catches child-process network attempts; do not impose a new mandatory container architecture on every developer without approval.

Compare coverage and semantic results, not timestamps/PIDs/temp paths or timings. Assert concrete tool/model/download/classifier counters and native/physical/replay outcomes. Run A → B → A, required GC/native/shared controls, broader regressions, final physical suites and declared Rust/platform checks. Save machine-readable input/version/coverage reports with safe diagnostics.

Request a fresh-file independent review of implementation and evidence. Verify each finding, record disposition and fix confirmed in-scope defects. Any required failed/unrun gate, lost coverage, unverifiable graph identity or unsupported isolation path remains an unresolved blocker, not accepted green.

## Risks and stop conditions

- Dependency preparation and supported OS/runtime prerequisites are explicit inputs, not a promise of platform independence. Missing tools/artifacts must not trigger automatic host discovery or reduced coverage.
- The second Pi release may expose real API/behavior drift. Diagnose harness assumptions versus production defects using fresh host sources and native controls. Product fixes or changed presentation contracts require separate authorization.
- A locked third-party version may be unavailable or incompatible with a selected host. Report that exact setup/integration failure; do not silently choose a newer version, drop the package or blame tidy-ui before a stock control.
- Public delivery and deterministic local installation prove different things. Preserve both under the approved boundary: same-commit Occipital for ordinary tests, published Occipital verification only for pi-tidy-ui releases. A successful published-binary check cannot establish correctness of current native sources.
- Per-version staging can accidentally mix host packages through deep imports, source symlinks or CLI aliases. Runtime identity controls are a release gate for the harness itself.
- Environment allowlists and fixture sentinels establish the declared test contract, not security isolation against malicious dependency code. Dependency installation disables scripts unless a separately justified fixture requirement is approved.
- If practical egress enforcement, dependency locking, selected-host staging or existing public-delivery preservation requires a broader architectural change, stop and obtain approval rather than weakening the definition of hermetic tests.

## Completion criteria

- Every repository test has declared inputs/isolation and no dependency on the user's configured or installed Pi.
- All selected tests run with controlled environment before imports, including children and native processes; ambient state does not select tests or reduce coverage.
- Ordinary tests use only Occipital built from the same tested commit/source snapshot, with verified build identity and no published-binary fallback, including local consumer installation and future daily compatibility runs.
- Test execution is public-network-free; fixture-local communication remains real. Preparation is explicit; external verification using published Occipital is separately reported and runs only for pi-tidy-ui releases.
- Baseline and a second exact Pi release execute the complete applicable Pi-dependent coverage, including types, SDK/GC and physical CLI/replay, with matching host/module identities and reproducible prepared inputs.
- Existing assertions, real native/third-party execution and delivery acceptance are retained or explicitly replaced by equivalent controls with a written mapping.
- No source manifest/lockfile mutation for host switching, user-setting changes, global Pi installation, daily workflow, publication or unapproved production compatibility fixes.
- Required checks and independent review pass; limitations and any unresolved failures are reported explicitly.

## Planning review disposition

An independent fresh-file review found one P2 wording defect: the initial execution rule prohibited all installation while the consumer phase required real installation under test. The finding was confirmed against `tests/fixtures/installed-occipital.mjs:58–64` and accepted. Decision 1 now prohibits acquiring missing harness dependencies, but explicitly permits disposable consumer installation exclusively from prepared inputs through fixture-local endpoints. Parent re-read confirmed consistency with phase 5.

The review found no other material coverage omission, unsupported architectural commitment or scope expansion in the original proposal. The operator subsequently settled the Occipital source/release boundary documented above; references to preserving ordinary public-delivery CI cadence were removed, and same-commit artifact provenance is now explicit across preparation, consumer fixtures, version runs and acceptance. This policy update was parent-reviewed for consistency; it is not a claim of a second independent review.

The review above concerned the plan only; no implementation or compatibility evidence existed at that point. The operator subsequently requested implementation of this plan. Implementation results must satisfy the gates above and are recorded separately; planning approval is not test acceptance.
