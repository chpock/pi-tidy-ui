# Provider selection, preferences and recovery

This chapter describes the extension client, not the daemon process. Construction, useful presentation attachment, provider publication and ready card paint are different boundaries. The [daemon runtime](../occipital/runtime.md) owns native threads/routes; [client requests](requests.md) owns correlation and physical settlement.

## Construction is not activation

The client is assembled before it is allowed to start a provider. `createSyntaxOptions` in `src/occipital/bootstrap.ts` captures the extension’s agent directory, current working directory and session identity, and creates the settings and provider-factory options. It does not launch Occipital. The captured session identity is metadata for a shared route; it is not a source-text store.

`SyntaxRuntime` in `src/syntax/runtime.ts` constructs `SyntaxClient`, its source controller and the public Pi-input owner, then leaves the client disabled. This allocates local bookkeeping, not a connection or helper process. The runtime’s enabled preference and the client’s current eligibility are deliberately separate: an enabled preference cannot activate native work without an active presentation.

Attachment supplies that missing condition. `SyntaxRuntime.attach` stores a weak reference to the presentation and schedules a microtask. The microtask checks the live presentation again before enabling the client and starting it. If the presentation disappeared or became inactive between attachment and delivery, startup does not proceed. Opening a menu can restore preferences through `prepareThemes`, but cannot bypass this attachment check.

`SyntaxClient.start` joins two independent operations: preference restoration and broker startup. Native source admission remains disabled until the preference is known. Conversely, restoring the preference does not establish that a compatible provider exists. Cards observe both conditions through cached client metadata; neither settings restoration nor a menu snapshot constructs source demands.

The callback path is also separated from the work path. Provider and source notifications reach the runtime through module-scoped weak callbacks. The runtime forwards them only to its current active presentation. Source notifications contain source keys and card-group IDs; they do not carry a captured card or a second copy of its text. The scheduled notification reads current state rather than replaying an old provider snapshot.

## From a factory result to a published provider

A **candidate** is a transport that has been created but has not yet become the client’s provider. A **published provider** is a candidate whose descriptor has passed broker validation and whose lifetime is now represented by a broker generation.

For shared service, `connectionCandidates` in `src/occipital/discovery.ts` returns a narrow ordered list rather than scanning ports, processes or directories. Explicit selection and `SUBC_CONNECTION_FILE` are exclusive. Otherwise the runtime-directory, home-directory and temporary-directory candidates follow the public discovery ordering, with duplicates removed.

`createSharedFactory` in `src/occipital/factories.ts` tries those candidates sequentially within one absolute attempt budget. `SharedTransport` first loads the public SDK, connects, resolves the syntax capability and opens its internal-service route. Its `ready` promise means that route initialization succeeded—not that the Occipital descriptor is compatible.

The factory therefore hands each ready route to the broker’s negotiation callback. `ProviderBroker.describeCandidate` performs the source-free descriptor request and validation. A rejected candidate is closed before trying another within the same budget. An accepted descriptor is bound to that exact transport; returning another transport cannot reuse it. An already-negotiated candidate does not receive a duplicate descriptor request.

This division keeps compatibility decisions in one place while allowing discovery to continue past a reachable but incompatible service. Candidate creation, descriptor negotiation and provider publication are three separate steps. None proves that source parsing has started.

The broker uses an **epoch**, a monotonically changing local attempt identity, to reject asynchronous results belonging to an abandoned selection or recovery operation. Publication establishes a separate provider generation. Requests and lifetime notifications carry that generation so an old connection cannot retire, debit or publish through its replacement.

Factory cancellation is scoped to acquisition. Once a transport is transferred, the completed factory removes its abort observers. Subsequent lifetime belongs to the broker and transport, not to the old acquisition signal. Late or unused candidates are closed instead of being silently adopted.

## Acquiring and owning the local process

The development/release choice determines which acquisition function is available; it does not replace runtime verification. The release preparation rules remain in [release delivery](../releases.md#extension-delivery).

For an optional installed payload, bootstrap reads bounded package metadata and checks the expected package name and daemon version before deriving its executable path. `acquireNative` in `src/occipital/native.ts` then verifies usable executable access and the declared bytes. An unusable installed payload can fall through to exact cache/download delivery; the installed package is not repaired or rewritten.

Relative paths are anchored before asynchronous work. Their internal parent-directory components are not collapsed across symlinks: doing so could make verification refer to a different location from the one the operating system later executes. Acquisition checks files through bounded streaming reads rather than loading an entire executable into memory.

Download handling validates the declared origin and allowed redirects, counts actual received bytes and hashes those bytes while writing a private temporary file. Publication exposes a complete validated executable. Concurrent cold clients may download the same immutable artifact independently; an already-valid completed publication wins. This does not require a lock service or stale-lock recovery.

Process ownership adds a different constraint. The owned factory maintains one module-level slot spanning factory and broker owners. Its absolute attempt budget includes waiting for the previous slot, acquiring the executable and launching it. It checks the slot again after acquisition because another caller may have launched while this one awaited delivery.

The slot is released only after the transport’s actual `close()` promise settles successfully. An expired wait, a sent termination signal or an `ended` notification is not interchangeable with that settlement. Thus a bounded cleanup wait can finish unsuccessfully while the earlier helper still prevents another launch.

## Providers and lifecycle

An eligible interactive adapter starts asynchronous selection automatically. Print/JSON/RPC loading, an inactive extension or constructing the client does not start a helper. Development version `0.0.0` uses only the colocated build, with a missing-build warning/fallback as specified [below](#binary-compatibility-and-delivery). Real-version packages select as follows:

1. Try a user-managed compatible Subconscious internal service using the public SDK/discovery contract. A connection file alone is not proof that Occipital is available.
2. If none is usable, resolve the extension-declared **exact** owned Occipital release for the actual OS/architecture/ABI. Verify the installed payload or exact cache bytes; otherwise acquire that declared artifact. Never substitute a newer cached version or query a latest release.
3. If neither provider is obtainable, keep the [ordinary fallback](work.md#rendering-and-fallback). Native availability does not gate tool execution or input.

Initial startup and connection-loss recovery use the same availability-wait path. A useful Bash demand postponed while the enabled provider/effective profile is unavailable marks the existing weak card/source state. Readiness revisits all such demands, not only the latest card, with the owner's latest text. Metadata-only loss does not reevaluate an unchanged processed Bash revision or turn its prior refusal into an availability wait; a real source change can create new demand. No extra strong owner/text queue or conversation-history scan is used. Already-current native coloring is not reparsed, and the existing bounded restored-file native upgrade/retained Pi fallback policy is unchanged. Paused owners wait for a new useful visit; frozen live aborts, removed/collected owners and bookkeeping refusals are not revived by readiness.

[Source and style work](work.md#scheduling-contract) owns the single chronological preparation/dispatch registry, its quotas, cached-local progress and publication constraints. Provider selection does not create another card queue.

The extension and Occipital versions/releases are independent. Compatible shared-service versions need not equal the standalone pin. Owned processes have one client owner and are closed/reaped on retirement; shared clients close only their own route/connection and never terminate the shared module or peers.

Confirmed owned-process loss allows at most **two consecutive automatic restarts**. Only a validated useful current native source result resets that chain; metadata, stale results and cache reads do not. Deliberate session re-enablement permits a fresh attempt after exhaustion.

Confirmed established shared loss permits bounded reconnect and owned takeover. Record whether shared service was usable at initial startup. Only an initially shared client that fails over gets one return window: one probe per **60 seconds for 600 seconds**, at most one active probe, no catch-up burst or extension from failed probes/source changes. A successful verified return retires and reaps only its owned helper before new shared source work. Initial standalone clients have no periodic shared probes. Off/disposal clears candidates and recovery timers.

Daemon state is disposable. Replies must match provider/source/profile generations and exact replacement coverage before publication. Lease expiry/state reset and stale responses cannot paint another source/version. A transport end does not by itself prove that a shared parser did not run.

## Recovery is a transition, not a fresh constructor call

`ProviderBroker` retains the origin of a recovery transition: confirmed loss or deliberate handoff, its provider kind, and any already-running shared-return window. It first retires publication, then closes the previous transport, then follows the corresponding bounded selection path.

Owned recovery additionally requires actual exit. An old cleanup promise can later deliver an owned-stop receipt for its original generation, even after the broker’s bounded cleanup wait expired. That receipt is useful execution evidence for the source controller; it does not independently start recovery or publish a provider.

Shared-return probes run while the owned provider remains active. A successfully negotiated shared candidate initiates handoff, but shared source authority is not published until the owned helper has actually closed. If the candidate becomes unusable during handoff, the broker follows its bounded fallback path without creating a new return window.

Intentional terminal suspension uses this transition machinery without treating the stop as a crash. The broker examines both its pending-request count and the transport’s pending records: a metadata caller whose wait ended may still leave physical control work outstanding. An idle healthy provider can remain published. A busy one is deliberately retired, and the source controller marks the interrupted jobs so late outcomes cannot manufacture ordinary recovery or publication authority.

These mechanisms implement the recovery bounds below; they do not expand them. In particular, cleanup after an uncertain ending cannot turn that ending into confirmed loss, and a new provider cannot erase an earlier shared request’s unknown execution.

### Execution authority and conservative recovery

Request disposition, transport lifetime and retained paint answer different questions:

| Evidence | Meaning and boundary |
| --- | --- |
| Local typed `RequestFailure.execution` | Whether that one client attempt started; not the source's entire work history. A trusted pre-dispatch refusal is distinct from an arbitrary thrown error. |
| Validated remote fault/acknowledgement | Disposition of the corresponding correlated native operation, not unrelated previous attempts. |
| Pending physical SOURCE or queued useful demand | Prevents a competing Pi classifier even when no retained result exists. |
| Per-source owned/shared unknown-work guard | Survives payload release, provider replacement and Native Off when required. Missing data or a later successful request does not settle earlier shared uncertainty. |
| Broker-owned stop receipt | Actual reaping of the matching owned-helper generation can clear that owned evidence only; it cannot clear an earlier shared attempt. |
| Retained ready paint or STYLE success | Display/style evidence, never proof of SOURCE completion or parser permission. |

Transport endings record their **first** authoritative origin: `lost` (confirmed loss), `closed` (owner close), `uncertain`, or `denied`. Cleanup cannot upgrade uncertainty to loss. Shared route-close notifications for connection loss/reload/restart/crash and typed socket/stale-route failures can prove loss. Conversely, the public SDK may wrap both real EOF and its local read timeout as a pending-request `SubcError` with `closeReason: connection_lost`; that wrapper is intentionally classified `uncertain`. Unknown future route-close reasons are `denied`. Some genuine disconnects therefore remain unavailable rather than receive an unsafe automatic retry. Error-message text is not recovery authority.

Recovery budgets are independent:

| Mechanism | Bound and trigger |
| --- | --- |
| Parser-state resynchronization | One automatic full-source restart after validated `restart_required` per source/provider incarnation; exhaustion blocks that demand. |
| Evicted unchanged demand | One explicit retry permission followed by a current full-source observation, never a retry from every render. |
| Profile refusal | Sequence-qualified metadata reconciliation; an older reply cannot satisfy a later refusal. Reconciliation alone does not dispatch or recolor unrelated sources. |
| Owned-helper crash | Two consecutive automatic restarts, reset only by useful validated current SOURCE or explicit fresh enablement as described above. |
| Established shared reconnect | At most two attempts before the existing takeover/fallback path. |
| Shared factory / metadata / cleanup wait | Five seconds each. |
| Owned factory | Fifteen seconds. |

Acquisition/control waits are engineering bounds, not parser/regex/usefulness deadlines. Expiring a cleanup wait does not prove owned exit or free unsettled physical work. Parser retries and metadata reconciliation neither spend nor reset the helper's separate crash budget.

### Intentional terminal suspension

The owned public terminal `stop`/`start` boundary also governs native syntax work, independently of terminal-color preferences. Before native stop, suspend SOURCE/STYLE/preparation admission. If a healthy provider has outstanding requests (including physical catalogue work whose waiter already ended), deliberately retire that connection; cancel pending startup/probe work. A genuinely idle healthy provider keeps its generation. This does not restart the session or clear ready paint, parsed scopes, style caches or measured geometry.

After successful native start, finish cleanup and reacquire through the existing bounded provider path. Owned replacement requires actual exit of the old helper; signal delivery or a close timeout is not proof. Close only this client's shared connection, never the shared service. The operator explicitly accepts that old shared computation may briefly overlap bounded replay after this deliberate interruption.

Mark interrupted requests so their late success or failure cannot publish or manufacture ordinary failure authority. Keep their physical job/byte reservations until settlement. Revisit current useful demand through the existing chronological queue, with latest text and fresh incremental leases rather than replaying an old append packet. Complete compatible scopes and ready styles remain reusable; pending STYLE does not require reclassification of complete source. Hidden/frozen/removed owners, Native Off and disposal retain their admission rules. Native Off clears deliberate replay intent, not ordinary unknown-execution evidence: Pi fallback still requires its existing no-start/settled/owned-stop proof.

This is a narrowly scoped replay exception for observed deliberate handoff, not a general timeout retry policy. An ordinary uncertain/denied/closed end, including cleanup still in progress before suspension, remains unavailable. Crash restart counters are not reset or consumed by an intentional stop; existing bounded reconnect limits and the initial shared-return window remain in force. No SDK deadline suspension or Pi signal handler is introduced. Arbitrary raw `SIGSTOP`, OS sleep and `bg` outside the observed terminal lifecycle are not covered. Native external-editor/renderer stop/start uses this same boundary.

Repeated suspension during reacquisition preserves the **current** recovery/interruption origin, taken from the active provider or in-progress transition, not historical `initialShared`. An interrupted crash-recovery transition retains its already-consumed restart charge. The original absolute shared-return deadline also survives interruption; restarting acquisition does not restart its 600-second window. Without a recovery origin, resume follows ordinary fresh shared-first selection.

Explicit Native Off/on clears suspend-specific origin/return intent and starts ordinary fresh selection. If reacquisition terminates unavailable, deliberate-replay priority stops blocking otherwise-proven Pi fallback; ordinary pending work, frozen state and owned/shared unknown-execution guards remain authoritative.

See [suspension validation](../testing.md#terminal-defaults-and-lifecycle) for real job-control and pending-request controls.

### Ownership exception

Temporary hidden/expanded/unsupported presentation and native highlighting off retain the same adapter's canonical work evidence. Complete adapter removal/reinstallation, including master off/on or reload, disposes its consumer and may allocate fresh source keys. An occasional repeated highlight while old work remains unsettled is explicitly accepted there; no cross-adapter owner registry or delayed installation is introduced. Normal cleanup, weak collection and rejection of late old-owner colors still apply.

Pi's synchronous transfer of the same components between fullscreen and regular renderers is not adapter replacement: preserve source keys, parsed scopes, ready palette/styles and measured geometry. This includes the final `fullscreenExitOutput: "transcript"` redraw. Renderer clear pauses work immediately; a weak microtask attachment check disposes only subtrees that remain detached. Ready unchanged demand does not repeat SOURCE/STYLE, classification or measurement on reattachment; changed text and equal-text finalization retain their own authority updates. Ordinary removal and adapter unload retain immediate cleanup.

## Selected, effective and ready are different states

`SyntaxClient` keeps the **selected** preference. `resolveTheme` in `src/occipital/profiles.ts` derives the **effective** rule/profile choice. `CardSources` separately owns the **ready** presentation currently displayed.

For Follow Pi, the effective rule definition is local and does not need a daemon catalogue. It still needs a usable provider for native SOURCE/STYLE work. For a native selection, no catalogue means “not yet resolved,” not “confirmed missing.” A validated catalogue lacking the selected ID produces a temporary effective Pi choice while preserving the selected native ID.

A card’s ready palette can lag behind either choice. Selecting another profile changes desired work; it does not make incomplete replacement styles displayable. The existing ready presentation remains the display authority until the [work controller](work.md) can publish a complete replacement.

Preference loading is revision-guarded. If a preview, saved-preference application or confirmation happens while the initial read is pending, that earlier read cannot overwrite the newer choice. Preview changes the session choice without saving. Confirmation applies the choice before persistence; persistence failure leaves that session choice in place and reports failure. Popup rollback and cross-process settings publication belong to the [settings chapter](../settings-menu-spec.md).

Missing-theme feedback is episode-based. A temporary provider outage does not end an unresolved missing-theme episode, and repeated metadata notifications do not produce a new warning each time. A subsequently resolvable profile can end it through normal reconciliation.

A profile refusal can request metadata without observing source text. The controller reports a provider generation and refusal sequence. The client permits one current catalogue read and remembers which need it attempted. Successful completion acknowledges that captured sequence; a newer refusal arriving during the read remains a separate need. Acknowledgement permits subsequent current demand to reconsider the source—it does not itself dispatch sources or recolor unrelated cards.

## Menu and preferences

Bare `/tidy-ui` opens the shared [settings popup](../settings-menu-spec.md):

- **Code color theme:** Follow Pi plus the eligible daemon catalogue, searched by label or stable ID. A scrolling public `SelectList` keeps the selected row visible. Arrow/wheel navigation and search preview the highlighted theme without persistence; Enter or a completed mouse click confirms once and returns to the first page. Cancelling or disposing an unconfirmed list restores its entry choice. Each visit has its own rollback point; late replies cannot reapply an abandoned preview. Coloring uses the existing coalesced, newest-first two-owner batches, so large histories update gradually. Selected/effective differences are explained only when needed.
- **Refresh theme list:** explicitly reloads the active daemon catalogue. Listing/status is not a reload. No watcher, update polling, daemon restart, file upload or provider selector.
- **Status & troubleshooting → Highlighting service details:** cached provider/lifecycle, daemon/protocol/standalone versions, selected/effective theme and bounded last issue. No source text, discovery or new source work.
- **Use Occipital highlighting:** native-only preference, restored across reload and master off/on. Disable closes owned resources without stopping a shared module. The preference is saved alongside the confirmed code theme and terminal-default preference; appearance and diagnostic capture are process-local.

Opening/status/cancelling cannot enable a disabled provider. Follow Pi remains selectable without a live catalogue. Preference preparation has an explicit completion boundary. Closing confirmed pending work is not rollback, but retired runtime/syntax owners cannot publish late actions. Feedback is UI-only, never a conversation/model message.

`syntaxTheme` remains `{ "kind": "pi" }` or `{ "kind": "occipital", "id": "<catalogue ID>" }` in `join(getAgentDir(), "extensions", "pi-tidy-ui", "config.json")`. Pi resolves the agent directory and its `PI_CODING_AGENT_DIR` override. Old theme-only files remain valid. Only the confirmed theme choice, terminal-default preference and native-highlighting preference persist; no provider, retry, lease, source or expanded theme data is saved.

Missing configuration defaults to Follow Pi and enabled switches without writing. Invalid/unreadable files and failed/cancelled saves report bounded errors rather than rewriting them or claiming success. Updates preserve unrelated fields and share one serialized writer within the installed extension. Native directory events propagate the last published settings into running Pi instances; metadata-gated reads replace periodic polling/read/hash. Appearance and capture retain only two process-memory booleans across `/reload`, defaulting On in a new process. During an unconfirmed preview, external confirmation updates the Esc rollback choice without interrupting the preview; Enter confirms the local choice. See [settings policy](../settings-menu-spec.md#changes-from-another-pi) for lifetime, invalid-file and concurrency rules. No database, migration or cross-process lock service is added.

An independent selected theme remains fixed across Pi theme changes. If unavailable on the current daemon, retain its saved ID, preserve a usable ready native display or use explicit whole-card Follow Pi fallback, and show one error for that unresolved episode. A later compatible catalogue/provider restores it through the same retained-owner theme-revision path; no-change or unrelated catalogue updates do not recolor cards. Theme definitions remain daemon-owned.

## Binary compatibility and delivery

The consumer requires the exact [v3 capability and structural revisions](../occipital/protocol.md#version-identities-and-carriers) and [resolver/font interpretation](follow-pi.md#typography-strikethrough-and-compatibility). Published Occipital `0.1.5` uses v2 and is incompatible; identical product names or a valid executable hash do not establish protocol compatibility. Previously published artifacts remain immutable.

Exactly extension version **`0.0.0`** selects development: only `<extension-root>/occipital` (`occipital.exe` on Windows) may start. It does not use shared discovery, native npm payloads, a release cache, downloads or compilation. If the local build is missing, a `[pi-tidy-ui]` UI warning identifies the extension and Occipital is not used. Files retain cached Pi fallback; Bash retains whole-command `toolTitle`. Protocol admission and actual owned-process cleanup still apply. The extension root, not the current project directory, owns the binary.

Real-version packages use shared-first selection, then the exact independent daemon declaration generated during release preparation. Missing or incomplete selected releases fail preparation rather than falling back to an older release. Runtime does not inspect Git/latest or build Rust. Optional native packages contain the executable, LICENSE/third-party NOTICE and metadata, not a duplicated JS client or startup installer. If the optional payload/SDK is omitted, exact declared cache/download delivery remains available.

[Release delivery](../releases.md#extension-delivery) owns version selection and byte admission; [supported platforms](../releases.md#supported-platforms) owns the OS/architecture policy for the entire extension, including the current Windows ARM64 exclusion. The installed Pi/Node host's requirements apply in addition to the helper's ABI requirements.

See [syntax validation](../testing.md#syntax-and-palette-validation) for counters, physical cells, exact data/replay and compatible-helper controls.
