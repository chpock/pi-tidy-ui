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

The searchable, scrollable list offers **Follow Pi theme**, then eligible native themes, followed by **Refresh theme list** and **Back**. The native Pi-palette profile is not duplicated as an independent theme. Search matches display names and stable catalogue IDs. Duplicate/control-like labels are disambiguated without using their text as action identity; terminal controls are escaped.

Opening waits for preference readiness, not a delay or provider-readiness guess. Root/status inspection never constructs syntax or starts a provider. Opening the picker may prepare preferences but does not enable appearance/native highlighting. Unavailable native catalogues are explained; Follow Pi remains selectable, and a missing saved ID is retained rather than fabricated as a choice.

Arrow/wheel navigation and search preview the highlighted theme immediately, without saving. Opening the list alone does not change the theme. Enter or a completed mouse click confirms and saves once, then returns to the first page without a progress or success message. A mouse press preserves the native pending-click identity; hover does not preview. Empty search results and action rows are not themes.

Escape, Back, Ctrl+C or disposal without confirmation restores the choice from entry to that particular theme-list visit, not from the first opening of the whole popup. Reopening the list after a confirmation creates a new rollback point. Deferred preference readiness from a cancelled visit cannot establish a later visit's rollback point. A failed save keeps the live selection and says it was applied but not saved. Closing during confirmed work is not rollback; late work cannot reopen a closed popup. Selected/effective differences are explained without duplicating equal values.

Preview and rollback use the ordinary retained-owner theme revision and bounded newest-first preparation. Fast navigation coalesces to the latest demand; already-dispatched work is still accounted, but late results cannot restore a superseded preview. Coloring a large history remains gradual. Preview never cancels a previous confirmed save, and completing that save cannot overwrite the current preview. Unconfirmed choices are client-local and do not survive runtime/session retirement.

## Troubleshooting

- **Reapply Tidy UI appearance** and **Reapply terminal colors** retry an already enabled preference without changing or enabling it.
- **Use Occipital highlighting** is the native-highlighting preference. Off leaves cached Pi fallback for file sources and whole-command title coloring for Bash. It does not stop a user-managed shared service.
- **Highlighting service details** reports cached provider/version/theme/issue state without new classification or discovery.
- **Diagnostic logs** shows capture, paths, identity and counters; **Record diagnostic logs**, **Retry recording** after failure, and **Write state snapshot** are explicit actions. Snapshot never enables recording.
- **Display cache** shows frozen-on-request details, per-kind counters and diagnostic JSON. **Refresh statistics** reads existing counters. **Clear saved layouts** releases only presentation data and captures its receipt synchronously, before a scheduled native repaint can rebuild layouts. Subsequent frames rebuild on demand; neither conversation nor native syntax data is cleared.
- **Refresh status** only reads current state. It does not reload themes, parse sources, retry a service, or enable a feature.

Reversible changes, snapshots and display-cache clearing have no confirmation dialog. Preference changes do not show automatic-save reminders, progress text or saved-success messages. Errors and explicit diagnostic-action results stay inside the popup without replacing its two description rows; independent background runtime warnings retain their normal notification path.

## Persistence

Preferences share the existing user-level file:

```text
join(getAgentDir(), "extensions", "pi-tidy-ui", "config.json")
```

Pi resolves the agent directory, including `PI_CODING_AGENT_DIR`. This is neither a project setting nor Pi's `settings.json`. The full known shape is:

```json
{
  "syntaxTheme": { "kind": "pi" },
  "appearanceEnabled": true,
  "terminalColorsEnabled": true,
  "nativeHighlightingEnabled": true,
  "loggingEnabled": true
}
```

An independent theme uses `{ "kind": "occipital", "id": "<catalogue ID>" }`. Old theme-only files remain valid. Missing switches default to On, and a missing theme defaults to Follow Pi; reading defaults does not write a file. Saved choices load before presentation, providers, terminal-color application or logging starts. Initially disabled logging creates no journal, overview, retention scan or cleanup operation.

Confirmed choices apply and save automatically; there is no Save button. Theme-list navigation is temporary until confirmation and does not write settings. All switch/theme writes use the same `ExtensionSettings` writer, reread the latest document, preserve unknown fields and replace a complete JSON file through a private temporary file and rename. Switch confirmations enter that queue before asynchronous transport/writer cleanup: dismissing and reopening a popup cannot let an older completion overwrite a newer confirmation. Saves fail visibly without undoing the live choice. Invalid/unreadable files are not silently overwritten.

Shutdown/session retirement cancels unpublished pending saves; a rename already requested is the commit boundary. Disposed syntax owners cannot publish late theme selections. No file watcher, database, migration, cross-process locking or propagation into already running independent instances is added.

Only the theme choice and four switches persist. Cache counters, provider state, recovery budgets, log paths/identities and reapply/refresh/snapshot/clear actions remain runtime state. Reload and fresh processes restore preferences rather than enabling everything again.
