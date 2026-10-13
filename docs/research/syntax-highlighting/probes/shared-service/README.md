# Shared-service experiment (v2)

Research-only Unix/Linux prototype. It is **not** a packaged daemon or a pi-tidy-ui adapter. The extension's dependencies, code and runtime are unchanged by this directory.

See [the report](../../shared-service.md) for interpretation, queueing limits, source/quality gates and unmeasured candidate frameworks.

## Reproduce

Requirements: Linux `/proc/*/smaps_rollup`, Unix sockets, Rust/C/C++ build toolchain, and **Node 22.19.0**. Tested: rustc 1.98.0, Linux 7.1.9-arch1-2, x86_64. Set paths explicitly on other installations.

From repository root:

```sh
# Reuse the previous study's isolated Shiki 4.5.0 setup, or create it from
# its archived manifests. These dependencies do not belong to the extension.
export HIGHLIGHT_RESEARCH_ROOT=/tmp/pi-tidy-ui-head-to-head
export RESEARCH_NODE=/tmp/pi-tidy-ui-head-to-head/node-v22.19.0-linux-x64/bin/node
mkdir -p "$HIGHLIGHT_RESEARCH_ROOT"
cp docs/research/syntax-highlighting/probes/head-to-head/dependencies.json "$HIGHLIGHT_RESEARCH_ROOT/package.json"
cp docs/research/syntax-highlighting/probes/head-to-head/dependencies-lock.json "$HIGHLIGHT_RESEARCH_ROOT/package-lock.json"
PATH="$(dirname "$RESEARCH_NODE"):$PATH" npm ci --legacy-peer-deps --prefix "$HIGHLIGHT_RESEARCH_ROOT"

cargo build --locked --release \
  --manifest-path docs/research/syntax-highlighting/probes/shared-service/Cargo.toml \
  --target-dir /tmp/pi-tidy-ui-highlight-service-target
export RESEARCH_NATIVE=/tmp/pi-tidy-ui-highlight-service-target/release/highlight-service-research

# Actual service/source/counter controls; no timing matrix.
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/shared-service/controller.mjs check

# Runs 33 scenarios/195 fresh clients. It OVERWRITES results.jsonl.
# On this ordinary shared host the complete run took several minutes.
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/shared-service/controller.mjs

"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/shared-service/summarize.mjs
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/shared-service/quality.mjs
"$RESEARCH_NODE" docs/research/syntax-highlighting/probes/shared-service/verify.mjs

/tmp/pi-tidy-ui-highlight-service-target/release/inventory \
  > docs/research/syntax-highlighting/probes/shared-service/inventory.json
```

The Node executable itself is external: obtain the official Node 22.19.0 distribution for the machine, then set `RESEARCH_NODE`. The native Cargo workspace is isolated with `[workspace]`; binaries/targets stay outside the repository. All Rust dependencies are pinned by `Cargo.lock`. The research binary links all three native candidates; **do not distribute it as a licensed production Tree-only artifact** without reviewing the combined dependency obligations, particularly Giallo/EUPL. A production single-engine build would exclude unused engines.

The parent controls all its disposable clients/services and stops them in `finally`. Do not run overlapping matrices: they would contend for resources and write the same data file. This is a controlled-launch experiment, not an automatic singleton-service startup implementation. Connection count, malformed-input behavior, stalled regex jobs, client disconnects during heavy work and Windows transport are not production acceptance tests.

## Files and exact scope

- `src/main.rs`: one worker owning one engine, persistent Unix connections, bounded 32-job queue, whole-frame buffered NDJSON responses; 4 MiB source limit. No AST/line-state document sessions. Optional bounded 16 MiB/64-entry common result cache.
- `src/bin/inventory.rs`: presence of 21 requested canonical IDs/extensions in Giallo and bat assets; no quality score.
- `client.mjs`: one actual Node process per client, same generic palette and archived input generator; no actual agent SDK/TUI.
- `node-server.mjs`: shared Shiki/Oniguruma topology control. Four loaded language families, no incremental document state. Forced GC sampling is visible in source.
- `controller.mjs`: rotated three-trial matrix for 1/10 clients; Linux process footprints; strict text reconstruction; ten-connection common-cache counters.
- `rpc.mjs`: persistent correlated NDJSON calls, counters and generated-SGR removal used only by these controls.
- `results.jsonl`: **33 final v2** records. `discarded-unbuffered-v1.jsonl` is incomplete diagnostic output from the old unbuffered serializer; it must not enter final tables.
- `check-tree.json`, `check-syntect.json`, `check-giallo.json`, `check-shiki.json`: actual controls, ranges, source preservation, expected Giallo CRLF rejection, and before/after/after-duplicates counters.
- `summary.json`: derived medians. Per-trial request median/p95 then median across trials; not a maximum-latency guarantee.
- `quality.json`: selected word categories under one fixed generic theme, derived from the checks, not raw grammar-scope conformance.
- `verify.mjs`: saved-packet audit (versions, all groups/trials, source hashes, sizes, 22,815 call counts, disabled measurement caches, contiguous spans, exact text, post-cache counters). It does not repeat measurements.
- `provenance.json`: exact environment, data/source hashes and measured native executable hash. Temporary artifact paths are not installation paths.

All timing/memory runs disable cached answers and use full snapshots. The cache control separately proves `10 connections → 1 highlight + 9 hits`, then `20 further hits → 0 more highlights`. Growing snapshots are checked for exact text at every update; this is not full-versus-incremental equivalence because this service does not implement incremental state.
