# Terminal-default colors

## Scope and controls

pi-tidy-ui can synchronize the terminal's default background and foreground with a **fixed, file-backed Pi theme**. This affects the shared terminal, not just a card. It is independently implemented in `src/terminal-colors.ts`; `src/index.ts` owns the host integration and `src/terminal-lifecycle.ts` binds the public terminal start/stop boundary.

The feature defaults to Off: without a saved preference, neither terminal-default channel is set or reset. Explicit saved On/Off choices are retained; no startup migration or default write is performed. Bare `/tidy-ui` exposes **Set terminal colors from Pi theme**: On/Off requests application of Pi's theme to the terminal background and default text color, rather than reporting whether colors match. **Status & troubleshooting** shows the current effective state and **Reapply terminal colors**. See the [saved-preference contract](settings-menu-spec.md).

Local off releases applied defaults but leaves cards, input styling and the footer eligible. It stops theme-source reads/application, not the one-shot default-RGB sampling needed to paint remaining cards correctly after a release. Appearance Off releases defaults and removes the observer. Appearance On respects the terminal-color preference; reload restores it before activation. Terminal/native preferences are saved in the extension config, not Pi settings; appearance is process-local. Explicit **Reapply terminal colors** rereads the enabled theme and resends every defined target even if its remembered value is unchanged, repairing an external reset. It never enables a disabled preference or resets an unowned absent channel. Ordinary theme refreshes still deduplicate.

Foreign editor/footer ownership does not itself disable terminal synchronization. Disable the old standalone `theme-background` extension manually before using this feature. Only one terminal-default writer is supported; pi-tidy-ui cannot coordinate arbitrary competing writers.

## Eligibility and automatic themes

Automatic pairs contain exactly one slash and two nonempty trimmed names; optional surrounding whitespace and identical names are allowed (`dark / dark`, not `dark dark`). Automatic pairs and `system` never receive feature color applications. A configured automatic/system setting remains a conservative opt-out even after a temporary programmatic selection. The current native appearance-tracking flag also disables application: effective saved settings alone can hide a runtime automatic selection under a project override.

Fixed-only application prevents a feedback loop: Pi can choose an automatic theme from reported terminal background, while our override changes that report. Keeping the override during selection could make Pi react to our output rather than the terminal profile.

The adapter reads one guarded **non-public renderer field**, `terminalColorSchemeNotificationsEnabled`, through Pi's stable TUI reference. This narrowly accepted compatibility exception supplies a current snapshot that the public notification setter does not expose. Observing future setter calls cannot establish already-active automatic mode during late installation or reload; effective saved settings alone can also hide that mode under a project override. It never writes that field or intercepts its setter, color queries, scheme subscriptions, callbacks or private ThemeController state. The field must be boolean. Missing/incompatible state disables terminal synchronization with a warning, not card rendering. A cooperating extension enabling native appearance notifications also causes conservative suspension. Arbitrary modifications of this native tracking mechanism are unsupported. Reset/query/reapply sampling would change unrelated public query results; intercepting a native subscriber would miss late attachment and other query origins. Those alternatives are deliberately not used.

The public zero-row `belowEditor` observer consumes normal invalidation/render visits. Eligibility loss releases owned defaults **synchronously before Pi's automatic-selection query** and invalidates queued work. Initial automatic mode, late loading, reload and renderer replacement must produce no feature metadata reads, reports, applications or resets, except the one-time release of previously applied defaults. There is no requirement to reset channels the feature never owned.

A fixed explicit CLI/native selection can be eligible even without a saved theme setting. Print, JSON and RPC modes install no observer or terminal operations. A generated/no-file theme has no inferred terminal targets.

## Metadata and resolution

- Background comes only from raw `export.pageBg`.
- Foreground comes only from raw `colors.text`.
- Use the active public `sourcePath` first, then the public name/path registry. Do not infer a file from a theme name or fall back to a differently named theme.
- A latest resolved named-file path survives registry disappearance only for the same accepted public theme revision, so a deleted/unreadable active file is a read error, not an intentional no-file theme. Different source revisions cannot inherit it.
- Decode JSON with an optional leading BOM. Resolve variable chains through own `vars` properties; reject unknown variables and cycles.
- Accept Pi's public hex, OKLCH, OKHSL and 0–255 numeric forms through its color parser/converter. Numeric zero is a color, not absence. Indexed values use the SDK's RGB conversion; no terminal ANSI-palette rewriting is performed.
- Missing or empty values, including variables resolving to empty, release that channel. Invalid data is not equivalent to absence.

The document and any present `vars`, `colors` and `export` sections must be non-array objects; missing sections are allowed. Recognized literal color syntax takes precedence over variable lookup, so a variable named `#abc` cannot redefine that literal. The controller's accepted source revision compares `theme.colors`, `theme.name`, `theme.sourcePath` and `theme.fg`, not just the forwarding Theme object's identity. Remembered registry paths are qualified by that complete revision; this is local observation, not a new Pi public API guarantee.

File lookup/read/parse happens in queued synchronization work, outside the current render call. Reads are synchronous within that finite task, not background-thread I/O. Same-name/export-only native hot reload counts as a new accepted theme revision. Unchanged ordinary/Working frames perform no repeated source lookup/read or color report. There is no interval, extra file watcher or polling retry.

An unreadable/malformed source retains the last valid **complete** terminal-target snapshot. Do not publish one channel from a partly invalid document. Repeated identical failure messages are suppressed; runtime health separately coalesces owner/operation/safe-code incidents, so a changed failure may be reported before recovery. Successful resolution clears the failure; intentionally abandoning the source releases its incident rather than claiming that file was repaired. Retry on an accepted theme revision, **Reapply terminal colors**, re-enabling the preference or eligible terminal restart, never by polling. A valid no-file/empty state, eligibility loss and off are intentional releases, not errors.

## Channel ownership and lifetime

Normalize valid targets to RGB hex. OSC 11/10 set background/foreground; OSC 111/110 release them. Deduplicate independently: changing background does not resend foreground; initially absent channels emit no reset. Compose changed channels in one terminal write. A changed packet during live synchronization queues one public `tui.requestRender(true)` after the current render stack, guarded against a retired observer, so unchanged visible rows are repainted immediately; ordinary diff rendering cannot observe OSC-only changes. Same-value ordinary refreshes, warm frames and RGB-only reports do not force redraws; explicit Reapply resends the targets and requests the matching repaint, and this does not globally invalidate component caches or restart syntax work. In regular mode Pi's forced redraw also clears terminal scrollback and re-emits history; fullscreen repaints the viewport. Disposal/process-exit cleanup adds no repaint. Do not alter cursor colors or the ANSI palette.

A release restores **profile defaults**, not a saved earlier application's dynamic override. Appearance Off, terminal-color Off and normal Pi quit release applied channels. Repeated release/disposal is idempotent.

Terminal defaults survive session transitions, but their applied values are valid only while Pi owns the running terminal. `/new`, `/resume`, `/fork` and `/reload` dispose the outgoing observer and its queued callbacks without resetting applied channels. A successor observer adopts the two applied RGB values, reconciles the current preference/theme and writes only changed channels; automatic mode, Off and valid empty/no-file targets still release them. No old UI, source/client, theme, widget or session is retained. `/tree` does not dispose the extension runtime.

One process-wide exit listener retains only the two primitive applied-channel values and synchronously releases remaining channels through stdout. It does not keep the extension runtime alive, replace process shutdown, or depend on another extension load. If tidy-ui is removed from configuration or successor loading fails, its UI hooks remain unloaded and the existing terminal colors stay until process exit. SDK embeddings can supply an isolated applied-color store. SIGKILL, transport failure and terminals without OSC support cannot guarantee restoration. The listener is shared across reloads, with no polling, per-session listener or timer.

Queued jobs and initial/late query responses validate generation, eligibility and public theme revision. Old jobs cannot apply defaults or change a later presentation. Report callbacks use separately constructed weak-only closures; even a never-resolving report must not keep a retired controller or its UI owner alive. Process-exit cleanup owns only channel values, never an observer.

## Terminal suspension and foreground return

Ctrl+Z is not a session shutdown. Pi stops its TUI and sends `SIGTSTP` to its process group; `fg` delivers `SIGCONT`, after which Pi starts and redraws the TUI. Toolview binds the public **terminal instance** `stop`/`start` methods, not the unstable method identities of the renderer facade. The same terminal object survives regular/fullscreen replacement. No signal handlers, keyboard interception, Pi private-state writes or session restart are added.

Before native terminal stop, release only owned OSC 11/10 channels synchronously, invalidate queued synchronization and old color-report generations, and discard profile reports/projections. Keep the last complete valid desired theme targets separately from the now-released applied values. Suspension does not request an extra redraw, read theme files or query terminal colors; observer visits and Reapply while suspended do nothing. It does not clear the editor, cards, source/style caches or measured geometry.

After a successful native terminal start, resume one finite synchronization against current preference, eligibility and theme source. Reapply eligible defined targets even if they equal the targets from before suspension; use last-good complete targets on a source error. A current Off/automatic/empty/no-file state must not reapply old colors. Refresh unowned profile RGB where eligible, rather than reuse a report from the previous terminal ownership period. Native start supplies the ordinary redraw; actual OSC application also uses the existing deferred forced redraw. Warm frames after this reconciliation do no repeated work.

The hooks preserve native receiver, arguments, result and thrown errors. Failed native start does not claim resumed ownership. Disposal deactivates callbacks, restores original property descriptors only while still owned, and cannot overwrite a later extension's method. Hook callbacks hold only weak color-controller and syntax-runtime references; no old runtime survives reload. An incompatible terminal lifecycle disables terminal synchronization with the existing warning, without disabling cards. Stopping/starting for a native external editor or renderer replacement uses the same boundary; it is not a promise to detect arbitrary raw `SIGSTOP`, `bg`, or competing writers which bypass Pi's terminal handoff.

Pi retains ownership of its mouse/input modes, cursor, native activity indicators and process signals. Its external taskbar progress restoration is a separate host issue; Toolview does not emulate it. The same lifecycle boundary deliberately interrupts outstanding Occipital work and resumes useful demand through bounded replay, independently of the terminal-colors switch; see [intentional syntax suspension](syntax-highlighting-spec.md#intentional-terminal-suspension). Retained ready cards are not invalidated. Ordinary timeout protection remains unchanged; no deadline extension or SDK timer suspension is introduced.

## Repaint cost

In regular mode, Pi's forced redraw clears terminal scrollback and re-emits history; fullscreen repaints its viewport. This is the accepted cost of repainting cells that an ordinary diff render considers unchanged after terminal defaults change. The saved session is not rewritten. The forced request is deferred beyond the current render stack because resetting native cursor/previous-row state inside that stack can corrupt the frame being produced.

## Concrete RGB for rendering

Changing terminal defaults does not automatically refresh Pi's cached `Theme.colors`. pi-tidy-ui therefore maintains one latest local concrete-color projection for its RGB arithmetic, including derived diff backgrounds and the input half-block. It does **not** mutate Pi's Theme, semantic methods or global theme/color state.

Known requested RGB is authoritative for a channel we apply. For unowned default-token channels, use actual public terminal reports when available. Merge independently arriving channels within the same generation. Default-token classification uses public ANSI methods and SGR operations, never numeric components inside RGB/indexed sequences. Preserve explicit and unfamiliar semantic tokens.

Default foreground/background are recognized by SGR **39/49** in public prefixes; foreground SGR **2** identifies the faint-default case. When both channels are known, the local faint approximation is a **50% sRGB mix** with the known background. A known default background retains projected identity even if its RGB equals Pi's fallback; equal numbers do not erase provenance. An equal foreground may reuse the original color. This arithmetic does not promise identical physical faint rendering across terminals.

The public color query has a **100 ms initial wait** and accepts late replies through its callback. Either or both channels may arrive, and applied targets outrank reports for owned channels. Missing/rejected reports preserve native fallback and do not start a retry loop.

After local off or a release into a no-file presentation, a finite profile report can repair RGB arithmetic even if native reload cached our former override. Local-off observation never reads theme metadata or sets colors. Automatic mode adds no such reports; Pi owns its profile query and theme update. Warm frames reuse the latest projection and start no query. A missing report uses native concrete fallback: it is **not** verified current profile RGB and may remain stale. Do not invent or promise unavailable pixels.

This latest numeric/projection state is outside both transcript accounting groups. It retains no tool/editor owner, source body or width history and introduces no persistent clock. Native scheme/query semantics, model requests, tool arguments/results, saved session bytes, geometry and editing state remain unchanged.

## Validation reference

See [terminal-default and lifecycle validation](testing.md#terminal-defaults-and-lifecycle) for actual OSC traffic, public-hook ownership, shell job control and physical repaint checks. Terminal support remains dependent on the host terminal; controlled headless behavior is not a guarantee of identical graphical-terminal pixels.
