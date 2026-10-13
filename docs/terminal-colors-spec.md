# Terminal-default colors

## Scope and controls

pi-tidy-ui can synchronize the terminal's default background and foreground with a **fixed, file-backed Pi theme**. This affects the shared terminal, not just a card. It is independently implemented in `src/terminal-colors.ts`; `src/index.ts` owns the host integration.

The feature starts enabled with pi-tidy-ui:

```text
/tidy-ui colors status
/tidy-ui colors off
/tidy-ui colors on
```

Local off releases applied defaults but leaves cards, input styling and the footer eligible. It stops theme-source reads/application, not the one-shot default-RGB sampling needed to paint remaining cards correctly after a release. Global `/tidy-ui off` releases defaults and removes the observer. Global on respects the local toggle; reload creates a fresh enabled runtime. Toggles are not written to Pi settings. Explicit colors on retries synchronization even if the native theme identity is unchanged.

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

Normalize valid targets to RGB hex. OSC 11/10 set background/foreground; OSC 111/110 release them. Deduplicate independently: changing background does not resend foreground; initially absent channels emit no reset. Compose changed channels in one terminal write. Do not alter cursor colors or the ANSI palette.

A release restores **profile defaults**, not a saved earlier application's dynamic override. Normal shutdown and a weak process-exit fallback release applied channels; SIGKILL, transport failure and terminals without OSC support cannot guarantee restoration. Repeated shutdown/disposal is idempotent. Runtime off/shutdown remove our widget and exit listener. Local off retains the zero-row RGB observer but removes the unnecessary application exit listener; enabling again installs at most one.

Queued jobs and initial/late query responses validate generation, eligibility and public theme revision. Old jobs cannot apply defaults or change a later presentation. Report/exit callbacks use separately constructed weak-only closures; even a never-resolving report must not keep a retired controller or its UI owner alive.

## Concrete RGB for rendering

Changing terminal defaults does not automatically refresh Pi's cached `Theme.colors`. pi-tidy-ui therefore maintains one latest local concrete-color projection for its RGB arithmetic, including diff Multiply tints and the input half-block. It does **not** mutate Pi's Theme, semantic methods or global theme/color state.

Known requested RGB is authoritative for a channel we apply. For unowned default-token channels, use actual public terminal reports when available. Merge independently arriving channels within the same generation. Default-token classification uses public ANSI methods and SGR operations, never numeric components inside RGB/indexed sequences. Preserve explicit and unfamiliar semantic tokens.

After local off or a release into a no-file presentation, a finite profile report can repair RGB arithmetic even if native reload cached our former override. Local-off observation never reads theme metadata or sets colors. Automatic mode adds no such reports; Pi owns its profile query and theme update. Warm frames reuse the latest projection and start no query. A missing report uses native concrete fallback: it is **not** verified current profile RGB and may remain stale. Do not invent or promise unavailable pixels.

This latest numeric/projection state is outside both transcript accounting groups. It retains no tool/editor owner, source body or width history and introduces no persistent clock. Native scheme/query semantics, model requests, tool arguments/results, saved session bytes, geometry and editing state remain unchanged.

## Verification contract

See [testing](testing.md) for commands and evidence discipline. Require:

- Resolver/channel first-red cases, independent releases, atomic source-error retention and numeric zero.
- Actual SDK positive mode/SGR/observer gates and missing/wrong-type/throwing-field rejection; future host contract drift must fail tests instead of silently accepting inactive coverage.
- Real fixed → automatic ordering under project overrides, initially automatic and late loading, reload and both renderer modes; no transient application.
- Controlled actual OSC set/reset/report traffic, hot reload/BOM, local/global toggles and normal exit.
- Physical diff/edge colors with stale native defaults, including local off after reload and late unowned-default reports on an already-rendered diff.
- Exact warm read/query/output/projection counters and retired-controller/UI GC with an active pending report.
- Native no-feature tool/model comparison, exact persisted content and same-session replay with zero new execution.

The controlled headless terminal retains application overrides across profile changes. It proves behavior in that model, not support or identical pixels in every graphical terminal. A physical-terminal smoke test remains separate.
