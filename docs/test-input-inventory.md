# Test input and coverage inventory

Baseline audit: `b8bf644435db17d586ba2bc6f93ef64cb900c6bd`. This is the migration map for `test-harness-plan.md`, not a passing-test report. Source inspection distinguishes fixture-controlled configuration tests from ambient-input leaks.

## Node suites (every baseline test file)

| Tests (`tests/`, suffix `.test.ts` unless shown) | Reads / commands / resources | Target isolation and retained gate |
| --- | --- | --- |
| `unit`, `component-layouts`, `queued-cards`, `spinner-scheduler` | Selected Pi SDK/TUI and deep host modules; real Node GC probes; Git repositories/watches; temp files; terminal widths | Materialized selected-host tree, controlled process before imports, declared Node/Git/PATH, GC by construction; retain first-owner collection, stock/layout/cursor and real Git controls |
| `syntax-card-display`, `syntax-card-lifecycle`, `syntax-cards`, `syntax-entry`, `syntax-host`, `syntax-paint`, `syntax-pi`, `syntax-runtime`, `syntax-sources`, `syntax-work` | Pi SDK/theme internals; timers; source/native fixtures; temp/session files; GC | Same host graph for source and tests, owned temp/config roots, required GC; exact native/Pi/classifier/source/cache/owner counters unchanged |
| `occipital-menu`, `occipital-pi-bridge`, `occipital-profiles` | Pi public dialog/TUI classes; optional menu-only alternate graph; GC | Remove single-module recompilation/environment switch; whole selected-host strict types + public class behavior; descriptor identity assertions |
| `occipital-bootstrap`, `occipital-client`, `occipital-controller`, `occipital-discovery`, `occipital-provider`, `occipital-ranges`, `occipital-retention`, `occipital-protocol` | Fixture clients/clock/data, native package/cache/config fixtures; optional SDK; GC; platform paths | Real filesystem/SDK integration where already used; test-owned HOME/cache/cwd; injected scenario inputs stay explicit; no user-service discovery |
| `occipital-factories`, `occipital-native` | Actual helper process, executable bytes/hash, protocol IO, config, owner cleanup | Required verified same-source helper, isolated env/cwd, no helper-present skip; preserve actual close/reap/limits/parser counters |
| `occipital-stdio`, `occipital-shared`, `shared-fixture-ownership` | Real fixture subprocess + installed locked subc SDK; transport pushes/close/GC | Controlled parent/child environment and selected Node; retain transport/lifecycle and GC probes; fixture shared transports are not an external user's host |
| `occipital-native-delivery` | Disposable native archive/cache, local filesystem, injected download fixtures, cwd changes | Owned files/cache and explicit paths; inert historical/synthetic release declarations are not executed published helpers |
| `debug-log`, `session-logging`, `settings` | Child Node, fixture HOME/env, session files, logs, timers | Fresh sanitized parent tree; children receive fixture-controlled state; tests of HOME/settings changes remain intentional inputs; no user settings/logs |
| `naming`, `test-filtering`, `test-fixtures` | Repository source, real Bash/Node child, explicit timing/skip fixtures | Materialized source snapshot and declared tools; focused skip behavior itself remains tested, not used to omit required input coverage |
| `npm-preparation`, `makefile` | npm/Git/Bash/Make subprocesses, fixture tool binaries, timing projection, mutable process env | Declared real tools; fixture-owned npm/Git configs/cache; fake Make tool scripts remain intentional command-observation fixtures; no raw npm logs in artifacts |
| `native-release.test.mjs`, `extension-release.test.mjs`, `npm-release.test.mjs`, `release-version.test.mjs`, `release-ci.test.mjs` | Real npm pack/config, tar, Git fixture histories, release scripts/workflow source; injected publication callbacks | Packaging/release regression profile with prepared tools and sanitized configuration; no actual publication. Update routing assertions to release-only published verification; retain six-platform packaging/notice/hash/version controls |
| `terminal.test.mjs` | Real selected Pi CLI through Python PTY, physical xterm cells, offline scripted traffic, real built-in tools, sessions/replay, Git, eleven third-party packages | Required prepared locked integration graph, per-terminal HOME/agent/work/config, explicit Node/CLI/Python/Git, fixture-only commands; preserve stock/off/on comparisons, task renderers, exact traffic/result/replay counts |
| `syntax-terminal.test.mjs` | Same PTY harness, actual helper + isolated supplied shared host, native source counters, stage copies, logging/reopen | Import support without registering broad terminal tests; required same-source helper/shared-host input; preserve physical styles, interrupted/reopened calls, actual shared peer/lifecycle controls |

New harness/profile/registry regression files belong to ordinary hermetic Node coverage, not public delivery acceptance. Pure Node/release tests do not require repeated Pi-version runs except where they exercise selected Pi code.

## Fixtures and process boundaries

- `cache-probe.ts`, `cache-partition-probe.ts`, `component-layout-probe.ts`, `queued-gc-probe.ts`, `spinner-gc-probe.ts`, `shared-import-gc.ts`: executable child probes, selected Node/host graph and required GC; no ambient cwd/module search/config.
- `driver.ts`, `presentation-driver.ts`, `editor-driver.ts`, `footer-driver.ts`, `foreign-editor.ts`, `logging-driver.ts`, `queued-driver.ts`, `syntax-driver.ts`, `terminal-colors-driver.ts`: test-owned real extensions loaded only into the selected isolated CLI. Scenario variables/fixtures are explicit; user extensions/auth/themes are never source inputs.
- `pty_bridge.py`: real PTY bytes/resize and process lifecycle; declared absolute Python, selected Node + CLI argv, owned cwd/env. Keep OS/PTY behavior real.
- `integration-profile.mjs`: formerly reads `~/.pi/agent/settings.json` and installed package versions. Replace with exact audited manifest/lock and prepared package directory. Keep AFT/keep-awake exclusions and actual two-call local task execution/replay.
- `shared-syntax-host.mjs`: spawn only a supplied hash-verified host and current helper with owned runtime/themes/config/connection files; never discover a user's service.
- `occipital-stdio.mjs`: inert local subprocess scenarios with explicit mode/environment; not a replacement for actual-helper cases.
- `await-fixture.ts`: fixture wait ownership only, no external dependencies.
- `npm-preparation.ts`: real npm helper with explicit environment/config/executable; preserve safe diagnostic projection only.
- `installed-occipital.mjs`: ordinary real npm install/omit, same-source native npm/raw bytes, local registry/download endpoints, cold/warm/source counters and actual reaping. Full transitive archive closure is prepared first. No public release selection.
- Existing networked installed-consumer control is preserved separately as `published-occipital.mjs`, only in pi-tidy-ui release verification; it does not count as a hermetic test.
- `occipital-release-0.1.4.json`: inert historical metadata fixture for staging/validation assertions, not permission to execute a published binary during ordinary testing.

## Rust/native platform coverage

Cargo auto-discovered integration targets are `actor`, `admission`, `admission_no_intern`, `admission_structural`, `catalogue`, `control`, `engine`, `frame`, `ingress`, `long_lines`, `payload_lifetime`, `reply`, `request`, `resource_policy`, `scheduler`, `service`, `stdio`. Retain all workspace unit/integration/doctests.

Most are in-memory actor/parser/resource tests. `catalogue`, `control`, and `stdio` create real filesystem/process fixtures: replace repository `target-catalogue` and PID-only temp roots with unique owned `TIDY_TEST_ROOT` cases; clear subprocess environments and explicitly supply recursive probe markers, platform configuration and actual Cargo executable. Keep real Syntect atom/XDG/HOME behavior.

`engine_probe` GNU allocator check retains actual `getconf GNU_LIBC_VERSION`/allocator API and declared absolute executable. `cargo fmt`, all-target strict Clippy, release build, glibc baseline verification and actual-built-helper protocol smoke remain gates. Prepare pinned Rust 1.99.0 and locked dependencies in an owned Cargo home; execution is offline. Docker image/toolchain acquisition is preparation; GNU test execution remains network-disabled.

## Entry points and source authority

- npm: `check`, `test`, `test:terminal`, `test:syntax-terminal`, `test:native-release`, `test:installed-native`; all route to prepared context, with direct test files rejecting missing bootstrap.
- Make: JS/SDK checks/tests, Rust/fmt/Clippy, native build/smoke, GNU ordered checks. Never use a merely present colocated helper as evidence of current source.
- `.github/workflows/ci.yml`: selected-host SDK/type and terminal/artifact checks, extension release path.
- `.github/workflows/occipital.yml`: six-platform native build/test/notice/runtime matrix, two Node consumer observations; ordinary consumers use the just-built artifact. Published checks only when invoked for pi-tidy-ui release, never main/PR or Occipital release.
- `scripts/release/linux-gnu.sh`: preserve real glibc 2.28/architecture/offline compiler gates with explicit provisioned paths/stores.
- `scripts/release/installed-linux-gnu.sh`: published consumer container is release-only; ordinary consumer needs prepared current build and local archives, without public egress.
- Occipital publication workflow remains publication infrastructure, not a hermetic test. No publish/tag/push authorization is implied by refactoring its inert regression tests.

## Verification mapping

Focused environment/descriptor/cleanup/wrong-commit/missing-input tests first; relevant Node cases and strict selected-host types next; actual native and Rust suites; local consumer under OS-enforced egress denial; full terminal/syntax/profile/replay last. Repeat Pi-sensitive coverage on 1.0.0 and explicit 1.2.0, then 1.0.0 again. Compare actual coverage and semantic counters under clean and polluted parents; platform inapplicability and every failed/unrun requirement remain explicit. No daily workflow or product compatibility fixes are authorized.
