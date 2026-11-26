# pi-tidy-ui changelog

User-facing changes to pi-tidy-ui are recorded here. Occipital has an independent
[history](https://github.com/chpock/pi-tidy-ui/blob/main/docs/occipital/CHANGELOG.md)
and release version. Release notes before the published 0.1.1 baseline have not
been reconstructed.

## [Unreleased]

### Changed

- Widen the `/tidy-ui` main menu by 20%, add space above its choices, and
  shorten each choice’s hint to one line.
- Add spacing around the `/tidy-ui` theme search and below Back. Replace the
  description block with separators that distinguish Follow Pi and Back from
  theme families without adding selectable rows.

### Fixed

- Leave two spaces between submenu arrows and the right edge of `/tidy-ui` menus.
- Restore the confirmed code theme when moving the selection to Back, without
  leaving the picker or saving changes.
- Widen `/tidy-ui` status and troubleshooting pages so fewer diagnostic lines
  wrap. The diagnostic popup still fits narrow terminals.

## [0.3.0] - 2026-11-26

### Breaking changes

- Remove GUI-only code themes `amoled`, `oc-2`, `onedarkpro` and `shadesofpurple`,
  and the unsupported transparent theme `lucent-orng`. A saved selection stays
  unchanged. The extension warns that the theme is unavailable and uses Follow Pi
  as the effective palette until you select another theme. TUI `opencode` is not
  an `oc-2` alias.
- Store the code-theme family in `syntaxTheme.id` and its variant separately in
  `syntaxThemeVariant` (`"dark"` or `"light"`). Missing or unsupported variants use
  Dark. Known legacy IDs such as `github-light` are recognized as the `github`
  family, but their suffix does not select Light: set `syntaxThemeVariant` to
  `"light"` to retain it. Reading does not rewrite configuration; confirming a
  theme or variant saves the new pair. Reset `syntaxTheme` to `{"kind":"pi"}`
  before downgrading to versions that require concrete palette IDs.

### Added

- Expand compact read summaries into syntax-colored, numbered source cards without
  diff styling. Fullscreen click and Ctrl+O reveal only the saved returned text;
  regular terminal mode uses Ctrl+O. Reads stay outside the automatic write/edit
  window. Expanded image reads reuse Pi's own images in an unframed image block
  within the owned presentation.

### Changed

- Recover useful native highlighting after service loss without a lifetime restart
  cap. Space automatic recovery cycles and selected retryable request failures by
  one minute; retain useful source work while connecting without requiring a new
  card update. Retry permission does not authorize duplicate Pi classification.
  Packaged Occipital 0.4.0 reports that a request may have run when its worker reply
  is lost; older compatible shared helpers retain their previous reporting.
- At terminal stop, end card work and readiness waits and close the syntax
  connection even when idle. On return, use ordinary activation and useful-work
  recovery while retaining eligible ready cards.
- Stop `/tidy-ui` arrow navigation at the first and last items instead of wrapping,
  including filtered theme lists; disabled items remain skipped.
- Use only OpenCode TUI themes: 32 families and 64 Dark/Light variants, including
  native `opencode` and excluding transparent `lucent-orng`. Preserve TUI syntax
  colors/fonts and authored diff code, gutter, sign and number colors without
  contrast correction; keep Follow Pi unchanged.
- List 32 code-theme families instead of 64 Dark/Light palettes in `/tidy-ui`.
  Choose the variant in a separate root control, dimmed, disabled and skipped
  during navigation when Follow Pi is selected; its remembered value is retained.
- Show expanded read/write/edit failures in Bash-style error panels, with a red
  stripe and status, readable complete error output, and no proposed file contents.
  Compact failure summaries and original session data remain unchanged.
- Show Bash as a compact tool call until its command/context and prepared card are
  available, rather than briefly displaying Pi's native card. Preserve explicit
  native policy and image safeguards; Ctrl+O keeps an unavailable owned card compact.
- Read expansion now opens the owned card instead of Pi's stock text card.
  Defer Pi's stock read text preparation while the owned card is active. Collapsed
  reads prepare no result body, and collapsing releases their derived full view.
  Appearance Off and explicit native-read policy retain Pi's presentation.
- Show the saved location of the full Bash output, or the reason it could not
  be saved, outside the collapsed Bash preview when Pi supplies those details.
- Reuse the final row arrays of unchanged tool cards with separators while Pi
  retains them. On Pi 1.6 this also avoids comparing those rows one by one.

### Fixed

- Restore the warning on Pi 1.6 and newer when a model received a placeholder
  instead of an image from `read`, in both compact and expanded views.
- Keep pi-tidy-ui active if an attached tool receives malformed arguments. That
  call uses its native renderer until it receives an argument object again.
- Keep accepted Bash and file syntax colors when parser data is evicted. Returning
  to the card or resizing it preserves its highlighting without parsing it again.
- Support Pi 1.6's read-only renderer rows without changing native presentation
  or raising the minimum supported Pi version.
- Refresh Bash cards when output changes while the terminal is stopped (for
  example, with an external editor open), without waiting for another input or resize.
- Prevent a retired native no-start refusal from blocking newly enabled work,
  independently of whether the refusal arrives before or after Native Off/On.
  Keep execution history and outstanding request reservations intact.
- Keep pi-tidy-ui active when enabling it with a collapsed pasted draft on Pi 1.5.2.
  Preserve the same editor, paste state, cursor and undo/history while routing
  native activity through Pi's separate status container.
- Keep the current activity indicator visible when Pi returns to an editor that
  first attached during a switch between two menus.
- Restore Pi's native presentation if pi-tidy-ui cannot install its hooks on a
  newly added component. Keep the component attached and warn once. Close the
  highlighting connection on that failure and do not reopen it on terminal
  return until a new presentation is installed.
- Refresh expanded write/edit details when updates reuse the same argument or
  result object. Keep current pending text and replace pending proposals with the
  saved error on final failure, while reusing unchanged bounded measurements.
- Derive file-preview language hints and patch structure from original bounded
  source rows before terminal-control cleanup. Refresh highlighting when raw hint
  validity changes without changing displayed text, and preserve physical rows
  across multiline control sequences. Like full views, previews reject
  control-decorated patch envelopes while safely cleaning controls in source text.
- Restore visible read/write/edit source cards after turning native syntax Off,
  instead of leaving them at a preparation placeholder when repaint happens before
  local paint recovery. Keep the selected theme and existing parser authority.
- Attribute all extension error, warning and info notifications with a consistent
  `[pi-tidy-ui] ` prefix, without changing their severity or repeat suppression.
- Keep oversized read/write/edit paths beside their heading labels when moving the
  path cannot make it fit. Share fragment wrapping and preferred separator cuts
  with compact tool calls, without changing file/diff body wrapping or remeasuring
  headings on resize.
- Show root-reaching `../` file paths as their resolved absolute names in owned
  tool summaries and read/write/edit headings, preserving nearby relative paths
  and original tool/session data.
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
