# Pi host integration and extension lifecycle

`src/index.ts` is the composition root and the only live-host adapter. It connects Pi's lifecycle, actual component tree and public extension UI to otherwise host-independent presenters, syntax services, preferences and diagnostics. It does not replace tools, execute commands on their behalf or rewrite conversation records.

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

1. The factory registers `tidy-ui-card` and `tidy-ui-compact` string flags. Deprecated `tidy-ui-cache-mb` and `tidy-ui-card-cache-mb` are accepted but ignored: live layouts are not subject to those former eviction budgets. Supplying them produces a bounded warning when presentation starts.
2. It starts one preference-load promise. Loading preferences does not construct the presentation adapter or start a syntax provider. The initial defaults are Follow Pi with terminal matching and native highlighting enabled; failures are reported rather than silently saved over the input file.
3. `session_start` closes an old popup, increments the lifecycle epoch, aborts old unpublished save work, clears transient Bash-call IDs/name state and waits for preferences if necessary. A later epoch invalidates that continuation.
4. Logging/health start from the public session identity. Presentation starts only in TUI mode with appearance enabled. Print/JSON/RPC paths do not install terminal presentation or open the menu.
5. `startColors` establishes the zero-row terminal observer before presentation capture. Its factory binds public terminal start/stop to colors and `ensureSyntax(ctx)`. This can construct the syntax runtime, but construction leaves its client disabled: an observer may exist even if presentation attachment later fails.
6. A separate zero-row public capture-widget factory obtains the actual live TUI. It is removed immediately: this is a capture mechanism, not an extra visible row. The adapter verifies that the TUI shares the imported `Container` identity, has the required operations and contains compatible component shapes.
7. The existing tree is visited before future-child observers are installed. A public `Container.addChild` wrapper subsequently visits the entire added subtree, not only its root; restored history can arrive already assembled. Only a successfully installed adapter is passed to `SyntaxRuntime.attach`, which schedules activation outside rendering.
8. The runtime installs eligible below-editor metadata and footer after adapter installation. A settings-directory subscription is bound to the current epoch.

The terminal-color observer is also a zero-row public widget. It supplies actual terminal write/query functions and binds the terminal instance's public start/stop lifecycle to both colors and syntax. [Terminal-default eligibility](terminal-colors-spec.md#eligibility-and-automatic-themes) includes a narrowly scoped guarded renderer-state read; it is not permission for general private renderer interception.

The stable TUI reference is retained across Pi's regular/fullscreen renderer replacement. This avoids receiver-capture probes, raw-input observation, private viewport-input wrapping or an input-hook migration protocol.

## What is hooked, and what remains native

| Boundary | Adapter observation/projection | Native work retained |
| --- | --- | --- |
| Tool prototype | Render, normalized mouse and update notifications (`updateArgs`, `updateResult`, `setArgsComplete`, `setExpanded`, `invalidate`, `markExecutionStarted`) | Original update method, receiver and arguments; actual tool execution and results |
| User-message prototype | Render plus rebuild/output-padding/invalidation notifications | Native Markdown rendering and original message data |
| Recognized stock editor | Presentation/border hooks, placement accessor and normalized mouse translation | Same editor instance, keyboard input, paste/cursor/undo/history and autocomplete engine |
| `Container` add/remove/clear | Tree attachment and owned-resource lifecycle | Native child mutations and ordering |
| Existing `Container.render`/`Spacer.render` | Call-local document settings/time samples, native widget-height observation and guarded queued-card projection | Native traversal, geometry updates and child ownership |
| Public footer/widget slots | Owned footer and metadata rows | Later owners, native selectors and native activity indicator lifecycle |

The integration uses **inspected private component shapes**, even though it imports host classes through public package exports. These are compatibility checks, not a promise that arbitrary future Pi implementations or other extensions have the same shape.

Required shared-class/tool contracts fail closed: installation/render exceptions disable the adapter, restore still-owned hooks and delegate to Pi. Unsupported optional pending-message or upper-widget shapes leave that block native instead of disabling all cards. Exact editor ownership can reject input/footer styling while cards remain active. The behavioral guards are described in [editor ownership](editor.md) and [queued projection](user-queued-cards.md).

Every restoration checks that the descriptor/function is still the adapter's own wrapper. If another extension replaced it, that later owner wins. Restoration also distinguishes an originally absent own property from an inherited one; it does not leave a shadow property behind.

Persistent prototype wrappers are made in prototype-only factory scopes, not a scope containing the first installed component. Merely using `WeakMap` does not prevent a shared V8 closure environment from retaining that component. The same restriction applies to persistent animation/report callbacks; weak accounting cannot compensate for an accidental strong closure capture.

## Presentation dispatch

Dispatch tests lifecycle and safeguards before it performs expensive preparation. Output size is not the policy selector.

| Current component | Selected path |
| --- | --- |
| Collapsed eligible text-only tool | Compact summary, unless a native-card policy/default applies |
| Exact Bash with displayable command/directory context | Bash frame, collapsed or expanded |
| Exact edit, final successful result, valid path | Saved diff frame, heading without metadata, or native fallback for malformed metadata |
| Exact write, final successful result, valid path | Saved changes or submitted-source card according to metadata; malformed metadata remains native |
| Incomplete/partial/failed edit or write | Compact lifecycle summary; a partial error is still running, a final error is wholly error-colored |
| PowerShell, ordinary expanded tools, images, intentional hiding or explicit opt-out | Native tool path |
| Compatible ordinary user / native pending queue | User or queued projection, not a synthetic conversation entry |
| Recognized still-owned stock editor | Editor frame and below-editor rows; separate footer eligibility also applies |

`--tidy-ui-card` adds exact names to native-card policy; using `bash`, `edit` or `write` opts that name out of its custom presenter. `--tidy-ui-compact` wins over that policy, but never over expansion, images or intentional native hiding. The same final-file-success predicate is used by rendering, spacing, mouse and animation teardown, avoiding a frame in one path and a running summary in another.

### Native visibility

A native self-shell renderer can return no rows even with `hideComponent=false`. Unknown, custom, mixed or replaced renderers must therefore execute their original renderer at the actual viewport width when visibility is needed. Names/schemas cannot prove that the component is visible.

The narrow stock-edit shortcut verifies on every visit:

- the `ToolExecutionComponent` shape and exact `edit` name;
- the call/result function pair obtained from public `createEditToolDefinition`;
- a current plain `Box` with exact stock `render`, `clear` and `addChild` methods.

Function identity alone is insufficient: the stock tool factory can reuse an earlier custom Box. This shortcut stores no visibility proof and changes no native state. Explicit native presentation, expansion, images/hidden guards and malformed fallback still use native rendering.

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
| `session_tree`, `session_compact`, `model_select`, `message_end`, `turn_end` | Update current context and advance footer semantic epoch |
| `tool_execution_end` | Footer refresh plus eligible Git rediscovery |
| `agent_end` | Clear live Bash IDs; footer/Git refresh |
| `session_info_changed` | Invalidate saved-name snapshot, request owned footer rendering and notify run-bound logging |
| `session_shutdown` | Retire epoch/watch/popup and services; restore owned UI as below |

Saved session-name event ordering is not trusted as current-name authority: a later render rereads the public current metadata once. Footer snapshots are keyed by session/model/leaf and semantic epochs, not a scan on every render. Live Bash IDs distinguish live interruption from a newly restored interrupted result; see [streaming state](bash-streaming-contract.md).

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

Quiescence stops new preparation/animation but lets already-painted unchanged layouts serve cleanup frames. Changed, uncached, differently sized or native content still delegates to Pi; unrelated native input/update handling is not frozen.

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

The minimum supported host is Pi 1.0.0. Positive activation on supported Pi versions is required precisely because fallback alone can hide contract drift. The adapter does not restyle HTML exports or standalone user shell messages, replace native focus/selection/mouse processing, mutate global themes, read tool files to reconstruct results, add model requests or promise compatibility with arbitrary competing hook owners. Native tool update/preflight work remains native and must not be misreported as custom rendering work.
