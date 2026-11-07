# Settings menu and saved preferences

## Service and popup boundaries

Three owners cooperate without sharing one lifetime:

| Owner | Responsibility | Does not own |
|---|---|---|
| `ExtensionSettings` (`src/settings.ts`) | Validate/load the file, serialize local writes, preserve unknown data and watch external publication | Overlay state or provider startup |
| `TidyMenu` (`src/tidy-menu.ts`) | One overlay with root/theme/support/service/log/cache pages, list/search/scroll state and the current preview rollback point | Session runtime, saved-file authority or source work |
| Host `TidyMenuOwner` (`src/index.ts`) | Supply cached snapshots; explicitly prepare preferences, preview a choice or perform a typed action | A second settings file or independent highlight queue |

The popup's `snapshot()` is read-only cached inspection. `prepareThemes()` establishes preference readiness; `previewTheme()` changes the current palette selection synchronously without persistence or provider activation. `act()` handles confirmed switches/themes and explicit maintenance actions. The host guards asynchronous continuations with its session epoch; the popup separately guards its own close/page/visit identity. A provider generation change therefore need not destroy navigation, while a late action cannot reopen a closed overlay.

A palette travels through **preview or confirmation → selected preference → effective local palette → complete ready card paint**. The file stores only confirmation; the local manifest resolves effective availability; the work controller publishes paint only when the card's input and semantic styles are ready. These stages explain why a successful local selection or file save is not proof that every visible card has already recolored. See [provider choice and readiness](syntax/providers.md#selected-effective-and-ready-palettes).

## Entry and navigation

Bare `/tidy-ui` opens one centered popup in Pi terminal mode. Each page fits its header, full item labels and values, selection gutter and basic navigation, using terminal-column widths. The preferred width is capped at 72 columns and Pi clamps it to the available terminal width; 72 is not a fixed window size. Descriptions, diagnostic details and error text wrap within that width rather than widening the popup. Theme sizing considers the complete local palette list, not just visible or filtered choices. Page/content changes can resize the same overlay; arrow movement, help changes, detail scrolling and search do not. Resizing the terminal preserves the preferred width when space permits and recenters the actual overlay, including its mouse bounds. Paged detail views use a compact navigation line when needed to retain the paging and back keys.

Menu items share a label column and a left-aligned value column, separated by two spaces. Submenu arrows occupy their own rightmost column, not the value text. Preferred width combines the widest label and the widest value across the full page, plus these gutters and indicators; it is not the longest individual row. Filtering and scrolling do not recompute column positions from a visible subset. Under the width ceiling or a narrow terminal, labels and values are ellipsized against shared boundaries rather than intruding on each other's columns. On/Off remains complete when enough room exists for a label, value and gutters; extremely small layouts keep compact keyboard access without promising every field fits.

Command arguments are no longer supported: they report usage and perform no action. Print/JSON/RPC modes do not open a menu.

The first page contains:

- **Tidy UI appearance** — requested styling for eligible cards, messages, input and footer.
- **Code color theme** — opens the family picker; it does not change Pi's overall theme.
- **Code color variant** — toggles Dark/Light for the chosen family and confirms the pair immediately. With Follow Pi selected it remains visible in the dim color, but is disabled: keyboard and wheel navigation skip it, and pointer/Enter activation cannot change it. The remembered variant is retained for the next owned family.
- **Set terminal colors from Pi theme** — apply Pi's theme to the terminal background and default text color, separate from card styling.
- **Status & troubleshooting** — actual appearance/color/highlighting state and less frequent controls.
- **Close**.

The theme row is initially selected, so the first Enter navigates rather than toggles. Header and bottom navigation are separate sections divided from the body by horizontal rules. After the menu, one empty row precedes exactly two reserved description rows for the selected item. Short descriptions leave the second row empty; longer ones end the second row with an ellipsis. Very short terminals omit the frame/header/navigation before giving up description space; below four rows only the compact list/details fit. Arrow keys navigate without wrapping on every page, including filtered theme lists: Up on the first item and Down on the last item leave selection unchanged. Disabled rows are still skipped. Enter confirms, Escape returns one page or closes from the first page; Ctrl+C closes. Fullscreen mouse clicks activate content rows, not borders. Disabled-origin pointer gestures stay inert even when an external preference change enables the row before release. A transient press-origin marker distinguishes no press, an accepted native press and a disabled press; list rebuilds discard native acceptance but retain disabled rejection until the final click or a new press. An accepted native press on an enabled row still confirms that original row if recentering places the disabled variant under the release coordinates. Narrow/short layouts retain keyboard access; Page Up/Down scroll detail text without skipping hidden rows. All pages occupy the same overlay, independent of the presentation adapter or syntax-provider generation. The native editor is not replaced or transferred.

Pi's native list wraps keyboard selection unconditionally. The popup consumes outward Up/Down actions at its current first/last item before native delegation, using the public selected item and the already retained page order. It uses the same configured select keybindings as the native list; wheel clamping and pointer gestures remain native. A boundary key does not change preview or save preferences.

The list's confirmation callbacks run synchronously and may close the popup before delegated keyboard or mouse handling returns. Once closed, that input event must stop menu processing: do not read the disposed list, update selection/preview or request another popup render. Mouse confirmation still returns the native handled result; subsequent input and repeated close/dispose calls do not reopen or complete the interaction again. Dismissal removes the popup frame from the terminal, and reopening creates a fresh usable menu.

Appearance Off leaves the menu and independent logging usable. On/Off values show preferences, not availability. Actual limitations are explained separately; automatic/system Pi themes retain native control of terminal colors.

## Theme picker

The searchable, scrollable list offers **Follow Pi theme**, 36 owned theme families, and **Back**: 38 rows, not one row per light/dark palette. Dark and Light are selected separately on the root page. Choosing an owned family from Follow Pi uses the remembered variant, initially Dark; changing that variant afterward is a second confirmed action. Follow Pi uses the common semantic definition through the same Rust resolver as every owned palette. An independent selection owns all prepared Bash/read/edit/write text-card colors, not only syntax tokens. Read's opaque host image block is borrowed without recoloring its pixels or native fallback; compact read remains a summary rather than preparing a hidden themed body. Pi's editor, summaries and global theme are unchanged. Search matches family display names and stable family IDs, not separate concrete palette variants. Duplicate/control-like labels are disambiguated without using their text as action identity; terminal controls are escaped.

The internal selected preference is one family/Follow-Pi choice plus its remembered variant. `resolveTheme` maps a known family and variant to one existing concrete palette ID; effective/ready palette identities and asset lookup remain concrete. Follow Pi ignores the variant for painting, not for remembering the preference.

Opening waits for preference readiness, not a delay or provider-readiness guess. Root/status inspection never constructs syntax or starts a provider. Opening the picker may prepare preferences but does not enable appearance/native highlighting. The bundled palette list is local; an unknown saved ID remains selected while effective presentation temporarily uses Follow Pi, with one bounded issue rather than a fabricated list entry.

Arrow/wheel navigation and search preview the highlighted theme immediately, without saving. Opening the list alone does not change the theme. Enter or a completed mouse click confirms and saves once, then returns to the first page without a progress or success message. A mouse press preserves the native pending-click identity; hover does not preview. Empty search results and action rows are not themes.

Escape, Back, Ctrl+C or disposal without confirmation restores the confirmed choice from entry to that particular theme-list visit, not from the first opening of the whole popup. An external confirmation during a local preview updates this rollback pair without interrupting the preview: Escape applies the latest external family and variant, while Enter saves the local pair that was previewed. The variant is fixed for that picker visit once preview begins; it cannot be silently replaced by an external variant at confirmation. Before the first local preview, an external confirmation can refresh both the visit selection and variant. Reopening the list after a confirmation creates a new rollback point. Deferred preference readiness from a cancelled visit cannot establish a later visit's rollback point. A failed save keeps the live selection and says it was applied but not saved. Closing during confirmed work is not rollback; late work cannot reopen a closed popup. Selected/effective differences are explained without duplicating equal values.

Preview and rollback use the ordinary retained-owner palette revision and bounded newest-first preparation. Fast navigation coalesces to the latest demand; already-dispatched work is still accounted, but late results cannot restore a superseded preview. Coloring a large history remains gradual. Source parsing is palette-independent: preview resolves only missing styles/input, and already-retained styles support local rollback/revisit. Ready colors remain visible until the replacement card palette and all its source styles can publish together. Preview never cancels a previous confirmed save, and completing that save cannot overwrite the current preview. Unconfirmed choices are client-local and do not survive runtime/session retirement.

A **new confirmed selection** cancels the previous client-owned theme-save request before queuing its replacement. A real native-highlighting enablement change and client disposal also cancel that outstanding save. Preview/rollback and temporary terminal suspension do not. Cancellation cannot undo a rename already requested: confirmation order controls pending publication, not retroactive file rollback.

## Troubleshooting

- **Reapply Tidy UI appearance** and **Reapply terminal colors** retry an already enabled preference without changing or enabling it. Terminal-color Reapply rereads the theme and resends defined OSC targets even when the remembered RGB is unchanged, so an external reset can be repaired; it does not reset absent/unowned channels. Ordinary refreshes still deduplicate. While Pi has yielded its terminal, no application occurs; native restart reconciles current eligibility and targets.
- **Use Occipital highlighting** is the native-highlighting preference. Off stops new SOURCE/STYLE work and releases semantic payloads while retaining local palette preparation: missing code can use the selected palette's neutral role; where the Follow Pi contract permits, exact cached file highlighting remains available and Bash stays whole-command neutral. It does not stop a user-managed shared service.
- **Highlighting service details** reports cached provider/version, selected/effective palette and issue state without new classification or discovery.
- **Diagnostic logs** shows capture, paths, identity and separately named **Runtime errors / active**, **Log write errors**, and **Dropped records**; runtime health remains available with capture Off or an unavailable/failed writer. Dropped records explicitly mean incomplete evidence, not extension errors.  **Record diagnostic logs**, **Retry recording** after failure, and **Write state snapshot** are explicit actions. Snapshot never enables recording.
- **Display cache** shows frozen-on-request details, per-kind counters and diagnostic JSON. **Refresh statistics** reads existing counters. **Clear saved layouts** releases only presentation data and captures its receipt synchronously, before a scheduled native repaint can rebuild layouts. Subsequent frames rebuild on demand; neither conversation nor native syntax data is cleared.
- **Refresh status** only reads current state. It does not load palette assets, parse sources, retry a service, or enable a feature.

Reversible changes, snapshots and display-cache clearing have no confirmation dialog. Preference changes do not show automatic-save reminders, progress text or saved-success messages. Errors and explicit diagnostic-action results stay inside the popup without replacing its two description rows; unexpected background runtime failures use coalesced public error notifications and stay visible under **Status & troubleshooting**. The root marks that page **Issues** while owner-specific failures remain active; provider readiness or success of another card does not clear them. Safe cause codes, UTC failure time and recovered/owner-removed disposition are visible, with no source bodies or recurring health polling. Counts reset for the new session runtime on session transition/reload. Full failure, recovery and deduplication semantics are in [runtime health](debug-logging-spec.md#runtime-health-is-not-log-writer-health).

## Persistence

Preferences share the existing user-level file:

```text
join(getAgentDir(), "extensions", "pi-tidy-ui", "config.json")
```

Pi resolves the agent directory, including `PI_CODING_AGENT_DIR`. This is neither a project setting nor Pi's `settings.json`. Explicit `agentDir`/`file` injection in `ExtensionSettings` is an embedding/test seam, not another production project/session override policy. The full known shape is:

```json
{
  "syntaxTheme": {
    "kind": "pi"
  },
  "syntaxThemeVariant": "dark",
  "terminalColorsEnabled": false,
  "nativeHighlightingEnabled": true
}
```

An owned family uses `{ "kind": "theme", "id": "github" }`, with `"syntaxThemeVariant": "dark"` or `"light"` as a separate top-level key. Only exact `"light"` selects Light; a missing or unsupported variant means Dark, independently of Pi or terminal color mode. Follow Pi retains that remembered variant while its control is disabled.

Known old concrete IDs such as `github-dark` and `github-light` are recognized as family `github` on read. The old suffix never supplies the variant: an old `github-light` without the new key therefore selects GitHub Dark; set `syntaxThemeVariant` to `"light"` explicitly to retain Light. Known family IDs take precedence over suffix recognition, so `one-dark` remains the One Dark family and the old `one-dark-light` resolves to that family, not `one`. Unknown IDs retain the existing selected-but-unavailable behavior rather than being guessed from arbitrary suffixes. Loading/watching does not rewrite an old document; an explicit theme or variant confirmation saves the canonical family and variant together. Switch-only saves leave untouched theme keys unchanged.

A prior `{ "kind": "occipital", ... }` value is still invalid under the strict theme-object schema. A missing `terminalColorsEnabled` defaults to Off; a missing `nativeHighlightingEnabled` defaults to On, and a missing theme defaults to Follow Pi. Explicit saved booleans keep their values, including an existing terminal-color On; reading defaults does not write a file. Shared choices load before presentation, providers and terminal-color application start.

**Tidy UI appearance** and **Record diagnostic logs** are local to the running Pi process. Their two boolean values live under a private `globalThis` symbol, with no component/session references or filesystem flag. They survive `/reload` and opening another session in the same process; a new process starts both On. Local Off is restored before presentation or journal initialization, so disabled capture creates no journal, overview, retention scan or cleanup operation. Legacy `appearanceEnabled`/`loggingEnabled` file fields are ignored and removed on the next explicit persistent save, not by a startup migration.

Confirmed theme/variant pairs and the two shared switches apply and save automatically; there is no Save button. Each theme or variant confirmation submits both wire keys in one patch through the existing writer; another process cannot observe a separately published family and variant. Theme-list navigation is temporary until Enter/completed-click confirmation and never writes settings. Local switches do not enter the persistence queue. Shared writes use the same `ExtensionSettings` writer, reread the latest document, preserve unknown fields and replace a complete JSON file through a private temporary file and rename. Saved files use pretty JSON with two-space indentation and a final newline. Existing compact files remain readable and are reformatted only on an explicit persistent save, never just by loading or watching them. Confirmations enter that queue before asynchronous transport cleanup: dismissing and reopening a popup cannot let an older completion overwrite a newer confirmation. Saves fail visibly without undoing the live choice. Invalid/unreadable files are not silently overwritten.

Shutdown/session retirement cancels unpublished pending saves; a rename already requested is the commit boundary. Disposed syntax owners cannot publish late theme selections.

### Validation and forward-compatible data

Input files and serialized replacements are capped at **64 KiB**, including indentation and the final newline in saved output. A formatted replacement over the cap is rejected without changing the previous file. Reads require valid UTF-8 and a JSON object, and read no more than the cap plus one detection byte even if the file grows after stat. Malformed known theme objects and switches invalidate the whole document, rather than partially salvaging preferences. The deliberate exception is `syntaxThemeVariant`: unsupported values are accepted and interpreted as Dark, without invalidating other valid settings. Initial failure reports an error and uses Follow Pi with terminal-color application Off and native highlighting On; an invalid subsequent external update instead retains already-live preferences.

Theme objects have exactly the keys of `{ "kind": "pi" }` or `{ "kind": "theme", "id": "..." }`; `variant` is not embedded inside them. IDs are opaque, nonempty, well-formed family strings of at most **64 UTF-8 bytes**, not paths. Persisted switches must be booleans. Internal update patches accept only `"dark"`/`"light"` for `syntaxThemeVariant`, even though external unsupported values are read as Dark.

Before upgrading from a saved `{ "kind": "occipital", ... }` choice, or downgrading after selecting an owned `{ "kind": "theme", ... }` palette, manually change only `syntaxTheme` in the extension settings file to `{ "kind": "pi" }`. Do this before switching versions: the current schema intentionally rejects the retired discriminator, and invalid files are not automatically rewritten or saved. Use the Occipital v4 helper matched to the current extension release; v3 helpers are not compatible with its syntax protocol. See the [palette contract](syntax/palettes.md) and [README recovery guidance](../README.md#troubleshooting-and-feedback).

Unknown data survives a save, including own prototype-named keys and numeric JSON tokens whose values exceed JavaScript's faithful number representation. Native JSON source-token/raw-value APIs preserve overflow, large integers, decimal precision, underflow and signed zero. If a numeric token cannot be preserved with those APIs, the operation reports `numeric-preservation-unavailable` rather than rounding or rewriting it. This preserves data and numeric tokens, not original whitespace formatting.

An update validates and copies its patch **before queuing**, so later caller mutation cannot change the admitted choice. Its unique temporary file is created exclusively in the same directory with mode `0600`; failure cleanup removes only that operation's own temporary file. Complete-file rename is atomic publication, not an `fsync` or power-loss durability guarantee. Independent processes remain last-actual-rename-wins; no transactional merge or lock is implied.

## Changes from another Pi

An active runtime watches the configuration directory, not the replaceable file. If it does not exist yet, watch the nearest existing ancestor until the directory is created; watching alone creates no files/directories. After subscribing to an ancestor, startup tries descending toward the desired directory again, closing the directory-creation window between a failed child subscription and the successful ancestor subscription without polling. Relevant filesystem events coalesce into a one-shot check of device/inode, size and modification/change timestamps. Read and validate JSON only when these metadata change. Unrelated filenames are filtered before stat. There is no periodic stat/read/hash, polling interval or watcher timer in idle Pi;100 idle instances perform no recurring configuration I/O.

Valid external settings apply to the running family/variant pair, terminal-default preference and native-highlighting preference without writing them back. Pair equality includes variant even under Follow Pi, so a variant-only change refreshes remembered state and the disabled row. Only changed known values trigger application; local appearance/logging remain untouched. A local unconfirmed preview stays visible as described above. A malformed/unreadable update retains the last live values and reports a bounded warning; deletion applies missing-file defaults. A failed native watch reports its failure rather than silently falling back to polling. Native event delivery depends on the filesystem/OS; a reload retries monitoring.

Each runtime closes its watcher and pending one-shot work on shutdown/reload; retired reads cannot publish. Reads wait for locally queued writes and discard a result superseded by a newer local write. Independent writers retain the existing last-actual-publication policy; concurrent distinct patches are not a transactionally merged database. No cross-process locks, database or sidecar/index files are added.

Only the confirmed theme/variant pair and two shared switches persist. Cache counters, provider state, recovery budgets, log paths/identities and reapply/refresh/snapshot/clear actions remain runtime state.
