# Prepared cards, geometry and painting

`CardSources` connects an eligible host component to the asynchronous source/style controller and one common literal-style renderer. Full display text, admitted classification text, measured geometry and ready paint are separate representations. The [rendering chapter](../rendering.md) explains common text units; the [source/style chapter](work.md) owns scheduling and fallback permission.

## The card record separates preparation from usefulness

`CardSources` in `src/syntax/cards.ts` stores state in a weak map keyed by the host component. Its registry ticket holds weak owner/state/consumer references, source keys and detached cleanup receipts. The source controller can schedule the ticket without retaining the component or a duplicate source-text queue.

`updateDisplay` is the cold lifecycle boundary: it prepares what the first frame will need. It registers the owner before heavy work, obtains geometry funding, builds the replacement display and measurements, and adopts them only if the owner and mutation identity still match.

`useful` is a different operation. It marks a prepared revision as worth processing and queues the existing ticket. It does not normalize the source or classify it on the render stack. `prepare`, later invoked through the controller’s registry, constructs source demands and reconciles styles/fallback.

The record uses several existing identities:

| Identity | What changes it |
|---|---|
| `revision` | The overall supplied display revision |
| `sourceRevision` | The source-bearing part of the supplied input |
| `serviceRevision` | Output, diagnostics or other service presentation |
| `version` | Local source version advanced when the source revision changes |
| `processed` | Source revision last evaluated by useful preparation |
| `preparedTheme` / `preparedPalette` | Desired theme/public Pi input already considered |
| `mutation` | Validity of an in-progress synchronous preparation or visit |
| Display `geometryStamp` | Prepared regions/measurements actually changed |
| Paint publication / `paintStamp` | New paint ownership versus changed visible effect |

These are not interchangeable counters. An output-only update can change service regions while reusing command measurement. Equal-text completion can require source-authority work without changing geometry. A new reader publication can have the same visible paint.

## Prepare the full display, classify an explicit prefix

For Bash, display preparation obtains the complete normalized command and separately prepares description, output, reminder and footer regions. Unchanged regions reuse their measurements. An appended command can use transactional measurement append; a rewrite measures the replacement. Collapsed service sections prepare only the rows needed by their bounded previews while retaining their complete source strings.

For file cards, `prepareFileCard` supplies the validated logical view. `CardSources` constructs visible row descriptors and their coordinates in the underlying logical source fragments. It walks the full supplied lines to compute old/next coordinates even when some context rows are not displayed.

Continuity matters. A gap or nonconsecutive line position ends a source fragment. Old and next sides have independent fragments; a context row can have coordinates on both. Each descriptor records its fragment key, UTF-16 offset and UTF-8 byte offset. It does not invent missing file contents to join disjoint fragments. The exact saved-format rules remain in the [edit](../edit-card-spec.md) and [write](../write-card-spec.md) chapters.

Useful preparation constructs one Bash demand or the file view’s source segments. Keys remain associated with the card ticket and segment order, and every segment belongs to the same controller group. That grouping does not turn all segments into one unbounded request; individual native work still obeys shared physical admission.

`requestSyntax` in `src/syntax/work.ts` selects the classified prefix before native observation or permitted Pi classification. The full prepared display remains separate. Slot identity records the source version, language, completion, palette and fallback mode; the controller owns the actual admitted source and its execution evidence.

Bash always requests neutral fallback, never Pi classification. A file can request Pi fallback only when its palette state permits it and the controller grants execution permission. A usable native palette instead keeps missing syntax native-neutral. The complete classification and line policies are owned by [source work](work.md#highlighting-volume-policy).

## From semantic contexts to card paint

A source result provides semantic coverage, not an ANSI string. The controller’s STYLE path resolves missing contexts and materializes complete concrete roles/styles as described in [source and style work](work.md). `CardSources.refreshPaint` then compiles that accepted group for the card’s output mode.

Its paint token includes the actual group publication and actual Pi-projection effects, not merely the requested theme. Work-only notifications cannot impersonate new syntax colors. The compiler enumerates all needed styles, funds the compiled table and builds normal, added-surface and removed-surface variants. The surface colors come from the ready roles; token backgrounds do not choose a different card surface.

Adoption rechecks owner, mutation, input and previous paint identity. A partially compiled table is discarded. If the new roles and member effects are visibly equal, the new compiled owner can retain the old paint stamp, avoiding a redraw for a purely administrative publication.

When native paint becomes ready, the card releases its no-longer-needed Pi-input lease. Conversely, a native card whose semantic reader is lost can retain complete native roles and render missing syntax neutrally. Stale readers are retired; their disappearance does not justify mixing Pi syntax into the retained native palette.

Source-key and group-ID notices are resolved through the existing ticket maps. They affect only still-owned records. Changed paint invalidates the relevant prepared component, and render requests are coalesced into a microtask. No transcript search is needed to discover which card belonged to a result.

## Measuring once and reflowing numbers

`measured-rows.ts` represents measurement as numeric glyph data. Each grapheme contributes its UTF-16 end, UTF-8 end, display width and flags such as tab/newline/whitespace. A temporary per-measurement memo avoids repeated width calls for identical graphemes during that measurement; it is discarded before returning. The retained measurement owns numeric storage, not a long-lived text-key memo.

Append preparation cannot assume that the old final grapheme remains complete. It remeasures that grapheme and the new suffix, stepping back farther when completing an isolated high surrogate could join the new scalar to the preceding grapheme. The candidate is checked before adoption. Commit transfers reusable capacity or adopts geometrically grown storage; failure preserves the old measurement.

Reflow consumes those stored widths and flags with a width/mode policy. It produces numeric rows and spans for source glyphs, tabs, replacement glyphs and Bash prompt cells. It does not resample the theme, invoke a classifier or call the width calculator again. Measurements retain their independent lifetime while layouts refer to their valid basis.

The common [rendering pipeline](../rendering.md) owns scene/frame composition. At this boundary, the useful distinction is that new width needs a new arrangement of existing measurements, whereas new source text can require new measurements. A color-only change needs neither.

## Monotonic painting

`paintFlat` in `src/syntax/flat-paint.ts` combines prepared row spans with ordered style ranges. It advances one row/span/glyph cursor as ranges arrive; it does not restart a source scan for each range.

Before a style interval, gaps paint with the neutral style. Within the interval, eligibility is tested at the glyph’s original first-scalar byte offset. A whole grapheme receives that chosen style, including when a validated historical prefix ends inside the grapheme. Prompt spans use their dedicated role; tab/replacement spans use their prepared cell widths. After the final style interval, the remaining glyphs are neutral.

The caller supplies the source-match proof and eligible byte count. The painter does not decide that old Bash text matches current text, or that a file’s classification belongs to its current version. Those decisions happen during preparation and publication.

Output allocation is funded while pieces and joined rows coexist. Each emitted piece encloses its style; final row strings become detached accounted output. An invalid range visitor or geometry lookup rejects the entire candidate and releases provisional pieces/rows. Frame composition consumes accepted paint under its separate [frame contract](../card-frame-spec.md).

## Pi fallback becomes the same kind of paint input

After `requestSyntax` obtains permission to call Pi, the returned rows are treated as external data. Their retained allocation is funded, then `preparePiFlat` in `src/syntax/pi-flat.ts` checks row sequence and visible text against the exact submitted source.

Every visible scalar must match. Row boundaries must correspond to source newlines. Malformed or unsupported escape sequences, changed text, missing rows or an invalid producer visit reject the whole candidate. The conversion does not normalize the classifier’s answer to make it fit.

Accepted foregrounds and font state become immutable literal styles and byte ranges. Background controls are parsed but do not replace the supplied card surface. Detailed font/color interpretation belongs to [Follow Pi](follow-pi.md) and the [color model](../color-model.md).

The result is staged and transferred into root retention; the original ANSI rows are released. Rendering then uses the common painter, not a second ANSI-row rendering branch. Since these styles contain literal colors rather than reversible semantic scopes, a changed effective fallback palette may require a newly permitted classification. Width changes do not.

## Following one owner through its lifecycle

Consider an eligible completed write card whose supplied file content is already prepared and whose provider is compatible.

1. **Installation/update:** `updateDisplay` creates the full logical file view, visible row coordinates and measurements. It records source and service revisions without waiting for native syntax.
2. **Useful visit:** `useful` queues the existing weak preparation ticket. `prepare` creates the finite source segment demands and updates the controller group.
3. **SOURCE/STYLE:** the controller admits source work, adopts validated semantic coverage, resolves missing styles and publishes one complete group. The card compiles that group and changes its paint stamp only if effects changed.
4. **Warm frame:** the caller uses retained geometry/paint identities and accepted row retention. No source observation or classification is performed merely to redraw the same state.
5. **Resize:** the same measurements are reflowed for the new usable width. Existing style readers paint that arrangement; SOURCE and STYLE identity are unchanged.
6. **Recolor:** desired selection changes through metadata. The controller reuses semantic scopes, requests only missing expressions/palette data or binds cached expressions locally. The card keeps its old complete paint until replacement is ready, then repaints without remeasuring or reflowing unchanged geometry.
7. **Removal:** `remove` deletes the weak-map association and releases the ticket. Unregistration removes its source group; cleanup receipts release measurements, descriptor storage, compiled paint and Pi leases. Late work can settle its physical liability but cannot republish into that owner.

For streaming Bash, step 1 repeats with current full command text. Output-only revisions reuse the command measurement. A useful active append schedules current source demand; equal-text finalization can still schedule authority work without rebuilding the command body.

Pause, freeze and restore change this trace differently. Pause retains the owner but stops new useful admission until resume. Freeze ends live source continuation while retaining the exact view eligible for recoloring and reflow. Removal ends ownership. A restored interrupted card is a new owner, not a resurrection of the frozen live parser.

On provider readiness, an eligible restored file with only exact Pi fallback can receive its first native SOURCE through the existing registry. It keeps fallback until its complete native group is ready. Older cards are lower priority, not permanently excluded. Paused, frozen, removed and refused owners retain their existing guards.

## Palette and geometry independence

Only syntax glyph color/attributes change; token backgrounds never replace structural row surfaces. Native themes own **all** card-interior roles: code/plain/unknown text, padding, numbers/gutters/signs, frames, errors, reminders and service/footer regions. Pi-colored edges are not a native-mode fallback. Before any usable native palette, an explicit whole-card Follow Pi fallback is allowed.

One accepted publication couples a card's palette with all its source styles, including both edit panes. Keep the old ready presentation until the new one is complete; a stale, rejected or exceptional candidate cannot partially replace it. An unchanged neutral preparation, waiting notification or completion-only acknowledgment changes authority without changing paint. Borrowed visits expire on replacement/removal, and failed outer visits release provisional layout/paint candidates before publication.

Text is prepared on installation and semantic updates, before the first frame. Color-free measured geometry owns reusable glyph widths, tabs and grapheme coordinates. Theme changes reuse measurement/reflow; width changes reflow locally without source/style requests or repeated width measurement, even after Pi's unrelated width-cache traffic. One flat painter combines prepared rows with ready indexed styles. Rendering does not sample a theme, normalize/classify/encode source or admit RPC work. Height-only clipping and unchanged warm frames reuse prepared data and borrowed row arrays without walking all retained glyph dependencies. Full dependency validation remains at construction/publication boundaries; a warm hit does not bypass ownership or mutation checks.

Argument appends reuse stable prefix measurements and prepare only the affected final grapheme plus the new suffix. Completing an incomplete UTF-16 scalar may also join the preceding grapheme; that boundary is remeasured before adoption. Numeric capacity grows amortized rather than copying the whole glyph vector on each append. Suspended readers keep old storage charged until callback exit. Display measurement tolerates an incomplete surrogate as a replacement scalar without changing the original tool text or relaxing classifier admission. Oversized replacement glyphs occupy their complete declared cell width; variable padding is constructed only after funding.

Collapsed Bash output and reminders prepare at most eleven logical rows per section, enough for each existing ten-visual-row preview plus its overflow witness. Repeated result updates do not measure hidden remainder. Expanding prepares all missing rows through the same lifecycle before render; collapsing releases hidden measurements. Complete source/result strings remain available, and command geometry is not rebuilt for output-only updates.

Theme changes renew useful weak tickets but do not change parser identity, reopen leases or discard successful parsing. Missing style contexts are resolved outside render; retained styles support rollback/revisited themes without another request. Desired native rules reconcile before testing DATA capacity; a prepared card's Follow Pi restoration may also reconcile local bindings and cached styles without DATA credit. Both kinds of local cached rollback must remain independent from two unrelated unsettled requests. Missing SOURCE/STYLE work still passes the shared physical admission authority. The two-owner LIFO scheduler coalesces previews and publishes different cards independently. Ready file syntax must match its actual text version, not merely the latest requested version. Equal-text finalization preserves geometry/paint identity while settling native obligations.

Compatible recovery reuses complete parsed scopes and current ready styles, even while native credits are busy; missing styles may be resolved without source replay. Changed assets/vocabulary and incomplete parser state retain explicit source-recovery behavior. Interruption stops continuation/new SOURCE requests to Occipital, not acceptance of correct already-requested STYLE results for the text currently displayed. Such a valid result may advance the retained presentation after interruption without another SOURCE request or lease revival. Interrupted calls also retain theme recoloring and local reflow. New STYLE work over retained paint must enumerate and capture that same view; this consistency requirement must not reject an already-captured valid pending result merely to preserve an older display identity. Explicit pause, including zero usable width, instead prevents new SOURCE/STYLE admission and publication of already-dispatched STYLE into that card until a new useful visit resumes it. Physical work still settles, and valid styles may enter the accounted cache for reuse on resume; pause does not release unsettled credit by assumption. Removed/collected owners cannot resume or publish. Native Off, genuine pressure eviction and owner removal retain their named release semantics. Off retires native groups but prepares an eligible custom neutral/Pi-role card rather than reverting Bash to the host's raw argument representation; it never enables Pi classification for Bash.

Cold restore treats an exact Pi file capture as provisional when Occipital becomes available. Every useful, unpaused registered file owner without retained semantic SOURCE can receive its first native SOURCE through the existing bounded LIFO registry, subject to canonical execution authority and physical/byte admission. A newer Bash or file owner determines priority, not whether older files may upgrade. Keep each card's fallback until all its semantic segments/styles are ready; no click is needed to admit the upgrade. Complete retained scopes are reused on warm visits and compatible recovery, not reparsed. Paused, frozen, removed and refused owners retain their existing lifecycle/admission semantics; this does not introduce an unconditional transcript sweep or retry loop.

While Occipital is unavailable or a request cannot be admitted, Pi fallback has less scope detail and does not promise the new delimiter shades or Markdown strike. Pi loads some grammars after its initial history paint. An early Pi fallback for such a language may remain uncolored in the exact cache even after the grammar loads, until the source, palette or presentation owner changes. This visual limitation is explicitly accepted: no readiness polling, private Pi hook or classification-cache reset on general screen invalidation is added. It does not remove text or affect native-daemon classification.
