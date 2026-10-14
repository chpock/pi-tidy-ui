# Diagnostic journals

pi-tidy-ui records human-readable text journals for session lifecycle, presentation decisions and failures across the extension. Capture is enabled by default and is independent of the Tidy UI appearance switch. It does not change highlighting or UI ownership policy.

## Reading and controls

Bare `/tidy-ui` → **Status & troubleshooting → Diagnostic logs** shows current session/run, paths, capture state and counters. **Record diagnostic logs** stops or resumes capture; **Retry recording** explicitly retries a failed writer. **Write state snapshot** records existing runtime/cache/syntax/color/Git/animation counters, without enabling capture or rendering.

The capture preference is stored in the [extension config](settings-menu-spec.md), independently of appearance. A saved Off is loaded before journal initialization: no files, retention scan or cleanup are started. Reload restores this preference in a new logging runtime. There is no separate log browser, JSON journal or session-history index; read or tail the overview and detailed text files at the displayed paths. Explicit retry keeps the run identity but uses a new capture file. Turning capture off flushes pending records without disabling the extension.

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
