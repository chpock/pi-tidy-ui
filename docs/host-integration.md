# Pi host integration and extension lifecycle

`src/index.ts` is the composition root and the only live-host adapter. It connects Pi's lifecycle, actual component tree and public extension UI to otherwise host-independent presenters, syntax services, preferences and diagnostics. It does not replace tools, execute commands on their behalf or rewrite conversation records. The minimum supported host is Pi 1.0.1, whose public tool-renderer resolver is required for file-presentation laziness.

Start with the [system overview](architecture.md). This chapter owns attachment, compatibility, publication into a live session and teardown. The [rendering pipeline](rendering.md) owns text/layout work; [editor](editor.md), [footer](footer-spec.md), [terminal defaults](terminal-colors-spec.md) and [syntax providers](syntax/providers.md) specify their narrower state machines.

## Composition and lifetime boundaries

Pi loads the TypeScript extension entry point directly. Host classes/functions come through public imports of the runtime peer dependencies, not a bundled second Pi or a private-path component import. This matters for `instanceof`, exact prototype checks and the fact that Pi itself must continue calling the methods the adapter observes.

| Owner | Retained state | Boundary |
| --- | --- | --- |
| Extension factory | Registered flags/events/command; settings instance and preference-load promise | No UI or provider start merely from constructing the factory |
| Current session runtime | Live context, lifecycle epoch, save-abort signal, confirmed theme, health/journal owners, current services | Replaced or retired through Pi lifecycle events; obsolete async results cannot publish into a successor |
| Presentation adapter | Owned descriptors, weak component state/parent edges, preparation consumer, animation observations | Explicit appearance Off, failure or teardown restores hooks and releases presentation |
| Component | Its latest prepared/painted representation and signature | Owner removal/collection, invalidation or replacement, with the synchronous renderer-transfer exception below |
| Settings popup | One overlay, current page/selection and theme-preview rollback point | Popup close does not own the provider or dispose the session runtime |
| Process-only state | Appearance/capture preference booleans and two applied terminal-default values | Survives reload without retaining UI, session, controller or theme objects |

These are different lifetimes. A width change is not a new source owner; a popup close is not a provider failure; changing a session is not the same as temporarily yielding the terminal. Treating them alike would either discard reusable work or let stale work affect a new owner.

The settings file persists only the confirmed code theme and terminal/native switches. Appearance and capture are process-only flags. See [persistence](settings-menu-spec.md#persistence) for validation and publication semantics.

## Startup and attachment

1. Before flags, hooks, commands or preference I/O, the factory requires public `registerToolRenderer`; an older host fails immediately with a message naming the 1.0.1 minimum. On supported hosts it registers the exact-stock read/write/edit lazy resolver before session use.
2. The factory registers `tidy-ui-card` and `tidy-ui-compact` string flags. Deprecated `tidy-ui-cache-mb` and `tidy-ui-card-cache-mb` are accepted but ignored: live layouts are not subject to those former eviction budgets. Supplying them produces a bounded warning when presentation starts.
3. It starts one preference-load promise. Loading preferences does not construct the presentation adapter or start a syntax provider. The initial defaults are Follow Pi with terminal matching and native highlighting enabled; failures are reported rather than silently saved over the input file.
4. `session_start` closes an old popup, increments the lifecycle epoch, aborts old unpublished save work, clears transient Bash-call IDs/name state and waits for preferences if necessary. A later epoch invalidates that continuation.
5. Logging/health start from the public session identity. Presentation starts only in TUI mode with appearance enabled. Print/JSON/RPC paths do not install terminal presentation or open the menu.
6. `startColors` establishes the zero-row terminal observer before presentation capture. Its factory binds public terminal start/stop to colors and `ensureSyntax(ctx)`. This can construct the syntax runtime, but construction leaves its client disabled: an observer may exist even if presentation attachment later fails.
7. A separate zero-row public capture-widget factory obtains the actual live TUI. It is removed immediately: this is a capture mechanism, not an extra visible row. The adapter verifies that the TUI shares the imported `Container` identity, has the required operations and contains compatible component shapes.
8. The existing tree is visited before future-child observers are installed. A public `Container.addChild` wrapper subsequently visits the entire added subtree, not only its root; restored history can arrive already assembled. Only a successfully installed adapter is passed to `SyntaxRuntime.attach`, which schedules activation outside rendering.
9. The runtime installs eligible below-editor metadata and footer after adapter installation. A settings-directory subscription is bound to the current epoch.

The terminal-color observer is also a zero-row public widget. It supplies actual terminal write/query functions and binds the terminal instance's public start/stop lifecycle to both colors and syntax. [Terminal-default eligibility](terminal-colors-spec.md#eligibility-and-automatic-themes) includes a narrowly scoped guarded renderer-state read; it is not permission for general private renderer interception.

The stable TUI reference is retained across Pi's regular/fullscreen renderer replacement. This avoids receiver-capture probes, raw-input observation, private viewport-input wrapping or an input-hook migration protocol.

## What is hooked, and what remains native

| Boundary | Adapter observation/projection | Native work retained |
| --- | --- | --- |
| Public tool-renderer resolver | Exact stock `read`/`write`/`edit` call+result renderer pairs receive lazy leaf proxies; custom, mixed and all other pairs pass through unchanged | Native execution and results; original stock callbacks and their arguments/theme/context when actually painted |
| Tool prototype | Render, normalized mouse and update notifications (`updateArgs`, `updateResult`, `setArgsComplete`, `setExpanded`, `invalidate`, `markExecutionStarted`) | Original update method, receiver and arguments; actual tool execution and results |
| User-message prototype | Render plus rebuild/output-padding/invalidation notifications | Native Markdown rendering and original message data |
| Recognized stock editor | Presentation/border hooks, placement accessor and normalized mouse translation | Same editor instance, keyboard input, paste/cursor/undo/history and autocomplete engine |
| `Container` add/remove/clear | Tree attachment and owned-resource lifecycle | Native child mutations and ordering |
| Existing `Container.render`/`Spacer.render` | Call-local document settings/time samples, native widget-height observation and guarded queued-card projection | Native traversal, geometry updates and child ownership |
| Public footer/widget slots | Owned footer and metadata rows | Later owners, native selectors and native activity indicator lifecycle |

Each lazy proxy is associated with the host renderer's actual weak-keyed `context.state`, not a process-global tool-call ID registry. It delegates rendering, input, mouse and invalidation to the current native component without inheriting Pi's container layout cache. Callback replacement retires superseded proxies and releases their slot inputs; when a successful custom card takes over, the live owner evicts its materialized native child components but retains the current deferred invocation and its input references for a later genuine native fallback. These are separate lifecycle operations even if Pi still holds an older proxy in its mouse layout. Call/result callback or component-render failures use bounded neutral fallback text, report one safe runtime-health issue per slot, and clear that issue after a later successful native generation.

The integration uses **inspected private component shapes**, even though it imports host classes through public package exports. These are compatibility checks, not a promise that arbitrary future Pi implementations or other extensions have the same shape.

Required shared-class/tool contracts fail closed: installation/render exceptions disable the adapter, restore still-owned hooks and delegate to Pi. Unsupported optional pending-message or upper-widget shapes leave that block native instead of disabling all cards. Exact editor ownership can reject input/footer styling while cards remain active. The behavioral guards are described in [editor ownership](editor.md) and [queued projection](user-queued-cards.md).

Every restoration checks that the descriptor/function is still the adapter's own wrapper. If another extension replaced it, that later owner wins. Restoration also distinguishes an originally absent own property from an inherited one; it does not leave a shadow property behind.

Persistent prototype wrappers are made in prototype-only factory scopes, not a scope containing the first installed component. Merely using `WeakMap` does not prevent a shared V8 closure environment from retaining that component. The same restriction applies to persistent animation/report callbacks; weak accounting cannot compensate for an accidental strong closure capture.

## Presentation dispatch

Dispatch tests lifecycle and safeguards before it performs expensive preparation. Output size is not the policy selector.

| Current component | Selected path |
| --- | --- |
| Collapsed eligible text-only tool | Compact summary, unless a native-card policy/default applies |
| Attached exact Bash under owned policy | Bash frame when command/context and prepared paint/layout are usable; otherwise the existing bounded summary, even expanded |
| Compatible read | Compact summary by default, including image results; explicit expansion selects owned saved text/error details and any host image block, never the write/edit automatic-full window |
| Compatible edit, final successful result, valid path | Selected bounded saved-diff preview or full saved diff; malformed preview metadata shows the owned unavailable row, while unsupported explicitly full metadata uses native rendering |
| Compatible write, final successful result, valid path | Selected bounded saved-data preview or full write card; malformed preview metadata shows the owned unavailable row, while unsupported explicitly full metadata uses native rendering |
| Incomplete/partial/failed edit or write | Compact lifecycle summary by default; expanded pending details show a bounded received-source excerpt, while expanded final-error details show all available saved request/error text only after ordinary construction funding and measurement succeed |
| PowerShell, ordinary expanded tools, non-read images, intentional hiding or explicit opt-out | Native tool path |
| Compatible ordinary user / native pending queue | User or queued projection, not a synthetic conversation entry |
| Recognized still-owned stock editor | Editor frame and below-editor rows; separate footer eligibility also applies |

`--tidy-ui-card` adds exact names to native-card policy; using `bash`, `read`, `edit` or `write` opts that name out of its custom presenter. `--tidy-ui-compact` retains priority when both flags name a tool. It does not defeat explicit expansion or intentional native hiding; ordinary non-read image results remain native. Read's explicit expansion uses the owned read view under its selected policy, including images, instead of ordinary-tool native expansion. The same final-success and selected-view predicates are used by rendering, spacing, mouse and animation teardown, avoiding a frame in one path and a running summary in another.

A stacked host wrapper that does not own a file tool's attached presentation delegates the original mouse event unchanged to its predecessor. It does not render that tool to infer an exterior gap: the attached owner's wrapper applies its own hit-testing and coordinates. This keeps mouse movement from causing hidden render, useful-card or measurement work in another live adapter.

### Native visibility

A native self-shell renderer can return no rows even with `hideComponent=false`. The host observer is installed only on the compatible public tool-component shape, but that includes the stock self-shell edit component. A compatible saved read/write/edit data shape remains eligible for a file card even when its renderer pair is custom, mixed or replaced; those callbacks remain untouched and their original renderer is executed at the actual viewport width when self-shell visibility or native fallback requires it. Names/schemas cannot prove that the component is visible.

The narrow stock-edit shortcut verifies on every visit either the original public `createEditToolDefinition` call/result pair plus a current plain `Box` with exact stock methods, or the exact adapter-owned deferred renderer pair plus its adapter-created call component. Function identity alone is insufficient for the unwrapped stock path: the stock tool factory can reuse an earlier custom Box. This shortcut stores no visibility proof and changes no native state. Compatible third-party file renderers remain eligible for the same saved-data presentation, but are not wrapped, retired or cleared; only the exact deferred stock pair receives lazy ownership and its native-work savings. Supported expansion uses the custom full saved-data view; explicit native presentation, non-read image/hidden guards and unsupported full write/edit metadata use the existing native renderer. Stock read's owned compact/full paths do not render a native shell to recover images: they borrow current public host Image children separately. Foreign self-shell hiding remains native-authoritative.

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

This is neither a grace-period cache nor a timed session handoff. Appearance Off, failure and unload still release immediately. Parent/index observations repair stale positions lazily; they do not create a second strong tree registry. See [layout ownership](render-cache-spec.md#invalidation-and-ownership) and [syntax work ownership](syntax/work.md).

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

Bare `/tidy-ui` opens a single public custom overlay. Arguments report usage; non-TUI modes do not open it. Its owner reads cached state and issues explicit actions; opening root/status does not perform source classification or service discovery. The [menu](settings-menu-spec.md) owns navigation, preview/rollback and file validation.

Actions capture the session epoch and save-abort signal. After awaited work they check those identities before updating the popup/runtime. Shared-switch persistence is queued **before** awaiting cleanup, so closing/reopening a popup cannot reverse confirmation order. A live application can succeed while persistence fails; the outcome explicitly says applied-but-not-saved rather than pretending to roll back the runtime.

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

Shutdown retires the epoch, aborts unpublished saves, removes settings watching and closes the popup first. It clears current live-Bash/name state, records existing diagnostics, disposes runtime health and quiesces the presentation adapter.

Quiescence stops new preparation/animation but lets already-painted unchanged layouts serve cleanup frames, including the borrowed image block of an expanded read. Changed, uncached, differently sized or native content still delegates to Pi; unrelated native input/update handling is not frozen.

Cleanup then uses nested `finally` blocks:

1. await syntax/helper disposal;
2. await closing the outgoing journal, so source-cleanup diagnostics still have their run-bound sink;
3. dispose terminal observers, preserving applied defaults for a non-quit successor or releasing them on quit;
4. restore the owned footer;
5. restore all still-owned presentation hooks without forcing an extra full teardown repaint;
6. clear runtime/context/diagnostic references even if an earlier cleanup rejects.

Appearance Off and rendering/install failure use their ordinary restoration/repaint behavior rather than this quiescent teardown sequence. Runtime health is independent of capture: explicit owner-qualified incidents flow through `DiagnosticSink.runtime`, not parsing of log messages. Old callbacks retain old observers and cannot notify a new session; neighboring successes cannot clear another owner's failure. Expected cancellation/refusal is not automatically an incident. See [health and journaling](debug-logging-spec.md).

Terminal stop/start is **not shutdown**. It keeps the session and ready representations, releases owned colors while yielded, and deliberately retires outstanding syntax work under the approved bounded-replay exception. Successful native restart reconciles current eligibility and useful work. It does not reinterpret an ordinary uncertain timeout as intentional suspension. Exact obligations are in [terminal lifecycle](terminal-colors-spec.md) and [intentional syntax suspension](syntax/providers.md#intentional-terminal-suspension).

## Compatibility boundary

The minimum supported host is Pi 1.0.1. Positive activation on supported Pi versions is required precisely because fallback alone can hide contract drift. The adapter does not restyle HTML exports or standalone user shell messages, replace native focus/selection/mouse processing, mutate global themes, read tool files to reconstruct results, add model requests or promise compatibility with arbitrary competing hook owners. Pi dispatches SGR mouse input only in fullscreen `TuiAltScreen`; regular TUI mode has no mouse-event dispatch, so pointer-selection guarantees and CLI click controls are fullscreen-only. For an exact deferred stock read/write/edit pair, an owned saved-data card does not materialize the stock renderer or run its native file preparation; a genuine TUI native path (appearance off, explicit native override or unsupported full write/edit metadata) materializes it and retains Pi's own behavior. Pi's `/export` command is separate: its HTML presentation uses saved call/result data independently of the owned TUI file card. The write/edit export path does not invoke the deferred TUI stock callbacks. The public `createToolHtmlRenderer` API is separately tested when directly supplied renderers. Compatible foreign renderers keep their callbacks and producer state untouched and are still presented from compatible saved data, but they have no zero-native-work guarantee.
