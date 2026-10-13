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

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, both tag families, and manual dispatch. It validates workflow syntax and resolves the ref. Extension checks use exact Node 22.19.0 and 26.7.0, strict TypeScript, unit/SDK/GC controls, packaging, and the shorter `test:syntax-terminal` physical syntax/replay checks with the Linux native artifact. The time-expensive full `test:terminal` step runs only when the validated ref is a `pi-tidy-ui-v*` extension release tag, including manual dispatch of that tag; PRs, `main` and branch dispatch skip it without skipping syntax checks. Extension-tag CI requires both suites to pass, but still does not publish the extension. Shared-service CLI checks require an explicitly supplied isolated host and skip when unavailable. Local final UI verification and focused development checks follow the [testing cadence](testing.md#test-selection-and-cadence).

The reusable `.github/workflows/occipital.yml` runs inert packaging/version controls and native Rust correctness, pipe protocol, parser-affinity doctest, formatting and Clippy checks. It builds release executables on native runners for GNU Linux x64/arm64, macOS x64/arm64, and Windows MSVC x64/arm64. GNU jobs build and run the full Rust checks, Clippy and actual release-binary protocol control inside pinned multiarch AlmaLinux 8 userspace, asserting glibc 2.28 and the native architecture. `scripts/release/linux-gnu.sh` reuses the runner's official Rust sysroot, Node 22.19.0 and fetched Cargo dependencies; compilation/testing is offline in the container. Its `RUSTUP_TOOLCHAIN` names that same mounted sysroot so Cargo-home rustup proxies need no container default or installation. The GNU cache key is separate from prior newer-host builds. The staging guard inspects actual required ELF symbol versions and refuses requirements above 2.28; optional weak versions do not impose a loader prerequisite. Both native architectures must pass before release acceptance. Published `0.1.4` verifies the selected glibc 2.28 baseline on both native architectures. Earlier `0.1.3` GNU binaries still require glibc 2.34 and remain immutable; a source-policy change cannot upgrade their bytes. Each actual release executable is checked through the canonical Node stdio client for protocol validity, UTF-8 colors, incremental counters and process cleanup, as well as its compiled version. Explicit Rust target triples prevent an emulated host toolchain from silently selecting a different architecture. `.cargo/config.toml` enables `crt-static` for both Windows MSVC targets; the locked Oniguruma C build inherits the same runtime choice through `cc`. No additional Rust target flags are introduced for Linux/macOS. Windows jobs install Rust's `llvm-tools-preview` component and inspect the actual executable's normal/delayed import tables before staging, refusing compiler-runtime DLL dependencies or missing/failed inspection output. System Windows DLLs remain valid dependencies. Static runtime security updates require rebuilding/releasing Occipital; published `0.1.3` executable imports and native-runner protocol checks verify this policy; `0.1.2` remains unchanged. Its artifact contains raw executables, native npm package staging, SHA-256/size metadata, source commit identity, LICENSE and third-party NOTICE inventory. Release staging and its notice preparation use the job-owned runner temporary directory, outside Cargo's cached `target/`; restored compiler outputs must never restore a prior release destination. Every resolved build/target dependency is fetched for the notice inventory; missing texts fail staging. The maintained Subconscious supplement copies original LICENSE bytes from the exact crate source commits. `.gitattributes` disables checkout newline conversion only for the project's `LICENSE` and maintained supplementary notice texts, preserving those bytes on Windows too.

GNU jobs also cache the public AlmaLinux/system-tool image, separately from Cargo and npm. The exact key includes the native platform and Dockerfile hash (including its pinned base digest), without fallback to another recipe. Docker still evaluates the recipe with inline-cache hints; cache loss rebuilds it, while an invalid restored archive fails visibly. The image contains no Rust SDK, source tree, native release output or credentials. Cached system-tool packages refresh when the recipe/base changes, not on every extension commit. Git is included for the unchanged installed-consumer's nearest-tag preparation inside GNU userspace; it is not used by the running extension or delivered in native packages. Archive creation and cache transfer are measured separately; the cache is saved only after a successful job, and full offline compiler/ABI/protocol checks still run.

Outside Occipital tags, every native runner also stages a real-version extension from the nearest public release, packs/installs it on Node 22.19.0 and 26.7.0, and tests native optional dependencies resolved from npm, then a separate `--omit=optional` consumer without the native package/shared SDK. The isolated installed consumer uses normal bootstrap, not a release or executable override: real cold download, warm cache reuse, incremental source counters and owned-process cleanup must pass. These checks consume the selected public payload, not a locally prepared native package or current Cargo build. GNU runners use `scripts/release/installed-linux-gnu.sh` to run that same consumer in the pinned glibc 2.28 userspace with the selected official Node distribution. Unlike offline compilation, this isolated clean installation/acquisition needs networking; it performs no compiler discovery or payload override. Other platforms run the consumer directly. They are skipped on daemon tags so an independent daemon release cannot be blocked by the extension's previous pin. Each installed check has a fifteen-minute step timeout; each npm preparation command has a five-minute limit. A per-platform npm content cache is restored before both Node checks and saved after a successful job. Its key includes the root lockfile hash, with a same-platform fallback when dependencies change. Only `_cacache` is retained, not `node_modules`, raw logs or the Occipital binary cache. Both Node versions share that package data; GNU checks bind the same directory into the container through `npm_config_cache`. Every consumer still starts clean and exercises the native cold/warm acquisition assertions.

On an Occipital tag, CI passes these **same-run, same-commit, tag-versioned artifacts** to `.github/workflows/occipital-release.yml`. No second build, historical-run lookup, or artifact race is needed. Branch artifacts now carry the nearest tag's compiled version, but are not that published release: source-commit/tag authority and actual binary hashes still govern admission.

Daemon tags skip unrelated extension checks and do not publish or change the extension. Extension tags do not publish Occipital. Native platform availability is established by successful runner builds/tests, not merely by this matrix's presence; broader minimum-OS/ABI claims still require their own verification. The selected GNU glibc floor is 2.28 for both architectures, with the installed Pi/Node host's kernel/CPU/OS requirements as well; container testing establishes userspace compatibility, not execution on an older kernel.

## Execution timeouts

Every runner job has an explicit `timeout-minutes`; matrix entries each receive the same job-specific bound. Reusable-workflow callers do not accept this setting, so their executable jobs own it.

| Job | Minutes |
| --- | ---: |
| Ref/version and workflow lint | 5 |
| Inert native packaging fixtures | 5 |
| Extension checks and packaging | 10 |
| Native checks, cold Rust build and artifact staging | 45 |
| Physical syntax CLI; full CLI/replay on extension release tags | 30 |
| GitHub Release assembly and publication | 10 |
| Manual native npm publication | 15 |
| Extension release admission and generated package | 15 |

The unit/SDK/GC step also has a five-minute limit within its ten-minute job. Installed-client steps have fifteen minutes each within the unchanged forty-five-minute native job; only npm preparation commands receive five-minute headroom, not native source/classification deadlines. These allowances leave headroom above successful runs, including cold installation/build work. Expiry stops the process or cancels the job; it does not bypass assertions or trigger a successful retry. Job execution timeouts do not bound waiting for a runner. Interrupted release publication can leave a draft; the existing inspection/no-overwrite rule below still applies.

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
npm run check
npm run test:native-release
node scripts/release/version.mjs --resolve refs/tags/occipital-v0.1.0
```

For local GNU baseline validation, use Docker on the corresponding native Linux architecture, an official Rust toolchain/Node 22.19.0 that themselves run on glibc 2.28, and fetch locked dependencies first:

```sh
cargo fetch --locked
bash scripts/release/linux-gnu.sh x86_64-unknown-linux-gnu
# On a native ARM64 host instead:
# bash scripts/release/linux-gnu.sh aarch64-unknown-linux-gnu
```

The wrapper owns the native-architecture/glibc assertions, Docker image/cache, SDK mounts and network isolation. Inside that environment it delegates the ordered tests, allocator diagnostic, strict lint, locked release build, ABI admission and actual helper smoke to the Makefile's internal `_gnu-native` target, with `CARGO_NET_OFFLINE=true`. That target is not a standalone host baseline check. The shared Make recipes also provide [local build/test shortcuts](testing.md#make-shortcuts); they do not replace release admission, stamping, same-run artifact authority or publication workflows.

The helper honors `CARGO_HOME` and `CARGO_TARGET_DIR`; use an isolated target directory for local experiments. It writes ordinary ignored Cargo/catalogue-test outputs as the invoking user, not root. The diagnostic-only `engine_probe` reports unavailable allocator data as `null` before glibc 2.33; no calibration mode is invoked by this gate.

The release regression suite uses tiny inert files: it checks independent version substitution, lock agreement, invalid tags, GNU symbol-version admission and native baseline wiring, Windows import policy, all-platform assembly and rejection of wrong commits/versions/targets/bytes/URLs or unresolved notices. It does not publish, launch a service, run a load calibration, or replace the real per-platform CI gates.
