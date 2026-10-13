# Debug logging plan

Status: **implemented; Linux verification complete**. Operational behavior: [diagnostic journals](debug-logging-spec.md). Windows runtime/ACL behavior is not established by these checks. Revised at the operator's request: ordinary human-readable journals, minimal bookkeeping and I/O, no JSON files, indexes, metadata sidecars or automatically assembled session database. Reasonable loss of diagnostic history is preferable to a complicated logging subsystem.

## Purpose

Diagnose **the whole extension**, not only Occipital. Explain what pi-tidy-ui did, why it chose a presentation, and what failed. Mixed highlighted/unhighlighted messages are a mandatory usefulness example, not permission to change the highlighting policy.

Observe decisions where they already happen. No extra classification, source rereads, transcript scans, rendering, provider calls or competing cache/state implementation. No logging service, dependency, native protocol change or persistent settings migration.

## Journals and session identity

Use a private per-user directory under `os.tmpdir()`; normally `/tmp/pi-tidy-ui-<uid>/` on POSIX. Allow an explicit root for isolated tests. The directory contains ordinary `.log` files:

```text
pi-tidy-ui-<user>/
  sessions.log                         # brief lifecycle lines from all Pi processes
  sessions.log.1                       # one predecessor
  <time>-<session>-<pid>-<run>.log       # detailed journal, one writer
  <time>-<session>-<pid>-<run>.log.1     # one predecessor
```

A detailed journal belongs to one extension/session run. Reload, resume and concurrent opens of the same Pi session receive separate run identities. Filenames use safe generated components; the header provides full IDs, not just shortened filename labels. Late callbacks keep their original session/run attribution.

The readable header identifies the Pi session ID, optional name/session file, cwd, PID/run ID, lifecycle reason, pi-tidy-ui/Pi/Node versions, platform and effective startup/provider/theme choices. A session-file path refers to Pi's existing history, which the logger does not create or change. Repeat the header after rotation. Record relevant later changes as ordinary lines, not by rewriting a metadata file.

`sessions.log` needs only a short start/end line containing time, session/run/PID, reason and the detailed journal path. It is a convenient recent overview for people, not an authoritative registry. A missing end line does not prove a crash or a clean shutdown. Reload/switch ends a run, not necessarily the persisted Pi session.

`/tidy-ui logs` shows current identity, both paths, enabled/failed state and drop/write-error counters from memory. `logs on/off` controls capture for the current session; `logs snapshot` writes existing state/counters without rendering. No `logs list` implementation: people can read/tail the common journal. Default capture is on, including while master presentation is off. Nothing is printed to protocol stdout/stderr.

## Human-readable records

Use timestamps, familiar severity labels, an area and a short explanation, followed by only useful named details. Do not dump objects or turn the text into a machine-oriented event schema. Newlines/control characters in names/paths are escaped; unusually large fields/records are visibly shortened or omitted.

Illustrative output, without conversation/source content:

```text
2026-10-05T12:00:00.000Z INFO  Session started: session=abc run=r1 pid=1234 reason=startup
    Pi session: /home/user/.pi/agent/sessions/example.jsonl
    Workspace: /work/example
    Extension: pi-tidy-ui 0.0.0; Pi 1.0.0; Node 22.19.0
2026-10-05T12:00:00.100Z DEBUG [occipital] Owned helper is starting; native provider not ready.
2026-10-05T12:00:01.000Z DEBUG [syntax] Write call=w1 source=new revision=1: Pi returned plain text; fallback result cached.
2026-10-05T12:00:01.500Z INFO  [occipital] Owned helper ready: Occipital 0.1.5.
2026-10-05T12:00:02.000Z DEBUG [syntax] Write call=w2 source=new revision=1: Occipital colors selected.
2026-10-05T12:00:03.000Z DEBUG [syntax] Bash call=b1 revision=2: native request still pending; showing toolTitle, no Pi classification.
```

Say "unknown" when the actual cause is not available. A successful plain Pi result is not a failed classifier; one color is not proof of parser failure.

## Coverage

| Area | What a person should be able to establish |
| --- | --- |
| Lifecycle, commands and settings | Installation/reload/switch/off/on, effective choices, validation/save failures and cleanup |
| Tools/messages and layout | Custom/compact/native/hidden routing and why, toolCallId/source identity, lifecycle/expansion/geometry changes, native restoration |
| Syntax and Occipital | Preparation/version/language/size, request/result/refusal/restart, queued/running/uncertain work, selected native/Pi/prefix/plain colors, stale rejection, provider selection/loss/recovery and profile/theme changes |
| Cache | Build/invalidation/clear causes when known, retained results and useful aggregate work counters |
| Editor, footer, status and queued cards | Eligibility/ownership/delegation changes, clipping/fallback and restoration |
| Themes and terminal colors | Selection, source/query/application/release changes, failures and suspension reasons |
| Animation and Git status | Participation/start/stop, refresh/cancellation/failure/cleanup; aggregate wakes/requests rather than every tick |
| Errors and resources | Failing operation, safe error code/location, recovery outcome and existing resource counters |

Record changes, completed operations and errors, **not each frame/getter/cache hit/timer rearm**. Repeated observations use existing counters or a small component-owned/weak decision marker. Do not retain tool/component/source owners in the logger. Read existing counters on an explicit snapshot or normal final summary, not on every write.

For mixed highlighting, connect the actual final painting choice to the same tool/source/version: exact native result, cached Pi result (possibly plain), retained colored prefix, waiting/uncertain veto, refusal/staleness/failure, intentional whole-command Bash `toolTitle`, or native delegation. Use already computed coverage facts; do not rescan text/ANSI to enrich a record. Ordinary assistant Markdown and user Markdown rendering remain Pi-owned: log our delegation/decoration decisions, not invented details about Pi/Syntect internals. Component decisions are not proof of physical terminal pixels.

## Low-overhead writing and retention

Initial defaults:

| Item | Limit/policy |
| --- | --- |
| Detailed journal | 4 MiB current + one 4 MiB predecessor, headers included |
| Common lifecycle journal | Approximately 1 MiB + one predecessor; best-effort shared rotation |
| Record | At most 16 KiB encoded UTF-8 |
| Pending and in-flight data together | 128 KiB per detailed writer |
| Batch | Flush at 32 KiB or after a one-shot 500 ms delay from the first pending record |
| Inactive history | Keep the newest 16 detailed journal pairs; remove pairs idle for more than seven days |
| Cleanup | At startup, then at most once per six hours when logging is already doing work |

Format/encode a record once, use its existing byte length and maintain file/queue sizes **in memory**. A fresh uniquely owned file starts at zero. No per-record `stat`, free-space probe, directory scan or total-byte calculation. Normal I/O is an asynchronous batch append; rotation is occasional. One write batch per detailed journal is in flight; a slow write cannot create an unlimited queue. If the queue overflows, drop diagnostics, count them and later write a readable omission notice. Do not block the UI or retry indefinitely.

The flush delay is not a recurring idle timer. No periodic snapshots or standalone cleanup timer. Cleanup runs separately from rendering and only at the stated opportunities. Last-write filesystem `mtime` is sufficient for inactivity: do not parse the last text record or read all journals. No aggregate disk quota, free-space reserve, lockfiles or lease/heartbeat registry.

Mark a normally closed detailed journal in its filename (`.closed.log`, with the matching predecessor); this is just a close-time rename, not another state file. Cleanup can remove closed pairs regardless of PID. For abandoned unmarked files, skip live/unknown PIDs and only remove recognized inactive pairs. PID reuse can delay deletion; this is an accepted conservative compromise. Never remove the current writer, foreign files or follow links outside the private directory. Use the newest modification time of the pair, not the session's start date. Concurrent cleanup tolerates an already removed file and does not coordinate through a new subsystem.

Sixteen inactive pairs hold at most approximately 128 MiB of detailed data, plus the small common journal and filesystem overhead. Active/uncertain journals are extra. Age/count cleanup is opportunistic, not an exact machine-wide quota or a promise to delete at the seven-day instant; no running extension means no maintenance.

The common journal is intentionally simpler: one bounded append per lifecycle message, no long-lived shared handle, lock or global writer. Check its size only for these rare lifecycle writes and rotate best-effort. Simultaneous lifecycle writes can exceed the threshold or lose overview lines during rotation; the overshoot depends on their concurrency. Detailed journals are independently owned and unaffected by that race; there is no claim of ordered, lossless shared logging.

On disk/permission/write failure, release pending data, disable the affected writer and report one public UI warning when available. Common-journal failure does not disable a healthy detailed journal. No console fallback, ongoing free-space monitoring or automatic retry loop. Explicit `logs on` can retry. Close drains pending data best-effort with a bounded wait; crashes can lose buffered events or leave a partial last record. No per-batch `fsync` or audit-grade durability.

## Privacy

Log metadata, identifiers, sizes, decisions and counters, not prompts/messages/drafts, Bash commands, source text, tool argument/result bodies, content-bearing cache keys, raw wire/native output, credentials, complete environment or arbitrary object/exception dumps. Errors need an intelligible owning operation and safe code/location, not an opaque payload copied into the file. Paths/session names are allowed metadata but still private.

POSIX directory/file permissions are 0700/0600. Windows uses the user's temporary directory and actual inherited permissions; Unix modes are not an ACL guarantee. No uploads. Test without inspecting existing user journals or changing user services/settings.

## Implementation and verification

1. Implement the small text writer, batch/rotation/rare cleanup and controls. Functional real-filesystem/child-process tests with tiny limits cover actual text, byte caps, batching, failures, dropped-record notices, closed/abandoned retention and concurrent lifecycle writes. Verify global-race compromises without adding locks or demanding transactional output. No tests for strings present in source code.
2. Connect public session identity/lifecycle and existing decision points across the coverage table. Test reload/resume/switch/cancellation, two runs of the same session and late old-owner completion. Failures in diagnostics must not break presentation. No private/global renderer hook or extra diagnostic traversal.
3. Reproduce the mixed-highlighting example with actual SDK/helper/Pi controls, including unavailable provider, retained plain fallback, pending/uncertain work and neutral Bash. Verify actual selected branch, not only an earlier RPC result. Keep exact source/classifier/body-build/request counters and saved/model/tool equality.
4. Verify overhead with observable counters: first prove logging is active and drain startup/pending records before the baseline. Settled unchanged frames and repeated same-size resize observations then add **zero journal records and logger I/O**. Real width/theme/eligibility/source changes may emit transition records, never duplicate source/body/render work. Directory/size probes occur only at permitted startup/cleanup/lifecycle boundaries; bursts use batch writes and empty capture has no active timer. GC controls prove no new owner/source retention. Include log write failure/disabled mode.
5. Run strict types and affected unit/SDK/GC checks on both supported Node runtimes, relevant real offline regular/fullscreen live/replay controls and final regression coverage per [testing.md](testing.md). Review current files independently before acceptance. Source/synthetic tests alone do not prove real Pi behavior or Windows runtime/permissions.

Reference: [Magic Context logger](https://github.com/cortexkit/magic-context/blob/6320a8b418ae37f07e1322712206ff44aec229d1/packages/plugin/src/shared/logger.ts) and [temporary path](https://github.com/cortexkit/magic-context/blob/6320a8b418ae37f07e1322712206ff44aec229d1/packages/plugin/src/shared/data-path.ts). Public Pi session metadata, `src/index.ts`, `src/syntax/*` and `src/occipital/*` supply the existing identities/decisions; [testing.md](testing.md) defines test discipline.

If implementation unexpectedly needs coordination, a new dependency/private API, wider data capture or extra presentation/source work, stop and discuss it rather than rebuilding the rejected subsystem. Implementation follows this approved design. Commits, push and publication require separate operator authorization.
