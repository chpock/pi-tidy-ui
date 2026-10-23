# Session footer

## Scope and ownership

pi-tidy-ui installs one noninteractive footer component through public `ctx.ui.setFooter`. It replaces the stock cwd/branch row, usage/model row and separate extension-status row, not the editor or native activity indicator. Cwd/branch and model/provider/thinking are omitted here because the eligible stock input displays them. Footer installation therefore requires pi-tidy-ui's recognized, still-owned stock editor. A foreign public factory (including one returning the exact stock class), subclass or overridden native presentation keeps the footer native too. Editor padding, autocomplete and temporary native selectors do not disable this input-ownership eligibility. Working/retry/compaction/future activity remains entirely Pi-owned in its native location.

There is one footer slot, not a stack of independent extension footers. The last public `setFooter` call wins. Pi calls our component's `dispose` when replacing it; that releases snapshots and records lost ownership. Off/shutdown restore stock only while pi-tidy-ui still owns the slot, never erase a later foreign owner, and do not reconstruct an earlier foreign footer. A later loss of editor ownership suppresses our rows immediately; one coalesced microtask restores stock through the public API after normal measurement, only if we still own the footer and the editor remains ineligible. No render-time container mutation, polling or extra editor render is used. Explicit **Reapply Tidy UI appearance** (under `/tidy-ui` → **Status & troubleshooting**) may reclaim the slot only with an eligible editor; after returning from a foreign editor use that action or reload to reinstall it, not automatic takeover of a possibly foreign footer. For native startup/reload with a temporarily mounted selector, initial installation waits for the stock editor. A weak snapshot of the guarded public footer slot and its single previous component permits that one delayed install only while the same owner remains; a later replacement cancels it. This does not enable general automatic reclaim. Reload restores the process-local appearance preference from memory before installing the footer; a new Pi process starts On. Footer installation does not intercept another extension's `setStatus` or `setFooter` calls. Print/JSON/RPC modes remain inactive.

## Internal data and composition flow

Three representations meet at `FooterView` in `src/footer.ts`:

1. **Numeric/context/title snapshot.** The host adapter supplies a `FooterData` object from public records, context/settings and saved-name state. `footerUsage` walks the supplied records once for cumulative totals and the rolling primary-assistant report history. `footerFirstMessage` supplies a title fallback from that same record snapshot, not another file read. Host semantic epochs/leaf/model identity determine when this input changes.
2. **Opaque current producer statuses.** Each render reads one public status-map snapshot. The footer neither captures producer objects nor intercepts their setters or parses extension-specific metrics.
3. **One latest row layout.** `FooterView` compares width, data/theme identity and the status key/value sequence. An unchanged tuple returns its retained rows; a changed tuple calls pure `renderFooter`, not usage aggregation.

The pure composition pass builds/truncates the statistics block first, sorts statuses by their keys, packs complete status entries beside it or onto subsequent right-aligned rows, then fills only the remaining first-row gap with the optional session label. Producer boundaries explicitly close both SGR and OSC8 link state. This keeps a producer's unclosed ANSI from coloring separators/padding while preserving its own visible styling.

Whole-status packing deliberately treats each public map entry as an indivisible producer-defined unit. Internal wrapping would require interpreting that producer's formatting; truncating merely to fill leftover space would lose information that can fit on the next full row. Only a value wider than an entire row is tail-truncated. The optional title is lower priority than both statistics and statuses, so it cannot change their packing.

The footer is neither the input metadata widget nor the native activity container. Its public slot ownership belongs to [host integration](host-integration.md); exact accounting, fitting and freshness rules follow below. Its retained rows have separate on-demand accounting, not another transcript-layout pool.

## Accounting and composition pipeline

The live adapter in `src/index.ts` supplies data; `src/footer.ts` calculates and formats it. There are two separate retained products:

- A **semantic snapshot** contains numeric totals, context data, the last ten primary cache reports and resolved title strings. Session/model/leaf and semantic-event identities determine when supplied records must be read again.
- A **layout** contains the latest terminal rows for width, theme, snapshot and producer statuses. Width, status or color changes can replace these rows without reacquiring history or recomputing context.

On a cold semantic refresh, the adapter borrows the public raw entry snapshot once. Usage aggregation and first-user-title discovery consume that same snapshot; they do not retain it. Cumulative totals and primary-assistant cache history use different eligibility rules below. Current context, auto-compaction and optional authentication state come from their own public sources, not reconstructed from totals.

Composition then formats one indivisible statistics status, obtains one sorted snapshot of opaque producer statuses, packs those whole statuses, and only afterward fits the optional session name into spare first-row columns. The title therefore cannot change another producer's placement or consume another row. ANSI isolation happens at producer boundaries; column/grapheme fitting precedes final placement.

A warm visit reuses the semantic snapshot and, when its layout identity also matches, its rows. Metadata-only renaming invalidates the name lookup without forcing a usage scan; a real intervening message append still invalidates numeric/context data. Native `Working` frames are not cache reports. The [freshness rules](#freshness-and-work) define these invalidation boundaries precisely; the host chapter defines the [events and slot lifetime](host-integration.md#semantic-events-and-snapshots).

## Statistics and sources

The ordinary order is one left statistics status, then opaque right-aligned producer statuses:

```text
[····█▅▂▁▁▁] CH98.5% • 105k/272k (38.4%)          mc: 104.5K (51%) · idle
[····█▅▂▁▁▁] CH98.5% • 105k/272k (38.4%) (auto off)
```

The values illustrate independent fields, not one arithmetically consistent traffic trace. The default order is the ten-report inverse cache-read graph, latest CH, then current context. Cumulative token totals, cache totals and cost/subscription remain implemented behind three source-only `FOOTER_FIELDS` flags in `src/footer.ts`, all false: `tokenTotals`, `cacheTotals`, `cost`. Edit source and reload to enable them; no runtime command or persisted setting is added. Hidden cost does not perform authentication lookups merely to prepare an invisible subscription marker.

- Aggregate all raw `ctx.sessionManager.getEntries()` records, not the current branch or compaction projection. Include assistant and usage-bearing tool messages, standalone usage entries, compaction and branch-summary usage, including abandoned history. Do not sum cumulative partial streaming updates or rewrite saved data.
- When enabled, ↑/↓ retain stock cumulative compact formatting, including initial `↑0 ↓0`; R/W appear only for nonzero cumulative cache-read/write tokens. These flags do not control graph/CH visibility. A first cold response with positive input and no cache reads must show a full error-colored bar and `CH0.0%`, even when cumulative R/W are zero.
- CH and its history use only raw primary assistant records. Compute `cacheRead / (input + cacheRead + cacheWrite) * 100` for each report, never a cumulative ratio, request-hit probability or token-weighted average of ten reports. Finite nonnegative input/cache-read/cache-write counts and a finite positive prompt denominator are required. An unavailable/invalid report is unknown, not zero. The latest unknown report shows muted `CH—` even when an older report is known. Side/tool/summary usage contributes to totals but does not advance CH history.
- Trust Pi's normalized usage without provider guesses. Some adapters normalize missing cached-token fields to zero, so a valid positive-input report with zero cache reads shows zero even if the underlying provider omitted that detail. No reliable cache-capability/availability signal is inferred from model/provider names.
- When enabled, cost uses three decimals and native visibility (nonzero total or subscription marker). `(sub)` follows the current provider's subscription-backed OAuth declaration/auth selection, including stock Pi's `kimi-coding` exception. It describes current authentication, not a subscription bill or proof that all historical usage used that authentication. Public registry/provider information supplies it; OAuth alone is insufficient.
- Take used count, maximum and percent together from `ctx.getContextUsage()`, including Pi's applicable routed limit/estimate. Do not reconstruct used tokens from a rounded percentage. Unknown used count is `?/272k`, without a percent. Undefined context usage omits the context block. Real estimates above 100% are not clamped.
- Effective `pi.getSettings().compaction?.enabled` supplies native auto-compaction state (default true). Enabled adds no annotation. Disabled adds `(auto off)`, even if context data is unavailable: dim parentheses, warning text. It warns about configuration, not an already full window; third-party context management and native compaction failures are separate concerns. Append a present context/auto-off block after cache information with dim ` • ` (one space on each side of the bullet); no trailing separator when both are absent.

Cumulative counters keep stock Pi compact formatting: integers below 1k, one decimal from 1k to below 10k, integer k up to 1M, one decimal M up to 10M and integer M thereafter. Context used/maximum have a distinct format: rounded integer k below 1000k; `X.XXM` from 1000k to below 10000k; `XX.XM` to below 100000k; integer M thereafter, retaining additional integer digits for larger values. Keep trailing decimal zeros. Normalize rounding carries before choosing a range: 999.5k becomes 1.00M, 9.996M becomes 10.0M, 99.96M becomes 100M. Examples: 104500 -> 105k, 1500000 -> 1.50M, 12000000 -> 12.0M, 1234000000 -> 1234M. Rounding affects presentation only; small known counts can round to 0k and remain distinct from unknown `?`.

## Cache-history gauge

The gauge is always formatted with `[` and `]` around ten one-column positions. Retain only the latest ten numbers/unknown slots in the existing usage snapshot, oldest left and newest right. Pad missing earlier history with muted `·`; unavailable reports also occupy `·` slots. The latest CH matches the rightmost report, not an older known value. Initial output is `[··········] CH—`.

One actual CH measurement update is one report. Current Pi/pi-tidy-ui CH reads finalized persisted assistant messages, not streaming deltas: each separate primary model response is a report, including reported usage on errors/aborts. Equal percentages on twenty consecutive requests remain twenty reports; only the last ten are displayed. Do not deduplicate by rounded text, collapse a tool loop into one final user-facing answer or add samples on redraw/semantic refresh. Streaming text updates do not manufacture CH reports. If the measurement source changes in a future host integration, preserve this report definition rather than implicitly collapsing intermediate measurements.

Restore from saved raw records on reload/replay/off-on. Model/branch/compaction/theme changes preserve the same raw-session chronology, including abandoned branches and earlier models. A new session has its own history. No additional persistence, timer, request hook or session mutation is needed.

Use a fixed inverse 0–100% scale and `▁▂▃▄▅▆▇█`; round CH to one decimal first and choose glyph index `round(7 * (1 - rate / 100))`. Thus 100% is the visible minimum `▁`, 0% the maximum `█`; nearby rates can share a height. Do not normalize to the minimum/maximum of the current ten samples. The graph helps spot repeated low cache reuse, not measure unique/cache-resident tokens, absolute uncached token volume, billing or latency. Each small/large request occupies one position. Red indicates low reported cache reads, not request failure.

## Colors

Use the current Pi theme. Unspecified numeric/annotation text is `muted`.

| Piece | Foreground |
| --- | --- |
| Arrow glyphs ↑/↓, R/W letters, $ glyph | `text` |
| Current used-context count, or unknown ? | `text` |
| `/`, `(`, `)`, gauge brackets and cache/context ` • ` | `dim` |
| Cumulative counter numbers, context maximum, sub text, cost digits | `muted` |
| `auto off` | `warning` |
| Unknown/padding `·` and unknown `CH—` | `muted` |
| Context percentage digits and % | Stock raw-percent rules: `error` above 90%, `warning` above 70%, otherwise `muted`; one decimal |
| Each known gauge bar and complete CH token | `success` at displayed rate >=95.0%, `error` below 80.0%, otherwise `warning` |
| Between-extension ` • ` | `dim` |

Round CH to its displayed one decimal before classification: 79.96 shows warning CH80.0%, 94.96 shows success CH95.0%. Context percentage deliberately retains stock raw-value thresholds instead. Producer colors/attributes inside statuses are not replaced with footer colors.

## Status fitting and overflow

Read one snapshot of public `footerData.getExtensionStatuses()` per render. One map entry is one opaque producer status, not necessarily one installed package. Sort stably by key using stock locale comparison; do not reorder for best fit, parse internal bullets or interpret extension-specific metrics. Normalize CR/LF/tab and repeated spaces and trim as the stock footer does. Skip zero-visible-width/empty entries. Close SGR/hyperlink state at each boundary so an unclosed producer style cannot leak into padding, our dim separator or the next status; preserve styling of its own visible glyphs.

When everything fits, statistics are left-aligned and statuses right-aligned on one row, with at least two blank columns between them. Join multiple statuses on that row by ` • `. If the next complete status cannot fit the remaining space, move it intact to a following full-width, right-aligned row; no leading/trailing separator is left at a break. If a status exceeds even an empty full-width row, truncate its tail with visible `…`, ANSI/column/grapheme-aware. Information loss in this case is explicitly accepted. Never internally wrap a status, truncate just to fill leftover space or emit an overwide row.

Our entire left statistics string is one complete status too: graph, CH, context, auto-off and any enabled optional fields must never wrap internally. If wider than a full terminal row, truncate its tail with the same ANSI/column/grapheme-aware dim `…`; information loss is accepted. Cache information comes first, so context loses space before the graph/CH; at still smaller widths the cache block itself can be clipped. Do not reduce the ten retained samples or add graph-height/width heuristics. Producer status packing starts beside this one statistical row, then continues on later rows when complete statuses do not fit. Different statuses may occupy different rows; this is not a globally one-row footer. Width zero returns no rows; tiny widths still cannot exceed the available columns.

Additional rows consume transcript height and are subject to ordinary Pi fullscreen footer clipping (`minSize: 0`). Native separate-status containers also have `minSize: 0`: with four rows, the one-row transcript minimum plus three-row editor minimum can leave both status and footer invisible. Their objects/rendered content remain active, and normal height recovery reveals them again; do not promise physical activity visibility at every height. No allocated-height heuristics, private layout hooks, overlay or alternate notification mechanism is added. This is one base line, not a fixed height under every width/height constraint.

## Optional session name

Pack statistics and producer statuses first using the rules above. Only then fill unused columns of the **first** row, after the entire statistics block and before its first producer status (or the end of the row), with the current session name. The name never shortens statistics, moves/truncates producer statuses, changes their right alignment, fills later rows or adds a row. If it cannot be usefully shown, retain the original footer exactly.

Resolve display text like native `/resume`: the latest nonempty explicit name from `session_info`, otherwise the first truthy user-message text in the raw session file order (including abandoned branches), otherwise `(no messages)`. String content is used directly; text blocks are joined with one space and image blocks are skipped. Empty/image-only messages do not establish the fallback; whitespace-only truthy text does, matching Pi before display normalization. Clearing an explicit name reveals this fallback rather than hiding all session information. A fork resolves from its own retained raw entries, not its parent's discarded records. Do not persist this derived label or reread session files/discover the session list for it.

Normalize the name for display only: remove terminal/bidi controls, collapse whitespace and trim. Empty names add nothing. Prefix a shown name with dim ` • `; the name and any suffix `…` use `muted`. Fit by terminal columns without splitting graphemes. A complete nonempty name may be as short as one column. A shortened name must retain at least **five actual columns of name text**, excluding the ellipsis and both separators; a five-column budget that only fits four columns of wide graphemes is insufficient.

If a complete name leaves more than three columns before a producer status on that row, retain the blank gap. Exactly three columns become dim ` • `. If fewer than three remain, reserve three for that separator and shorten the name under the minimum above, otherwise omit it. A shortened name before a producer status always has the right separator, with any grapheme-fit slack kept as blank columns. No right separator is added when the first row has no producer status, even if producer statuses exist on subsequent rows. Reserve the left separator, optional right separator and ellipsis in addition to the useful name text.

## Freshness and work

`src/footer.ts` aggregates supplied records and prepares themed rows; `src/index.ts` is the only live adapter. It caches a plain numeric/context/title snapshot by session ID, leaf, current model identity and semantic event generation. Session start/tree/compaction, model selection, completed messages/turns/tools/agent operations refresh that generation; leaf changes catch intervening appends. Get current auto/auth flags normally. Read the session name through public `getSessionName()` once when an eligible footer first observes a session and once after public `session_info_changed` invalidates that snapshot. Notifications can be delayed/reordered by other extensions' async handlers, so use the current saved name rather than an old event payload. Each notification requests a repaint of the still-owned footer through a weak TUI reference; delayed delivery does not rely on a future native frame. Multiple notifications before a frame coalesce into one name lookup. Session start/reload/resume/fork/new boundaries reset that name snapshot. The first-message fallback is borrowed from the same public `getEntries()` snapshot already required for numeric/context refresh: cache only its text string after finding the first truthy user text, and stop searching on subsequent appends or renames. Until it exists, a legitimate numeric/context refresh can discover it; no extra history read is introduced. Session-ID changes and footer disposal release/reset the fallback. Numeric title-lookup/entry-visit diagnostics verify zero fallback-source work on later appends once found, metadata-only rename/clear, warm/resize/theme/status frames. Name changes replace only presentation data; metadata-only `session_info` appends may advance the recorded leaf without invalidating usage/context, but an intervening non-metadata append still refreshes them. No name history search occurs on warm/resize/theme/status frames. Arbitrary unannounced mutation of existing persisted entries is not supported.

Retain one latest width/theme/data/status layout per component, outside both transcript accounting groups. **Status & troubleshooting → Display cache** estimates these saved footer rows separately and adds them to combined presentation totals without rebuilding or reading session data. **Clear saved layouts** releases the footer layout without resetting numeric usage/history accounting. The snapshot also retains at most ten cache reports and the resolved title strings, without source message/session/component references. Theme/width/status changes rebuild presentation without rescanning session history or rereading context. Ordinary warm and native Working frames must perform zero new usage aggregations, entry visits, history reads, context calculations or report additions. A new saved report refreshes history even if its CH text equals the previous report. Final saved usage changes rebuild from native records. No timer, new Git source, model request or execution interception exists here. Stock footer already avoids hot history scans; this design preserves that property, not a claim of inherently lower CPU or constant-cost whole Pi frames.

## Related contracts

[Input ownership and native activity](card-frame-spec.md#below-editor-metadata-working-directory-and-native-activity) define the complementary editor rows. See [footer validation](testing.md#footer) for accounting, fitting, lifecycle and real-terminal controls.
