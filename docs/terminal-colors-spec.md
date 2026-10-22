# Terminal-default colors

## Scope and controls

pi-tidy-ui can synchronize the terminal's default background and foreground with a **fixed, file-backed Pi theme**. This affects the shared terminal, not just a card. It is independently implemented in `src/terminal-colors.ts`; `src/index.ts` owns the host integration and `src/terminal-lifecycle.ts` binds the public terminal start/stop boundary.

The feature defaults to On. Bare `/tidy-ui` exposes **Set terminal colors from Pi theme**: On/Off requests application of Pi's theme to the terminal background and default text color, rather than reporting whether colors match. **Status & troubleshooting** shows the current effective state and **Reapply terminal colors**. See the [saved-preference contract](settings-menu-spec.md).

Local off releases applied defaults but leaves cards, input styling and the footer eligible. It stops theme-source reads/application, not the one-shot default-RGB sampling needed to paint remaining cards correctly after a release. Appearance Off releases defaults and removes the observer. Appearance On respects the terminal-color preference; reload restores it before activation. Terminal/native preferences are saved in the extension config, not Pi settings; appearance is process-local. Explicit **Reapply terminal colors** rereads the enabled theme and resends every defined target even if its remembered value is unchanged, repairing an external reset. It never enables a disabled preference or resets an unowned absent channel. Ordinary theme refreshes still deduplicate.

Foreign editor/footer ownership does not itself disable terminal synchronization. Disable the old standalone `theme-background` extension manually before using this feature. Only one terminal-default writer is supported; pi-tidy-ui cannot coordinate arbitrary competing writers.

## Eligibility and automatic themes

Automatic pairs, including same-name and whitespace-separated pairs, and `system` never receive feature color applications. A configured automatic/system setting remains a conservative opt-out even after a temporary programmatic selection. The current native appearance-tracking flag also disables application: effective saved settings alone can hide a runtime automatic selection under a project override.

The adapter reads one guarded renderer field, `terminalColorSchemeNotificationsEnabled`, through Pi's stable TUI reference. It never writes that field or intercepts its setter, color queries, scheme subscriptions, callbacks or private ThemeController state. The field must be boolean. Missing/incompatible state disables terminal synchronization with a warning, not card rendering. A cooperating extension enabling native appearance notifications also causes conservative suspension. Arbitrary modifications of this native tracking mechanism are unsupported.

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

File lookup/read/parse happens in queued synchronization work, outside the current render call. Reads are synchronous within that finite task, not background-thread I/O. Same-name/export-only native hot reload counts as a new accepted theme revision. Unchanged ordinary/Working frames perform no repeated source lookup/read or color report. There is no interval, extra file watcher or polling retry.

An unreadable/malformed source retains the last valid **complete** terminal-target snapshot. Do not publish one channel from a partly invalid document. Warn once for a continuous error; a successful synchronization clears it. Retry on a subsequent accepted native theme revision or explicit colors on. A valid no-file/empty state, eligibility loss and off are intentional releases, not errors.

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

## Concrete RGB for rendering

Changing terminal defaults does not automatically refresh Pi's cached `Theme.colors`. pi-tidy-ui therefore maintains one latest local concrete-color projection for its RGB arithmetic, including derived diff backgrounds and the input half-block. It does **not** mutate Pi's Theme, semantic methods or global theme/color state.

Known requested RGB is authoritative for a channel we apply. For unowned default-token channels, use actual public terminal reports when available. Merge independently arriving channels within the same generation. Default-token classification uses public ANSI methods and SGR operations, never numeric components inside RGB/indexed sequences. Preserve explicit and unfamiliar semantic tokens.

After local off or a release into a no-file presentation, a finite profile report can repair RGB arithmetic even if native reload cached our former override. Local-off observation never reads theme metadata or sets colors. Automatic mode adds no such reports; Pi owns its profile query and theme update. Warm frames reuse the latest projection and start no query. A missing report uses native concrete fallback: it is **not** verified current profile RGB and may remain stale. Do not invent or promise unavailable pixels.

This latest numeric/projection state is outside both transcript accounting groups. It retains no tool/editor owner, source body or width history and introduces no persistent clock. Native scheme/query semantics, model requests, tool arguments/results, saved session bytes, geometry and editing state remain unchanged.

## Verification contract

See [testing](testing.md) for commands and evidence discipline. Require:

- Resolver/channel first-red cases, independent releases, atomic source-error retention and numeric zero.
- Actual SDK positive mode/SGR/observer gates and missing/wrong-type/throwing-field rejection; future host contract drift must fail tests instead of silently accepting inactive coverage.
- Real fixed → automatic ordering under project overrides, initially automatic and late loading, reload and both renderer modes; no transient application.
- Controlled actual OSC set/reset/report traffic, hot reload/BOM, local/global toggles and normal exit; on/off must physically rewrite an unchanged visible marker in both modes, with no forced redraw on unchanged targets/warm frames or RGB-only reports.
- Session/reload handoff with zero reset/reapply for unchanged targets, inherited automatic-mode release, no-successor native UI and owner-free process-exit cleanup.
- Real shell job-control Ctrl+Z → `fg` in both renderers: synchronous independent releases, current targets restored, Off retained, editor draft/paste/cursor and saved traffic unchanged; explicit Reapply repairs an observed foreign reset. Verify native mode restoration and zero warm work, not merely the preference state.
- Public lifecycle hook delegation/descriptor ownership, failed native start, inactive-controller GC, stale query rejection, source errors and Off/automatic/empty transitions during suspension.
- Physical diff/edge colors with stale native defaults, including local off after reload and late unowned-default reports on an already-rendered diff.
- Exact warm read/query/output/projection counters and retired-controller/UI GC with an active pending report.
- Native no-feature tool/model comparison, exact persisted content and same-session replay with zero new execution.

The controlled headless terminal retains application overrides across profile changes. It proves behavior in that model, not support or identical pixels in every graphical terminal. A physical-terminal smoke test remains separate.
