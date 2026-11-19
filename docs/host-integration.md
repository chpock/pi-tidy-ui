# Pi host integration and extension lifecycle

`src/index.ts` is the application composition root. `src/host/pi/` owns the concrete native bindings and one live native installation; entry wiring connects those bindings and Pi's public lifecycle/UI to host-independent presenters, syntax services, preferences and diagnostics. It does not replace tools, execute commands on their behalf or rewrite conversation records. The minimum supported host is Pi 1.0.1, whose public tool-renderer resolver is required for file-presentation laziness.

Start with the [system overview](architecture.md). This chapter owns attachment, compatibility, publication into a live session and teardown. The [rendering pipeline](rendering.md) owns text/layout work; [editor](editor.md), [footer](footer-spec.md), [terminal defaults](terminal-colors-spec.md) and [syntax providers](syntax/providers.md) specify their narrower state machines.

## Composition and lifetime boundaries

Pi loads the TypeScript extension entry point directly. Host classes/functions come through public imports of the runtime peer dependencies, not a bundled second Pi or a private-path component import. This matters for `instanceof`, exact prototype checks and the fact that Pi itself must continue calling the methods the adapter observes.

| Owner | Retained state | Boundary |
| --- | --- | --- |
| Extension factory | Registered flags/events/command, one preference owner and focused diagnostic/footer/color bindings | No UI, journal or provider start merely from constructing these owners |
| Application preferences | One initial read, confirmed theme/shared switches, process-local switch reference and pending confirmations | Outlives repeated start callbacks; native-incarnation theme cancellation remains distinct from application-epoch switch cancellation |
| Session diagnostic binding | Current ID-qualified health/sink, optional run-bound journal and separate strongly held health/warning context cells | Same-ID reuse, weak observer edges, explicit health/journal/final-release phases; no source/native/footer ownership |
| Footer binding | Factory-lived name/generation/deferred-slot state; each installed view's semantic snapshot and latest rows | Current editor/preference facts gate the public slot; exact disposal and coalesced post-measurement work preserve later owners |
| Terminal-color binding | One current zero-row widget/controller and detach operation | Lazy widget-time diagnostic/default selection; borrowed current context/preferences and direct terminal-lifecycle capability, not another syntax owner |
| Application currentness scope | One generation and its switch-save abort controller | Initial generation is live; start advances/aborts then replaces the signal, retirement advances/aborts without a successor; no UI or cleanup sequencing |
| Current session runtime | Live context, borrowed currentness, selected diagnostic observers and current services | Reused where still active or retired through Pi lifecycle events; obsolete async results cannot publish into a successor |
| Native session | Owned descriptors, weak-keyed parent/index records, actual renderer/shell/tree/image/Markdown borrows and native widget observations | One liveness/failure/restoration authority; supplies current facts/capabilities without owning card policy, source jobs or row caches |
| Presentation sessions and presenters | Per-component view/preview/currentness state, latest row/scene handles, preparation consumer and render/spacing/hit/update policy | No native component shapes or hook ownership; no source-execution, fallback or physical-job authority |
| Component | Its latest prepared/painted representation and signature | Owner removal/collection, invalidation or replacement, with the synchronous renderer-transfer exception below |
| Settings popup | One overlay, current page/selection and theme-preview rollback point | Popup close does not own the provider or dispose the session runtime |
| Process-only state | Appearance/capture preference booleans and two applied terminal-default values | Survives reload without retaining UI, session, controller or theme objects |

These are different lifetimes. A width change is not a new source owner; a popup close is not a provider failure; changing a session is not the same as temporarily yielding the terminal. Treating them alike would either discard reusable work or let stale work affect a new owner.

The settings file persists only the confirmed code theme and terminal/native switches. Appearance and capture are process-only flags. See [persistence](settings-menu-spec.md#persistence) for validation and publication semantics.

### Concrete native binding owners

`NativeSession` is constructed before its presentation consumers are wired, but construction neither visits the tree nor publishes hooks. `install()` runs only after the real consumers and controller exist. A `NativeSession` and its private binding owners serve one installation: restoration retires that owner, and a later attachment constructs a new one rather than reinstalling the retired instance. Application composition keeps the source/palette/preparation owners; the native session receives their presentation operations, not a source client or funding pool.

| Module | Native state and responsibility |
| --- | --- |
| `src/host/pi/native-session.ts` | Sole active/failure state, attachment/index metadata, Container dispatcher and weak one-microtask renderer retirement. It coordinates installation and ordered restoration of its private families. |
| `src/host/pi/tool-components.ts` | Inspected tool fields, prototype/update descriptors, original renderer calls, exact stock/deferred-shell recognition and opaque image-row borrows. Actual-width visibility is queried, never cached here. |
| `src/host/pi/user-components.ts` | Native user/Markdown field borrows and prototype/update descriptors. The caller's `UserPresenter` alone retains rows and signatures. Persistent wrappers have no installer-node parameter. |
| `src/host/pi/native-editor.ts` | Joint ownership of editor geometry, placement descriptors, unfinished native status transfers, visibility and upper-widget/spacer observations. A late editor's transfer remains pending until the guarded native rebind succeeds; an intervening selector defers it to the next eligible attachment. The session's single dispatcher invokes these observations; metadata and gap decisions read the same guarded records. |
| `src/host/pi/lazy-native-renderers.ts` | Existing weak `context.state`-qualified stock renderer leaves, invocation inputs and eviction/retirement behavior, independent of the native session's prototype records. |
| `src/host/pi/native-bindings.ts` | Public Pi classification binding, native Text service-row projection, guarded terminal-tracking read and weak current-footer-slot observation. It does not decide fallback permission or footer policy. |
| `src/presentation/spinner.ts` | Presentation's existing weak compact-call participants, monotonic pass sample and single fallback deadline. Native document observation supplies begin/end notifications, not a second clock or per-frame aggregate snapshot. |

Full restoration first disables native-session admission and releases application-owned presentation/source consumers. It restores still-owned Container/Spacer observers and tool/user methods, then restores still-owned editor placement flags and attempts the guarded same-editor rebind before releasing editor presentation methods. If Pi's rebind or its validation fails, the release still runs; restored descriptors are not evidence of successful indicator relocation. Finally the application removes its metadata/Git owner and optionally requests repaint. The inactive/no-hook path disposes consumers without repeating editor rebinding. No generic cleanup stack or independently closable hook family changes this order.

`src/application/footer-session.ts` owns footer eligibility, delayed installation, explicit reclaim and later-owner policy over narrow fact readers supplied by composition. The native layer lends only a weak slot/owner observation and current editor eligibility; it does not forward arbitrary public UI operations or retain footer contents.

## Startup and attachment

1. Before flags, hooks, commands or preference I/O, the factory requires public `registerToolRenderer`; an older host fails immediately with a message naming the 1.0.1 minimum. On supported hosts it registers the exact-stock read/write/edit lazy resolver before session use.
2. The factory registers `tidy-ui-card` and `tidy-ui-compact` string flags. Deprecated `tidy-ui-cache-mb` and `tidy-ui-card-cache-mb` are accepted but ignored: live layouts are not subject to those former eviction budgets. Supplying them produces a bounded warning when presentation starts.
3. It starts one preference-load promise. Loading preferences does not construct the presentation adapter or start a syntax provider. The initial defaults are Follow Pi, terminal matching Off and native highlighting On; failures are reported rather than silently saved over the input file.
4. `startSession` closes an old popup, advances `ApplicationScope`, aborts old unpublished shared-switch saves before allocating the successor signal, clears transient Bash-call IDs/name state and waits for preferences if necessary. A later epoch invalidates that continuation.
5. The factory-lived diagnostic binding selects logging/health from the public session identity. It synchronously lends the selected sink to root composition before the journal branch; composition publishes a native-failure callback frozen to that sink. The native owner still chooses the current callback at report time. Same-ID starts reuse observers; optional journal construction cannot move ahead of sink publication. Aggregate snapshots stay in composition. Presentation starts only in TUI mode with appearance enabled. Print/JSON/RPC paths do not install terminal presentation or open the menu.
6. `TerminalColorSession.start(ctx)` establishes the zero-row terminal observer before presentation capture. Its factory binds public terminal start/stop to colors and `ensureSyntax(ctx)`. This can construct the syntax runtime, but construction leaves its client disabled: an observer may exist even if presentation attachment later fails.
7. A separate zero-row public capture-widget factory obtains the actual live TUI. It is removed immediately: this is a capture mechanism, not an extra visible row. The adapter verifies that the TUI shares the imported `Container` identity, has the required operations and contains compatible component shapes.
8. The existing tree is visited before future-child observers are installed. The `Container.addChild` wrapper calls Pi's original method once, then visits the entire added subtree; restored history can arrive already assembled. Pi's own exception propagates unchanged. If the visit fails while installing the adapter's hooks, the native addition stands and the adapter restores native presentation. Only a successfully installed adapter is passed to `SyntaxRuntime.attach`, which schedules activation outside rendering.
9. The runtime installs eligible below-editor metadata and footer after adapter installation. A settings-directory subscription is bound to the current epoch.

The application terminal-color binding installs a zero-row public observer widget. Actual construction, not the extension factory, selects the current diagnostic sink and injected/process defaults store. The binding supplies actual terminal write/query functions and binds the terminal instance's public start/stop lifecycle to both colors and syntax. [Terminal-default eligibility](terminal-colors-spec.md#eligibility-and-automatic-themes) includes a narrowly scoped guarded renderer-state read; it is not permission for general private renderer interception.

Footer/color installation uses its explicit public context, whereas later semantic/color callbacks and restore/removal borrow composition's current context. Footer view records retain their installation's journal sink; deferred/release decisions borrow the current journal. Color removal clears the current view before detaching hooks and disposing it, so retired widget visits and queued forced redraws cannot act as a successor. Algorithms remain in `footer.ts`/`terminal-colors.ts`, and current native slot/tracking facts remain in `host/pi`.

The stable TUI reference is retained across Pi's regular/fullscreen renderer replacement. This avoids receiver-capture probes, raw-input observation, private viewport-input wrapping or an input-hook migration protocol.

## What is hooked, and what remains native

| Boundary | Adapter observation/projection | Native work retained |
| --- | --- | --- |
| Public tool-renderer resolver | Exact stock `read`/`write`/`edit` call+result renderer pairs receive lazy leaf proxies; custom, mixed and all other pairs pass through unchanged | Native execution and results; original stock callbacks and their arguments/theme/context when actually painted |
| Tool prototype | Render, normalized mouse and update notifications (`updateArgs`, `updateResult`, `setArgsComplete`, `setExpanded`, `invalidate`, `markExecutionStarted`) | Original update method, receiver and arguments; actual tool execution and results |
| User-message prototype | Render plus rebuild/output-padding/invalidation notifications | Native Markdown rendering and original message data |
| Recognized stock editor | Presentation/border hooks, placement accessor and normalized mouse translation | Same editor instance, keyboard input, paste/cursor/undo/history and autocomplete engine |
| `Container` add/remove/clear | Tree attachment and owned-resource lifecycle; post-add hook installation | Native child mutations, ordering and `addChild` exceptions |
| Existing `Container.render`/`Spacer.render` | Call-local document settings/time samples, native widget-height observation and guarded queued-card projection | Native traversal, geometry updates and child ownership |
| Public footer/widget slots | Owned footer and metadata rows | Later owners, native selectors and native activity indicator lifecycle |

Each lazy proxy is associated with the host renderer's actual weak-keyed `context.state`, not a process-global tool-call ID registry. It delegates rendering, input, mouse and invalidation to the current native component without inheriting Pi's container layout cache. Callback replacement retires superseded proxies and releases their slot inputs; when a successful custom card takes over, the live owner evicts its materialized native child components but retains the current deferred invocation and its input references for a later genuine native fallback. These are separate lifecycle operations even if Pi still holds an older proxy in its mouse layout. Call/result callback or component-render failures use bounded neutral fallback text, report one safe runtime-health issue per slot, and clear that issue after a later successful native generation.

The integration uses **inspected private component shapes**, even though it imports host classes through public package exports. These are compatibility checks, not a promise that arbitrary future Pi implementations or other extensions have the same shape.

Required shared-class/tool contracts fail closed: installation/render exceptions disable the adapter, restore still-owned hooks and delegate to Pi. Unsupported optional pending-message or upper-widget shapes leave that block native instead of disabling all cards. Exact editor ownership can reject input/footer styling while cards remain active. The behavioral guards are described in [editor ownership](editor.md) and [queued projection](user-queued-cards.md).

Every restoration checks that the descriptor/function is still the adapter's own wrapper. If another extension replaced it, that later owner wins. Restoration also distinguishes an originally absent own property from an inherited one; it does not leave a shadow property behind.

Persistent prototype wrappers are made in prototype-only factory scopes, not a scope containing the first installed component. Merely using `WeakMap` does not prevent a shared V8 closure environment from retaining that component. The same restriction applies to persistent animation/report callbacks; weak accounting cannot compensate for an accidental strong closure capture.

## Presentation dispatch

Dispatch tests lifecycle and safeguards before it performs expensive preparation. Output size is not the policy selector. The static [producer registry](tool-adapters.md) matches the current exact names `read`, `write`, `edit` and `bash` with each adapter's saved-shape rules, then returns a semantic card kind. `ToolProducerPresenter` captures that supplied call, `ToolPresentationPolicy` combines it with host-supplied flags/state into a typed intent, and `ToolRoutingPresenter` checks only the native visibility/renderer capabilities supplied by the host. The policy uses the semantic kind for routing, expansion, turn-window membership and layout accounting; unrecognized names use the summary kind rather than acquiring per-name layout categories. Actual names remain authoritative for policy flags, labels and native tool identity. Saved-format recognition neither discovers external extensions nor attributes a historical call to its current registration.

| Current component | Selected path |
| --- | --- |
| Collapsed eligible text-only tool | Compact summary, unless a native-card policy/default applies |
| Attached supported command under owned policy | Bash-style frame when command/context and prepared paint/layout are usable; otherwise the existing bounded summary, even expanded |
| Compatible read | Compact summary by default, including image results; explicit expansion selects owned saved text/error details and any host image block, never the write/edit automatic-full window |
| Compatible edit, final successful result, valid path | Selected bounded saved-diff preview or full saved diff; malformed preview metadata shows the owned unavailable row, while unsupported explicitly full metadata uses native rendering |
| Compatible write, final successful result, valid path | Selected bounded saved-data preview or full write card; malformed preview metadata shows the owned unavailable row, while unsupported explicitly full metadata uses native rendering |
| Incomplete/partial/failed edit or write | Compact lifecycle summary by default; expanded pending details show a bounded received-source excerpt, while expanded final-error details show all saved error-result text in the shared error frame only after ordinary construction funding and measurement succeed, without proposed source |
| PowerShell, ordinary expanded tools, non-read images, intentional hiding or explicit opt-out | Native tool path |
| Compatible ordinary user / native pending queue | User or queued projection, not a synthetic conversation entry |
| Recognized still-owned stock editor | Editor frame and below-editor rows; separate footer eligibility also applies |

`--tidy-ui-card` adds exact names to native-card policy; using `bash`, `read`, `edit` or `write` opts that name out of its custom presenter. `--tidy-ui-compact` retains priority when both flags name a tool. It does not defeat explicit expansion or intentional native hiding; ordinary non-read image results remain native. Read's explicit expansion uses the owned read view under its selected policy, including images, instead of ordinary-tool native expansion. `ToolPresentationPolicy` supplies the shared selection predicates; `ToolRoutingPresenter` preserves lazy, actual-width native visibility checks for routes that need a host renderer. Rendering, spacing, mouse handling and animation teardown reuse those same predicates rather than independently selecting a conflicting route.

A stacked host wrapper that does not own a file tool's attached presentation delegates the original mouse event unchanged to its predecessor. It does not render that tool to infer an exterior gap: the attached owner's wrapper applies its own hit-testing and coordinates. This keeps mouse movement from causing hidden render, useful-card or measurement work in another live adapter.

### Native visibility

A native self-shell renderer can return no rows even with `hideComponent=false`. The host observer is installed only on the compatible public tool-component shape, but that includes the stock self-shell edit component. A compatible saved read/write/edit data shape remains eligible for a file card even when its renderer pair is custom, mixed or replaced; those callbacks remain untouched and their original renderer is executed at the actual viewport width when self-shell visibility or native fallback requires it. Names/schemas cannot prove that the component is visible.

The narrow stock-edit shortcut verifies on every visit either the original public `createEditToolDefinition` call/result pair plus a current plain `Box` with exact stock methods, or the exact adapter-owned deferred renderer pair plus its adapter-created call component. Function identity alone is insufficient for the unwrapped stock path: the stock tool factory can reuse an earlier custom Box. This shortcut stores no visibility proof and changes no native state. Compatible third-party file renderers remain eligible for the same saved-data presentation, but are not wrapped, retired or cleared; only the exact deferred stock pair receives lazy ownership and its native-work savings. Supported expansion uses the custom full saved-data view; explicit native presentation, non-read image/hidden guards and unsupported full write/edit metadata use the existing native renderer. Default-shell stock reads need no native renderer body to recover images: they borrow current public host Image children separately. A deferred stock-read pair alone does not prove a default shell. The compact-summary render call still checks current-width visibility when that pair is used with a self shell. Predecessor/mouse compact selection, file projection and source preparation retain their own exact-pair shortcuts. Custom or mixed callback self shells remain native-authoritative.

### Lazy stock file renderers

The public resolver wraps only the complete stock read, write or edit renderer pair. A custom, mixed, missing or later-replaced renderer is returned unchanged. This lazy-owner boundary is separate from file-card eligibility: compatible third-party saved data still uses the custom file presenter without claiming callback savings. Resolver selection creates a lightweight component but does not run Pi's syntax highlighting, edit-preview preparation or result formatting. The stock callback receives the current borrowed arguments and its callback-generation theme/context only when Pi actually paints the component on the native path; repeated paints reuse that call/result component. A custom successful-file preview can therefore avoid work that would have been performed solely to construct an invisible native renderer. The wrapper keeps its lazy renderer data in the weak per-component `context.state` association and returns plain-text native fallback content if a stock callback fails.

When an owned file presentation takes over, the adapter evicts already-materialized stock child components but preserves the current lazy renderer leaves and their latest invocation inputs. This releases invisible native component trees without requiring `updateDisplay`, while an immediate native fallback can still reconstruct the current call and result. Replacing a renderer or disposing its host owner retires the old leaf and drops its invocation inputs; only a live leaf may rematerialize.

The lazy owner holds one current argument reference shared by call invocation and both slot contexts. After the original host `updateArgs()` returns, the adapter replaces that reference only for the complete deferred stock pair and the matching state/tool/call identity. Invocation recipes exclude the old `context.args` as well as the previous component; callback generations still supply their other context fields, themes, result envelopes and options. This constant-time reference update neither creates an owner nor invokes a renderer, clones arguments, clears native children or forces `updateDisplay()`. It preserves hosts that batch callback replacement until a native frame while releasing obsolete arguments even when custom cards bypass that frame. Native-child eviction remains an actual custom-takeover operation, not a side effect of every argument delta.

Read remains compact without result-body preparation until its host expansion state requests a full view. It never registers for the write/edit turn window. Collapse discards owned text/geometry/paint while retaining Pi's saved data; expansion rebuilds from current saved result parts. Read construction accounts for returned text, not just its path/arguments. Funding refusal stays owned rather than materializing a stock read card. The exact source, pending/error and opaque image rules are in [read cards](read-card-spec.md).

### One document visit

The already-owned document observer scopes a primitive Output-padding snapshot and one monotonic spinner-time sample to a normal traversal, clearing both in `finally`. Direct component/mouse visits read current settings/time instead. This avoids cloning settings or splitting animation phases at every tool/predecessor without adding another timer or hook.

The frame knows geometry and caller-supplied paint, not execution state or tool names. Native user-component padding only supplies Markdown stripping/width geometry; transcript exterior padding comes from Pi's effective Output padding. Editor padding and footer layout are separate. Detailed preparation, separator calculation and exact hit testing belong to [rendering](rendering.md).

## Tree removal versus renderer transfer

Ordinary detached removal and nested-container clear release affected custom rows, syntax ownership and compact animation immediately. If a component has already moved to an attached parent, it is not released merely because the old parent's remove wrapper ran.

Pi's current renderer is a special case: it can clear that renderer and synchronously move the same tree through the stable TUI reference into a replacement, including the final fullscreen transcript. Immediate release would lose ready colors, source identities and measured geometry before a tree that remains live is painted again.

For that specific clear:

1. stop animation and pause new useful syntax demand for the detached subtree;
2. keep only weak subtree references until one microtask;
3. recheck actual attachment against the stable TUI;
4. retain synchronously transferred owners; release only genuinely detached subtrees.

This is neither a grace-period cache nor a timed session handoff. Appearance Off, failure and unload still release immediately. Parent/index observations are weak-keyed by child and repair stale positions from current native children; each live record holds its parent strongly. They do not create a second strong registry of children. See [layout ownership](render-cache-spec.md#invalidation-and-ownership) and [syntax work ownership](syntax/work.md).

## Semantic events and snapshots

| Event handled by the extension | Action |
| --- | --- |
| `session_start` | New epoch/save-abort ownership; preference readiness; logging/presentation start; replace settings subscription |
| Assistant `message_start` | Clear primitive IDs of the current live Bash stream |
| TUI tool-call start/delta/end `message_update` | Record exact live Bash call IDs, never retain message bodies/history |
| `turn_start` | Start the current candidate batch for the weak latest-ten automatic full-file window; refresh the footer semantic snapshot |
| `session_tree`, `session_compact`, `model_select`, `message_end` | Update current context and advance footer semantic epoch |
| `tool_execution_end` | Refresh footer/Git state; a successful write/edit marks its attached owner as a completed-window candidate |
| `turn_end` | Filter attached final-success candidates, fold the whole batch into the latest-ten automatic window and demote older automatic views together; an empty/non-file turn leaves it unchanged; refresh the footer semantic snapshot |
| `agent_end` | Clear live Bash IDs, finalize the file-window batch as a fallback boundary, then refresh footer/Git state |
| `session_info_changed` | Invalidate saved-name snapshot, request owned footer rendering and notify run-bound logging |
| `session_shutdown` | Retire epoch/watch/popup and services; restore owned UI as below |

Saved session-name event ordering is not trusted as current-name authority: a later render rereads the public current metadata once. Footer snapshots are keyed by session/model/leaf and semantic epochs, not a scan on every render. Live Bash IDs distinguish live interruption from a newly restored interrupted result; see [streaming state](bash-streaming-contract.md).

In ordinary terminal mode, shrinking a file card above the visible area (for example, demoting an older automatic full view to preview) can make Pi redraw the screen and clear terminal scrollback. This does not remove saved session or tool data. Fullscreen uses its own screen buffer; the file-window policy does not promise scrollback preservation or zero full redraws.

This table describes the extension's handlers, not a claim that every Pi transition necessarily reuses the same extension factory. Pi owns history reconstruction and intermediate reload frames. No private session-transition wrappers, transition timer, screen snapshot or output suppression hides the native interval between extension runtimes.

## Settings actions and asynchronous ownership

Bare `/tidy-ui` opens a single public custom overlay. Arguments report usage; non-TUI modes do not open it. Its owner borrows cached state and issues explicit actions; opening root/status does not perform source classification or service discovery. Application menu contracts and pure projections supply fixed rows, typed intentions and status/cache text. A separate stateless action policy handles eligibility, preference delegation and outcome messages through narrow operations; composition retains current native binding, reapply effects, eager clear receipts and coupled recording operations. The overlay retains native navigation, gestures and preview/rollback. [Settings and menu](settings-menu-spec.md) separates those responsibilities from persistence validation.

`ApplicationScope` in `src/application/scope.ts` jointly owns the application generation and shared-switch abort controller. Startup and menu-open continuations compare generation only; each popup/watch receives one existing `PreferenceScope` projection whose action predicate also requires the current signal not to be aborted. Initial generation zero is live. A projection's signal reader follows the current controller; only its captured-generation predicate admits use, and an already-admitted save receives the concrete signal at that admission. Retirement advances and aborts without creating a successor signal, so the existing generation-only command admission can still mount a popup after shutdown while every action remains retired; it cannot restart services or persist a switch. This preserves command semantics, not a claim that ordinary Pi dispatches such a command.

Actions borrow that currentness predicate and shared-switch save signal; they do not create another epoch or abort owner. Shared-switch persistence is queued **before** awaiting cleanup, so closing/reopening a popup cannot reverse confirmation order. Theme confirmation instead keeps lazy syntax acquisition, the matching native-incarnation preference scope and its post-await epoch/runtime-identity check together. Native deactivation may abort a theme save while that application epoch remains open. A live application can succeed while persistence fails; the outcome explicitly says applied-but-not-saved rather than pretending to roll back the runtime. Recording retry rereads the current writer after enablement; snapshot captures one active writer and fences its completed flush by epoch and identity. Their completion results do not transfer writer ownership to the policy.

| Requested control | Effective action |
| --- | --- |
| Appearance Off | Release terminal defaults, footer, hooks/layouts and syntax runtime; capture/menu remain independently usable |
| Appearance On / Reapply | Attempt current compatible attachment without taking over a foreign editor; with an eligible stock editor, explicitly reclaim the footer slot if Toolview no longer owns it |
| Terminal matching Off | Stop owned default-color application; while appearance is active, finite concrete-color sampling can still support local card calculations |
| Native highlighting Off | Stop native work under the source-authority contract; do not stop a separately managed shared daemon or pretend uncertain old requests never executed |
| Capture Off | Close/disable file capture, not runtime-health state or presentation |
| Refresh status / cache statistics | Read existing state/counters, not reclassify sources or retry a provider |
| Clear saved layouts | Release presentation retention and capture the receipt before repaint; leave conversation/native syntax data alone |

Explicit On/Reapply differs from automatic restoration and cleanup. A later footer owner's disposal of Toolview's footer clears Toolview's ownership record; a subsequent explicit action may call public `setFooter` again when the stock editor is eligible. Delayed automatic installation and cleanup still preserve later owners. See [footer ownership](footer-spec.md#scope-and-ownership).

The process-only appearance flag gates terminal matching as well: an enabled terminal-color preference is not a promise of application while appearance is Off. The menu displays requested choices separately from effective state.

## Directory metadata service

`GitBranchSource` in `src/git-branch.ts` owns one asynchronous branch snapshot, not editor/footer state. The below-editor renderer gives it the eligible `cwd` and reads a result only for that same directory. Directory abbreviation/coloring is pure `editor-status.ts` work.

The refresh algorithm is:

1. On a different cwd, advance generation, abort the previous job, close watches and clear its one-shot debounce. A missing eligible cwd retires the source.
2. Coalesce pending refresh requests through a microtask. At most the current job runs; later demand is remembered rather than starting overlapping Git subprocesses.
3. Use `execFile("git", ["-C", cwd, ...])`, never a shell. Each child has a 2-second deadline and 65,536-byte output cap.
4. Ask the selected Git for `rev-parse --local-env-vars`. Cache those names by `PATH` and `GIT_EXEC_PATH`; remove reported repository-local redirect variables case-insensitively from a copied environment. This stops the parent process's Git environment from redirecting the lookup to a different repository.
5. On discovery, ask Git for its absolute git-dir and common-dir. Do not infer `.git`, linked-worktree layout or HEAD storage format. Remove only Git's trailing LF, not genuine path whitespace.
6. Recreate watches on cwd, discovered metadata directories and available `reftable` subdirectories. Same pathname does not prove same inode after replacement. Filter relevant names before scheduling another refresh.
7. Install/rearm watches **before** `symbolic-ref --quiet HEAD`. Otherwise a HEAD change during rearming can leave an obsolete snapshot without a live event to correct it.
8. Accept only a successful, nonempty, control-free `refs/heads/` value. Detached/unavailable means no branch, not a synthesized label. Publish/request rendering only when the value changes.

Generation/abort checks guard every async continuation. Filesystem events use one unreferenced 75-ms debounce, not periodic polling. A watch error closes that watcher and requests rediscovery; an unavailable watch leaves completed-operation refresh as a fallback. Repository creation in an unwatched ancestor is not guaranteed immediate detection. These OS event limits are not a universal filesystem or Windows support claim.

Diagnostics keep primitive query/spawn/watch/job counters, never process/component references or raw Git stdout. Rendering may schedule a refresh but never waits synchronously for Git.

## Shutdown and failures

`shutdownSession` calls the explicit `quiesceSession` phase: retire the application generation, abort unpublished saves, remove settings watching, then close the popup. Unlike startup, shutdown closes the popup after retirement, so its preview rollback cannot act through an obsolete admission. It clears current live-Bash/name state, records existing diagnostics, disposes runtime health and quiesces the presentation adapter.

Quiescence stops new preparation/animation but lets already-painted unchanged layouts serve cleanup frames, including the borrowed image block of an expanded read. Changed, uncached, differently sized or native content still delegates to Pi; unrelated native input/update handling is not frozen.

The same named shutdown function then uses explicit nested `finally` blocks; the scope owner neither stores these operations nor drives their order:

1. await syntax/helper disposal;
2. await the outgoing journal's existing close Promise, so source-cleanup diagnostics still have their run-bound sink, then release its current writer/warning references;
3. dispose terminal observers, preserving applied defaults for a non-quit successor or releasing them on quit;
4. restore the owned footer;
5. restore all still-owned presentation hooks without forcing an extra full teardown repaint;
6. clear runtime/context references and finally the diagnostic binding's outgoing context/sink/health references, even if an earlier cleanup rejects.

Appearance Off and rendering/install failure use their ordinary restoration/repaint behavior rather than this quiescent teardown sequence. A hook-install exception after a successful native `addChild` uses the existing one-time failure report, owned-hook restoration and warning, without retrying the add or removing the child. If the visit has already recorded the failure and restoration or warning throws, that exception propagates instead of being swallowed by a second failure call. Runtime health is independent of capture: explicit owner-qualified incidents flow through `DiagnosticSink.runtime`, not parsing of log messages. Old callbacks retain old observers and cannot notify a new session; neighboring successes cannot clear another owner's failure. Expected cancellation/refusal is not automatically an incident. See [health and journaling](debug-logging-spec.md).

Terminal stop/start is **not shutdown**. It keeps the session and eligible ready representations, releases owned colors while yielded, stops card work and current completion waits, and closes our connection even when idle. Already-sent requests may settle for accounting, not late publication. Successful native start reconciles current eligibility and reacquires through ordinary activation/useful-work rules. Intentional inactivation and ordinary uncertain faults retain distinct evidence and recovery eligibility. Exact obligations are in [terminal lifecycle](terminal-colors-spec.md) and [intentional syntax suspension](syntax/providers.md#intentional-terminal-suspension).

## Compatibility boundary

The minimum supported host is Pi 1.0.1. Positive activation on supported Pi versions is required precisely because fallback alone can hide contract drift. The adapter does not restyle HTML exports or standalone user shell messages, replace native focus/selection/mouse processing, mutate global themes, read tool files to reconstruct results, add model requests or promise compatibility with arbitrary competing hook owners. Pi dispatches SGR mouse input only in fullscreen `TuiAltScreen`; regular TUI mode has no mouse-event dispatch, so pointer-selection guarantees and CLI click controls are fullscreen-only. For an exact deferred stock read/write/edit pair, an owned saved-data card does not materialize the stock renderer or run its native file preparation; a genuine TUI native path (appearance off, explicit native override or unsupported full write/edit metadata) materializes it and retains Pi's own behavior. Pi's `/export` command is separate: its HTML presentation uses saved call/result data independently of the owned TUI file card. The write/edit export path does not invoke the deferred TUI stock callbacks. The public `createToolHtmlRenderer` API is separately tested when directly supplied renderers. Compatible foreign renderers keep their callbacks and producer state untouched and are still presented from compatible saved data, but they have no zero-native-work guarantee.
