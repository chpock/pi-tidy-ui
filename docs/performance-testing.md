# Performance measurement framework

This is an opt-in measurement framework for a Git checkout, not a production profiler or a machine-independent performance gate. Ordinary CI runs its correctness tests; it does **not** run benchmark batches or enforce latency/RAM thresholds. Preparation, identity checking and network isolation reuse [the test infrastructure](testing.md).

## What a result means

Two separate drivers are deliberately retained:

- `sdk`: fixed passes over real Pi SDK components, using the common layout renderer. This isolates component/card/layout work; it is **not** a completed terminal frame or a running Pi session.
- `cli`: a real, fresh Pi process, PTY and synthetic saved session. An opt-in lightweight observer verifies actual native render/layout completion. A fixed batch of requested frames waits for completed native calls; raw observed call/layout/write counts accompany the timing. Idle windows separately observe naturally scheduled frame frequency. A stable screen string is not used as proof that a new frame happened.

Variants are `native` (extension not loaded), `off` (loaded, appearance disabled), and `on`. Their visuals intentionally differ. Compare the **same variant** before/after a change; cross-variant deltas are descriptive, not a requirement that enabling the extension be cheaper.

## Execution environment

Every trial uses an exact prepared Node/Pi environment and an owned synthetic history, never a live session or personal transcript. [Performance run procedures](testing.md#performance-runs) cover preparation, launch and comparison commands.

`--inputs` must match both checkout and prepared source bytes; stale snapshots fail before measurement. The selected Node, not necessarily the command's launcher Node, executes each measured target. Each repetition gets a fresh application process and neutral settings/workspace. Dependency installation/native compilation is outside phase timing. Each CLI repetition has a fresh TMPDIR and fresh Node/Jiti application byte-cache directories; `preload-to-native-ready` includes subsequent cold application/extension loading and compilation. It is not isolated rendering time. SDK bootstrap/static modules and the initial extension import precede `cold-build-layout`; the runner installs no shared SDK compilation cache. The two policies are recorded separately rather than inventing a prepared/shared cache. Host filesystem/page caches are not cleared or claimed cold. Kernel group memory can include charged file-cache memory; it is not a sum of process RSS.

Actual launch currently requires Linux, unified cgroup v2 and working systemd user scopes plus the prepared network-isolation tooling. Unsupported containment fails closed; there is no uncontained fallback. Every trial has 2 GiB aggregate RAM, 1.5 GiB memory.high, zero swap, 128 tasks, a bounded lifetime and whole-scope cleanup. It must be outside the compositor's cgroup. Child startup receives only the prepared explicit environment, not inherited Node options, user configuration or provider credentials. A two-second stop grace and bounded kill/reap handle descendants. Do not increase limits to turn a failing benchmark green.

The orchestrator supplies a **120-second** scope limit and fixes affinity to the first two CPUs allowed to its launcher, or the smaller available set. The inner process establishes limits/affinity; the outer owner independently checks the cgroup and CPU set before releasing the measured target. Both stdout and stderr are drained, but at most **1 MiB combined** is forwarded, with truncation recorded. These limits and affinity are measurement conditions, not incidental runner details.

Disposable runner/trial trees are removed on success and failure after required results are preserved. Cleanup failure is recorded and cannot silently pass or replace an earlier primary failure. Durable evidence stays in the requested output directory.

The output directory must be new. `results.json` is checkpointed after each repetition; failed/interrupted outcomes and guard receipts remain evidence, not successful samples. No results are uploaded automatically. Raw local profiles can contain source paths; keep them private unless intentionally reviewed for sharing.

## Workloads and selection

`quick` uses small representative histories. `standard` includes the 10/100/1000-card render/frame scaling curve and larger remaining cases. `extended` adds a 3000-card point. These are curated profiles, not a Cartesian matrix of every parameter.

| Case | Driver | Purpose |
|---|---|---|
| `render` | SDK | Cold creation/layout, explicit warmup, no-op envelope and unchanged ready passes |
| `stream` | SDK | Accumulating partial Bash output in fixed older history, equal-text completion, then unchanged passes |
| `layout` | SDK | Scroll, height-only resize, width changes/return, expansion/collapse and theme invalidation |
| `lifetime` | SDK | Release history, attach/remove and adapter-reset cycles, post-GC samples |
| `frames` | CLI | Cold restoration, readiness, warmup, idle frequency and completed native frames |
| `syntax` | CLI, On | First native-theme preparation, same-source Pi styling, cached rollback to both themes and no-op reselection |
| `arguments` | SDK | Empty-to-partial command argument formation, equal-text completion and ready passes |
| `status` | CLI | Public extension-status updates in otherwise ready history |
| `activity` | SDK | Actual native Loader timer requests, active fixed render passes and stopped-timer proof; not real-Pi FPS |
| `queued` | SDK | Actual native queue construction absent/present and unsupported-prefix fallback, without model/queue delivery |
| `source-stream` | SDK, On, real helper | SOURCE append/finalization, committed-prefix reuse, STYLE readiness and explicit removal |
| `observer` | SDK, Native | Matched light-observer wrappers Off/On on a real regular renderer and in-memory terminal |

The first native-theme phase may legitimately parse a file that initially used Pi fallback; it is not labeled pure STYLE computation. After all native semantic data is present, switching to Pi must send zero SOURCE work; subsequent cached rollbacks must send neither SOURCE nor STYLE. Repainting changed colors is allowed and measured separately from these work invariants.

Histories mix Bash, write, edit and read cards with normal messages, Unicode and bounded source/output. Their seed, digest, dimensions, action counts and scenario version are recorded. They do not execute the historical shell commands or call a live model. `--cases frames,render`, `--variants native,off,on`, `--cards`, `--iterations`, `--warmup`, `--seed`, `--width`, `--height`, `--mode regular|fullscreen`, and `--repetitions` select bounded workloads. Explicit `--cards` replaces a profile's size list. Repetitions are serial; every other repetition reverses the **whole planned scenario sequence**, not merely variants within one case, to reduce simple ordering bias. No slow samples are silently discarded or rerun until green.


Selection omits unsupported case/variant pairs (`syntax` and `source-stream` are On-only; `observer` is Native-only). Invalid names or an entirely empty resulting plan fail rather than creating an empty successful measurement. Defaults and supported numeric ranges are:

| Parameter | Default | Inclusive range |
| --- | --- | --- |
| Cards | quick: 10; standard/extended non-scaling cases: 100; scaling lists above | 1–3,000 |
| Iterations | quick: 10; standard/extended: 50 | 1–1,000 |
| Warmup | 5 | 1–100 |
| Repetitions | 3 | 1–15 |
| Width / height | 100 / 40 | 24–240 / 10–150 |
| Seed | 1 | 0–2,147,483,647 |
| CLI mode | `fullscreen` | `regular` or `fullscreen` |

The workload parameter model also fixes Unicode coverage on and idle observation to 500 ms by default (the internal idle parameter admits 100–5,000 ms); these are not additional CLI switches. Explicit card counts replace the profile's entire scaling list, not one point in it.

Native-required workloads (enabled CLI cases and SDK `source-stream`) require the actual native build configuration in `--native-build-policy`, particularly when comparing different binaries; do not copy the example label if the helper was built differently. No build configuration is invented from a hash. Helper-free SDK cases and native/Off CLI trials record `not-used` because they do not launch the helper. `product.source` identifies loaded runtime extension inputs (`not-loaded` for the native control); helper bytes/tree identify the native product. Full tested commit/tree and collector/workload hashes are separate provenance. A simultaneous extension/helper change permits combined-product attribution only.

## Metric boundaries

- Elapsed time is monotonic milliseconds; CPU is target-process user/system CPU. Child-helper CPU is not silently attributed to the Pi isolate. Native SOURCE/STYLE wall time includes IPC, queueing and helper work, not pure Rust compute time.
- `allocatedBytes` is the delta of V8's cumulative **main-isolate** JS allocation counter. It includes allocations later collected, but excludes other isolates and native malloc. Node 26.7 exposes it; Node 22.19 does not. Unavailable means `null` plus a reason, never zero, `heapUsed` growth or a sampling estimate.
- `heapUsed`, `heapTotal`, `external`, `arrayBuffers` and RSS are distinct before/after snapshots. External and ArrayBuffer values overlap; do not sum them. A difference in live heap is not allocated volume.
- `maxRssKiB` is a process-lifetime high-water mark. Subtracting two such maxima does not produce a phase peak.
- A fresh trial's `preCleanup.memoryPeakBytes` is the kernel whole-scope accounted peak through that observation, including launcher/PTY/helper descendants and accounted file/kernel memory. It is not target RSS. `finalLifetime` separately records values observable through teardown; a removed cgroup can make them unavailable. Never relabel the earlier peak as an exact final one.
- Post-GC snapshots and lifecycle accounting participate directly in summaries/comparisons as `retained.<field>` and `lifecycle.<id>.memory.<field>` / `.accounting.<numeric-leaf-path>`. Kernel scope observations use `scope.preCleanup.<field>` and `scope.finalLifetime.<field>`; unavailable final values remain unavailable, not zero. Optional observation-shape mismatches are not comparable. These selectors are distinct from an ordinary phase's heap growth.
- GC is natural during ordinary timing. Explicit three-turn GC/yield happens at recorded retention boundaries, outside timed operations. Post-GC snapshots and logical cache/resource accounting are not proof of a complete live-object census or leak freedom.
- `operations` names completed scripted work; accompanying native call/layout and requested-work counts remain available. Keep raw totals, normalized values and actual frame counts together. Do not assume a target FPS or identify render invocations with unique visible frames.
- Real-Pi readiness primes one actual frame, then waits for exact current prepared history/profile and no pending source jobs/lease closes without injecting full-history frames on every poll. Readiness must survive two final actual frames before warmup. Its timeout is a failed trial, not a partial warm baseline.
- Warm correctness assertions are strict for every repetition: unchanged frames must not cause new parsing/style RPC or product-body/layout construction where the workload requires reuse. Counters and visual/data integrity controls are separate from numerical performance tolerances.

The real-Pi observer identifies the selected CLI's actual layout binding (including published bundled TUI copies), verifies its source hash and counts the layout entry; an independently installed SDK copy is not accepted as proof of work in the CLI. Source/binding ambiguity fails instead of producing a silently empty denominator. These test-only loader hooks never affect ordinary Pi or ordinary CLI observation.

The observer counts actual `requestRender` calls separately from scripted actions, coalesced completions, layout entries and writes. `observer` is a matched SDK-only wrapper calibration on one prepared row (100 native render passes per requested iteration), with wrappers actually removed/reinstalled. Both arms warm up on the real renderer; their execution order alternates between repetitions and is recorded separately from the stable named phase order. It is not PTY throughput and does not measure every asynchronous frame-wait cost in the real-Pi driver. Preserve its raw arms; do not subtract their difference from unrelated workloads.

SDK component inputs are independent of their expected-data baseline; neither the initial handoff nor intentional streamed results alias that oracle. These synthetic input preparations are outside measured batches. Representative row bounds derive from admitted input size, including valid long SDK output without native collapsed renderers, not a universal preview-row cap.

Untimed integrity controls before and after workload actions compare exact tool arguments, content/details/error fields and bounded representative renders appropriate to each variant. Real native Bash shows its tail; the extension shows a prefix; read summaries intentionally differ. Actual Pi also checks the bounded viewport and unchanged saved-session bytes across actions/shutdown. Normal startup changes, if any, have separate generated/ready hashes. Correctness sampling is outside timed batches and followed by warmup.

Ordinary timing avoids per-frame JSON, full transcript retention, screenshots and diagnostic instrumentation inside the measured loop. No-op envelopes calibrate instrumentation separately; do not blindly subtract an arbitrary constant. Setup, first cold work, warmup, warm work, changed work and cleanup/retention are separate observations.

## Diagnostic passes

`--gc-profile` enables V8 GCProfiler. `--allocation-profile` uses direct V8 allocation sampling for the warm phase; it requires a supporting selected runtime and otherwise fails explicitly. SOURCE streaming currently exposes exact allocation deltas but not allocation-stack sampling; select `render`/`frames` for stack diagnosis. Both settings change measurement identity: never compare a profiled run to an ordinary run as if instrumentation were free.


Allocation profiles include sampled objects collected by both minor and major GC. Self weights and sample totals are independent estimates; do not sum inclusive ancestor weights or infer object/call/frame counts from sample counts. Raw profiles are local files, not heap snapshots, and no TCP Inspector endpoint is opened. Compare matched profile-Off/On passes to see observation overhead. Diagnostic repetitions are not ordinary timing repetitions.

## Saved results and comparison

The collection contains every planned/completed trial, exact selected-host lock/runtime/native identities, workload and collector hashes, environment/limits, ordered repetitions, phase metrics, resource receipts and failures. `summaries.json` and `summary.txt` preserve all samples and show median/min/max/spread. Three samples enable a selected threshold policy; they do **not** establish statistical confidence or universal latency bounds.


Without a policy, comparison is descriptive (`observed`), not a green performance guarantee. Environment, workload, capabilities, profiling/GC policy and phase/work shape must be compatible. Source/helper identities may differ because they are the products being compared. Missing/failed repetitions cannot pass. Incompatible runs say `not-comparable`, not improved.

Collector identity conservatively hashes all `scripts/test/` plus test fixture/support/helper inputs, including support unused by a particular scenario. Changing such support can invalidate comparison without visibly changing that scenario. Environment equality includes hashed machine identity, kernel/CPU information, memory size, selected Node executable bytes, exact host lock/package identities, affinity and limits; matching Node/Pi version strings is insufficient. Measurement, scenario and capability records must also match. Phase/work compatibility compares phase IDs, operation totals, counter-name sets and GC method, **not equal counter values**: counters remain measured observations and correctness assertions. Optional observation structure must be compatible as well.

Optional `--policy FILE` maps case IDs to phase/metric thresholds, for example:

```json
{
  "frames": {
    "warm-frames.metrics.allocatedBytes": { "absolute": 1048576, "relative": 0.1 },
    "retained.heapUsed": { "absolute": 1048576, "relative": 0.1 }
  }
}
```

Count policies such as `warm-frames.counts.dispatches` with zero tolerances and `minRepetitions: 1` apply only to collections where that counter exists (for example enabled-only runs). Selecting an extension counter for a Native control fails rather than inventing zero. Post-GC heap uses `retained.heapUsed`; lifecycle samples and kernel scope boundaries remain separate selectors.

Metric units are bytes, milliseconds, KiB or counts as named; relative tolerance is a fraction. A regression exceeds **both** absolute and relative tolerances. Timing/allocation/memory policies need at least three repetitions; deterministic count policies can use one, but do not replace per-repetition driver assertions. For each selected metric, `delta = afterMedian - beforeMedian`; regression requires both `delta > absoluteTolerance` and `delta > abs(beforeMedian) × relativeTolerance`. Equality with either tolerance is not a regression. Zero baselines have no finite reported relative ratio but still undergo this threshold evaluation. Negative retention deltas remain signed, and a negative baseline uses its absolute magnitude only for the relative tolerance. Metrics without a selected policy remain descriptive even when other selected metrics pass. Unknown selectors/policy fields fail. Do not select a percent from a single noisy observation and call it a statistically justified budget.

## Module boundaries

Bounded performance modules and fixtures own versioned workload identity, warm/readiness proof, observed-work denominators, deterministic correctness assertions and failure receipts. They add no unconditional product counters, profiler listeners, live-session attachment or separate dependency installer. Workload modules are not `.test` files, so the ordinary catalogue does not run benchmark batches accidentally.

Framework correctness controls live under `tests/harness/performance/`; the real-Pi frame-proof controls live under `tests/cli/native/harness/performance/posix/` and require prepared native inputs. They check correctness and cleanup, not machine-dependent thresholds. Benchmark output describes the selected workload and measurement conditions, not a general product-performance guarantee.
