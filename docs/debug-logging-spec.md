# Diagnostic journals

pi-tidy-ui records human-readable text journals for session lifecycle, presentation decisions and failures across the extension. Capture is enabled by default and is independent of the Tidy UI appearance switch. It does not change highlighting or UI ownership policy.

## Reading and controls

Bare `/tidy-ui` → **Status & troubleshooting → Diagnostic logs** shows current session/run, paths, capture state and counters. **Record diagnostic logs** stops or resumes capture; **Retry recording** explicitly retries a failed writer. **Write state snapshot** records existing runtime/cache/syntax/color/Git/animation counters, without enabling capture or rendering.

The capture preference is [process-local](settings-menu-spec.md#persistence), independently of appearance: it is never stored in config and never changed by another Pi. Two primitive memory flags preserve capture/appearance through `/reload`; a new process starts On. Local Off is restored before journal initialization: no files, retention scan or cleanup are started. Legacy saved capture flags are ignored. There is no separate log browser, JSON journal or session-history index; read or tail the overview and detailed text files at the displayed paths. Explicit retry keeps the run identity but uses a new capture file. Turning capture off flushes pending records without disabling the extension.

The private directory is `os.tmpdir()/pi-tidy-ui-<user>`: the numeric UID on POSIX, a sanitized username on Windows. The directory contains:

- `sessions.log` and optionally `sessions.log.1`: brief start/end lines with session/run/PID, reason and detailed path.
- A uniquely named detailed `.log` for each capture, with one `.log.1` predecessor.
- Normally closed captures renamed to `.closed.log` and, if present, `.closed.log.1`.

The header contains full session/run identities, the Pi session file, workspace, versions, platform, mode, model provider and Pi theme. A filename's final UUID identifies the capture; the full run identity is in the header. Reload/resume/concurrent opens receive separate runs. The logger does not read Pi session history to obtain a name: the header may say `unknown`, and public name-change events are recorded later. Rotation repeats the startup header; subsequent changes remain ordinary lines.

Paths and session names are private metadata. POSIX directory/file modes are 0700/0600; Windows inherits permissions from the user's temporary directory, not a new ACL. Unsafe final-directory symlinks and unsuitable POSIX ownership/permissions disable the writer. Nothing is uploaded or printed to protocol stdout/stderr.

## What the journal explains

Records contain a timestamp, severity, area, explanation and selected primitive details. Controls/newlines are escaped and large fields or records visibly shortened. The journal does **not** contain prompts, drafts, messages, Bash commands, source text, tool argument/result bodies, wire payloads, credentials, environment dumps or arbitrary exception text. Failures use an owning operation and a recognized safe error code; unavailable causes stay `unknown`.

The existing owners report:

- Session/startup/commands, effective settings, installation, cleanup and compatibility restoration.
- Tool/user/native/hidden/compact/card routing, build/invalidation and already-computed geometry; editor/footer/status/queued-card eligibility, clipping and restoration.
- Syntax source identity/version/language/size, native request/result/rejection/staleness/restart, provider selection/loss/recovery and theme/profile changes.
- Terminal-color application/query/release/suspension, Git operations and failures, and fallback-animation participation. Git and animation work totals appear in explicit snapshots rather than per-tick records.

Syntax records correlate the **selected projection** with the tool call and source/version: exact native classification, cached Pi fallback, file retained committed ranges, Bash historical/frozen matching-prefix styles, pending/uncertain work, plain projection or native delegation. Pi fallback records distinguish returned style directives from a valid unstyled result without another ANSI/source pass. This is not a claim about physical terminal pixels or why Pi's parser returned those styles. Bash without native coloring uses whole-command `toolTitle`, never the Pi classifier.

`demandOutcome` labels the earlier demand evaluation, not current execution; historical display styles are not current-source proof. Fallback permission records are not Pi classifier invocations. Provider candidate callbacks are not evidence of shared discovery or a connection. Expected missing Git `reftable` directories do not produce repeated failure records; real watcher errors/refresh/rebinding behavior is unchanged.

Native tool lifecycle callbacks are counted, but repeated callbacks in the same phase are not separately logged. Real source versions/preparation and phase changes remain recorded. Explicit snapshots expose callback and phase-change totals; no source contents or per-frame records are added.

An explicit snapshot reads existing counters; it does not render, classify, query providers or scan the transcript. Decisions are deduplicated by component/source-owned primitive markers with weak ownership. Settled unchanged frames and repeated same-size observations create no new journal records or logger I/O. Actual state/width/theme/geometry changes may produce records without introducing presentation work.

## Runtime health is not log-writer health

`/tidy-ui` → **Status & troubleshooting** and **Diagnostic logs** distinguish:

- **Runtime errors**: deduplicated unexpected failure episodes detected by the extension during the current session runtime. **Active** is the number of unresolved source/operation failures, not the number of failed commands or log lines.
- **Log write errors**: errors opening/writing/rotating the diagnostic destination and overview. A zero value says nothing about syntax or other extension correctness.
- **Dropped records**: records omitted by the bounded log buffer. A nonzero value explicitly indicates incomplete diagnostic evidence; it is neither a runtime-error count nor a write failure.

Unexpected failures issue a deferred public error notification pointing to `/tidy-ui`, even with capture Off, no writer, a failed disk or a full buffer. Notification delivery occurs outside render/settlement callbacks. Repeated failures with the same subsystem/operation/safe-code category are coalesced while that category remains active, rather than notifying for every streamed update. Different categories arising in the same turn each retain a pending notice; one cannot overwrite another. An unrelated old failure does not suppress a new category. Distinct lease generations keep independent failure/recovery records but share the lease-close notification category, so many identical cleanup failures do not flood the UI. The menu's root shows **Issues**; status and service pages retain safe cause codes and UTC timestamps, independently of the provider's connected/ready status. The most recent failure can have recovered while another source remains broken: active examples remain visible and the count does not become healthy because a neighboring card succeeded.

Failure/recovery belongs to the owning operation. A validated accepted SOURCE settles a source failure; successfully published replacement styles settle that owner's STYLE failure. A successful Pi projection settles that classifier failure. Obsolete STYLE failures do not reopen degradation after cached rollback; lease-close incidents retain their original weak source identity and generation so a reused key cannot blame a replacement owner. A valid settings read/save or terminal-color resolution settles only its matching operation. Removing or collecting an owner removes its active problem but marks the last event **owner removed**, never **recovered**. Session transition/reload closes the old health observer and starts fresh counts; it does not reinterpret old callbacks as new-session errors. There is no cross-reload health history, transcript scan, journal parser, recurring timer or automatic retry.

Intentional Off, expected volume/storage/queue refusal, catalogue/profile changes, source restart and explicit lifecycle cancellation are not runtime errors. Bad reply structure/identity, parser/classifier exceptions, unexpected request rejection, startup failure, settings failure and terminal-default errors are abnormal. Such failures are logged as **ERROR** when capture is active, but runtime accounting is explicit and does not count every `WARN`/`ERROR` line as another incident. Historical log entries are not retroactively counted. The extension continues safe fallback presentation and preserves unknown-outcome/duplicate-classification restrictions; a notification does not silently grant retry permission or fix the failure.

Owned-helper startup has its own broker-owned incident: failed acquisition/download, a present unusable executable, incompatible/malformed metadata, unexpected exit or startup deadline failure is abnormal even though optional fallback keeps Pi usable and `start()` resolves. Genuinely missing colocated development builds, absent shared candidates and unsupported platform/ABI targets remain expected; they do not create runtime errors. A versioned package missing its release declaration or an artifact for a supported target is instead a packaging failure and must remain visible. Ready publication recovers the startup incident; explicit Off/disposal releases it. A generic runtime startup-success callback cannot clear that distinct incident. No exception body/path is retained. Embeddings without the health observer still receive the existing weak, episode-coalesced startup error notification.

Changing from a broken file-backed terminal theme to a theme without a file source releases that obsolete color-source incident and clears its repeated-failure suppression marker; it is not described as repair of the abandoned file. Returning to the same broken source can therefore report a fresh incident. Successful resolution of a valid file source instead records recovery. Neither event clears another owner's failure.

`src/runtime-health.ts` owns only scalar safe metadata and weak references to current failing owners; it never retains source text, exception objects, commands or UI trees. `src/diagnostics.ts` carries explicit lifecycle events alongside the existing optional journal sink. File writer counters remain in `debug-log.ts`. Status reads do not activate or reclassify syntax.

## Batching and retention

| Item | Policy |
| --- | --- |
| Detailed file | 4 MiB including header, plus one predecessor |
| Overview | Approximately 1 MiB, plus one predecessor |
| Record | At most 16 KiB encoded UTF-8 |
| Pending + in-flight buffer | 128 KiB per detailed writer |
| Flush | 32 KiB threshold or a one-shot 500 ms delay |
| Inactive history | Newest 16 recognized pairs; discard pairs idle for more than seven days |
| Cleanup | Startup, then at most once per six hours when a write already occurs |
| Close wait | Best-effort drain, bounded at two seconds |

Ordinary records format/encode once and update in-memory byte counts. There is no per-record filesystem size check, free-space check or directory scan. Writes are asynchronous batches with one batch in flight. Empty capture has no timer. Cleanup uses the latest filesystem modification time of a pair, never parses old journal contents, and has no independent timer.

Normally closed pairs are removable regardless of PID. Abandoned unmarked pairs with live/unknown PIDs are left alone; PID reuse can delay cleanup. Current/foreign/link entries are not removed. No running extension means no maintenance. Sixteen inactive pairs hold roughly 128 MiB; active or uncertain pairs are extra, not an exact machine-wide disk quota.

The shared overview has no lock or long-lived handle. Simultaneous processes can lose overview lines or overshoot its rotation threshold; independently owned detailed journals are unaffected. It is a convenient recent overview, not an authoritative session database or proof of clean exit.

Buffer pressure drops diagnostics, counts omissions and later writes a readable omission notice. A disk/permission/write error stops the affected writer, releases pending buffers and emits one public UI warning when available; there is no automatic retry or console fallback. Overview failure does not stop a healthy detailed writer. Crashes or a slow close can lose buffered records or leave a partial last line; there is no `fsync` or audit-grade durability guarantee.

## Implementation and checks

`src/debug-log.ts` owns files, batching and retention; `src/session-logging.ts` binds observers to a run; `src/diagnostics.ts` isolates observers and classifies safe errors. Existing UI/syntax/Occipital owners emit already-computed decisions. Old callbacks cannot be reattributed to a new run.

See [testing](testing.md) for executable filesystem/child-process, SDK/GC and real offline Pi live/replay controls, including active-logger warm-frame counters and strict tool/model/session comparisons. Linux/POSIX evidence does not establish Windows ACL, watcher or runtime behavior. The accepted design is recorded in the repository's `docs/debug-logging-plan.md`; working findings and execution evidence remain in ignored `.test-artifacts/`.
