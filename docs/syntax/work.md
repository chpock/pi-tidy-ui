# Source and style work

`SourceController` is the canonical authority for source work and fallback permission. `CardSources` supplies useful weak owner registrations; transport disappearance, retained paint and source execution evidence are not interchangeable. See [providers](providers.md), [request settlement](requests.md), [storage](storage.md), and [prepared cards](prepared-cards.md).

## Demand, execution and display advance independently

`SourceController` in `src/occipital/controller.ts` keeps three kinds of information that must not be collapsed into one readiness flag:

- **Current demand:** the owner’s requested text version, syntax hint, completion state and desired presentation.
- **Execution evidence:** queued work, physically held SOURCE jobs, validated outcomes and unresolved earlier execution.
- **Ready display:** a retained semantic view and its complete concrete palette/styles.

A source can have newer demand, an older request in flight and an even older ready display at the same time. Bash may reuse matching-prefix colors from that display; files require exact compatible coverage. Neither display path changes execution evidence.

`observe` records demand outside rendering. Source versions must be monotonic, and a version cannot silently acquire different text. Same-version warm observations can therefore return without another prefix check or byte measurement. New source text is admitted to the retention root before becoming dispatchable.

The source state’s `dirty` flag means SOURCE work remains to be considered. `styleDirty` means the semantic data or desired presentation requires style reconciliation. `blocked` records a refusal/protection that stops ordinary source dispatch. `uncertain` and the owned/shared unknown guards preserve execution evidence. These fields do not describe whether a card currently has useful colors.

Equal text can acquire a newer logical version without invalidating its semantic content. `contentVersion` records the beginning of that equal-content interval. It permits local coverage reuse; it does not rewrite the remote acknowledgement version or pretend that a completion request has already settled.

The syntax identity includes the selected explicit `language` (when present), `path` and source version. A changed first-line interpreter changes the explicit language and therefore invalidates source reuse even if the displayed body is unchanged. The bounded alias detector, per-side hint propagation and split/unified painting contract are described in [shebang-derived hints](shebang-hints.md). A style/theme change alone never changes this parser identity.

## One chronological registry, two separate admission questions

A card registers a `SourcePreparation` before expensive demand construction. Its registration contains a weak preparation reference and the existing set of source keys. A standalone source registers on first admission. Both occupy the same linked chronological registry.

The newest registration is visited first: **last registered, first considered**. Updates, retries and theme changes rewind the scan but do not move an older owner to the front. There is no sorted theme queue and no list of strong card/text subscribers.

Two different limits apply during a pass:

- The **host-turn preparation quota** bounds how many owners are reconsidered before yielding to the event loop.
- The **physical job/byte authority** bounds operations whose settlement is still outstanding.

Reaching one is not proof of reaching the other. Source, style and queued lease-close operations use the controller’s physical DATA jobs. Transport admission and the provider’s negotiated per-route limit remain additional checks. The module-level `flight` counters cover simultaneously living controllers from that module incarnation; they are not a cross-reload ownership registry.

A normal `flush` proceeds as follows:

1. Reconcile the published provider generation and discard obsolete remote-lease bookkeeping.
2. Dispatch eligible queued lease closes within the same physical capacity, avoiding a source that is still busy.
3. Resume the existing registry cursor from the newest unvisited work.
4. For each entry, try applicable style progress. Cached local progress must not wait merely because unrelated native jobs occupy both slots.
5. For a preparation entry, check its weak owner, pause state, pending flag and metadata-refresh revision. Ask `needsRefresh` lazily rather than eagerly traversing all cards when metadata changes.
6. Run `prepare` only if it is useful and its required admission is available. Source ownership that is still physically busy can be skipped while another owner uses available capacity.
7. Update the group’s membership seal, reconsider styles produced by the preparation, then dispatch eligible member sources.
8. Yield after the preparation quota. `setImmediate` resets that quota on a later host turn; synchronous flushes and promise microtasks cannot reset it.

A native-capacity failure records the need for another scan. Local-only pending work can continue past blocked native entries. Actual physical credit release wakes weak controller waiters and rewinds where necessary. This preserves progress for cached palette restoration without turning every warm frame into an admission attempt.

## Coalescing source updates and completing a stream

While a SOURCE request is outstanding, newer observations replace the latest admitted snapshot rather than creating parallel appends for that source. The request retains its own captured input and expected acknowledgement. When it settles, ordinary registry work considers the newest demand, not a stored queue of intermediate append packets.

`prepare` chooses the operation from current parser authority:

- No lease and complete input: finite `highlight`.
- No lease and growing input: `stream.open`.
- Validated lease: `stream.append` against its acknowledged revision and full-input byte count.

Append replies replace the provisional suffix beginning at the last committed boundary. A validated result advances the acknowledged basis, committed offset and lease state. It does not necessarily satisfy newer demand already observed while it was running.

Completion is a real authority transition even when no characters were added. A final append may carry an empty added string while closing the incremental parser state. Range adoption compares actual coverage/effects separately from revision metadata, so this acknowledgement need not rebuild identical geometry or paint.

A rewrite, changed syntax identity or resumed growing formation cannot reuse a lease merely because a display exists. Restart logic selects a fresh parser basis while preserving an independently owned display where allowed. Complete semantic coverage can survive compatible provider recovery; assets and vocabulary must match before it is reused as compatible native data. An incomplete parser state does not acquire a portable lease across providers.

The [prefix policy](#highlighting-volume-policy) applies before this process. Saturating the useful prefix makes the submitted source finite even if the complete displayed Bash command is still growing. Completion, offsets and revisions describe that prefix only.

## Refusals and held outcomes

When `workStatus` computes fallback permission, it first checks physical SOURCE jobs by logical key, including jobs whose payload or old state has been retired. A state without retained ranges can still have held native work. It also considers ready queued demand, frozen state, current uncertainty and earlier owned/shared unknown guards.

A local pre-dispatch refusal or a validated remote no-start fault can establish the disposition of that attempt. An arbitrary rejection or malformed response cannot. A later successful request does not erase an earlier shared unknown outcome.

Retirement requests cancellation but does not refund physical credit. Normal settlement releases the job’s reservation. Actual owned-helper cleanup can additionally supply generation-qualified stop evidence; it cannot clear an earlier shared attempt. STYLE success and retained colors never supply that proof.

Validated SOURCE success remains useful execution evidence even if local storage pressure refuses its colors. In that case the controller closes any returned live lease as needed, blocks the unfunded demand and retains the established display policy. It does not reinterpret a storage refusal as “native parsing never happened.”

Recovery permissions are explicit rather than frame-driven. `restart_required` consumes the source’s bounded resynchronization allowance. Evicted unchanged demand needs the existing explicit retry permission followed by a full current observation. Profile refusal produces a sequence-qualified metadata need; acknowledgement allows subsequent useful demand to reconsider it. The exact recovery bounds remain in [provider recovery](providers.md).

Native Off releases native payloads and ready groups but preserves records needed for held, frozen or uncertain source authority. Complete owner removal is a different boundary; its accepted reinstall exception is described in the provider chapter.

## STYLE work uses scopes, not another parse

Style selection is prepared separately from source observation. `setStyleSelection` installs a funded immutable selection and advances style work; changing rules, native definition or local bindings is not a reason to rewrite source text or reopen a parser lease.

For each eligible registry entry, `prepareStyles` determines the vocabulary from its actual semantic data. Frozen owners use their retained display view. It obtains unique live context handles through the incremental context index, then subtracts expressions already present for that vocabulary/rule identity.

If all expressions and required palette roles are available, publication is local. Follow Pi binding changes can materialize the same expressions with new public colors. Native cached roles permit equivalent cached restoration. These paths can proceed while native DATA capacity is full.

Otherwise the controller inspects existing physical STYLE jobs for the same vocabulary/rules and overlapping missing handles. Those few jobs are the overlap index: there is no separate subscriber queue. A coalesced owner can retain a primitive outcome receipt, while an ordinary credit wake revisits its registry entry. This prevents duplicate matching without retaining the waiting card through another owner list.

Before encoding missing descriptors, the controller admits the full incremental peak: encoding, captured semantic views, decoded result and complete materialization workspace. Materialization needs all captured contexts, not just the missing subset, because parser progress can occur before the reply arrives.

A valid obsolete reply may still install immutable expressions into the accounted cache. Publication has stricter checks: current selection, vocabulary, owner, membership revision and pause state must still agree. A paused card cannot receive the old dispatched STYLE as new ready paint, though accepted expressions may later be reused on resume. A frozen card can recolor its retained view without reviving SOURCE.

Positive coverage witnesses avoid repeatedly enumerating a group already known to have all required expressions. They identify the semantic source/view and arena invalidation revision. Actual expression loss invalidates that witness; merely changing metadata does not.

## Sealing and publishing one card

A **group seal** is the controller’s funded record of a preparation’s ordered source keys and their current owner incarnations. Registration alone does not establish useful membership. `updatePreparation` creates or reuses the seal after logical preparation; an explicit membership edit outside `prepare` must update it as well.

Style work checks the seal before capturing candidates and again before publication. Reusing a key for another source incarnation cannot make an old reply a member of the new card.

`publishStyles` constructs complete concrete roles and context styles for every member. `SemanticRetentionPool.publishDisplays` stages and funds the whole replacement set before committing any of it. All members must agree on vocabulary, rules, palette and binding identity; captured members must belong to the expected capture group. No user callback runs during the commit.

The controller then publishes the card group’s roles and member readers. Its reader-validity stamp can advance while its paint stamp remains unchanged if visible roles and member effects are equal. Different cards can publish independently; this atomicity does not impose ordered network completion or a transcript-wide theme barrier.

A card with no source members can still require a native palette. It follows the same registry and group-notification path without inventing a SOURCE acknowledgement. Similarly, locally prepared empty semantic coverage is not a native checkpoint: arrival of real text must begin a genuine parser generation.

## Surfaces and source text

- Native classification applies only to pi-tidy-ui's Bash command and successful edit/write source bodies, including Markdown files. Bash output is not classified. Ordinary summaries, user-message Markdown, the editor and native delegated cards remain outside this highlighter and its card palette.
- Bash argument updates prepare the latest command outside `render`. Pi's `setArgsComplete` finalizes the input independently of tool execution: a still-running Bash process does not require an unfinished syntax lease. Persisted completed calls use one-shot classification.
- A final live formation error retires native work and attempts lease closure outside `render`, without pretending that arguments completed or a tool executed. One already validated, budgeted display basis remains while its card owner lives. Obsolete replies cannot replace it; valid already-requested STYLE may advance it under the [current ownership and per-card publication rules](#sealing-and-publishing-one-card), without reopening SOURCE work. Warm frames cannot reopen retired work. A new restored terminal card, including an interrupted call, admits one finite native classification of its available saved text; source finiteness does not mean complete Bash arguments or tool execution. Public current-assistant tool-call IDs identify live ownership without history scans or retained messages, including abort before a useful frame; unknown embedding origin stays conservative. Warm/repeated/geometry-only visits reuse that static result. Positive execution/persisted `toolResult` evidence takes precedence over reconstructed incomplete flags. Partial error output and execution errors do not abandon the source.
- Edit/write use validated supplied source/diff data. Old/new sides are separate logical sources; a missing diff region starts a new parser context. No file reread or invented continuity across omitted context is permitted.
- Logical preparation first normalizes line endings and removes display-forbidden terminal/bidi controls. Parsing sees that normalized source before tab expansion, wrapping or paint; source offsets do not refer to raw streamed JSON, prompts or expanded-tab cells. Painting projects structured ranges onto existing display text, with unchanged glyphs, wrapping, gutters, context, tint, padding and mouse bounds. Existing ANSI style isolation remains authoritative.
- Classification does not modify tool arguments/results, execute tools, send model requests or alter saved conversation entries.

## Scheduling contract

One chronological `SourceController` work registry selects both preparation and native dispatch newest-first (LIFO). Cards register their existing weak tickets before heavy preparation; all native segments of an edit share that entry. Standalone sources register once on first admission. Updates/retries do not change registration order. Card preparation no longer has a separate sorted queue, and no numeric priority is passed between layers. A group awaiting fresh preparation cannot dispatch obsolete queued work. Busy/protected sources are skipped; accepted results publish independently, without an ordered-completion barrier. Already dispatched native jobs retain their physical reservations. It processes at most two owners per batch, using the existing job limit, and yields to the event loop before more work. The continuation holds only the weak controller; synchronous or asynchronously queued demand cannot schedule an unbounded preparation microtask chain. The host-turn barrier survives a momentarily empty pending set after dispatch; the one-shot stops without rescheduling if no work arrives. Existing controller/provider/global job and byte credits still govern native dispatch. A resumable cursor walks this same linked registry without copying/reversing the entire registry for each batch. Theme metadata advances one refresh revision in O(1); weak tickets check usefulness lazily. Native-credit exhaustion stops new-card/theme source preparation until real settlement; it does not defer live text changes or unrelated permitted fallback. Local-only pending work can pass native-blocked entries in the same registry; actual credit release reconsiders the skipped native work. File layout stamps track actual native/Pi display identity, not requested theme or work-state notices; resuming a temporarily unavailable projection replaces its plain cached layout without repeating classification. Profile-only supersession does not abort already dispatched work: let its bounded physical jobs settle, reject obsolete presentation, then dispatch the latest profile. Genuine lifecycle cancellation still reaches every pending generation of the same source incarnation. Canonical source owners receive validated terminal transport replies even after other local cancellations; malformed, lost and started/unknown outcomes retain their existing protective meaning. No polling, new payload queue or time budget; one large preparation is not preemptible.

## Rendering and fallback

Preparation, encoding, requests and classification occur outside terminal rendering. Rendering borrows already validated ranges or an exact prepared fallback; it never waits for a daemon. Keyed coalesced notices carry source keys **and primitive card-group IDs**, independently of display effects. Group notices also make source-less cards ready when only their complete palette was missing; existing weak ticket lookup reaches them without a transcript scan. A Bash card is invalidated only when its compatible display stamp changes, without traversing transcript history. Waiting/no-coverage preparation and equal-text finalization with identical styles do not rebuild or request a redraw.

The canonical `SourceController.workStatus` determines whether Pi classification is allowed. Queued, running or uncertain source work blocks a duplicate Pi parser within the same installed adapter. Style responses, cancellation, timeouts and provider absence do not prove that source parsing never started or has physically finished.

| Situation | Presentation |
|---|---|
| Validated semantic ranges and ready styles | Use the ready card's coherent palette and style table |
| Another code profile selected, not ready or refused | Keep the last validated native display; it is not classification proof for the requested profile |
| Growing/corrected Bash command with a compatible display basis | Reuse colors of the matching scalar prefix, including provisional styles; display every current character |
| Native work not started or unavailable, Bash | Whole command in the ready palette's command-neutral role (`toolTitle` in Follow Pi); **never call Pi's highlighter** |
| Native work not started or unavailable, file source | Reuse compatible exact display. With a ready native palette, missing syntax is native-neutral, not Pi-colored. Without any usable native palette, explicitly use whole-card Follow Pi, with one permitted exact Pi classification |
| Source/style work pending | Compatible historical Bash prefix or exact file fallback; otherwise complete text in the ready palette's neutral color. Styles never authorize a duplicate parser |
| Source/result cannot be retained or admitted | Complete text, with only any valid reusable classification |

The [Bash streaming contract](../bash-streaming-contract.md) supersedes the former complete-line-only Bash display rule. Historical colors are presentation data, not proof of current parsing, current parser state or permission for a second classifier. Scalar-prefix verification runs outside render when the prepared command or validated basis changes. Its cached eligible-byte proof is guarded by source revision and basis geometry identity; rendering and width/theme changes reuse it without rescanning text. New glyphs after the mismatch use the ready command-neutral role, with the explicit whole-grapheme first-scalar exception. No source normalization, range copying, verification walk or work scheduling is added to a warm body hit. File exact-fallback and parser incrementality rules are unchanged.

Completed Pi fallback ANSI is converted once into accounted flat ranges and immutable styles; the stored representation does not keep a second ANSI copy. It preserves public foregrounds and bold/faint/italic/underline/strikethrough, including SGR `22` clearing only bold/faint, SGR `29` clearing strike, and SGR `0` restoring the supplied neutral foreground and attributes. That neutral code role can itself carry supported typography (for example faint); SGR `0` does not unconditionally erase it. This differs from public-prefix sampling, whose reset starts from no attributes. Both inputs use one literal-style painter with explicit RGB/indexed/terminal-default colors and attribute resets. Per-token backgrounds are suppressed: the ready card palette owns code/diff-row surfaces.

Unlike semantic contexts, Pi fallback contains literal colors, not reversible scope/role annotations. A genuinely changed effective fallback palette may therefore require one newly permitted classification for that exact source/palette. Width changes, warm visits, an unchanged fallback palette and an independent native-theme change do not justify it. Failure/refusal caches are palette-qualified too; changing a palette never clears unresolved native-work barriers. A usable native palette must not trigger a Pi classification whose colors would then be discarded.

There is no millisecond budget, cold/warm timing gate, cooldown, sampling heuristic or per-frame classifier retry. A synchronous Pi fallback remains synchronous; moving it outside `render` does not make it an asynchronous parser. Exact source/palette reuse prevents ordinary repeated fallback work.

Pi fallback, semantic snapshots, contexts, styles and prepared geometry share the existing bounded logical-data authority. Charges follow actual storage lifetime, including captures and borrowed data after removal; existing cache cleanup returns geometry quota without another GC handler. Contexts are vocabulary-qualified. Styles are shared by live context and rule identity, and released with their owners; one ready display is retained, not a history of rendered themes.

## Highlighting volume policy

Native admission, client decoding and classification-prefix selection enforce these bounds. They cover classification and its data exchange, not preparation, normalization, wrapping, painting or virtualization of the complete card.

| Boundary | Default | Unit and scope |
|---|---:|---|
| Native classified source | **64 KiB** | UTF-8 bytes of the prefix of one logical source; not per line or update |
| Native classified lines | **8,192** | Logical lines in that prefix; stop at the first byte or line boundary |
| Finite SOURCE batch | **64 KiB / 8,192 lines** | Sum over all sources, still at most eight sources; do not multiply the allowance by eight |
| Public Pi fallback source | **8 KiB** | UTF-8 prefix, using the same bounded selection and line-count rules; file sources only |
| DATA request or reply | **512 KiB** | Complete serialized application JSON body, including envelope, all sources/contexts, rules and palette; request and reply each have their own bound |
| Expanded context descriptions | **65,536** | Total numeric scope IDs after expanding front-coded contexts across the entire SOURCE/STYLE job, not encoded suffix words |
| Decoded result | **2 MiB** | Existing controlled-allocation policy charge of the complete decoded SOURCE/STYLE message, inside the existing data authority |

All limits are inclusive. Empty text has zero logical lines; count each LF plus one for a nonempty unterminated tail. A final LF does not invent another empty tail. Blank lines count. CR in CRLF does not introduce another line. Prefix selection respects complete Unicode scalar boundaries and counts UTF-8 bytes, not JavaScript UTF-16 units, terminal columns or JSON-escaped bytes. JSON escaping is independently included in the 512 KiB message check. Smaller negotiated existing limits remain authoritative. A provider advertising DATA `reply_bytes` above 512 KiB is not suitable for this consumer and is rejected before SOURCE/STYLE work: a local post-decode cap cannot protect Node from a shared SDK that has already parsed an oversized reply. Use the existing descriptor field, not a new protocol negotiation mode. A more generous input allowance alone does not require rejection because the client can send a smaller request; `line_bytes` remains the classified-per-line window, not a maximum accepted line-length constraint.

### Coverage, streaming and refusal

Select the prefix before allocating its UTF-8/JSON source payload or invoking either classifier. Scan only as far as needed to decide the prefix; do not encode an enormous full source merely to reject it. Preserve the complete latest display text separately from the actual classification source. Native `source_bytes`, committed offsets, ranges, revisions and completion refer to the prefix actually submitted, never to an invented parse of its neutral remainder.

The prefix budget belongs to the logical source, not to an append RPC: streaming does not grant another 64 KiB or 8,192 lines on every update. Once the admitted prefix is finite, settle/close its parser lease even if real Bash arguments continue to grow. Further changes solely after that boundary do not send more SOURCE/STYLE or re-encode the classified prefix. Corrections inside covered text use normal versioned replacement/recovery; they cannot keep obsolete file styles as current proof. Prefix completion does not mean Bash arguments completed or a tool executed. Historical Bash first-scalar/grapheme projection, frozen/paused ownership and unresolved-native fallback authority remain unchanged.

The raw daemon/client data boundary refuses an over-policy source or aggregate batch; it does not silently truncate wire text while acknowledging full coverage. The UI selects the useful prefix explicitly. Native production rejects excess context/result growth before excessive owned expansion/serialization; the client checks before typed context/range allocation and retained interning. A small wire dictionary can still exceed the expanded-context limit, and many empty context rows can exceed the decoded-charge limit without exceeding the word limit. The three result guards are intentionally independent. Wire-size refusal is based on actual encoded size, not a pessimistic source-size multiplier.

The transport passes the admitted size to the client in call-local, out-of-band ticket/byte metadata: stdio uses the actual JSON frame-body length, shared ingress uses its existing bounded canonical-JSON count. The semantic decoder checks that size against the current negotiated cap without repeating the full payload traversal, then still validates identity, shape, ranges, contexts and allocation limits. This metadata owns no response payload and is not a cache or a wire field. Raw unknown-object decoder calls without matching transport metadata retain the complete accessor-safe byte check.

A refusal retains the established current/last-ready or neutral presentation and physical-settlement semantics. It is not permission to run unlimited Pi fallback, reparse SOURCE because STYLE failed, or retry the same rejected work on every warm frame. Pi fallback has the smaller prefix allowance and still obeys canonical native-work permission; Bash never calls it. A ready native palette keeps the unclassified suffix native-neutral rather than mixing in Pi syntax. Classification limits do not truncate tool/session data or add a second painter.

### Why these values

The bounds protect different costs rather than treating source size as a proxy for all work:

- **64 KiB native prefix:** useful asynchronous syntax coverage without admitting a very large synchronous JSON decode/adoption on Pi's thread. Parsing is native, but client decoding, validation and retention still cost UI-thread work.
- **8,192 logical lines:** many blank or short lines can cause many parser calls while producing a tiny reply; byte/frame caps alone miss that cost.
- **8 KiB Pi fallback:** public Pi classification is synchronous in the UI process, so its coverage allowance is smaller than the native asynchronous allowance. It is not a latency guarantee.
- **512 KiB DATA body:** envelopes, multiple sources, contexts and style tables make a reply larger than its source. The same bound covers SOURCE and STYLE; source-free control caps remain **4 KiB request / 32 KiB reply**.
- **65,536 expanded IDs:** front coding can represent a large scope stack expansion compactly. This bounds the expanded numeric scope storage independently of encoded JSON size.
- **2 MiB decoded charge:** rows, indexes, ranges and styles also consume controlled storage. This per-message ceiling uses the existing data authority; it is not another cache, a per-card cap or a measurement of allocator bytes.

No separately tunable range-count or nesting-depth policy is added merely to duplicate these bounds. Positive-byte ranges within 64 KiB already have a finite count; context/result guards cover distinct expansion costs. Existing exceptional engine-safety checks remain. No new wall-clock timeout, worker, queue, scheduler, hidden reclassification timer or arbitrary-language deadline is introduced.

### Existing authority and guarantees

The **1 GiB client logical-data authority**, shared **1 GiB controlled application ledger**, **two unsettled physical client DATA calls** and at most one append per source remain. Shared service limits remain sixteen outstanding DATA jobs across eight routes and 4,096 leases globally/512 per route. Leases expire after five minutes idle or one hour total age; no no-op heartbeat renewals. The native DATA wait deadline remains five minutes, not a claim that a regex can be interrupted. Source-free metadata stays independent; catalogue wait expiry does not destroy unrelated highlighting. The outer emergency framing ceiling remains separate from the much smaller DATA policy. Native admission failures must not leave uncharged persistent engine/binding capacity: surviving capacity is reconciled against the already admitted credit before reducing a failed job to its error envelope. The physical slot still belongs to that job through reply handoff or confirmed cleanup. Native lease/binding pruning merges the existing tables in monotonic incarnation order, avoiding a full slot search for every binding or an additional retained index.

Bounds on bytes/lines/expansion are not hard time or whole-process memory guarantees. A Syntect regex call and synchronous Pi `highlightCode` cannot be preempted by a JavaScript timer. Two valid replies may settle close together. A per-source coverage quota is not a cumulative CPU allowance for a whole event-loop turn or many independent Pi classifications; the existing useful-work scheduling remains separate. Parser heaps, Node/V8 transients and private SDK buffers are not application charges. In particular the public shared SDK can copy/decode before the application's validator; producer-side bounded replies matter, and a hostile unrelated peer is not made safe by post-decode validation. Public Rust SDK pre-handler body retention remains outside this application's admission claim. No hard RSS/OOM guarantee, infinite-input display protection or all-language latency promise follows from these values.

### Configuration authority

The production defaults are named together in `src/occipital/limits.ts` (`HIGHLIGHT_LIMITS`) and `crates/occipital/src/limits.rs`; `protocol/syntax-v3/highlighting-limits.json` is their shared numeric conformance fixture, not another runtime policy store. Keep the two small language-native tables and fixture in sync. No user-preference/menu/environment override or runtime file watcher is introduced. Increasing a coverage limit is not sufficient by itself: DATA size, expanded contexts, decoded charge and existing physical credits must still admit the corresponding work.

See [volume-policy validation](../testing.md#syntax-and-palette-validation) for conformance, boundary and real-transport controls.
