# pi-tidy-ui changelog

User-facing changes to pi-tidy-ui are recorded here. Occipital has an independent
[history](https://github.com/chpock/pi-tidy-ui/blob/main/docs/occipital/CHANGELOG.md)
and release version. Release notes before the published 0.1.1 baseline have not
been reconstructed.

## [Unreleased]

### Added

- Expand compact read summaries into syntax-colored, numbered source cards without
  diff styling. Fullscreen click and Ctrl+O reveal only the saved returned text;
  regular terminal mode uses Ctrl+O. Reads stay outside the automatic write/edit
  window. Expanded image reads reuse Pi's own images in an unframed image block
  within the owned presentation.

### Changed

- Read expansion now opens the owned card instead of Pi's stock text card.
  Defer Pi's stock read text preparation while the owned card is active. Collapsed
  reads prepare no result body, and collapsing releases their derived full view.
  Appearance Off and explicit native-read policy retain Pi's presentation.

### Fixed

- Keep read/write/edit text preparation outside drawing, including neighbor spacing
  and terminal color-mode changes. Show memory-limit messages only after an actual
  refusal, without self-triggered repaint retries. Recover an accepted file view
  after palette or paint funding becomes available without rebuilding its source.
- Reopen a collapsed read with complete text and highlighting even when its native
  syntax results are retained, rather than incorrectly reporting a paint-budget limit.
- Support AFT's saved numbered read results without duplicate gutters or passing
  producer line-number prefixes into syntax highlighting. Preserve literal stock
  read text, returned line coordinates and producer notices.

## [0.2.0] - 2026-11-03

### Breaking changes

- Require Pi 1.0.1 or newer. Node.js 22.19.0 remains the minimum Node version.
- Require an Occipital helper supporting `syntax-highlight/v4`; the published
  0.2.0 helper uses the incompatible v3 contract. Published extension packages
  declare their matching helper independently of the extension's version. When
  no compatible helper is available, Follow Pi file cards may use the permitted
  Pi highlighter; selected local palettes retain neutral text without Pi colors.
- Replace Occipital-owned syntax themes and `.tmTheme` support with 72 bundled
  local palettes. A saved `syntaxTheme` with `kind: "occipital"` is not migrated:
  manually select `{"kind":"pi"}` before upgrading. Also reset a local-palette
  selection to Follow Pi before downgrading to a version without local palettes.
- Ctrl+O expands Toolview's own write/edit cards instead of switching them to Pi's
  stock presentation.

### Added

- Bundled semantic palettes and one shared syntax-region classifier for Bash,
  write and edit, including the default Follow Pi palette.
- Short write/edit previews for restored history and older cards. The ten latest
  successful live file calls remain automatically full across turns; explicit
  per-card choices are preserved. Fullscreen primary click toggles an individual
  card, and Ctrl+O controls expansion in both terminal modes.
- Versioned changelogs, generated GitHub release notes and native Pi 1.5 package
  update notices for stable npm releases. First discovery records the version;
  notices appear for later updates on a fresh launch.

### Changed

- Prepare full file views on demand and release their derived rows and measurements
  when returning to a preview. Original Pi arguments, results and saved sessions
  remain intact. When a card above the visible area shrinks, Pi's ordinary
  terminal renderer may fully redraw and clear terminal scrollback.
- Defer stock write/edit preparation while Toolview owns the visible card. Native
  appearance and fallback remain available without changing tool execution.
- Keep streamed argument references current with Pi 1.5's deferred native updates,
  without retaining replaced arguments or forcing stock preparation.
- Show short details while file operations are pending and complete error details
  after they fail. If preparation exceeds the memory budget, show an explicit
  limitation instead of silently constructing an unrestricted stock view.

### Fixed

- Stop handling keyboard and mouse input after the settings menu closes.

## [0.1.1] - 2026-10-26

### Changed

- Published baseline for this changelog. The original package is available as
  [pi-tidy-ui 0.1.1](https://www.npmjs.com/package/pi-tidy-ui/v/0.1.1).
