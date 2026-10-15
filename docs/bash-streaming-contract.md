# Bash streaming: display and work contract

**Status: implemented and verified on Linux with Node 22.19.0 and Node 26.7.0; independent code review closed.**

The primary task is to replace the rules that produce unstable presentation and unnecessary work. Individual fixes follow this contract, not the other way around. This contract is Bash-specific; it does not replace edit/write Pi fallback, parser correctness, transport recovery, resource limits, card geometry or the independent release scheme.

The overlapping sections in `syntax-highlighting-plan.md`, `syntax-highlighting-spec.md`, `bash-card-spec.md`, `render-cache-spec.md` and `debug-logging-spec.md` are updated together. This approved contract intentionally replaces the prohibition on displaying old provisional-tail styles and the coupling of source retirement to display deletion. Implementation findings, observable-counter evidence and final acceptance are recorded in `.test-artifacts/bash-streaming/{review-disposition.md,verification.md}`; the restored-card correction has separate evidence in `.test-artifacts/bash-restored/verification.md`.

## 1. Evidence and actual failure

Investigation baseline: `03268fb03d1db4ac6c624753f8e8278748355069`. The explicitly supplied journal was frozen for analysis: 567559 bytes, 2355 complete lines, SHA-256 `6860de4c11bd2075a61aabb5f8fc550e272d10f95c70cacf849ec700bbad32b0`.

| Observed work | First Bash call | Second Bash call |
|---|---:|---:|
| Native `updateArgs` callbacks | 252 | 262 |
| Prepared source versions / accepted results | 96 / 96 | 76 / 76 |
| Custom layout builds | 148 | 130 |
| Committed-line parser calls | 6 | 0 |
| Provisional-tail parser calls | 92 | 75 |

There were 173 native dispatches: two opens, 170 appends and one close. The second command is one logical line: before completion, its colors are provisional, not a committed prefix. Dropping those colors after every input revision is therefore not cured by preserving completed lines alone.

The first command ended while its arguments were incomplete, without execution. Its source removal erased the colors and left a misleading `execution failed` footer. The underlying `WebSocket closed 1000` text comes from Pi's provider client; this journal does not establish why the connection closed.

A real-SDK host experiment with controlled RPC delivery established three extra body builds with identical ANSI rows. Measured deltas were:

| Transition | Body builds | Explicit invalidations | Host render requests | Native requests |
|---|---:|---:|---:|---:|
| Already dispatched first reply remains held; prepared waiting display is rendered | 1 | 0 | 0 | 0 |
| Same-text argument finalization before final reply | 1 | 1 | 2 | 1 |
| Completion-only acknowledgment | 1 | 1 | 1 | 0 |

The finalization's two render requests include the original Pi setter's request, which must remain, and an additional adapter request. A body rebuild is not by itself evidence of explicit invalidation or a request. The waiting result is scoped to that experiment's boundary, not attributed to a particular invalidation path without further proof. This is not a native CPU benchmark or a replay of the real provider stream. The real journal independently demonstrates the last case; Rust's empty-final-append path emits cached tail runs and closes the lease without parsing.

These counters do not measure CPU time, frame counts, disk writes, wire bytes or physical allocation. Reserved bytes are protective accounting; cumulative source bytes are not incremental transmission volume. No repeated committed-prefix parsing, native failure, restart or repeated terminal-color I/O was established.

Evidence and method: `.test-artifacts/journal-audit-20261013/{counters.md,analyze.mjs,host-counter-probe.md,host-counter-probe.ts}`; independent findings and Oracle review are retained with this investigation. The evidence directory contains the authorized private journal and is not a distributable fixture.

## 2. User-visible invariants

1. **Always show the complete latest display-normalized command.** Do not wait for classification, freeze old rows, delay streamed characters or alter native arguments/model/session data. The existing `blockText` normalization, prompt, tabs, wrapping and frame geometry stay authoritative.
2. **Waiting is not a reason to erase colors.** A new revision, queue entry, in-flight RPC, acknowledgment, lease transition, finalization or formation error cannot by itself turn an unchanged colored prefix into whole-command `toolTitle`.
3. **Reuse historical styles for the matching prefix, including provisional styles.** When text is appended, retain the last validated style of matching old characters. New graphemes without applicable styles use `toolTitle`. Each current grapheme is indivisible and takes its first scalar's style: if that scalar matches the basis, the whole grapheme inherits it, including any newly appended combining/joining scalars. A fresh accepted classification may legitimately change token styles.
4. **Corrections invalidate from the first mismatch onward.** Match the scalar prefix; a current grapheme whose first scalar lies beyond that prefix is neutral. The indivisible-grapheme exception above applies if a mismatch occurs inside the current grapheme. Do not reuse arbitrary equal suffixes, search for repeated text islands, or color new text using old byte offsets.
5. **Retained styles are display history, not current-source proof.** They may temporarily be lexically outdated after appending text. This is the explicit trade-off for continuity. They do not validate new source text, provide a parser checkpoint, authorize Pi/native parsing or reset a crash budget.
6. **Bash never uses Pi's classifier.** With no compatible retained styles, display the entire current command using `toolTitle`. The first native color upgrade is expected; repeated loss of colors solely because another result is pending is not.
7. **Formation failure freezes display, not parsing.** Stop abandoned native work and close its lease; keep compatible cached colors for the command still present in the card. Never execute incomplete arguments or restart parsing to recover an abandoned call's colors.

The no-flicker guarantee concerns scheduling/authority transitions of the same retained presentation. It does not prohibit real native token-style changes, changed text, an explicit theme/mode change, actual cache eviction or complete presentation-owner replacement. It does not promise perfect current lexical coloring while a newer classification is pending.

## 3. Separate facts, not separate source owners

The existing source/controller remains the single owner of native work and retained source data. Expose three distinct facts without introducing a second source-owner system or a general readiness framework:

- **Latest display target:** current normalized command and display identity; width and other presentation arguments remain layout concerns.
- **Validated display basis:** the existing acknowledged immutable source text, its complete validated compact classification, language/profile identity and a display-effect stamp. Full classification includes provisional colors, not only `committedBytes`.
- **Work authority:** latest useful native demand, in-flight captures, uncertainty, completion, lease/recovery state and parser permissions.

The controller currently stores an acknowledged basis separately from the latest desired snapshot. Reuse that representation. Add a canonical read-only basis-view interface; do not duplicate full strings, encoded buffers, classifications or caches in the host. The view must pair ranges with the exact text they classified. A visitor clipped according to the newest demand's committed-prefix rule is insufficient for historical display reuse.

Reading a view does not observe a new demand, acquire credit, dispatch a request, change fallback permission or keep a Pi component alive. No current-version/exactness decision may be inferred from availability of the view alone.

## 4. Projection and compatibility

On a cold layout, project the latest normalized command against the validated basis. While doing the existing glyph/UTF-8 traversal, verify the matching scalar prefix and apply its styles to current graphemes according to their first scalar. After the first mismatch or basis end, remaining graphemes are neutral except for the already-started matching grapheme. No separate whole-source hash, diff, matching-suffix pass or eager per-callback encoding is allowed.

This deliberately permits **bounded display compatibility checks inside cold layout projection**, replacing the broader old restriction that prevented using the full latest text before deferred preparation. It does not permit classification, source admission/normalization for RPC, source encoding or dispatch inside `render`. Use the command representation already required by ordinary Bash display; do not add another normalization pass solely for reuse.

- Compare display-normalized text, never raw streamed JSON or raw ANSI/control characters.
- Match Unicode scalar boundaries; preserve the existing first-scalar style ownership of a displayed grapheme. A mismatch cannot retain a partial UTF-8 sequence or split a surrogate pair. A newly appended combining mark or ZWJ sequence can enlarge a matching grapheme: the entire current grapheme inherits its matching first scalar's style, with no ANSI inserted inside it. This is the explicit exception to new-text neutrality; current glyphs and geometry always win.
- Keep logical source offsets distinct from prompt columns, expanded tabs and soft-wrapped rows. Description, cwd and output are never classified as command text.
- Reuse requires the same presentation/source owner, language and compatible effective syntax profile. A temporarily missing provider description is not proof of profile incompatibility.
- Pi category roles may be reprojected using the current public palette without reclassification. A deliberate incompatible independent RGB profile change cannot silently reuse the old profile as the new one.
- Width/padding changes rebuild geometry only; they do not create a new logical source or native request.

Warm layouts use the existing cache signature and a primitive display stamp. They do no compatibility traversal, normalization, source-buffer allocation, parser work or new diagnostic emission.

## 5. Scheduling and lifetime

Preserve the existing useful-demand boundary and coalescing. Real argument callbacks cheaply record current identity; they do not each become a native request. A normal render may record the existing weak useful-demand ticket; preparation/admission/encoding/dispatch remain outside it. Do not add a viewport subsystem or call an already visited component necessarily visible.

- Keep at most the existing in-flight source capture and latest waiting demand per source. Repeated/identical updates coalesce; metadata-only description/cwd/result changes do not parse the command.
- Initial startup and later connection loss share one availability-wait path. A useful Bash demand deferred specifically because an enabled provider/effective profile is unavailable marks its existing card/source slot. On compatible readiness, revisit all such live weak tickets through the existing dispatcher, using each owner's latest revision. Do not scan conversation history, retain owners/text in a separate queue, reclassify already-current sources or replay every file fallback. Frozen, paused, removed, collected and bookkeeping-refused owners are not revived; a paused owner requires a fresh useful visit. Metadata-only loss does not reevaluate an unchanged processed Bash revision or relabel its prior refusal as an availability wait; a real source change can create new demand.
- An explicit code-theme selection or changed effective profile ID/fingerprint renews all previously useful retained owners, including completed Bash and file sources, through the same weak-ticket scheduler. Track prepared/requested theme revision independently of text revision. Offline choices remain pending for readiness; ordinary same-profile recovery does not renew completed work. Old incompatible native styles are not painted as the new profile, including cached file layouts. No conversation scan, source copies or strong owner queue; paused owners wait for useful demand and live-frozen/removed/collected owners stay retired.
- Take accumulated card demand from newest to oldest, using stable source-ticket creation order rather than its latest update/retry. The pending list contains only existing weak tickets; issuing a batch removes its newest entries without sorting the entire backlog each turn. Already admitted native work is not cancelled or reprioritized.
- Prepare no more than the existing two-job credit limit of card owners in one batch; yield to the event loop with a weak one-shot continuation before another batch. Synchronous or asynchronously queued notifications cannot replace that continuation with an immediate microtask chain. Keep the barrier even when the pending set is momentarily empty after a flush; the one-shot continuation stops without further scheduling if no demand arrives. Native RPC admission still obeys controller/provider/global byte and job limits. There is no idle polling, time budget or new queue/payload store. One individual source preparation/classification is not preemptible and has no hard latency guarantee.
- Append continues the existing native stream; corrections use the existing bounded source-restart rule. Historical display styles do not change parser-basis selection. Parser-generation replacement must not delete a compatible historical display basis merely because the old parser stream is retired. Retain one charged display basis while the latest replacement demand is prepared; do not accumulate a history of snapshots.
- Finalization remains mandatory for an existing stream, even with no appended bytes. It settles authority and releases the native lease. It is not an unnecessary RPC merely because the cached tail needs no parsing.
- Live abandonment ends work admission for that installed call owner, aborts/retire-closes through the existing transport authority, and freezes the current display basis. A late result cannot revive it or replace the frozen presentation; it may still settle genuine physical obligations.
- A restored terminal card is a new static display source, including an interrupted call with incomplete Bash arguments. Classify its available text once as a finite snapshot under ordinary useful-demand/provider admission; do not reopen a continuing stream, execute the command, alter argument-completion/execution/error flags, or require persisted colors. Cache the result for ordinary frames/geometry changes. A public assistant-stream tool-call identity distinguishes live owners from restored owners, even when a live abort precedes the first rendered frame. Remember only primitive IDs for the current message until the next assistant message, agent end or session replacement; never scan history or retain message bodies. Embedders without this semantic identity preserve the conservative live-error behavior.
- Work retirement and presentation-owner removal are different operations. Display eligibility is independent of permission to admit new work: an abandoned command can remain an owned display without being a live source demand. Owner removal, full adapter disposal and GC release the retained display data; abandoned calls must not require a live daemon lease to keep their colors. Geometry-only changes, including a temporary zero usable width, do not replace the source owner or discard its basis. They may withhold new useful demand without freezing the call as terminal.
- Retained active/frozen views remain charged to the existing bounded source-retention budget. Borrowing cannot keep uncharged payloads alive after pool removal. No new count caps, full-source copies or pressure-driven replay loops.
- Genuine eviction may remove historical styles, with an explicit reason. An abandoned live owner never resumes parsing because its frozen view was evicted; new-owner static restoration is the separately authorized case above.
- Cancellation, rejection and missing provider state are not proof that an RPC did not start. Existing unresolved captures/credit/fallback evidence remain held until the existing completion or actual owned-process cleanup authority resolves them. Other sources continue independently.

A direct bounded freeze/retire distinction in the existing controller/consumer is preferred over a separate display service, disconnected cache or reference-ownership framework. Interface names are implementation choices; the lifetime obligations above are not.

## 6. Notifications and layout invalidation

Work-state notifications and display changes have different effects. Continue delivering all genuine settlement, permission, credit, lease and recovery facts. The Bash host does not invalidate a layout solely because such a notification arrived.

Invalidate only for current text/presentation/geometry changes, palette/profile effects, retained-style loss, or a classification/basis change that can affect projection. In particular:

- admission/waiting with no new display coverage does not discard the already correct neutral layout;
- setting argument completion without text/style change does not discard the command layout;
- accepting a completion-only cached-tail result preserves the layout while updating acknowledgment/completion/lease state;
- changes that genuinely color new characters, revise styles or make a different basis applicable still request the required repaint;
- error/output changes can rebuild the card while retaining the command's compatible display basis.

Maintain a display-effect stamp alongside canonical retained data, separate from request/source revision and native authority. Determine compact classification effects during the already required decoded-range installation, comparing the touched normalized style spans when necessary; do not add a second whole-source scan, hash, speculative row build or equality cache. Equivalent captured text/styles with changed completion metadata keep the stamp. Zero parser-call counters, equal row counts or equal source length alone are not style-equality proof.

Existing keyed observers may keep their signatures if the consumer can read the primitive stamp. Introduce a broader notification interface only if that minimal interface cannot satisfy the contract, and obtain approval before implementation.

## 7. Error presentation and diagnostic coverage

Use known native lifecycle facts, not a generic `isError` bit, to describe failure:

- final error with known incomplete arguments and no execution: **`[error: incomplete tool call]`**;
- known execution failure: preserve the existing applicable exit-code/timeout/`execution failed` policy;
- unknown phase: a generic tool-call failure, not an invented execution or provider diagnosis.

Keep the producer's error/output text unchanged as ordinary card output. `WebSocket closed 1000` is not a daemon failure and does not reveal the closure's cause. This work does not patch Pi's provider client or mask an incomplete response.

Logs describe current facts with separate fields for display basis/version, latest target revision, historical/provisional reuse, actual work phase and initial demand outcome. A record cannot present an initial `waiting` outcome as the current execution state or imply that a generic settled fallback veto means Pi was used for Bash.

Do not emit one identical lifecycle record per `updateArgs`. Use existing source/preparation/publication records for source progression, actual phase/geometry/result changes for lifecycle, and aggregate already counted callback/source-update totals at completion/error or explicit snapshots. Preserve description/cwd changes that genuinely affect layout without logging their content. This changes diagnostic coverage deliberately, rather than adding timed sampling or dropping errors.

Add role/stop-reason fields only where already supplied by public semantic-boundary events. Do not scan session history, read raw messages, dump provider errors/stacks, or add private provider hooks. Clarify local-only policy versus a no-op shared-selection callback and normal missing optional Git-backend paths. No JSON journals/indexes, extra clocks, per-frame records or record-level filesystem checks.

## 8. Derived correction plan

Implementation is authorized under this contract. Keep changes in the relevant seams rather than imposing a repository-wide refactor.

| Stage | Work | Acceptance before proceeding |
|---|---|---|
| 1. Canonical display basis | Add full validated-basis view and independent display-effect identity; distinguish frozen display retention from retired native work. Keep source-budget and physical-job authority correct. | Focused first-red controls for text/range pairing, budget accounting, freeze/late-result behavior, completion-only effects and first-owner GC. No duplicated full-source buffers or daemon-protocol change. |
| 2. Bash projection | Paint the full latest normalized text using matching-prefix historical styles, including provisional tail. Remove revision-gated whole-command fallback without reusing old rows. | One-line and multiline append, correction and held-reply tests verify current glyphs and prefix foregrounds before deferred preparation, while pending and after reply; zero Pi calls. |
| 3. Host lifecycle/cache | Retain command display on formation failure; separate work notices from display invalidation; completion/mark-execution/output flags only change what they actually display. | No-effect waiting/finalization/acknowledgment cause zero extra custom builds/invalidation/requestRender beyond original native lifecycle redraws. Changed classification still repaints. Native lease/captures close correctly. |
| 4. Error/log clarity | Phase-accurate footer; display-vs-work logs; reduced callback duplication and truthful startup/Git labels. | Real phase/description/cwd/result changes remain diagnosable; raw content absent; warm records/I/O zero. No inferred WebSocket root cause. |
| 5. Integrated acceptance | Update superseded specs, test both supported Node runtimes, real helper and physical Pi live/replay. Independently review actual corrected files and saved evidence. | All affected focused/type/unit/SDK/GC and final UI/CLI/replay gates pass. Report remaining gaps, not arbitrary unrelated skips. |

The canonical view, lifecycle separation, cold-projection permission and diagnostic-coverage change are explicit operator-approved cross-component/product decisions in this document. Do not implement an interim gate bypass, eager parser dispatch or retained old-row workaround first.

## 9. Regression and observable-counter gates

Test native ready/unavailable/off, late discovery/replay, multiple independent cards and these concrete sequences:

1. **Single logical line, held reply:** append repeatedly after one colored result. Every previous matching character retains its color while waiting; all latest characters are shown. New unclassified characters are neutral. No whole-command fallback cycle or duplicate Pi work.
2. **Multiline append:** both committed prefix and previously displayed provisional tail remain continuous. Completed-line parser calls account only for newly completed lines, not old-prefix replay.
3. **Correction:** reuse only the matching prefix; never an equal suffix after a mismatch. Include non-ASCII, surrogate/scalar boundaries, combining/joining glyphs, tabs, controls, narrow widths and soft wraps. Appended combining/ZWJ scalars inherit the style of their current grapheme's matching first scalar; no ANSI splits that grapheme. Reconstruct the current displayed command against the ordinary Bash display control.
4. **Initial no-coverage wait:** one initial neutral body. After admission/drain with its RPC still held, an unchanged render does not rebuild it. Genuine first coloring does.
5. **Completion-only:** hold the final empty append after exact text has been shown. Completion and acknowledgment alter no command colors/body; the real helper reuses its tail and removes the lease. A counter-zero but style-changed controlled reply must still repaint: counters are not equality authority.
6. **Abandoned formation / static restoration:** freeze cached colors in the live owner, show the incomplete-call label and unchanged producer output, stop source work, close the lease and reject late publication. No execution, resurrection or classification on later width/redraw in that owner, even if no useful frame preceded the abort. Keep actual unresolved physical reservations until proven settled. Close/reopen Pi or reconstruct a new historical owner: admit one finite native classification of the saved available text, including unclosed quotes; warm frames/resize add zero classifications and the error/args/execution state remains unchanged. Missing/off native keeps `toolTitle`, never Pi.
7. **Real failure and deliberate changes:** execution/timeout labeling remains correct; owner removal, mode switch, incompatible profile and genuine eviction follow named invalidators. Temporary provider loss alone does not erase otherwise compatible retained colors. Category-palette reprojecting does not parse.
8. **100 warm frames and width round trip:** warm work/build/request/log/I/O deltas are zero; width changes only add required geometry projection. First-owner active GC and frozen-owner cleanup pass with `--expose-gc`.
9. **Coalescing under held work:** many input updates leave one latest waiting target rather than a request per callback; current text stays visible, other cards progress. Count dispatches, meaningful native work, builds, invalidations and explicit host render requests separately.
10. **Real Pi live/replay:** reproduce the two shapes and provider-error phase with the isolated scripted provider, actual helper and held replies. Inspect physical foreground cells across the stream, not only final screenshots. Preserve strict native tool/model/session content equality; replay geometry/glyphs match.
11. **Availability backlog:** restore multiple Bash cards, including an interrupted first call, before releasing a held actual acquisition. Each demanded card receives one finite classification. Kill the isolated owned process, create multiple new demands while its replacement is held, and verify the same ready path colors both without reparsing earlier results. Test 1/2/4/8 weak owners, latest-version coalescing, removal/freeze/pause/GC/refusal and a host event-loop callback after at most two preparations, including reentrant demand. Warm/resize add zero native work.

During implementation use focused affected `node --test` controls and `npm run check`; use `--expose-gc` for ownership. Run broader affected integration checks before delivery. Reserve the full `test:terminal` for final UI/integration acceptance; include affected syntax-terminal cases per `testing.md`. Run both exact minimum Node 22.19.0 and current Node 26. No new installations/user-service changes, tags, publication, commit or push follow from approval to implement unless separately authorized.

## 10. Finding dispositions and remaining boundaries

- **Bash color cycles / first changed-frame prefix loss:** addressed by the new historical-prefix projection rule, not by preserving the obsolete completed-line-only display policy.
- **First command loses final colors:** separate live work retirement from frozen presentation retention; source cleanup remains mandatory. Restoring a new historical card classifies its available text as one finite snapshot rather than inheriting the old owner's permanent work freeze.
- **Misleading execution-failure footer:** addressed by phase-aware presentation.
- **No-effect wait/finalization/acknowledgment builds:** addressed by display-effect identity and targeted counter gates, not by suppressing native finalization.
- **Historical `outcome=waiting`, generic Pi permission and local shared-candidate labels:** clarify meaning; they are not evidence of stuck RPCs, Bash Pi parsing or prohibited shared I/O.
- **Streaming lifecycle journal volume:** change coverage explicitly as above; callback count alone was not proof of expensive parser work or excessive disk I/O.
- **Four Git rediscoveries / missing `reftable`:** no refresh-policy change in this plan. Same branch text does not prove watch identity is unchanged. Deeper Git optimization needs a separate controlled replacement/worktree/backend study; do not delete `agent_end`, watcher rebinding or permanently memoize optional-path absence.
- **71 accepted versions without an exact-native paint record:** not proof of wasted requests; older results can advance the basis and logging/rendering coalesce.
- **Repeated normalization on warm Bash frames:** not established by the journal. A separate actual-SDK control checks the two existing normalization operations directly, including a positive observer control; preserve current raw-identity/memo reuse rather than inventing an extra normalization cache.
- **Footer/editor/animation/terminal-color failures, native leaks/restarts, 268-MB physical allocations:** not established; no speculative fixes or altered limits.
- **Provider WebSocket closure:** unresolved upstream cause, outside this extension contract. Do not execute truncated arguments or hide the error.

The operator approved provisional-prefix display reuse, bounded compatibility checks during cold projection, frozen-view retention and reduced callback logging. Implementation and independent review are complete for the documented Linux scope; the linked verification record distinguishes focused, real-helper, physical CLI/replay and broad regression gates. Actual historical physical-frame counts, CPU/RSS/I/O cost, Windows behavior and provider closure cause remain unclaimed.
