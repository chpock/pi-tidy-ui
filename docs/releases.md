# CI and release versions

The extension and Occipital have independent release versions. Repository manifests use `0.0.0`: root `package.json`/`package-lock.json`, and the Occipital Cargo manifest/lock entry. Native npm templates retain their substitution marker until staging.

| Ref | CI version substitution | Publication |
| --- | --- | --- |
| Branch / pull request | None; `0.0.0` development artifacts | None |
| `pi-tidy-ui-v0.2.0` | Only the extension npm manifest/lock roots | Extension tarball in CI artifacts; no publishing workflow yet |
| `occipital-v0.1.0` | Only the daemon Cargo manifest/lock entry, **before compilation** | Occipital GitHub Release only |

Tags must contain a complete SemVer version. Prerelease tags such as `occipital-v0.1.0-rc.1` produce prereleases. CI substitutions affect disposable checkouts, not repository commits or dependency versions. The npm package is still named `pi-toolview` and the command is still `/toolview`; the tag prefix does not rename them.

## Workflow relationship

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, both tag families, and manual dispatch. It validates workflow syntax and resolves the ref. Extension checks use exact Node 22.19.0 and 26.7.0, strict TypeScript, unit/SDK/GC controls, packaging, and physical CLI/replay checks with the Linux native artifact. Shared-service CLI checks still require an explicitly supplied isolated host and skip when unavailable.

The reusable `.github/workflows/occipital.yml` runs inert packaging/version controls and native Rust correctness, pipe protocol, parser-affinity doctest, formatting and Clippy checks. It builds release executables on native runners for GNU Linux x64/arm64, macOS x64/arm64, and Windows MSVC x64/arm64. Each actual release executable is checked through the canonical Node stdio client for protocol validity, UTF-8 colors, incremental counters and process cleanup, as well as its compiled version. Explicit Rust target triples prevent an emulated host toolchain from silently selecting a different architecture. Its artifact contains raw executables, native npm package staging, SHA-256/size metadata, source commit identity, LICENSE and third-party NOTICE inventory. Release staging and its notice preparation use the job-owned runner temporary directory, outside Cargo's cached `target/`; restored compiler outputs must never restore a prior release destination. Every resolved build/target dependency is fetched for the notice inventory; missing texts fail staging. The maintained Subconscious supplement copies original LICENSE bytes from the exact crate source commits.

On an Occipital tag, CI passes these **same-run, same-commit, tag-versioned artifacts** to `.github/workflows/occipital-release.yml`. No second build, historical-run lookup, or artifact race is needed. Branch artifacts with compiled version `0.0.0` cannot substitute for a release version.

Daemon tags skip unrelated extension checks and do not publish or change the extension. Extension tags do not publish Occipital. Native platform availability is established by successful runner builds/tests, not merely by this matrix's presence; broader minimum-OS/ABI claims still require their own verification.

## Published assets

The release workflow checks all six artifacts' source commits, versions, targets, raw executable hashes/sizes, URLs and notice inventories before publication. It uploads:

- `occipital-vVERSION-TARGET` raw executables (`.exe` for Windows);
- matching `*.NOTICE` files and the project's `LICENSE`;
- `native-release.json` with the exact version, platform URLs, SHA-256 and byte sizes;
- `SHA256SUMS` for every preceding asset.

It creates a draft, uploads all files, then publishes it. An existing release/draft is not overwritten; after a failed upload inspect or remove the draft before rerunning. It uses the job-scoped `GITHUB_TOKEN` with `contents: write`, not an npm token. Do not move published tags.

Creating/pushing a tag is a separate operator action. These workflows do not create tags, commit version changes, publish npm packages, or update `src/occipital/release.ts`. Adoption of an owned helper still requires downloading/verifying the published release and explicitly pinning `NATIVE_RELEASE`. That pin remains a real exact daemon version, independent of the extension's version and repository placeholders.

## Local checks

```sh
npm run check
npm run test:native-release
node scripts/release/version.mjs --resolve refs/tags/occipital-v0.1.0
```

The release regression suite uses tiny inert files: it checks independent version substitution, lock agreement, invalid tags, all-platform assembly and rejection of wrong commits/versions/targets/bytes/URLs or unresolved notices. It does not publish, launch a service, run a load calibration, or replace the real per-platform CI gates.
