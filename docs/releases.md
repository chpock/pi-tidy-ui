# CI and release versions

The extension and Occipital have independent release versions. Repository manifests use `0.0.0`: root `package.json`/`package-lock.json`, and the Occipital Cargo manifest/lock entry. Native npm templates retain their substitution marker until staging.

| Ref | CI version substitution | Publication |
| --- | --- | --- |
| Branch / pull request | Extension remains `0.0.0`; daemon uses the nearest reachable `occipital-v*` version | None |
| `pi-tidy-ui-v0.2.0` | Extension release version; daemon uses the nearest reachable `occipital-v*` version | Extension tarball in CI artifacts; no publishing workflow yet |
| `occipital-v0.1.0` | Only the daemon Cargo manifest/lock entry, **before compilation** | Occipital GitHub Release only |

Tags must contain a complete SemVer version. Prerelease tags such as `occipital-v0.1.0-rc.1` produce prereleases. CI substitutions affect disposable checkouts, not repository commits or dependency versions. The npm package is named `pi-tidy-ui` and the command is `/tidy-ui`; tags select versions without changing these identities.

## Extension delivery

The operator selected the extension's **own package version** as the only local/published discriminator: exactly `0.0.0` is development; a real release version uses the published-package contract. This does not compare the extension version with the daemon version. `0.0.0` is reserved for development, not a production extension release. No `.git`/path/install-method heuristic, environment override or extra mode flag is required.

Development uses only `occipital` (`occipital.exe` on Windows) in the extension root, never shared discovery, a release cache, native npm payload or download. Resolve that directory from the extension, not the current project cwd or `PATH`; building the binary is the developer's explicit action. If it is missing, the UI warns with a `[pi-tidy-ui]` prefix, and Occipital is not used. Files retain exact cached Pi-core highlighting; Bash retains whole-command `toolTitle` coloring. Existing protocol/capability checks and owned-process cleanup still apply to the local build. Published packages keep shared-first selection.

Keep concrete native package versions out of the repository `package.json` and `package-lock.json`. During extension release preparation, select the nearest `occipital-v*` tag once, verify the published artifacts/native npm packages and compatibility, then generate exact optional native dependencies and matching version/URL/SHA-256/size metadata in the disposable release package. Do not commit those generated native pins or change the source lockfile. The installed archive remains fixed; no runtime Git/latest lookup is introduced. Consumer lockfiles may record the resolved native versions.

Select the nearest reachable `occipital-v*` by Git history from the built commit (the commit of `pi-tidy-ui-v*` for an extension release), using `git describe --tags --match 'occipital-v*' --abbrev=0`, not maximum SemVer or publication time. Complete history and tags are required. A malformed nearest tag, missing release or incomplete six-package npm family stops preparation; never silently choose an older release. Development without a usable colocated binary falls back without downloading or compiling. See [the accepted delivery revision](syntax-highlighting-plan.md#accepted-localpublished-delivery-revision).

`src/occipital/release.ts` is an unpinned source template. `scripts/release/extension-release.mjs` prepares a real-version package after release admission; its lower-level staging helper also creates isolated test packages. Neither modifies repository manifests/lockfiles nor publishes the extension. The npm package is `pi-tidy-ui`; its public command is `/tidy-ui`.

## Compiler and release equality

`rust-toolchain.toml` pins Rust **1.99.0**, the compiler used for published Occipital `0.1.4` on all six platforms. Native CI resolves that exact version from the file rather than following `stable`; compiler upgrades are explicit reviewed changes. Repository Cargo manifests keep `0.0.0`, but disposable CI checkouts stamp the nearest daemon tag before compilation so embedded version text alone does not change an otherwise identical executable. On an Occipital tag, the tag itself supplies its release version even when multiple tags share a commit.

When both products change, complete the Occipital GitHub/native npm release before releasing the extension. The extension-release barrier compares every platform's raw CI executable with the selected published Occipital artifact, including SHA-256/size, and verifies all six npm archives and their contained executables. It does not block ordinary CI or independent daemon releases merely because new native code has changed the bytes. Fixed Rust plus reproducible Windows linking produced identical raw files on all six platforms in independent cached/clean builds. Hosted C compilers/linkers/SDKs can still change: a future mismatch fails admission visibly rather than treating source equality as proof or normalizing bytes.

The first versioned six-platform run reproduced published `0.1.4` byte-for-byte on GNU Linux and macOS (both architectures), but each Windows executable differed in 28 bytes confined to PE timestamps and its CodeView GUID. Windows target flags now pass `/Brepro` to the MSVC linker to request deterministic metadata; CRT static linking and native runtime/import checks remain unchanged. This option is described by [LLVM's deterministic-build guidance](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html), but is not a documented Microsoft linker compatibility guarantee. Independent cached/clean builds established identical complete files on all six targets. Compare raw complete files without stripping, replacing metadata or accepting a normalized hash. The published `0.1.4` remains immutable; `0.1.5` delivers the deterministic Windows correction, and its six native npm packages are public with provenance.

Manual CI dispatch has an optional `clean-native-build` control, default `false`. It disables only restoration/saving of Cargo build outputs, preserving all native tests/lint/ABI/protocol and installed checks. Compare its fresh raw binaries with ordinary CI and the published release to establish the equality prerequisite; no tag or publication is needed. Ordinary CI retains its compilation cache.

## Workflow relationship

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, both tag families and manual dispatch. It validates workflow syntax and resolves the ref. Extension type/unit/SDK/GC and physical CLI jobs select **Node 22.19.0 and 26.7.0 × exact Pi 1.0.0 and 1.2.0**. Each selection prepares its own coherent CLI/SDK/TUI dependency tree; selecting an alternate executable while retaining baseline SDK imports is not compatibility coverage. Pi-independent inert release fixtures do not need duplication across Pi hosts.

Preparation owns networking, locked dependency resolution, toolchain provisioning and current-source artifact admission. Execution uses `scripts/test/run.mjs --inputs ABSOLUTE_INPUTS --suite NAME`, a fresh sanitized process tree and owned runtime/config/cache roots outside checkout ancestry. Source edits invalidate the descriptor. Required native, GC, shared-host and integration inputs fail setup instead of selecting skips. npm/Make route to this same interface; see [testing commands](testing.md#requirements-and-commands).

The shorter `syntax-terminal` suite remains in ordinary PR/`main` and branch-dispatch CI for every Node × Pi selection. The expensive full `terminal` suite runs in CI only for validated `pi-tidy-ui-v*` extension release refs, including dispatch of such a tag. Both are required on extension tags; CI does not publish the extension. Local full terminal verification remains a final UI/integration gate, not each edit. Occipital tags skip unrelated extension checks, not native/current-consumer coverage. No future daily compatibility workflow, moving-version resolver or automatic lockfile update is implemented. Future compatibility execution must likewise use current-source Occipital, even when testing published Pi.

Linux extension/terminal/inert-fixture jobs invoke `--network-isolated` with declared bubblewrap. The harness regression verifies actual local HTTP (one request), denied public socket connection (`ENETUNREACH`) and trusted connection-file ancestry. This restriction covers the spawned process tree, not just a JavaScript fetch function. Native GNU execution uses Docker `--network=none`. Non-Linux native CI uses prepared-local inputs and sanitized environments, but currently lacks equivalent OS-level egress-enforcement validation; do not infer equal enforced isolation or passing platform acceptance from the workflow matrix.

Shared syntax CLI coverage requires the explicitly provisioned official **Subconscious 0.20.83** host. Linux x64 preparation downloads `ck-subc-linux-x64.zip` and verifies SHA-256 `c905fd8c5eba045c38fb61dd0c6c0ffc8254ae2cb0be50ef1017cde5470e62c4` before admitting the extracted executable hash. This is a third-party prerequisite, **not published Occipital**. The fixture runs it with no arguments, private XDG configuration/runtime/connection files and the same-source Occipital module, never an installed service. Shared discovery, actual loss and owned-to-shared return retain strict traffic/peer counters and process reaping; host provisioning alone does not prove those controls passed.

The reusable `.github/workflows/occipital.yml` runs inert packaging/version controls and native Rust correctness, pipe protocol, parser-affinity doctests, formatting and strict Clippy. It builds on six native platforms: GNU Linux x64/arm64, macOS x64/arm64 and Windows MSVC x64/arm64. Provision Rust **1.99.0** plus rustfmt/Clippy and locked Cargo dependencies before execution, using owned artifact stores without user Cargo config. Declared Rust test/build commands execute offline; `rust-check` orders fmt before Clippy. Version stamping affects only the verified neutral source copy before compilation. After staging, CI verifies that the original checkout is unchanged before commit-only artifact admission.

GNU jobs run format/correctness/allocator/Clippy checks, locked release build and ELF glibc admission inside pinned multiarch AlmaLinux 8 userspace, asserting glibc 2.28 and native architecture. `scripts/release/linux-gnu.sh` receives an explicit provisioned Rust sysroot, official Node 22.19.0 and owned fetched Cargo artifacts. Compilation/testing is network-disabled; `_gnu-native` is an internal ordered gate, not a standalone host-baseline command. **Staging is separate:** CI stages version/source/notices/hash metadata for the exact executable, verifies that neutral-copy stamping left the original checkout unchanged, prepares the staged current-commit artifact, then runs actual-helper smoke and the current consumer on each Node version. No published helper is used for this smoke. Required ELF symbol versions above 2.28 fail admission; optional weak versions do not create a loader prerequisite. Both native architectures must pass before release acceptance. Published `0.1.4` uses this baseline; earlier `0.1.3` GNU binaries still require glibc 2.34 and remain immutable. A source-policy change cannot upgrade their bytes. Containers prove userspace compatibility, not an older kernel.

Windows uses `crt-static` for both MSVC targets, including the locked Oniguruma C build through `cc`, and `/Brepro` deterministic linking. Jobs provision `llvm-tools-preview` and inspect normal/delayed executable imports before staging, refusing compiler-runtime DLL requirements or missing/failed inspection output. System Windows DLLs remain valid dependencies. Static runtime security updates require rebuilding/releasing Occipital; published `0.1.2` remains unchanged. Platform compiler/SDK inputs remain prerequisites; matrix presence is not evidence that all six hosts passed or a minimum-OS guarantee.

Disposable hosted CI preserves the exact effective `CARGO_HOME` exported by Rust setup: dependency-source paths can survive stripped release builds. Before Cargo starts, the workflow verifies the store is inside the declared hosted setup roots and contains no root configuration or credentials; unexpected state fails without reading or deleting it. Only registry/Git artifacts and build outputs are cached. Local preparation still uses its own Cargo home. Both direct and GNU/Make environments select `RUSTUP_TOOLCHAIN` by the absolute pinned Rust root so Cargo-home Rustup proxies do not need user defaults. Preserving this path is not proof of all-platform current/public byte equality; the unchanged release admission remains authoritative.

Native artifacts contain raw executables, native npm package staging, SHA-256/size metadata, source commit identity, LICENSE and third-party NOTICE inventory. Staging/notice preparation uses the job-owned runner temporary directory, outside cached Cargo `target/`; restored compiler outputs must never restore an old release destination. Every resolved build/target dependency is fetched for the notice inventory; missing texts fail staging. The maintained Subconscious supplement copies original LICENSE bytes from exact crate source commits. `.gitattributes` disables checkout newline conversion only for the project's `LICENSE` and maintained supplementary notice texts, preserving these bytes on Windows.

GNU jobs cache only the public system-tool image separately from Cargo outputs. Its exact key includes native platform and Dockerfile hash/base digest, without recipe fallback; invalid archives fail visibly and misses rebuild. No source tree, Rust SDK, native output or credentials are baked into that image. Its Git/Node runtime prerequisites are tooling, not delivered Occipital dependencies. `clean-native-build` disables Cargo build-output caching, not tests, artifact admission or consumer gates.

Every native platform is wired to run the **current-source consumer** on both Node versions, including Occipital tags. `prepare.mjs --archives --native-artifact ...` supplies the exact staged commit/nativeTree executable and integrity-checked transitive package archives. The ordinary `consumer` contract uses real npm, a fixture-local registry/download server and fresh consumers; optional-package installation and the raw cold-download endpoint must serve the same current-source bytes. Preserve zero optional bootstrap downloads, exactly one cold fixture download without optional packages, zero warm HTTP, UTF-8/incremental counters and owned-process cleanup. A successful local consumer is not public npm/GitHub delivery acceptance.

GNU consumers use `scripts/release/installed-linux-gnu.sh TARGET SUITE PREPARATION ARTIFACT [RELEASE_REF]`. `native` and `consumer` execute with `--network=none`; re-preparation uses explicit `--offline --npm-cache` inputs inside the baseline container. Non-Linux execution uses the prepared runner directly, with the enforcement gap noted above. Each consumer gets a fresh home/native cache; prepared npm package data does not replace cold/warm assertions. Only safe projected npm/fixture diagnostics are uploaded, not raw logs, commands, URLs, environment or error text.

Published Occipital checks are a **separate external verification**: `published-consumer` / `test:installed-native:published`, with an explicit `--release-ref refs/tags/pi-tidy-ui-vVERSION` identifying the tested commit. Only extension release tags run this public npm/GitHub delivery lane, on both Node versions across the native platform matrix. It deliberately needs public networking and does not count as hermetic acceptance. It never runs for main/PR, Occipital releases or future daily compatibility. Ordinary tests must not fall back to public binaries if preparation fails.

On an Occipital push tag, CI passes the same-run, same-commit, tag-versioned artifacts to `.github/workflows/occipital-release.yml`, without a second build or historical-run lookup. Branch artifacts may carry the nearest tag's compiled version without being that published release: source authority and raw hashes govern admission. Extension tags do not publish Occipital; daemon tags do not publish/change the extension. The selected GNU floor is glibc 2.28 on both architectures, in addition to Pi/Node kernel/CPU/OS prerequisites.

## Execution timeouts

Every runner job has an explicit `timeout-minutes`; matrix entries each receive the same job-specific bound. Reusable-workflow callers do not accept this setting, so their executable jobs own it.

| Job | Minutes |
| --- | ---: |
| Ref/version and workflow lint | 5 |
| Inert native packaging fixtures | 5 |
| Extension checks and packaging | 10 |
| Native checks, cold Rust build, artifact staging and consumers | 60 |
| Physical syntax CLI; full CLI/replay on extension release tags | 30 |
| GitHub Release assembly and publication | 10 |
| Manual native npm publication | 15 |
| Extension release admission and generated package | 15 |

The unit/SDK/GC step also has a five-minute limit within its ten-minute job. Current-source and extension-release-only published-consumer steps have fifteen minutes each within the sixty-minute native job; npm commands have a five-minute bound, not relaxed native source/classification deadlines. Time limits are configured bounds, not evidence that required jobs passed. Expiry stops the process or cancels the job; it does not bypass assertions or trigger a successful retry. Job execution timeouts do not bound waiting for a runner. Interrupted release publication can leave a draft; the existing inspection/no-overwrite rule below still applies.

## Published assets

The release workflow checks all six artifacts' source commits, versions, targets, raw executable hashes/sizes, URLs and notice inventories before publication. It uploads:

- `occipital-vVERSION-TARGET` raw executables (`.exe` for Windows);
- one common `NOTICE` covering every platform, plus the project's `LICENSE`;
- `native-release.json` with the exact version, platform URLs, SHA-256 and byte sizes;
- `SHA256SUMS` for every preceding asset.

The common `NOTICE` preserves each distinct platform inventory byte-for-byte and labels its covered targets; identical complete inventories appear once. Native npm packages retain their own platform `NOTICE`. This layout is used by `0.1.3` and subsequent releases; earlier published assets remain unchanged.

It creates a draft, uploads all files, then publishes it. An existing release/draft is not overwritten; after a failed upload inspect or remove the draft before rerunning. It uses the job-scoped `GITHUB_TOKEN` with `contents: write`, not an npm token. Do not move published tags.

Creating/pushing a tag is a separate operator action. The tag-triggered workflows do not create tags, commit version changes, publish npm packages, or update `src/occipital/release.ts`. Native npm publication is a separate manual workflow described below. Extension release admission downloads/verifies the selected public family and generates its exact `NATIVE_RELEASE` only in the disposable package, independently of the extension's version and repository placeholders.

## Extension release preparation

On an extension tag, `extension-package` runs only after native, unit/SDK and physical CLI gates. It fetches the selected completed public release, compares all six current executables and registry payloads, and stages the package only after every check passes. Changed bytes, missing assets, incomplete npm versions or a malformed nearest tag fail instead of choosing an older release. It packs/uploads an admitted tarball but has no npm publication permission. The command takes explicit current/public artifact directories:

```sh
SOURCE_COMMIT=FULL_EXTENSION_COMMIT node scripts/release/extension-release.mjs \
  refs/tags/pi-tidy-ui-vVERSION CI_ARTIFACTS PUBLIC_ASSETS NEW_OUTPUT
```

`PUBLIC_ASSETS` includes the public release assets and `release.json` from the GitHub API. `CI_ARTIFACTS` contains all six same-commit `occipital-vVERSION-TARGET` directories. The ref must resolve to the checked-out source commit. The generated package directory and `plan.json` are disposable release artifacts, not source files.

## Manual native npm publication

`.github/workflows/occipital-npm-publish.yml` runs only by explicit manual dispatch on `main`, independently of GitHub/extension release workflows. Supply the published `occipital-vVERSION` tag and the exact successful CI run ID that built/released it. The run must be this repository's `ci.yml` push-tag run, with the tag's resolved commit and a successful conclusion; PR/branch/development artifacts cannot substitute. CI artifacts currently expire after 14 days. Missing/expired artifacts stop publication; the workflow does not rebuild or select a different run. This npm path rejects versions containing SemVer `+build` metadata before packing or registry access because npm removes that metadata from the version. GitHub/native releases retain their full-SemVer contract; no version aliases or rewrites are introduced.

The workflow compares every assembled executable, notice, license, metadata and checksum file with the already-public GitHub release. It validates all six platform package manifests, payloads and platform notices before packing, restores executable permissions lost by artifact ZIPs, and never runs package scripts. Future native manifests include the canonical `repository.url` required by npm provenance; already-published `0.1.4` packages remain unchanged.

Configure trusted publishing for **each** `@kchpock/occipital-*` package: GitHub owner `chpock`, repository `pi-tidy-ui`, workflow filename `occipital-npm-publish.yml`, direct `npm publish` allowed, and no environment name (this workflow does not use one). The GitHub-hosted job grants `id-token: write` and installs exact npm `12.0.2` on Node `26.7.0` (npm 12's own Node requirements do not change the extension's Node 22.19.0 minimum). It uses short-lived OIDC authentication, not an npm token, approval command or bypass-2FA credential. Although npm normally generates provenance automatically with trusted publishing, the workflow explicitly passes `--provenance` to require generation and stop publication on generation failure. The provenance describes this verified-artifact packaging/publication workflow, not a source audit or proof of reproducible Rust compilation; the original Rust build's authority remains the checked source CI run/commit.

Before any upload, all six registry versions are inspected. An existing version is skipped only when its integrity matches the prepared archive; a mismatch or registry error stops the family before publication. Prereleases use `next`; stable versions retain npm's normal implicit-`latest` checks. After publication, each exact-version registry record and its raw tarball are read directly, refusing redirects and non-HTTPS/outside-registry archive URLs and bounding streamed bytes to the prepared archive size before accepting SHA-512 equality. Do not re-resolve the just-published version with `npm pack`: that returned `ETARGET` after a successful upload. An unavailable record/byte mismatch fails immediately; there is no delayed retry or republishing fallback. npm publication is not atomic: interruption can leave some packages public. Per-package receipts distinguish not-started, unconfirmed, published and already-published outcomes; an explicit rerun with identical artifacts skips matching versions instead of overwriting them. Receipts/plan are retained for 14 days, without raw npm logs or credentials.

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
