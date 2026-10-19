# Settings menu and saved preferences

## Entry and navigation

Bare `/tidy-ui` opens one centered popup in Pi terminal mode. Each page fits its header, full item labels and values, selection gutter and basic navigation, using terminal-column widths. The preferred width is capped at 72 columns and Pi clamps it to the available terminal width; 72 is not a fixed window size. Descriptions, diagnostic details and error text wrap within that width rather than widening the popup. Theme sizing considers the full available catalogue, not just visible or filtered choices. Page/content changes can resize the same overlay; arrow movement, help changes, detail scrolling and search do not. Resizing the terminal preserves the preferred width when space permits and recenters the actual overlay, including its mouse bounds. Paged detail views use a compact navigation line when needed to retain the paging and back keys.

Menu items share a label column and a left-aligned value column, separated by two spaces. Submenu arrows occupy their own rightmost column, not the value text. Preferred width combines the widest label and the widest value across the full page, plus these gutters and indicators; it is not the longest individual row. Filtering and scrolling do not recompute column positions from a visible subset. Under the width ceiling or a narrow terminal, labels and values are ellipsized against shared boundaries rather than intruding on each other's columns. On/Off remains complete when enough room exists for a label, value and gutters; extremely small layouts keep compact keyboard access without promising every field fits.

Command arguments are no longer supported: they report usage and perform no action. Print/JSON/RPC modes do not open a menu.

The first page contains:

- **Tidy UI appearance** — requested styling for eligible cards, messages, input and footer.
- **Code color theme** — opens the theme picker; it does not change Pi's overall theme.
- **Set terminal colors from Pi theme** — apply Pi's theme to the terminal background and default text color, separate from card styling.
- **Status & troubleshooting** — actual appearance/color/highlighting state and less frequent controls.
- **Close**.

The theme row is initially selected, so the first Enter navigates rather than toggles. Header and bottom navigation are separate sections divided from the body by horizontal rules. After the menu, one empty row precedes exactly two reserved description rows for the selected item. Short descriptions leave the second row empty; longer ones end the second row with an ellipsis. Very short terminals omit the frame/header/navigation before giving up description space; below four rows only the compact list/details fit. Arrow keys navigate, Enter confirms, Escape returns one page or closes from the first page; Ctrl+C closes. Fullscreen mouse clicks activate content rows, not borders. Narrow/short layouts retain keyboard access; Page Up/Down scroll detail text without skipping hidden rows. All pages occupy the same overlay, independent of the presentation adapter or syntax-provider generation. The native editor is not replaced or transferred.

Appearance Off leaves the menu and independent logging usable. On/Off values show preferences, not availability. Actual limitations are explained separately; automatic/system Pi themes retain native control of terminal colors.

## Theme picker

The searchable, scrollable list offers **Follow Pi theme**, then eligible native themes, followed by **Refresh theme list** and **Back**. Follow Pi uses local declarative rules through the same Rust resolver as native themes; it does not require a daemon catalogue `pi` profile. An independent selection owns all custom Bash/edit/write card-interior colors, not only syntax tokens. Pi's editor, summaries and global theme are unchanged. Search matches display names and stable catalogue IDs. Duplicate/control-like labels are disambiguated without using their text as action identity; terminal controls are escaped.

Opening waits for preference readiness, not a delay or provider-readiness guess. Root/status inspection never constructs syntax or starts a provider. Opening the picker may prepare preferences but does not enable appearance/native highlighting. Unavailable native catalogues are explained; Follow Pi remains selectable, and a missing saved ID is retained rather than fabricated as a choice.

Arrow/wheel navigation and search preview the highlighted theme immediately, without saving. Opening the list alone does not change the theme. Enter or a completed mouse click confirms and saves once, then returns to the first page without a progress or success message. A mouse press preserves the native pending-click identity; hover does not preview. Empty search results and action rows are not themes.

Escape, Back, Ctrl+C or disposal without confirmation restores the confirmed choice from entry to that particular theme-list visit, not from the first opening of the whole popup. An external confirmation during a local preview updates this rollback choice without interrupting the preview: Escape applies the latest external choice, Enter saves the local selection. Reopening the list after a confirmation creates a new rollback point. Deferred preference readiness from a cancelled visit cannot establish a later visit's rollback point. A failed save keeps the live selection and says it was applied but not saved. Closing during confirmed work is not rollback; late work cannot reopen a closed popup. Selected/effective differences are explained without duplicating equal values.

Preview and rollback use the ordinary retained-owner theme revision and bounded newest-first preparation. Fast navigation coalesces to the latest demand; already-dispatched work is still accounted, but late results cannot restore a superseded preview. Coloring a large history remains gradual. Source parsing is theme-independent: preview resolves only missing styles/palette, and already-retained styles support local rollback/revisit. Ready colors remain visible until the replacement card palette and all its source styles can publish together. Preview never cancels a previous confirmed save, and completing that save cannot overwrite the current preview. Unconfirmed choices are client-local and do not survive runtime/session retirement.

## Troubleshooting

- **Reapply Tidy UI appearance** and **Reapply terminal colors** retry an already enabled preference without changing or enabling it.
- **Use Occipital highlighting** is the native-highlighting preference. Off stops native work and uses the syntax contract's whole-card fallback policy: missing code may remain neutral under a usable retained native palette; without one, use Follow Pi with cached file highlighting and whole-command neutral Bash. It does not stop a user-managed shared service.
- **Highlighting service details** reports cached provider/version/theme/issue state without new classification or discovery.
- **Diagnostic logs** shows capture, paths, identity and separately named **Runtime errors / active**, **Log write errors**, and **Dropped records**; runtime health remains available with capture Off or an unavailable/failed writer. Dropped records explicitly mean incomplete evidence, not extension errors.  **Record diagnostic logs**, **Retry recording** after failure, and **Write state snapshot** are explicit actions. Snapshot never enables recording.
- **Display cache** shows frozen-on-request details, per-kind counters and diagnostic JSON. **Refresh statistics** reads existing counters. **Clear saved layouts** releases only presentation data and captures its receipt synchronously, before a scheduled native repaint can rebuild layouts. Subsequent frames rebuild on demand; neither conversation nor native syntax data is cleared.
- **Refresh status** only reads current state. It does not reload themes, parse sources, retry a service, or enable a feature.

Reversible changes, snapshots and display-cache clearing have no confirmation dialog. Preference changes do not show automatic-save reminders, progress text or saved-success messages. Errors and explicit diagnostic-action results stay inside the popup without replacing its two description rows; unexpected background runtime failures use coalesced public error notifications and stay visible under **Status & troubleshooting**. The root marks that page **Issues** while owner-specific failures remain active; provider readiness or success of another card does not clear them. Safe cause codes, UTC failure time and recovered/owner-removed disposition are visible, with no source bodies or recurring health polling. Counts reset for the new session runtime on session transition/reload. Full failure, recovery and deduplication semantics are in [runtime health](debug-logging-spec.md#runtime-health-is-not-log-writer-health).

## Persistence

Preferences share the existing user-level file:

```text
join(getAgentDir(), "extensions", "pi-tidy-ui", "config.json")
```

Pi resolves the agent directory, including `PI_CODING_AGENT_DIR`. This is neither a project setting nor Pi's `settings.json`. The full known shape is:

```json
{
  "syntaxTheme": { "kind": "pi" },
  "terminalColorsEnabled": true,
  "nativeHighlightingEnabled": true
}
```

An independent theme uses `{ "kind": "occipital", "id": "<catalogue ID>" }`. Old theme-only files remain valid. Missing persisted switches default to On, and a missing theme defaults to Follow Pi; reading defaults does not write a file. Shared choices load before presentation, providers and terminal-color application start.

**Tidy UI appearance** and **Record diagnostic logs** are local to the running Pi process. Their two boolean values live under a private `globalThis` symbol, with no component/session references or filesystem flag. They survive `/reload` and opening another session in the same process; a new process starts both On. Local Off is restored before presentation or journal initialization, so disabled capture creates no journal, overview, retention scan or cleanup operation. Legacy `appearanceEnabled`/`loggingEnabled` file fields are ignored and removed on the next explicit persistent save, not by a startup migration.

Confirmed themes and the two shared switches apply and save automatically; there is no Save button. Theme-list navigation is temporary until Enter/completed-click confirmation and never writes settings. Local switches do not enter the persistence queue. Shared writes use the same `ExtensionSettings` writer, reread the latest document, preserve unknown fields and replace a complete JSON file through a private temporary file and rename. Confirmations enter that queue before asynchronous transport cleanup: dismissing and reopening a popup cannot let an older completion overwrite a newer confirmation. Saves fail visibly without undoing the live choice. Invalid/unreadable files are not silently overwritten.

Shutdown/session retirement cancels unpublished pending saves; a rename already requested is the commit boundary. Disposed syntax owners cannot publish late theme selections.

## Changes from another Pi

An active runtime watches the configuration directory, not the replaceable file. If it does not exist yet, watch the nearest existing ancestor until the directory is created; watching alone creates no files/directories. Relevant filesystem events coalesce into a one-shot check of device/inode, size and modification/change timestamps. Read and validate JSON only when these metadata change. Unrelated filenames are filtered before stat. There is no periodic stat/read/hash, polling interval or watcher timer in idle Pi;100 idle instances perform no recurring configuration I/O.

Valid external settings apply to the running theme, terminal-default preference and native-highlighting preference without writing them back. Only changed known values trigger application; local appearance/logging remain untouched. A local unconfirmed preview stays visible as described above. A malformed/unreadable update retains the last live values and reports a bounded warning; deletion applies missing-file defaults. A failed native watch reports its failure rather than silently falling back to polling. Native event delivery depends on the filesystem/OS; a reload retries monitoring.

Each runtime closes its watcher and pending one-shot work on shutdown/reload; retired reads cannot publish. Reads wait for locally queued writes and discard a result superseded by a newer local write. Independent writers retain the existing last-actual-publication policy; concurrent distinct patches are not a transactionally merged database. No cross-process locks, database or sidecar/index files are added.

Only the confirmed theme and two shared switches persist. Cache counters, provider state, recovery budgets, log paths/identities and reapply/refresh/snapshot/clear actions remain runtime state.
