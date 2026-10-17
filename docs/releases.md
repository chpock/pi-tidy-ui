# CI and release versions

The extension and Occipital have independent release versions. Repository manifests use `0.0.0`: root `package.json`/`package-lock.json`, and the Occipital Cargo manifest/lock entry. Native npm templates retain their substitution marker until staging.

## Supported platforms

The current support policy covers five OS/architecture combinations:

| Operating system | Architecture |
| --- | --- |
| GNU Linux, glibc 2.28+ | x64 |
| GNU Linux, glibc 2.28+ | ARM64 |
| macOS | x64 |
| macOS | ARM64 |
| Windows | x64 |

The installed Pi/Node host's OS, kernel and CPU requirements also apply; a successful hosted runner is not proof of a minimum OS version.

**Windows ARM64 is temporarily unsupported for the entire pi-tidy-ui extension**, not just Occipital or syntax highlighting. An existing package or native binary that installs or runs there does not establish current support. This policy does not by itself introduce an installation/startup block or change already-published packages.

### Why Windows ARM64 support is suspended

After correcting redundant consumer preparation and Windows temporary-storage placement, the [Windows-only verification run](https://github.com/chpock/pi-tidy-ui/actions/runs/38832045793) at commit [`f547aff`](https://github.com/chpock/pi-tidy-ui/commit/f547aff6a8af72d8220bae358bc8c5ee9e0d949f) passed all retained functional checks but measured:

| Current-source helper/consumer step, including preparation | Node 22.19.0 | Node 26.7.0 |
| --- | ---: | ---: |
| Windows x64 | 1:12 | 1:18 |
| Windows ARM64 | 9:12 | 8:43 |

These are step wall times, **excluding earlier native compilation**, not whole-workflow or billing figures. They are observations from one hosted run, not a universal Windows/ARM performance ratio. The earlier x64 steps took 14:13 each; those avoidable harness costs were fixed before making this support decision.

On ARM64, the selected-host dependency installation plus the two mandatory independent consumer installations alone took **6:27–6:52 per Node profile**. The two consumer installations accounted for 4:13–4:16 of that subtotal. Removing the remaining copy/archive overhead cannot alone meet the practical 2–3-minute verification target. The target allows justified variation; roughly nine minutes on each runtime is not a small variation. Both Nodes ran natively as ARM64, not through x64 emulation. Real optional-package/omission, cold/warm download, incremental classification and process-cleanup controls were preserved; no timeout was raised.

The residual cost is concentrated in installation fetching/unpacking on the hosted ARM64 environment. The measurements do **not** isolate a particular filesystem, scanner, CPU or GitHub runner defect. This is a temporary cost-based support decision, not evidence that the extension is functionally broken on ARM64. Reconsider it when real hosted installation performance improves; re-enablement requires the unchanged functional/cleanup controls and acceptable complete verification time on both Node profiles, not merely new runner release notes or a successful smoke test.

### Implementation and historical release boundary

`scripts/release/platforms.mjs` is the single platform catalogue. Windows ARM64 remains fully described but disabled by default. Set the repository Actions variable `CI_WINDOWS_ARM64=true` to include its existing build and release inputs again, with minimum-Node consumers for ordinary events and both-Node consumers for releases; absent/`false` excludes it, and any other value fails planning. Compilation, consumers, release assembly and generated native dependencies use the same selected targets. Enabling that platform does not by itself establish restored support: both runtime profiles and complete release admission must pass.

Published artifacts/tags remain immutable, including existing Windows ARM64 binaries. Do not delete or substitute them. Admission validates the identities and public raw/npm bytes actually declared by the selected public release, and requires current CI equality for every enabled platform. Generated extension dependencies include only those enabled platforms; no stale ARM64 CI binary is invented when it is disabled. No installation/startup prohibition is introduced.

## Version and publication routing

| Ref | CI version substitution | Publication |
| --- | --- | --- |
| Branch / pull request | Extension remains `0.0.0`; daemon uses the nearest reachable `occipital-v*` version | None |
| `pi-tidy-ui-v0.2.0` | Extension release version; daemon uses the nearest reachable `occipital-v*` version | Admitted npm tarball prepared and checked; npm publication remains a commented placeholder |
| `occipital-v0.1.0` | Only the daemon Cargo manifest/lock entry, **before compilation** | Occipital GitHub Release, followed automatically by native npm publication |

Tags must contain a complete SemVer version. Prerelease tags such as `occipital-v0.1.0-rc.1` produce prereleases. CI substitutions affect disposable checkouts, not repository commits or dependency versions. The npm package is named `pi-tidy-ui` and the command is `/tidy-ui`; tags select versions without changing these identities.

## Extension delivery

The operator selected the extension's **own package version** as the only local/published discriminator: exactly `0.0.0` is development; a real release version uses the published-package contract. This does not compare the extension version with the daemon version. `0.0.0` is reserved for development, not a production extension release. No `.git`/path/install-method heuristic, environment override or extra mode flag is required.

Development uses only `occipital` (`occipital.exe` on Windows) in the extension root, never shared discovery, a release cache, native npm payload or download. Resolve that directory from the extension, not the current project cwd or `PATH`; building the binary is the developer's explicit action. If it is missing, the UI warns with a `[pi-tidy-ui]` prefix, and Occipital is not used. Files retain exact cached Pi-core highlighting; Bash retains whole-command `toolTitle` coloring. Existing protocol/capability checks and owned-process cleanup still apply to the local build. Published packages keep shared-first selection.

Keep concrete native package versions out of the repository `package.json` and `package-lock.json`. During extension release preparation, select the nearest `occipital-v*` tag once, verify the published artifacts/native npm packages and compatibility, then generate exact optional native dependencies and matching version/URL/SHA-256/size metadata in the disposable release package. Do not commit those generated native pins or change the source lockfile. The installed archive remains fixed; no runtime Git/latest lookup is introduced. Consumer lockfiles may record the resolved native versions.

Select the nearest reachable `occipital-v*` by Git history from the built commit (the commit of `pi-tidy-ui-v*` for an extension release), using `git describe --tags --match 'occipital-v*' --abbrev=0`, not maximum SemVer or publication time. Complete history and tags are required. A malformed nearest tag, missing release or missing required native npm package stops preparation; never silently choose an older release. Development without a usable colocated binary falls back without downloading or compiling. See [the accepted delivery revision](syntax-highlighting-plan.md#accepted-localpublished-delivery-revision).

`src/occipital/release.ts` is an unpinned source template. `scripts/release/extension-release.mjs` prepares a real-version package after release admission; its lower-level staging helper also creates isolated test packages. Neither modifies repository manifests/lockfiles nor publishes the extension. The npm package is `pi-tidy-ui`; its public command is `/tidy-ui`.

## Compiler and release equality

`rust-toolchain.toml` pins Rust **1.99.0**, the compiler used for published Occipital `0.1.4` on all six platforms. Native CI resolves that exact version from the file rather than following `stable`; compiler upgrades are explicit reviewed changes. Repository Cargo manifests keep `0.0.0`, but disposable CI checkouts stamp the nearest daemon tag before compilation so embedded version text alone does not change an otherwise identical executable. On an Occipital tag, the tag itself supplies its release version even when multiple tags share a commit.

When both products change, complete the Occipital GitHub/native npm release before releasing the extension. The extension-release barrier compares every platform's raw CI executable with the selected published Occipital artifact, including SHA-256/size, and verifies the declared npm archives and their contained executables. Current CI equality and generated pins cover every enabled platform. It does not block ordinary CI or independent daemon releases merely because new native code has changed the bytes. Fixed Rust plus reproducible Windows linking produced identical raw files on all six platforms in independent cached/clean builds. Hosted C compilers/linkers/SDKs can still change: a future mismatch fails admission visibly rather than treating source equality as proof or normalizing bytes.

The first versioned six-platform run reproduced published `0.1.4` byte-for-byte on GNU Linux and macOS (both architectures), but each Windows executable differed in 28 bytes confined to PE timestamps and its CodeView GUID. Windows target flags now pass `/Brepro` to the MSVC linker to request deterministic metadata; CRT static linking and native runtime/import checks remain unchanged. This option is described by [LLVM's deterministic-build guidance](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html), but is not a documented Microsoft linker compatibility guarantee. Independent cached/clean builds established identical complete files on all six targets. Compare raw complete files without stripping, replacing metadata or accepting a normalized hash. The published `0.1.4` remains immutable; `0.1.5` delivers the deterministic Windows correction, and its six native npm packages are public with provenance.

Manual CI dispatch has an optional `clean-native-build` control, default `false`. It disables only restoration/saving of Cargo build outputs, preserving all native tests/lint/ABI/protocol and installed checks. Compare its fresh raw binaries with ordinary CI and the published release to establish the equality prerequisite; no tag or publication is needed. Ordinary CI retains its compilation cache.

## Workflow relationship

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, both tag families, ordinary manual dispatch and a best-effort **03:23 UTC** nightly schedule. `scripts/test/ci-plan.mjs` plans fixed event obligations, never source-impact/diff routing or maintainer-approved narrowing. Every job uses one exact tested source SHA: PR HEAD for a pull request and the pushed commit for a push. Ordinary and extension-tag type/unit/SDK/GC and physical CLI jobs select **Node 22.19.0 and 26.7.0 × minimum Pi 1.0.0 and npm dist-tag `latest`, resolved once and pinned to one exact version per workflow** (de-duplicated when equal). Invalid/unavailable latest metadata fails planning without an older fallback. Each profile prepares its coherent CLI/SDK/TUI graph; an alternate executable with baseline SDK imports is not compatibility coverage.

Preparation owns networking, locked dependency resolution, toolchain provisioning and current-source artifact admission. Execution uses `scripts/test/run.mjs --inputs ABSOLUTE_INPUTS --suite NAME`, a fresh sanitized process tree and owned runtime/config/cache roots outside checkout ancestry. Source edits invalidate the descriptor. Required native, GC, shared-host and integration inputs fail setup instead of selecting skips. npm/Make route to this same interface; see [testing commands](testing.md#requirements-and-commands).

Every ordinary `main` push, PR and manual dispatch runs **all enabled native platforms and one minimum-Node/minimum-Pi current-source consumer per target**, plus complete `unit` and types on every Node/Pi profile. Complete CLI runs on Linux x64 / minimum Node / latest Pi; each other profile runs one fixed physical smoke/editor compatibility union, not every dedicated physical scenario. `unit` includes all ordinary harness and Pi-sensitive `harness/packaging` tests; inert delivery runs separately once per Node/minimum Pi. Every complete CLI profile runs `--suite cli --shard I/4` in four exhaustive, disjoint partitions, without file/group/pattern/skip/layer narrowing. Secondary ordinary profiles run `--suite cli-compatibility` once, unsharded, rejecting those same filters and shard arguments; selection reads all tests under the existing smoke/editor folders, without a filename registry. Compatibility-role names and reports distinguish this shorter coverage. New tests are discovered recursively by structural role, not registered in filename lists. Provisioning native/shared/profile prerequisites from discovered categories does not select away tests. The 2–3-minute feature-loop target is **local only**, not a full-CI budget; local feature/group options never narrow CI.

Nightly runs only exact-latest Pi compatibility on both Nodes: types, all `product/` and `integration/` tests plus Pi-sensitive `harness/packaging`, and the complete four-shard CLI union. Its Linux x64 Pi-free native producer supplies a same-source helper prerequisite, not a native-delivery matrix. There are no minimum-Pi profiles, native consumer jobs, other-OS builds or inert/public delivery jobs in nightly. It has distinct concurrency and a `Nightly latest-Pi result` check, separate from `Complete CI result`. The required final result is green only when every planned branch/matrix succeeds; failure, cancellation or required skips cannot be hidden by nonapplicable branches or a later commit. GitHub's schedule is best-effort, not an execution-time guarantee.

Occipital push tags retain both-Node/minimum-Pi consumers on every enabled platform, once-per-Node/minimum-Pi inert delivery, and a mandatory **daemon-regressions** branch on both Nodes/minimum Pi: all `integration/native` and Pi-sensitive `harness/packaging`. Publication waits for these checks as well as platform gates; unrelated UI/CLI profiles and latest resolution are omitted. Extension push tags retain the complete Node/SDK/types and full CLI matrix, both-Node/minimum-Pi consumers on every enabled platform, public native admission/consumers and extension packing, not actual extension npm publication. The ordinary runner-budget reductions do not narrow either release kind. Manual/scheduled execution cannot confer push-tag publication authority. See the [fixed CI obligations](testing.md#fixed-ci-obligations). No automatic lockfile update is introduced, and defining this graph is not hosted-run acceptance.

Linux extension/terminal/inert-fixture jobs invoke `--network-isolated` with declared bubblewrap. The harness regression verifies actual local HTTP (one request), denied public socket connection (`ENETUNREACH`) and trusted connection-file ancestry. This restriction covers the spawned process tree, not just a JavaScript fetch function. Native GNU execution uses Docker `--network=none`. Non-Linux native CI uses prepared-local inputs and sanitized environments, but currently lacks equivalent OS-level egress-enforcement validation; do not infer equal enforced isolation or passing platform acceptance from the workflow matrix.

Shared syntax CLI coverage requires the explicitly provisioned official **Subconscious 0.20.83** host. Linux x64 preparation downloads `ck-subc-linux-x64.zip` and verifies SHA-256 `c905fd8c5eba045c38fb61dd0c6c0ffc8254ae2cb0be50ef1017cde5470e62c4` before admitting the extracted executable hash. This is a third-party prerequisite, **not published Occipital**. The fixture runs it with no arguments, private XDG configuration/runtime/connection files and the same-source Occipital module, never an installed service. Shared discovery, actual loss and owned-to-shared return retain strict traffic/peer counters and process reaping; host provisioning alone does not prove those controls passed.

The reusable `.github/workflows/occipital.yml` performs only native production: Rust correctness, pipe protocol, parser-affinity doctests, formatting, strict Clippy, release build and staging. `prepare-native.mjs` materializes the verified neutral source and explicit tools without installing Pi/npm dependencies or copying a Cargo cache. Linux x64 has an independent producer so product SDK/CLI feedback does not wait for other platforms. The existing native descriptor/bootstrap and Node test runner execute every test under `tests/native-build/` before source stamping, including the real positive/neutral `checkCargoAncestry` once in each producer (under bubblewrap on Linux). `test:rust-harness` and its Make counterpart require that descriptor, not general Pi inputs. Consumer jobs install neither Rust nor an MSVC build environment. Each other platform runs its own `occipital-platform.yml`: its producer immediately unlocks `occipital-consumer.yml` for the event-selected profiles (minimum Node ordinarily, both Nodes in parallel for releases). Those consumers do not await other platform builds. Pi-independent packaging/version regressions run once per Node, not once again in native production. Provision Rust **1.99.0** plus rustfmt/Clippy and locked Cargo dependencies before execution, using owned artifact stores without user Cargo config. Declared Rust test/build commands execute offline; `rust-check` orders fmt before Clippy. Version stamping affects only the verified neutral source copy before compilation. After staging, CI verifies that the original checkout is unchanged before commit-only artifact admission.

GNU jobs run format/correctness/allocator/Clippy checks, locked release build and ELF glibc admission inside pinned multiarch AlmaLinux 8 userspace, asserting glibc 2.28 and native architecture. `scripts/release/linux-gnu.sh` receives an explicit provisioned Rust sysroot, official Node 22.19.0 and owned fetched Cargo artifacts. Compilation/testing is network-disabled; `_gnu-native` is an internal ordered gate, not a standalone host-baseline command. **Staging is separate:** CI stages version/source/notices/hash metadata for the exact executable, verifies that neutral-copy stamping left the original checkout unchanged, prepares the staged current-commit artifact, then runs actual-helper smoke and the current consumer on each event-selected Node version. No published helper is used for this smoke. Required ELF symbol versions above 2.28 fail admission; optional weak versions do not create a loader prerequisite. Both native architectures must pass before release acceptance. Published `0.1.4` uses this baseline; earlier `0.1.3` GNU binaries still require glibc 2.34 and remain immutable. A source-policy change cannot upgrade their bytes. Containers prove userspace compatibility, not an older kernel.

Windows uses `crt-static` for both MSVC targets, including the locked Oniguruma C build through `cc`, and `/Brepro` deterministic linking. Jobs provision `llvm-tools-preview` and inspect normal/delayed executable imports before staging, refusing compiler-runtime DLL requirements or missing/failed inspection output. System Windows DLLs remain valid dependencies. Static runtime security updates require rebuilding/releasing Occipital; published `0.1.2` remains unchanged. Platform compiler/SDK inputs remain prerequisites; matrix presence is not evidence that all six hosts passed or a minimum-OS guarantee.

Disposable hosted CI preserves the exact effective `CARGO_HOME` exported by Rust setup: dependency-source paths can survive stripped release builds. Before Cargo starts, the workflow verifies the store is inside the declared hosted setup roots and contains no root configuration or credentials; unexpected state fails without reading or deleting it. Only registry/Git artifacts and build outputs are cached. Compiler-cache keys include native source hashes and restore only compatible compiler/lock/target prefixes, so changed source can save its updated outputs. Product jobs cache the actual owned npm `_cacache`, not unused user npm state. Local preparation still uses its own Cargo home. Both direct and GNU/Make environments select `RUSTUP_TOOLCHAIN` by the absolute pinned Rust root so Cargo-home Rustup proxies do not need user defaults. Preserving this path is not proof of all-platform current/public byte equality; the unchanged release admission remains authoritative.

The only Actions uploads are one-day native staging transfers required by downstream jobs. A producer retry replaces its own same-run transfer by name; no published release asset is replaced. Transfer names are unique per version/platform and only that producer writes them. Transfers contain: raw executables, native npm package staging, SHA-256/size metadata, source commit identity, LICENSE and third-party NOTICE inventory. No diagnostics, test results, screenshots, development tarballs or publication receipts are uploaded. Safe summaries stay in logs; raw npm logs, environment, commands, URLs and opaque error text are excluded from diagnostic projections. Existing stored artifacts are not deleted by this policy. Real current-source consumers already pack the extension; full product jobs do not repeat a development pack. Durable distributables belong only in GitHub Releases/npm. `Cargo.toml` already uses `strip = true`, with release debug information disabled by default; no debug binaries or new debug build mode are introduced. Staging/notice preparation uses the job-owned runner temporary directory, outside cached Cargo `target/`; restored compiler outputs must never restore an old release destination. Every resolved build/target dependency is fetched for the notice inventory; missing texts fail staging. The maintained Subconscious supplement copies original LICENSE bytes from exact crate source commits. `.gitattributes` disables checkout newline conversion only for the project's `LICENSE` and maintained supplementary notice texts, preserving these bytes on Windows.

GNU jobs cache only the public system-tool image separately from Cargo outputs. Its exact key includes native platform and Dockerfile hash/base digest, without recipe fallback; invalid archives fail visibly and misses rebuild. No source tree, Rust SDK, native output or credentials are baked into that image. Its Git/Node runtime prerequisites are tooling, not delivered Occipital dependencies. `clean-native-build` disables Cargo build-output caching, not tests, artifact admission or consumer gates.

Ordinary CI wires every enabled native platform to the **current-source consumer** on minimum Node/minimum Pi; releases retain both Node versions, including Occipital tags. Nightly omits consumers. Only the number of ordinary Node profiles changes; consumer assertions and both fresh installation modes remain intact. `prepare.mjs --archives --native-artifact ...` supplies the exact staged commit/nativeTree executable and integrity-checked transitive package archives. The ordinary `consumer` contract uses real npm, a fixture-local registry/download server and fresh consumers; optional-package installation and the raw cold-download endpoint must serve the same current-source bytes. Preserve zero optional bootstrap downloads, exactly one cold fixture download without optional packages, zero warm HTTP, UTF-8/incremental counters and owned-process cleanup. A successful local consumer is not public npm/GitHub delivery acceptance.

GNU consumers use `scripts/release/installed-linux-gnu.sh TARGET SUITE PREPARATION ARTIFACT [RELEASE_REF]`. `native`, `consumer` and the combined `native-consumer` execute with `--network=none`; re-preparation uses explicit `--offline --npm-cache` inputs inside the baseline container. Online closure preparation uses lock-only resolution plus fresh-cache `npm ci --dry-run`; offline closure preparation replays the frozen locks with `npm ci --dry-run`, not materialized consumer `node_modules`. Both validate the exact graph/peers and every required archive; zero preflight unpack is a fixed-graph control, not a universal npm guarantee. The fixture retains two independent actual `npm ci` installs and all optionality, native-counter and cleanup controls. Only the later mandatory fresh installs establish installability and actual SDK/native behavior; preparation success alone does not. Non-Linux execution uses the prepared runner directly, with the enforcement gap noted above. Each consumer gets a fresh home/native cache; prepared npm package data does not replace cold/warm assertions. The combined `native-consumer` entry shares one offline preparation per Node, then invokes the native and consumer runners separately with fresh execution roots. Safe projected npm/fixture summaries are printed to job logs; diagnostics, receipts, screenshots and test results are never uploaded.

Published Occipital checks are a **separate external verification**: `published-consumer` / `test:installed-native:published`, with an explicit `--release-ref refs/tags/pi-tidy-ui-vVERSION` identifying the tested commit. Only extension push tags run this public npm/GitHub delivery lane, on both Node versions across the native platform matrix. It deliberately needs public networking and does not count as hermetic acceptance. CI never runs it for main/PR, Occipital releases, nightly compatibility or manual dispatch merely pointing at a tag. Ordinary tests must not fall back to public binaries if preparation fails.

On an Occipital push tag, CI passes the same-run, same-commit, tag-versioned artifacts to `.github/workflows/occipital-release.yml`, without a second build or historical-run lookup. Branch artifacts may carry the nearest tag's compiled version without being that published release: source authority and raw hashes govern admission. Extension tags do not publish Occipital; daemon tags do not publish/change the extension. The selected GNU floor is glibc 2.28 on both architectures, in addition to Pi/Node kernel/CPU/OS prerequisites.

## Execution timeouts

Every runner job has an explicit `timeout-minutes`; matrix entries each receive the same job-specific bound. Reusable-workflow callers do not accept this setting, so their executable jobs own it.

| Job | Minutes |
| --- | ---: |
| Ref/version and workflow lint | 5 |
| Required complete/nightly result | 5 |
| Prepared SDK, inert delivery or daemon regressions | 10 |
| Native checks, cold Rust build and artifact staging | 60 |
| One platform/Node consumer job | 25 |
| Each complete physical CLI partition or unsharded physical compatibility profile | 30 |
| GitHub Release assembly and publication | 10 |
| Automatic native npm publication | 15 |
| Extension release admission and generated package | 15 |

The unit/SDK/GC step also has a five-minute limit within its ten-minute job. Current-source and extension-release-only published-consumer steps have fifteen minutes each within the twenty-five-minute platform/Node consumer job; npm commands have a five-minute bound, not relaxed native source/classification deadlines. Time limits are configured bounds, not evidence that required jobs passed. Expiry stops the process or cancels the job; it does not bypass assertions or trigger a successful retry. Job execution timeouts do not bound waiting for a runner. Interrupted release publication can leave a draft; the existing inspection/no-overwrite rule below still applies.

## Published assets

The release workflow checks every enabled platform artifact's source commits, versions, targets, raw executable hashes/sizes, URLs and notice inventories before publication. It uploads:

- `occipital-vVERSION-TARGET` raw executables (`.exe` for Windows);
- one common `NOTICE` covering every platform, plus the project's `LICENSE`;
- `native-release.json` with the exact version, platform URLs, SHA-256 and byte sizes;
- `SHA256SUMS` for every preceding asset.

The common `NOTICE` preserves each distinct platform inventory byte-for-byte and labels its covered targets; identical complete inventories appear once. Native npm packages retain their own platform `NOTICE`. This layout is used by `0.1.3` and subsequent releases; earlier published assets remain unchanged.

If absent, it creates a draft, uploads all files, then publishes it. A retry may reuse an already-published release only when tag/prerelease identity, exact asset names/sizes and every raw asset byte match the newly admitted same-source assembly; that branch performs no remote mutation. Drafts, changed/missing/extra assets and lookup/download failures stop publication without repair or overwrite. After a failed draft upload, inspect it before an explicitly authorized cleanup/rerun. It uses the job-scoped `GITHUB_TOKEN` with `contents: write`, not an npm token. Do not move published tags.

Creating/pushing a tag is a separate operator action. The tag-triggered workflows do not create tags, commit version changes or update `src/occipital/release.ts`. An Occipital tag automatically publishes its admitted native npm packages after GitHub Release success; it never publishes the extension. Extension release admission downloads/verifies the selected public family and generates its exact `NATIVE_RELEASE` only in the disposable package, independently of the extension's version and repository placeholders.

## Extension release preparation

On an extension tag, `extension-package` runs only after native, unit/SDK and physical CLI gates. It fetches the selected completed public release, compares current executables for every enabled platform and validates the declared public registry payloads, and stages the package only after every check passes. Changed bytes, missing assets, incomplete npm versions or a malformed nearest tag fail instead of choosing an older release. It packs an admitted tarball but does not upload it or grant npm publication permission. The future npm publish command is present only as a comment; no extension GitHub Release is created. The command takes explicit current/public artifact directories:

```sh
SOURCE_COMMIT=FULL_EXTENSION_COMMIT node scripts/release/extension-release.mjs \
  refs/tags/pi-tidy-ui-vVERSION CI_ARTIFACTS PUBLIC_ASSETS NEW_OUTPUT
```

`PUBLIC_ASSETS` includes the public release assets and `release.json` from the GitHub API. `CI_ARTIFACTS` contains every enabled platform's same-commit `occipital-vVERSION-TARGET` directories. The ref must resolve to the checked-out source commit. The generated package directory and `plan.json` are disposable release artifacts, not source files.

## Automatic native npm publication

`.github/workflows/ci.yml` calls `occipital-npm-publish.yml` automatically for a new Occipital push tag after all required build/consumer/delivery/daemon-regression gates and GitHub Release publication. It consumes the same-run staged artifacts, exact source SHA and selected targets; no cross-run download or rebuild occurs. The caller must be this repository's exact-tag `ci.yml` with matching workflow/source SHA and OIDC authority. PRs, branches and manual dispatches cannot publish. Transfers expire after one day: rerun failed jobs before expiry; missing transfers fail rather than selecting another build. Automatic native releases reject SemVer `+build` metadata in the initial version gate, before building or publishing GitHub assets, because npm removes it from the version. Stable/prerelease SemVer remains supported; no version aliases or rewrites are introduced.

The workflow compares every assembled executable, notice, license, metadata and checksum file with the already-public GitHub release. It validates every selected platform's package manifest, payloads and platform notices before packing, restores executable permissions lost by artifact ZIPs, and never runs package scripts. Future native manifests include the canonical `repository.url` required by npm provenance; already-published `0.1.4` packages remain unchanged.

Configure trusted publishing for **each** `@kchpock/occipital-*` package: GitHub owner `chpock`, repository `pi-tidy-ui`, workflow filename **`ci.yml`**, direct `npm publish` allowed, and no environment name (this workflow does not use one). Both caller and reusable workflow grant `id-token: write`. npm's [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/#troubleshooting) matches the calling workflow, not the nested file: existing publisher registrations must be updated to `ci.yml` before automatic publication can authenticate. The GitHub-hosted job installs exact npm `12.0.2` on Node `26.7.0` (npm 12's own Node requirements do not change the extension's Node 22.19.0 minimum). It uses short-lived OIDC authentication, not an npm token, approval command or bypass-2FA credential. Although npm normally generates provenance automatically with trusted publishing, the workflow explicitly passes `--provenance` to require generation and stop publication on generation failure. The provenance describes this verified-artifact packaging/publication workflow, not a source audit or proof of reproducible Rust compilation; the original Rust build's authority remains the checked source CI run/commit.

Before any upload, every selected registry version is inspected. An existing version is skipped only when its integrity matches the prepared archive; a mismatch or registry error stops the family before publication. Prereleases use `next`; stable versions retain npm's normal implicit-`latest` checks. After publication, each exact-version registry record and its raw tarball are read directly, refusing redirects and non-HTTPS/outside-registry archive URLs and bounding streamed bytes to the prepared archive size before accepting SHA-512 equality. Do not re-resolve the just-published version with `npm pack`: that returned `ETARGET` after a successful upload. An unavailable record/byte mismatch fails immediately; there is no delayed retry or republishing fallback. npm publication is not atomic: interruption can leave some packages public. Per-package receipts distinguish not-started, unconfirmed, published and already-published outcomes; an explicit rerun with identical artifacts skips matching versions instead of overwriting them. Safe per-package receipt projections appear in job logs, not Actions artifacts; plans and package staging are job-local only.

A staged version already occupies its package/version identity and cannot be published again through this workflow. The maintainer must approve it with 2FA; OIDC does not authorize stage approval. The manually approved `0.1.4` family is the first native npm delivery, not a reason to rerun publication or issue another daemon release. This workflow never publishes the root extension, changes tags, adopts another pin or dispatches itself.

## Local checks

```sh
npm run check -- --inputs /absolute/path/to/prepared/inputs.json
npm run test:native-release -- --inputs /absolute/path/to/prepared/inputs.json
npm run test:rust-check -- --inputs /absolute/path/to/prepared/inputs.json
node scripts/release/version.mjs --resolve refs/tags/occipital-v0.1.0
```

For local GNU baseline validation, use Docker on the corresponding native Linux architecture and explicitly provision the pinned Rust sysroot (including rustfmt/Clippy), official Node 22.19.0 and locked dependencies in an owned Cargo home without user config. Toolchain/dependency/image acquisition belongs to preparation; the execution container cannot fetch missing inputs. For example, after preparing native dependencies through `prepare.mjs --rust-root ... --build-native`:

```sh
RUST_ROOT=/absolute/path/to/rust-1.99.0 \
CARGO_HOME=/absolute/path/to/prepared/cargo-home \
NODE=/absolute/path/to/node-22.19.0/bin/node \
bash scripts/release/linux-gnu.sh x86_64-unknown-linux-gnu
# On a native ARM64 host, use aarch64-unknown-linux-gnu instead.
```

The wrapper owns native-architecture/glibc assertions, Docker image/cache and SDK mounts. Image construction may need networking; the execution container uses `--network=none`. Inside it, the Makefile's internal `_gnu-native` target orders fmt, workspace tests, the allocator diagnostic, strict lint, locked release build and ABI admission with `CARGO_NET_OFFLINE=true`. Actual-helper protocol smoke follows separate exact-artifact staging/preparation in CI, before the current consumer; it is not performed by `_gnu-native`. That target is not a standalone host-baseline check. The shared Make recipes also provide [local build/test shortcuts](testing.md#make-shortcuts); they do not replace release admission, stamping, same-run artifact authority or publication workflows.

The helper honors `CARGO_HOME` and `CARGO_TARGET_DIR`; use an isolated target directory for local experiments. It writes ordinary ignored Cargo/catalogue-test outputs as the invoking user, not root. The diagnostic-only `engine_probe` reports unavailable allocator data as `null` before glibc 2.33; no calibration mode is invoked by this gate.

The release regression suite uses tiny inert files: it checks independent version substitution, lock agreement, invalid tags, GNU symbol-version admission and native baseline wiring, Windows import policy, all-platform assembly and rejection of wrong commits/versions/targets/bytes/URLs or unresolved notices. It does not publish, launch a service, run a load calibration, or replace the real per-platform CI gates.
