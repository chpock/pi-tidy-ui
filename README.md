# pi-tidy-ui

An alternative presentation for Pi: concise tool summaries, terminal-style bash cards, framed user messages and input, OpenCode-style syntax-colored edit diffs, source-aware write cards, native rich cards for other commands, and a compact session footer.

```text
 → read src/app.ts [offset=5, limit=10]
 ⚙ grep "handleRequest" in src
 ⠋ aft_zoom src/app.ts [symbols="render"]

 ┃
 ┃ # Run the regression tests
 ┃
 ┃ $ npm test
 ┃
 ┃ tests passed
 ┃

 → read missing.ts
```

This is not a blanket card shrinker. Tool purpose determines the default presentation; reading a large file still produces a summary. Full available results remain accessible through expansion.

## Try it

From this repository, without changing your settings:

```sh
pi -e ./src/index.ts
```

Or install this directory as a local Pi package:

```sh
pi install /absolute/path/to/pi-tidy-ui
```

Pi loads the TypeScript source directly. No build, fork, copying into `~/.pi`, or npm publication is necessary. To remove the local installation, use `pi remove /absolute/path/to/pi-tidy-ui`.

## Behavior

- Collapsed text-only tools use compact summaries by default, including third-party tools. Action/target fields precede auxiliary and content fields; payloads are visible and exact top-level secrets remain masked. Displayed values are capped at 256 Unicode graphemes, with 1024 for the complete name/argument preview; `…` marks abbreviation and wrapping adds no further truncation. Oversized words fill preceding-row space and prefer nearby path/URL separators without wasting more than half the available space; fitting words remain whole.
- Summaries show `→` for `read`, `←` for `edit`/`write`, otherwise `⚙`. Actual execution replaces that glyph with a shared spinner. Final failures color the entire summary with `error`; result/error bodies stay available through native expansion. Trailing status markers are disabled by the source constant `SHOW_COMPLETION_MARKERS = false`.
- `bash` uses a terminal-style card with the complete command, optional description/workdir, a ten-visual-row output preview and a metadata-derived error footer. Expansion shows all already-available output, never rereads output files or reconstructs upstream truncation. An exact separated terminal timeout pair with final numeric exit code 124 becomes one error-colored `[exit code: 124; error: command timed out]` footer; code 124 alone does not imply a timeout. This [display convention](docs/bash-card-spec.md#4-output-and-streaming) does not change raw results or reliably identify the producer/cause.
- Ordinary user messages share the frame, using `customMessageLabel` for the stripe and `userMessageBg` for the panel. Native Markdown styles, transformations, selection/copy and navigation zones are preserved; user cards have no expansion behavior.
- Unsent Steering/Follow-up messages use plain-text user-colored cards above the editor, not in history. `QUEUED · Steering` / `QUEUED · Follow-up` has the stripe color as its background; only the last card includes Pi's current edit-all shortcut, with dim parentheses and muted text. The whole queue has a soft budget of one third of terminal height (rounded down), at least 10 rows. If needed, first-to-last sweeps cap text at 5→1 rows with `…`; frames/metadata count toward the budget and no card is dropped even if the minimum overflows. Native fullscreen clipping can still hide overflow. See the [queued-card contract](docs/card-frame-spec.md#queued-message-cards).
- Main text input shares the user-card stripe/background, without horizontal borders or a prompt glyph. The same native editor retains paste/image markers, undo/history, shortcuts and autocomplete; native menus stay below the panel. One unpainted row separates upper widgets from the input panel; absent/zero-row widgets add no extra separator, and lower widgets do not trigger it. Pi's **Editor padding** sets exterior margins of the whole input panel, including its status and lower edge, immediately; its inner gap stays one column even at zero. Transcript cards are unaffected. A public `belowEditor` widget adds model-name/provider-ID/thinking information, ` • Idle` only at idle, a right-aligned `cwd:branch`, and a `╹▀…` half-height panel edge. The session footer requires the same eligible stock input; losing input ownership also releases our footer without overwriting a later footer owner. Directory fitting prioritizes its last name; Git determines whether a named branch exists. Both widget rows disappear while the native autocomplete list is open; pending lookup alone does not hide them. Working and other activity remain in Pi's separate native container above the input, with Pi's own object, animation and lifecycle. Metadata follows ordinary belowEditor height clipping, independently of native activity. Custom editor factories remain native; impossible tiny widths delegate to Pi. See the [editor contract](docs/card-frame-spec.md#main-input-editor).
- `edit` uses a compact `edit <path>` before completion and on failure, ignoring every other argument when `path` is a nonempty string; without that path it uses generic formatting. Only final success enters the syntax-colored diff presenter: `← Edited <path>`, original line numbers, up to three unchanged context lines per side (`DIFF_CONTEXT_LINES`), and syntax highlighting inside changed code. Addition-only/removal-only diffs are always unified; mixed changes split above 120 columns. Missing metadata gives an inline success title; unsupported metadata delegates to native.
- `write` follows edit's path-only compact lifecycle, then shows `Created` (additions only), `Edited` (additions plus context), `Replaced` (any removals), or `Wrote` (no changes/diff or explicitly truncated diff). Created/Wrote use numbered syntax-colored source without diff signs/tint; Edited/Replaced reuse edit's diff. All available changes remain visible. `Created` includes filling an existing empty file, not proof of new-file creation. No-diff Wrote shows submitted content, not guaranteed post-format bytes; explicit truncation is noted.
- `powershell` keeps its original renderer. Ordinary expanded calls, images and intentional native hiding remain native; expanded Bash retains its custom card unless opted out.
- Consecutive single-row summaries are adjacent; a wrapped summary introduces one blank row before the following tool. Pi's **Output padding** (0 or 1, default 1) sets the exterior left/right margins of transcript summaries, Bash/edit/write cards and user messages, immediately without reload. Cards retain one fixed interior column per side, a left-only stripe and no hover paint. Output padding does not change Editor padding, the input/status panel or the footer.
- Ctrl+O remains Pi's global expansion control. In fullscreen mode, completed summaries/edit/write panels expand on click and expandable Bash panels toggle; exterior margins/separators are not targets. Card clicks do not interrupt active selection. Regular mode uses terminal-owned mouse handling, so use Ctrl+O there.
- One public session footer shows a ten-report cache-use gauge and the latest CH percentage first, followed by current context usage, then right-aligned extension statuses. The session title matches `/resume` (explicit name or first user-message text) and uses only spare first-row space, without displacing statuses; shortened names retain at least five text columns. It highlights disabled native auto-compaction rather than annotating the normal enabled state. Each complete status, including our statistics, stays on one row; whole producer statuses move to later rows when needed, and a status wider than a full row is ellipsized. Cumulative counters/cost remain implemented behind disabled source flags. See [reading the footer](#reading-the-footer) and the [footer contract](docs/footer-spec.md).
- Fixed file-backed themes can set terminal defaults from `export.pageBg` and `colors.text`, including variable chains and native color formats. Missing/empty values release only our channels; source errors retain the last valid complete targets. Auto/system modes suspend application and release defaults before Pi queries its profile. A zero-row observer follows native theme/hot-reload updates without polling. RGB calculations use a local concrete projection rather than modifying Pi's Theme. See the [terminal-color contract](docs/terminal-colors-spec.md).
- Bash commands and edit/write sources can use asynchronous Occipital syntax classification outside rendering. `/tidy-ui` opens appearance settings, a code-theme picker and nested troubleshooting tools. The theme and all four switches are saved automatically. Without native availability, Bash retains whole-command title coloring and files retain cached Pi highlighting. Source version `0.0.0` uses only `occipital` (`occipital.exe`) beside the extension; a missing local build produces a `[pi-tidy-ui]` warning and fallback, never a shared/downloaded engine. Published packages fix exact native optional dependencies and SHA-256 download metadata during release preparation. They prefer a compatible user-managed shared service; otherwise they use the verified installed/cache/download payload (GNU Linux requires glibc 2.28+). Rust and an external Subconscious installation are not required for published standalone use. See [delivery](docs/releases.md#extension-delivery). See the [syntax contract](docs/syntax-highlighting-spec.md).
- Colors otherwise follow the active Pi theme and layouts follow the actual viewport width. An explicitly selected independent syntax theme remains fixed across Pi-theme changes. Tool execution, model-facing results and saved session data are unchanged.

Exact formatting, metadata, geometry and safeguards are defined in the [specifications](#documentation).

### Reading the footer

```text
[····█▅▂▁▁▁] CH98.5% • 104k/272k (38.1%)          mc: 123.1K (60%) · idle
```

The footer is meant to help you notice **a run of requests that stops benefiting from the prompt cache**, not just the last request's percentage. Repeated low cache reuse can mean that a large amount of input is being processed without a cache read. The graph is a quick recent trend, not an absolute token count, cache size, price or guarantee about latency. A small and a large request each occupy one position.

- `104k/272k (38.1%)` is Pi's estimated current context use, applicable window limit and filling percentage. Counts are rounded; `?` means Pi cannot yet estimate the count, for example just after compaction.
- When native Pi automatic compaction is disabled, `(auto off)` follows the context, with warning-colored text. Enabled is the default and adds no annotation. The warning describes configuration, not an already full window; extensions may manage context separately, and enabled auto-compaction is not a guarantee against overflow.
- The bracketed gauge contains **ten reports**, oldest on the left and newest on the right. Each individual primary model response contributes a report, even if its CH is identical to the previous one. A task with twenty model requests produces twenty reports, of which the last ten remain visible; it is not collapsed into one task result. Current CH comes from saved final responses, not intermediate streaming text updates. Reload/replay and off/on restore the history from those records without new requests.
- Bar height is **inverted**: `█` means 0% cache reads, while the visible minimum `▁` means 100%. Eight fixed height levels summarize the 0–100% scale, so nearby rates can share a height. A muted `·` means missing history or an unavailable report; it is not a zero. Before any reports, the gauge is `[··········] CH—`.
- `CH98.5%` is the fraction of the **latest report's input tokens** read from the cache: `cacheRead / (input + cacheRead + cacheWrite)`. It is not a session-wide ratio or the probability that a request hits the cache. The newest bar and CH describe the same report. Colors use the displayed one-decimal rate: green/success at **95% or above**, yellow/warning from **80% to below 95%**, and red/error below **80%**. A red bar indicates low reported cache reuse, not a failed request; a first cold request can naturally show `CH0.0%`.

Pi normalizes absent cached-token fields to zero for some providers. A valid positive-input report with zero cache reads therefore shows zero, without guessing provider capabilities. Missing/invalid input usage shows `·` and, for the latest report, `CH—`. History covers primary responses in the raw session chronology, including previous models and abandoned branches; auxiliary tool/summary/cache-warm usage does not advance it. New sessions have their own history.

Our entire statistics block is one status, with cache history and CH before the context. At narrow widths it loses its tail to `…`, so context is clipped before cache information, rather than wrapping or changing the ten stored samples. Each extension's opaque status also remains one row; different whole statuses can still occupy different footer rows.

The three `FOOTER_FIELDS` source flags in `src/footer.ts` default to `false`: `tokenTotals` for ↑/↓, `cacheTotals` for R/W, and `cost` for cost plus `(sub)`. Their native accounting/formatting is retained. Edit the source flags and reload to show them; there is no new command or persisted setting.

### Controls

Run **`/tidy-ui`** to open a centered settings popup:

- **Tidy UI appearance** — turn styling on or off.
- **Code color theme** — preview Follow Pi or an independent code theme with arrows or search; Enter confirms, cancelling restores the previous choice.
- **Set terminal colors from Pi theme** — apply Pi's theme to the terminal background and default text color when eligible.
- **Status & troubleshooting** — actual state, reapply controls, native highlighting, logs and display-cache tools.

Arrow keys navigate; Enter selects; Escape goes back or closes. The first Enter opens the theme picker, not an on/off toggle. Appearance Off leaves the menu and logging usable. Old command arguments are no longer supported. See the [menu contract](docs/settings-menu-spec.md).

Each transcript/queued-message component owns its latest prepared presentation through weak component state, much like Pi's `Text` retains its latest rendered rows. There is **no entry-count or byte-limit eviction**: an unchanged attached component reuses its rows regardless of transcript age or the size of other presentations. Width/Output-padding/theme and relevant state changes replace its previous layout, not accumulate variants. The execution spinner changes only its prefix, using Pi's existing document frames whenever available. One shared, unreferenced 100 ms timeout requests a fallback frame only after document visits fall silent; it stops when no compact calls are executing. See the [host-driven animation design](docs/architecture.md#host-driven-spinner-and-fallback).

Removing a component/subtree through native `Container.removeChild` or `clear` releases its presentation immediately, even if another caller still holds the component. Otherwise component collection also releases its weakly owned layout. Accounting retains only weak references/numbers, with eventual finalizer cleanup and on-demand snapshots; it cannot keep components or rendered strings alive. Detached/replaced layouts do not accumulate.

**Status & troubleshooting → Display cache** reports:
- Transcript/queued totals and `byKind` breakdown for `summary`, `bash`, `edit`, `write`, `user` and `queued`: retained-byte estimates, strings/overhead, saved entries and visual rows.
- Queued-card rows include full preparation and up to five possible ellipsized endings per item; height-only changes select rows without rebuilding. They belong to `ordinary` and release with the native queued item, not with the persistent pending container.
- The `ordinary` and `cards` accounting groups (not bounded pools), plus hits, misses, builds, releases and GC-only `collected` accounting cleanups.
- `footerLayout` and combined `presentationRetainedBytes`, `presentationEntries` and `presentationRows`. The main editor retains no pi-tidy-ui row cache.
- Whole-Pi `processHeapUsedBytes`, explicitly **not** pi-tidy-ui attribution.

**Clear saved layouts** releases transcript, queued-message and footer layouts; the next requested frame rebuilds them on demand. The displayed receipt records the completed clear before that repaint. Legacy `--tidy-ui-cache-mb` / `--tidy-ui-card-cache-mb` flags are recognized only to warn that they are ignored, preserving launch compatibility without silently reintroducing limits. Cache actions write no settings.

Estimates are not exact V8 heap measurements: native caches, raw/signature data and transient rendering are excluded, and strings may be shared. Memory necessarily grows with the current **live retained transcript and queue**, but no detached-owner or width/state history is intentionally retained. No fixed total-process memory bound is claimed. See the [cache contract](docs/render-cache-spec.md).

Turning **Set terminal colors from Pi theme** off stops terminal-default application and theme reads without disabling cards. Remaining presentation can make a one-shot profile RGB query after releasing colors. **Reapply terminal colors** retries the current enabled preference; appearance On respects the local switch. Reload restores the saved preference. Releases restore terminal **profile defaults**, not another application's prior dynamic override. Disable the old standalone `theme-background` extension manually: concurrent default-color writers are unsupported.

Diagnostic capture is on by default, including while presentation is off. **Status & troubleshooting → Diagnostic logs** shows private human-readable journal paths and counters; **Write state snapshot** records existing state without rendering. **Record diagnostic logs** controls capture; **Retry recording** explicitly retries a failed writer. No conversation, command or source bodies are logged. See [diagnostic journals](docs/debug-logging-spec.md) for batching, cleanup and accepted loss limits.

The code theme, appearance, terminal-color matching, native highlighting and log-recording switches are saved in `getAgentDir()/extensions/pi-tidy-ui/config.json` (normally `~/.pi/agent/extensions/pi-tidy-ui/config.json`). They restore before activation on reload and future launches. Missing switches default to On; old theme-only files remain valid. Theme previews are temporary until confirmed; other changes apply immediately. A failed save is reported without undoing the live choice. Disabling appearance restores original presentation methods, including the editor, without transferring its draft; re-enabling covers existing and future components.

Use exact, case-sensitive tool names to customize the presentation for one invocation:

```sh
pi -e ./src/index.ts --tidy-ui-card Agent,ask_user_question
pi -e ./src/index.ts --tidy-ui-compact write
```

`--tidy-ui-card` adds to the native-card defaults; explicitly naming `bash`, `edit` or `write` restores its original Pi card. `--tidy-ui-compact` takes precedence over that list, but never over expansion, image, or hidden-component safeguards. These presentation overrides have no configuration file; the syntax menu separately persists only its theme preference through Pi's agent directory.

## Compatibility

The supported/tested host is **Pi 1.0.0**. One adapter obtains the stable TUI reference through a public widget factory and narrowly wraps private component rendering, normalized tool clicks, UI updates, stock-editor presentation and child attachment/removal. Native methods still execute; no tool execution or raw input is intercepted. Host libraries are not bundled or privately imported. See [architecture](docs/architecture.md) for the integration and ownership boundaries.

This is intentionally a compatibility-sensitive integration. If a required component contract cannot be established, pi-tidy-ui warns and retains native rendering. Optional queue-card and upper-widget shape guards instead leave the affected block native. Runtime restoration does not overwrite hooks subsequently replaced by another extension. Arbitrary extensions wrapping the same private methods and future Pi versions are not guaranteed compatible; run the terminal checks after upgrading.

**Main-input styling is stock-editor-only.** If another extension installs or replaces its own editor (for example, `pi-powerline-footer`), pi-tidy-ui leaves that editor and its appearance under the owning extension's control. It does not disable the extension or replace its editing behavior. This ownership limitation also disables pi-tidy-ui's session footer, restoring stock only while we own that slot. Tool and user-message cards retain their own eligibility safeguards. Terminal-default synchronization is global and remains independent of editor/footer ownership. After the stock editor returns, `/tidy-ui on` or reload reinstalls the footer; an ineligible editor cannot reclaim it. Footer-only extensions do not block input styling. Footer replacements instead compete for Pi's single footer slot: the last owner wins. Off restores stock only while pi-tidy-ui still owns it, never removes a later owner, and cannot restore a previous foreign footer. Publishers using `setStatus` coexist through the shared status map. See the [editor contract](docs/card-frame-spec.md#main-input-editor).

The extension is inactive in print, JSON, and RPC modes. Component restyling applies to interactive terminal tools, ordinary user messages, queued-message previews, the stock main editor and the session footer, not HTML exports or standalone user shell messages. Terminal defaults affect the shared terminal. Their eligibility additionally depends on one guarded native renderer flag; missing/incompatible state disables only this feature with a warning.

## Development

```sh
make deps
make check
make test
# Optional local syntax helper, copied beside the extension:
make build
```

`make` lists shortcuts and performs no work by default. Useful modes include `make test-gc`, `make test-focus TEST_FILES='tests/unit.test.ts' TEST_PATTERN='^bash timeout'`, `make test-release` and `make test-syntax`. The latter requires an existing helper; `make build` needs the pinned Rust toolchain. npm commands remain available. See [Make shortcuts](docs/testing.md#make-shortcuts) for scopes, requirements and networked checks.

Reserve the full `npm run test:terminal` for final UI/integration verification, not each edit or commit. See the [testing cadence](docs/testing.md#test-selection-and-cadence) for focused checks and the shorter syntax CLI suite.

Development copies of host packages are pinned for reproducible tests; runtime imports are wildcard peer dependencies supplied by Pi. There is no bundling step. Repository versions are `0.0.0`; CI substitutes independent `pi-tidy-ui-vSEMVER` and `occipital-vSEMVER` tag versions. See [CI and releases](docs/releases.md).

Terminal tests require a POSIX environment, Python 3, and a real Pi CLI. They use an offline scripted provider, isolated configuration/workspaces, real tool execution and keyboard/mouse input, and native control runs. They do not require model credentials. Generated evidence belongs in the gitignored `.test-artifacts/` directory.

The installed-package smoke test is version-audited and explicitly skips unavailable profiles; it is not a full user-runtime compatibility guarantee. See [testing and coverage](docs/testing.md) for the harness, reproducible checks and exclusions.

## Documentation

- [Architecture](docs/architecture.md) — modules, host integration, lifecycle, data and ownership boundaries.
- [Tool summary specification](docs/tool-summary-spec.md) — arguments, status, wrapping and compact input.
- [Bash card specification](docs/bash-card-spec.md) — command/output/footer semantics and expansion.
- [Bash streaming contract](docs/bash-streaming-contract.md) — current text, historical prefix colors, native-work retirement and display-effect invalidation.
- [Edit card specification](docs/edit-card-spec.md) — persisted metadata, syntax, diff format and lifecycle.
- [Write card specification](docs/write-card-spec.md) — source classification, numbered plain/diff bodies and fallbacks.
- [Shared frame specification](docs/card-frame-spec.md) — geometry, paint, user/queued cards, main input and click bounds.
- [Terminal-color specification](docs/terminal-colors-spec.md) — fixed-theme metadata, automatic-mode boundaries, OSC ownership and concrete RGB.
- [Session-footer specification](docs/footer-spec.md) — native usage/context data, colors, whole-status fitting and ownership.
- [Render-cache specification](docs/render-cache-spec.md) — invalidation, component ownership, memory diagnostics and performance guarantees.
- [Syntax-highlighting specification](docs/syntax-highlighting-spec.md) — source/presentation separation, native/Pi fallback, themes, providers, resources and outstanding delivery gates.
- [Diagnostic journals](docs/debug-logging-spec.md) — session/run identity, decision explanations, controls, low-I/O writing and retention.
- [Testing and coverage](docs/testing.md) — automated gates, strict native/data controls and coverage limits.

These documents describe the current project. Run evidence and working review reports belong in gitignored `.test-artifacts/`, not in the documentation tree.
