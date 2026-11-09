# Occipital changelog

Changes to the Occipital helper are recorded independently of
[pi-tidy-ui](https://github.com/chpock/pi-tidy-ui/blob/main/CHANGELOG.md).
Release notes before the published 0.2.0 baseline have not been reconstructed.

## [Unreleased]

### Breaking changes

- Reorganize the Rust library's SOURCE interface under `occipital::source`,
  with shared configuration in `limits::Limits`, failures in `fault::Fault` and
  admission metadata in `protocol::Admission`. Rust callers must update imports,
  use `source::request::decode` instead of `SourceRequest::decode`, and pass a
  validated `SourceOperation` to `Service::start` instead of the request envelope.
  STYLE values and work now use `occipital::style`, with context admission,
  rules, matching and the request adapter under `style::contexts`, `style::rules`,
  `style::resolver` and `style::request`. Replace the mixed `semantic::Error`
  with context-only `style::contexts::Error` or value-only `style::StyleError`.
  Old Rust paths and signatures are not retained. The executable interface,
  `syntax-highlight/v4` JSON/RPC contract and resource limits are unchanged.

## [0.3.0] - 2026-11-03

### Breaking changes

- Replace `syntax-highlight/v3` with `syntax-highlight/v4` and resolver revision 3.
  Clients and helpers must implement the same contract; published v3 releases
  remain immutable and are not compatible with v4 clients.
- Remove the native theme catalogue, `.tmTheme` loading, native palettes and
  theme-specific profile definitions. Clients now own their palettes and submit
  generic style rules.

### Added

- Context-qualified generic STYLE rules with nearest-owner matching. Equal-score
  matches use the first applicable declaration independently for foreground,
  background and each font attribute.
- v4 conformance vectors and explicit rule limits: 512 selectors, 4096 paths,
  4096 atoms and 256 KiB of rule-name bytes.

### Changed

- Move theme selection and final palette application to clients and remove the
  unused theme-loading dependencies. SOURCE parsing remains theme-independent.
- Generate release descriptions from this product's versioned changelog instead
  of using a generic asset-packaging description.

## [0.2.0] - 2026-10-25

### Compatibility

- Published `syntax-highlight/v3` baseline with resolver revision 2. Original
  binaries and metadata remain available in
  [Occipital 0.2.0](https://github.com/chpock/pi-tidy-ui/releases/tag/occipital-v0.2.0).
