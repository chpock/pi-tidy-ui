# A shared native syntax-highlighting service

Date: 2026-10-07. Status: source-based research and 33 final buffered-transport experiments complete. This document does not approve production implementation, a daemon installation, or changes to Pi/AFT. The earlier Oracle review covers the in-process comparison, not this separately executed study.

## The question and the important correction

Can independent coding-agent processes use one local syntax-highlighting service, sharing grammar/regex assets instead of each loading a highlighter?

Yes, this is a viable architecture. Sharing a process and choosing a compiled engine are **two independent decisions**. A shared Shiki service can remove duplicated engines without changing grammars; a native service can additionally avoid V8 and JS/native capture materialization. Neither benefit should be inferred just from the word "daemon" or "Rust".

The previous [Tree-sitter/Shiki comparison](tree-sitter-vs-shiki.md) reports whole experimental-process RSS after specific workloads, not a fixed per-agent charge. It explicitly did not measure a native Rust highlighter returning compact output. Multiplying its largest RSS row by ten is not a prediction of ten ordinary pi-tidy-ui instances.

A useful resource model is:

- **In process:** `N × (agent runtime + loaded highlighter assets + live-source state + rendered output)`.
- **Shared service:** `N × (agent runtime + client + rendered output) + shared assets + worker state + all live-source states`.

Grammar tables, compiled regexes and immutable queries can be shared. Independent documents' parse/line states generally cannot. Source bytes, returned colors, pi-tidy-ui's per-agent rendered-card LRU, the agent's model/session data and existing Node runtimes do not disappear. Identical-source result caching is a separate optional saving, not a prerequisite for sharing assets.

RSS double-counts shared executable/library pages. The experiment therefore records Linux **PSS** (resident pages divided among their users), private resident pages, RSS and swap PSS. These remain process footprints, not exact retained engine allocations.

## What AFT actually demonstrates

The installed `@cortexkit/aft-bridge` 0.58.2 has two distinct topologies:

1. `BinaryBridge` spawns `aft` with stdio. `BridgePool` is a process-local map keyed by canonical project root. Sharing it within a host process does not share the binary across separate host processes.
2. `SubcTransportPool` uses one authenticated client connection to the **Subconscious (`subc`) daemon**, with routes for root/harness/session identities. The transport factory selects this when the user configures `subc.connection_file`; an unavailable explicitly selected daemon fails rather than silently spawning separate binaries.

At inspection, three standalone `aft` processes had different parent PIDs. This does not establish every user's configuration, but reinforces the source-level distinction: **a subprocess is not automatically a common service**. No AFT process or configuration was changed.

Primary evidence: installed `dist/bridge.js` (the `spawn` call), `dist/pool.js`, `dist/transport-factory.js`, `dist/subc-transport.js`, and the [Subconscious repository](https://github.com/cortexkit/subconscious). Installed `@cortexkit/subc-client` 0.13.1 documents authenticated loopback TCP, immutable route handles, correlation IDs, deadlines and reconnect identities.

## Native engine candidates

### 1. Rust `tree-sitter-highlight` 0.27.0

**What it provides:** the official native highlighter, including overlap resolution, locals and injections. It emits `HighlightEvent::{HighlightStart, HighlightEnd, Source}`. The service can consume byte ranges directly and produce foreground spans/ANSI without constructing thousands of JS wrapper objects.

**Material difference from the previous study:** that study used Node/web query adapters, not this highlighter. Their capture-materialization RSS is not the cost of this Rust route.

**Advantages:** native parser; compact streaming events; reusable parser/cursor resources; configurable language-specific queries; parser/query cancellation mechanisms; MIT license for the engine. Four exact grammar crates are tested, including composed JS+TS highlights and TS locals.

**Limitations:** the core crate itself is not an all-language grammar/query distribution; individual assets and their licenses still need management. The ready collections below can take over much of this packaging work. Injection callbacks require child configurations to be installed. Structural parsing does not by itself classify every ordinary name.

**Important API limitation:** public `Highlighter::highlight()` reparses using `None` as the old tree. Reusing `Highlighter` does **not** make repeated snapshots incrementally parsed. Tree-sitter's lower-level parser can reuse an edited tree, but adding that to the complete highlighting/injection/locals pipeline is additional work. Do not advertise the tested snapshot server as an incremental Tree-sitter implementation.

Sources: [crate/version](https://docs.rs/tree-sitter-highlight/0.27.0/tree_sitter_highlight/), [actual source](https://docs.rs/tree-sitter-highlight/0.27.0/src/tree_sitter_highlight/highlight.rs.html), and grammar crates pinned in the experimental Cargo lockfile.

### 2. Giallo 0.5.2, Rust + native Oniguruma

**What it provides:** TextMate tokenization/theme matching using a curated bundle derived from the same [TextMate grammar/theme project](https://github.com/shikijs/textmate-grammars-themes) used by Shiki. `Registry::highlight(&self, ...)` supplies structured styled text; HTML is not required. Immutable grammars and registry-level compiled-pattern caches can stay in one service.

**Advantages:** ready-made broad grammar family; native Oniguruma rather than WASM; embeddings/injection machinery; theme API; no Node token/projection objects. The publisher documents 220+ grammars; that claim is not substituted for a verified current cardinality.

**Limitations/gates:** young implementation; packaged README still shows older API examples, so actual 0.5.2 source is the authority. The public full-highlight API does not expose the resumable tokenizer stack/checkpoints used internally. Continuing arbitrary source chunks is not a ready public equivalent of Shiki `GrammarState`.

**Exact-text defect verified:** `Registry::highlight` normalizes CRLF and standalone CR. Our service's exact-source guard rejects CRLF instead of silently returning changed text. A generic service cannot adopt this behavior unnoticed. Correct original-offset preservation or an explicitly accepted canonical-input contract would be required.

**License:** EUPL-1.2, not MIT. The packaged license contains source-availability and copyleft obligations. Distribution/service obligations and each selected grammar's license require a deliberate review; using a socket is not a license exemption.

Sources: [crate/version](https://docs.rs/giallo/0.5.2/giallo/), [repository](https://github.com/getzola/giallo), actual `registry.rs`, `tokenizer/mod.rs`, and packaged `LICENSE` in the pinned crate.

### 3. Syntect 5.3.0 + bat 0.26.1 grammar assets, Rust + native Oniguruma

**What it provides:** Sublime grammar parsing, themed tokens and **public resumable line state** (`ParseState`, `HighlightState`). Grammar/theme tables can be shared while each document retains its own states. Checkpointing/reprocessing an unfinished line supports append-heavy code; middle changes can propagate until states converge.

**Advantages:** mature Rust ecosystem; line-state API; structured terminal-friendly output; MIT engine and MIT/Apache-2.0 bat asset-provider code. Native Oniguruma is used here, not the separate fancy-regex mode. Bat contributes maintained real-world grammar packaging rather than requiring an editor.

**Important actual test:** Syntect's bare `load_defaults_newlines()` bundle did not provide TypeScript. It was not silently treated as plain text. The tested configuration explicitly uses `bat::assets::HighlightingAssets::from_binary()` with default CLI/git features disabled. Individual bundled grammar licenses remain separate from the engine's license.

**Limitations:** Sublime grammar coverage/theme semantics are not identical to Shiki's TextMate bundle. A public line API is not a turnkey chunked-document protocol: retain completed-line checkpoints, reprocess the incomplete line and compare updates with a full result. The benchmark currently uses complete snapshots, not that stateful implementation. Long lines and expensive regexes still require limits/cancellation decisions.

Sources: [Syntect](https://docs.rs/syntect/5.3.0/syntect/), [ParseState](https://docs.rs/syntect/5.3.0/syntect/parsing/struct.ParseState.html), [bat assets API](https://docs.rs/bat/0.26.1/bat/assets/struct.HighlightingAssets.html).

### 4. Ready native Tree-sitter collections, source-verified but not benchmarked

**[Arborium 2.18.2](https://docs.rs/arborium/2.18.2/arborium/)** is a particularly relevant option: a feature-selectable grammar/query collection, injection handling, `Highlighter::highlight_spans`, terminal output and an explicit shared `Arc<GrammarStore>`. `Highlighter::fork()` gives each worker its own parse context while retaining the same grammar store. This directly fits a bounded shared-service worker pool without inventing that layer. Engine license: MIT OR Apache-2.0; grammar licenses remain individual.

The moving repository README says about 70 default permissive grammars, but **the published 2.18.2 Cargo manifest has `default = []`** and an explicit `all-languages` feature. For a reproducible build enable the intended `lang-*` features; do not treat that README as the deployed inventory. Its measured speed/memory are **not** the raw Tree-sitter service's numbers above.

**[Lumis 0.17.0](https://docs.rs/lumis/0.17.0/lumis/)**, formerly Autumnus, packages Tree-sitter grammars, Neovim-derived rules/themes, structured highlight events and custom/ANSI formatters. The publisher documents 110+ languages and 250+ themes; these are publisher totals, not an audited quality score. The actual crate declares Rust **1.95** as its minimum, which matters for source builds. Its “streaming-friendly” wording means incomplete code is accepted; it is not proof of old-tree reuse or a document-append protocol. Engine license: MIT; selected asset licenses need inspection.

**[Syntastica 0.6.1](https://docs.rs/syntastica/0.6.1/syntastica/)** separates runtime, query preprocessing and parser collections (pinned Git/crates/dynamic collections). It can adapt extended Neovim queries and is a more configurable packaging route, not a small drop-in all-language daemon. MPL-2.0; scope distribution obligations deliberately.

**[Inkjet 0.11.1](https://github.com/Colonial-Dev/inkjet)** should not be a new dependency: the maintainer explicitly ended support and points to Autumnus. The current Autumnus 0.9.0 crate is itself deprecated in favor of Lumis. Search-result/project-name history must not obscure this maintenance chain.

These collections change the integration tradeoff: a Rust Tree-sitter service does **not** necessarily have to curate every language from scratch. They do not yet establish which collection has the best language-specific classification, native resource footprint or append API for pi-tidy-ui.

### 5. Another native TextMate candidate, not benchmarked

**[Syntaxmate 0.2.1](https://docs.rs/syntaxmate/0.2.1/syntaxmate/)** is MIT, Rust-native, with bundled TextMate grammars/themes and its own regex engine rather than native Oniguruma. Actual source exposes `Highlighter::session`, `HighlightSession::highlight_line_into`, caller-reusable span buffers, exact scope stacks and resumable state; prepared language assets/idle tokenizers are shared and bounded. This makes it especially relevant to growing Bash source.

It is an early 0.2.x implementation. Its [compatibility contract](https://github.com/phongndo/syntaxmate/blob/main/docs/compatibility.md) describes oracle corpus parity, but explicitly does not prove every Oniguruma expression/grammar. A successful call can carry `HighlightStatus::Degraded` when work limits prevent complete highlighting; callers must inspect this. No competitive speed, memory or parity claim is adopted without our own same-input run. Minimum Rust: 1.88. The source-inspected public incremental API is a concrete advantage over Giallo's public snapshot API, not yet a verified winner.

### 6. Other credible alternatives, not benchmarked here

- **[Chroma](https://github.com/alecthomas/chroma), Go:** broad Pygments-style lexer catalogue, token iterators and terminal formatters; straightforward standalone binary/service, MIT. It is not TextMate-compatible and its ordinary `Tokenise` API is a complete-input interface, not a generic resumable document protocol. Modern Go regexp/GC and output quality still need measurement. The cited license is pinned to [v2.23.0 COPYING](https://raw.githubusercontent.com/alecthomas/chroma/v2.23.0/COPYING); moving main advertises v3, so do not mix their API/version assumptions.
- **[KSyntaxHighlighting](https://github.com/KDE/syntax-highlighting), C++/Qt:** Kate's mature standalone engine, custom-renderer callbacks and retained per-line `State`; no need to embed the Kate editor. Its current contribution policy says MIT; selected source files/XML definitions and Qt dependency licenses must be checked, not labelled uniformly LGPL from an old summary. Qt/ECM/platform packaging is heavier than a small Rust binary. [State API](https://api.kde.org/ksyntaxhighlighting-state.html).
- **[Pygments](https://pygments.org/docs/api/), Python:** broad lexer ecosystem with token offsets and terminal output. A persistent service still shares initialization/grammar state across clients. It is not the native-speed option requested here and is not measured, but process sharing does not require a compiled language.
- **Shared Shiki:** a strong control and feasible deployment option, not a new native engine. It preserves the previously measured grammar/state APIs and avoids per-agent engine duplication. A single Node event loop doing synchronous tokenization can also become a queue bottleneck; moving it into a service does not make the work parallel.

None of the above is automatically a complete secure, cross-platform, self-managed highlighting daemon. They supply engines or transport components; the service/client contract remains necessary.

## Frameworks and transport choices

### Minimal local service

On Unix, `std::os::unix::net` or Tokio Unix sockets are sufficient. The prototype uses a private temporary directory, socket permissions `0600`, persistent connections, request IDs, one compute worker and a bounded queue. This is enough to test the architecture without adding HTTP, gRPC, databases or a general RPC platform.

For portable production transport, [interprocess 2.4.4](https://docs.rs/interprocess/2.4.4/interprocess/local_socket/index.html) maps local sockets to Unix-domain sockets on Unix and named pipes on Windows. Its documentation explicitly preserves raw bytes without proprietary framing, so Node's `net` API can speak the same protocol. Message framing, revision identities and permission checks still belong to the application.

[Tokio](https://docs.rs/tokio/latest/tokio/net/struct.UnixListener.html) can handle connections asynchronously. CPU tokenization must not run on its I/O executor. Use a bounded worker pool sharing immutable assets, not one full registry clone per request. [Started `spawn_blocking` jobs cannot be aborted](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html); a client deadline is not engine cancellation. Dedicated workers are another legitimate choice. Axum is useful if an HTTP API is actually required, not necessary for these local clients.

### Existing supervisor/router framework

**[Subconscious](https://github.com/cortexkit/subconscious)** is the directly relevant existing framework: one daemon, supervised modules and many agent clients. Its source documents opaque payload routing, authenticated loopback transport, flow control, module manifests, health checks, restart handling, and TS/Rust client SDKs. A native highlighting **module process** could share one registry across all connected agents; it does not have to be linked into the router.

It is MIT and currently labelled **alpha**. This is a real option if the operator already adopts the CortexKit daemon, not proof of a stable highlighting module or a deployment prerequisite. No existing syntax-highlighting module was verified. Introducing this supervisor solely for one small rendering service carries more dependency/protocol/lifecycle surface than a direct socket service. Do not modify AFT or assume pi-tidy-ui can access its private bridge.

MCP is not required: rendering should call a local client API directly, not ask the model to invoke a highlighting tool.

## Controlled experiment

Code, lockfile, controls and results: [probes/shared-service](probes/shared-service/).

- Official Node 22.19.0 for all Node clients and the Shiki control; optimized Rust release build.
- Four measured language families: TypeScript, Python, Bash and Rust; the same archived real `file-card.ts` source as the previous study.
- One and **ten independent Node client processes**, not ten objects in one JS process. Clients are research stand-ins, not actual agent/TUI replays.
- Identical sources, generic palette and output contract, **not identical grammar versions or colored ranges across engines**. Output byte sizes and source hashes are saved. These are complete deployment-path measurements, not proof that only programming language/runtime caused a difference.
- In-process Shiki/Oniguruma; shared Node/Shiki; shared native Tree-sitter, Syntect/bat and Giallo; plus ten separate Giallo services to isolate topology from language/runtime effects.
- Three fresh trials per case, rotated order. Four warm requests per client; five complete-input calls per timing input (first excluded); 32 growing-source snapshots per streaming control; four large stress inputs per client.
- Cached results disabled in timing/memory runs. A separate ten-connection control enables one bounded common cache and asserts **one compute + nine hits**. Twenty further hits require `computeNs === 0`. This proves actual shared-result reuse, not merely lower elapsed time.
- Clients retain the most recent ANSI result, then explicitly release it. Returned strings remain client memory, not a vanished service expense. The service retains engine assets; no document AST/line-state sessions are implemented.
- Each accepted output reconstructs the input exactly after removing only generated SGR. Empty lines, LF, emoji, combining marks and CJK are checked. CRLF rejection by Giallo is recorded rather than hidden. The prototype protocol accepts well-formed Unicode; a production contract must handle transient JS surrogate prefixes explicitly.
- End-to-end timings include request/response serialization, socket delivery, output JSON parsing and queue time. Server `computeNs` includes native/token projection and foreground ANSI construction, not wire serialization. Echo timing is only a lower-bound control with a smaller plain response.
- PSS/private/RSS/swap metrics are sampled for the actual clients **and** services. Full registry bundle sizes differ: Syntect/bat and Giallo provide broad packages; Tree and Shiki load four selected families. This is a deployment comparison, not a per-grammar equality claim.
- Ordinary shared developer host, not an exclusive CPU/memory lab. Report medians and sampled p95, not universal worst-case guarantees.

### Measurement correction

The first run streamed `serde_json::to_writer` directly into a Unix socket. ANSI escape sequences caused many small writes, materially inflating IPC overhead. That unbuffered v1 run reached its deadline; its partial records are retained as **discarded diagnostic evidence**, not the final selection dataset. Its processes were verified cleaned up before retry.

The final native transport serializes one complete NDJSON frame into a byte buffer before writing it to the socket. Engine work is unchanged. This matters: an avoidable serializer/transport mistake must not be attributed to Rust, the highlighter or IPC itself.

### Memory: ten independent clients

Values are medians in MiB (1 MiB = 2²⁰ bytes). “Extra warm PSS” is combined client/service PSS **above that scenario's already-running Node-client baseline**, after four short-language requests per client. It includes the entire service, client protocol costs and small returned output, not just a grammar allocator. Cached answers are disabled.

| Deployment | Extra warm PSS | Service PSS after warm | Extra PSS after large stress | Service PSS after large stress |
|---|---:|---:|---:|---:|
| Shiki in each of 10 Node clients | 428.5 | — | 1730.7 | — |
| Giallo in 10 independent native sidecars | 420.6 | 419.6 total | 1320.3 | 906.7 total |
| One common Node/Shiki service | 58.5 | 57.4 | 537.7 | 281.2 |
| One common Rust/Giallo service | 46.3 | 45.3 | 477.1 | 170.6 |
| One common Rust/Syntect-bat service | 13.7 | 12.8 | 339.6 | 99.2 |
| One common Rust/Tree-sitter service | 13.5 | 12.5 | 542.0 | 132.5 |

Interpretation:

- Sharing alone removes much of the multiplication: common Shiki is about **7.3× smaller in warm incremental footprint** than ten in-process Shiki instances. No language switch is needed to obtain that result.
- The controlled Giallo topology comparison is **420.6 → 46.3 MiB** with the same engine/registry and client implementation: about **9.1×**. Merely replacing Node with ten native sidecars is not the architecture sought.
- Raw Tree-sitter and Syntect/bat have very small warm native footprints here. Four-family Tree/Shiki versus broad bundled Giallo/bat assets are different package configurations, not equal catalogue cardinalities.
- Large stress is four sources of 10,000 instructions **per client**. Returned ANSI expansion, JSON delivery/parsing, source checks and allocators' high-water pages become important. Tree's stressed clients occupy about **620.6 MiB** and its service **132.5 MiB**: the combined 754.2 MiB is not 754.2 MiB of grammar memory. Tree's native speed/warm win does not make it the lowest stressed whole-system footprint.
- Explicitly dropping the last client output and disposing in-process Shiki reduces live allocations but does not reset PSS to warm levels. Retained allocator pages are not proof of a leak. All final stress swap-PSS samples are zero.

The measured baseline is a lightweight Node research client (about 21 MiB per process), **not** a complete Pi/LLM agent. Its baseline is subtracted only to isolate the additional measured deployment cost; actual agents still need their other memory.

### Speed: socket overhead is feasible, but a common worker creates queues

End-to-end medians in milliseconds for **one client**, full input, no result cache:

| Deployment | Real TypeScript file, 363 lines | TS, 1000 instructions | Python, 1000 | Bash, 1000 | Rust, 1000 |
|---|---:|---:|---:|---:|---:|
| In-process Shiki/Oniguruma | 57.56 | 124.75 | 118.73 | 49.93 | 126.00 |
| Common Node/Shiki | 62.63 | 147.56 | 117.81 | 55.29 | 123.50 |
| Common Rust/Giallo | 56.04 | 126.25 | 99.48 | 51.44 | 92.55 |
| Common Rust/Syntect-bat | 46.26 | 125.67 | 84.56 | 37.87 | 53.57 |
| Common Rust/Tree-sitter | **9.09** | **22.69** | **22.16** | **15.74** | **15.35** |

The plain-source echo control is **0.22–0.31 ms** median. It does not include large colored output or highlighting. Tree's real-file computation/ANSI projection itself is **5.25 ms**, versus **9.09 ms** total: the non-compute cost is real. Giallo is only modestly faster than Shiki on that file; “native Rust” alone is not a universal speed multiplier.

Under **ten continuously active clients**, one worker handles a mixed pipeline; clients advance independently through the same ordered corpus. These are not isolated same-input synchronized bursts. Queue waiting and slow large jobs affect small-job tails.

| Deployment, 10 clients | Real-file median / sampled p95 | 1000-instruction TS median |
|---|---:|---:|
| In-process Shiki in each client | 120.40 / 141.06 ms | 266.37 ms |
| Ten native Giallo sidecars | 81.28 / 111.56 ms | 210.53 ms |
| Common Node/Shiki, one worker | 252.69 / 871.34 ms | 1203.10 ms |
| Common Rust/Giallo, one worker | 518.83 / 624.19 ms | 1127.79 ms |
| Common Rust/Syntect-bat, one worker | 436.75 / 483.77 ms | 1131.62 ms |
| Common Rust/Tree-sitter, one worker | **53.78 / 77.10 ms** | **155.91 ms** |

Thus **a shared single-worker Shiki/Giallo daemon would save memory but worsen burst responsiveness**. Native Tree's measured computation is fast enough to win in this pipeline; that is not a guarantee for every language/size. Production pool sizing, per-client fairness, latest-update coalescing and stateful append handling remain acceptance decisions. More workers need private parser/scratch state; they should share immutable grammar/query assets.

### Growing code: measured full-snapshot services, not incremental claims

Total per-client median milliseconds over 32 successive growing snapshots, including IPC:

| Deployment | Bash, 1 client / 10 active clients | Growing TS function, 1 / 10 |
|---|---:|---:|
| In-process Shiki | 122.54 / 315.36 | 261.63 / 552.51 |
| Common Node/Shiki | 150.38 / 933.37 | 346.20 / 2124.14 |
| Common Rust/Giallo | 130.24 / 936.94 | 322.25 / 2470.22 |
| Common Rust/Syntect-bat | 79.63 / 661.00 | 238.88 / 2300.00 |
| Common Rust/Tree-sitter | **36.42 / 234.78** | **46.20 / 303.96** |

Every row deliberately recomputes complete snapshots. Native Tree wins this control without old-tree reuse. Syntect, Shiki and Syntaxmate have public continuation APIs suitable for a distinct stateful-server experiment; Giallo's public API does not currently provide the same access. Nothing here proves a production chunk/patch implementation or its document-state memory.

### Final evidence and coverage

The final v2 packet has **33 scenario records, 195 fresh Node client processes across those scenarios and 22,815 highlight calls**. Three trials are present for all eleven deployment/client-count groups. [summary.json](probes/shared-service/summary.json) is generated from [results.jsonl](probes/shared-service/results.jsonl), with separate server/client memory and queue-inclusive timings. The four `check-*.json` packets ([Tree](probes/shared-service/check-tree.json), [Syntect](probes/shared-service/check-syntect.json), [Giallo](probes/shared-service/check-giallo.json), [Shiki](probes/shared-service/check-shiki.json)) record source reconstruction, counter checks, startup and echo probes. The cache control verifies **1 compute/9 hits**, then **20 more hits with zero new computations**, with post-hit counters checked.

[Inventory](probes/shared-service/inventory.json) verifies Giallo and bat grammar **presence for all 21 requested IDs/extensions**. Bat's actual packaged set has **220 syntax entries**; this is not 220 language families or a quality/embedding guarantee. Tree's measured set is the four explicitly pinned grammar crates. Arborium/Lumis/Syntastica/Syntaxmate are source-reviewed alternatives, not measured variants of this packet.

## Quality does not follow from moving the engine

[Saved category checks](probes/shared-service/quality.json) use one explicit generic theme. They are observations, not a universal quality score:

- TypeScript names/functions/types are substantially classified by Tree, Giallo and Shiki; Syntect/bat leaves the tested `id` property plain under this theme.
- Ordinary Python `result`, `client`, `user`, `fallback` remain plain under Giallo, Shiki and Syntect/bat; Tree supplies variable categories.
- Bundled Tree Rust leaves those ordinary names plain; Giallo/Shiki supplies variable categories. Syntect/bat also leaves several tested Rust names/types plain under this theme.

A faster native process cannot invent missing grammar/query classifications. Generic theme matching can itself omit language-specific scope rules; these controls do not replace an all-language acceptance corpus, injection testing or official-theme parity.

## Integration constraints for pi-tidy-ui

Current `src/index.ts` calls `highlightCode` synchronously inside `fileLayout`/`renderFileCard`; `src/file-card.ts` separately highlights old and next diff sources. **A socket promise is not a drop-in replacement for that callback.** Blocking RPC in a render callback would freeze the TUI and reintroduce the wrong architectural coupling.

A proper extension-contained integration would:

1. Derive the exact displayed old/next/source inputs once at source-update boundaries; preserve existing saved-metadata classification and native fallback authority.
2. Submit asynchronous highlighting work outside `render`. Associate every response with source revision/hash, engine/grammar version, language and theme/palette revision.
3. Publish only still-current results, invalidate only the affected presentation and request a render. Unchanged frames/width changes reuse syntax independently of layout and issue **zero new IPC** when nothing relevant changed.
4. Keep width-dependent framing, wrapping, diff backgrounds and mouse geometry in the client. Return compact spans/style IDs or verified foreground-only ANSI; never let remote ANSI reset diff backgrounds or mutate model/session text.
5. Explicitly define initial/pending/unavailable-service presentation. Neither stale-source colors nor silently loading a heavyweight per-agent fallback is an approved solution. This is an implementation decision, not a passed research gate.
6. For growing code, own document states by connection/document/revision and release them on completion/detach. Coalesce superseded updates, bound queues and source/result caches, and test stateful/full equality. Bash syntax applies to `args.command`, not arbitrary stdout/stderr.

The existing rendered-only LRU and weak ownership contract are not changed by this research. No perpetual polling timer, project-root-bound service registry, source rereads, execution interception, keyboard handling or host modifications are implied.

## Recommendation

**Adopt the shared-service architecture as the leading option for the operator's many-agent use case, not ten independently spawned highlighter binaries.** The multi-process memory controls support that decision even when the service still uses Shiki.

**For a native service, prioritize the Tree-sitter route.** Its measured Rust event pipeline substantially changes the previous Node-binding tradeoff: lower warm system footprint and much faster full snapshots, including IPC. Investigate **Arborium's shared grammar-store/fork/span API**, and **Lumis's curated grammar/theme/event layer**, before committing to manual per-language packaging. Neither collection inherits the raw prototype's numbers without measurement. Select the collection only after its grammar/embedding/ordinary-name corpus and licensing are checked.

**Do not select Giallo solely on “Shiki in Rust”.** It achieves topology savings, but the tested regex path does not dramatically beat Node/Shiki, lacks a public append-state API, changes line endings and is EUPL-1.2. Syntect/bat is a mature low-footprint alternative with useful line state, but its scope/theme gaps and single-worker latency are explicit. **Syntaxmate merits a separate equivalent-grammar/stateful evaluation** because it offers native TextMate plus public continuation without the Oniguruma/EUPL combination; it is not an already verified replacement.

A complete native highlighter inside each agent could also avoid the old JS-capture costs and share executable/parser table pages through the OS. Native bindings and ten Tree-only sidecars were **not measured here**, so this study does not prove a daemon is the only economical native solution. The measured ten-Giallo-sidecar control does prove that native executables alone need not remove registry duplication.

For infrastructure, a small direct local-socket service is sufficient. **Subconscious is a credible existing supervisor/router if the operator already wants that platform**, not a mandatory extra daemon for one feature. Do not add HTTP/MCP/general plugin infrastructure just because the engines allow it.

This is a researched architecture choice and a native-engine shortlist, **not** approval to implement or install them. pi-tidy-ui integration remains asynchronous precomputation outside render, with explicit pending/error behavior and strict source/theme/owner revisions. Real-agent memory, a bounded multi-worker/stateful workload and actual SDK/CLI/replay verification are not completed by this prototype.

## Verified corrections and remaining findings

1. **Prototype transport corrected:** unbuffered v1 is discarded; all final numeric rows are buffered v2. This correction is not evidence of a universal IPC speedup, nor does it remove serialization/queue costs.
2. **Giallo exact-text blocker remains:** CRLF/CR normalization is caught and rejected, not repaired or accepted implicitly. LF/Unicode controls pass.
3. **One shared compute worker is not a universal responsiveness solution:** saturated Giallo/Syntect/Shiki pipelines queue real-file requests for hundreds of milliseconds. A native language does not remove this design requirement.
4. **Append state is not implemented:** public continuation APIs are source-verified where stated, but snapshot measurements cannot prove incremental equality/state memory.
5. **New native collections are not benchmarked:** Arborium's published default features differ from its moving README; Inkjet/Autumnus maintenance transitions are verified. Those libraries' actual quality/footprints remain a separate engine-selection gate.

Saved-packet audit: [verify.mjs](probes/shared-service/verify.mjs). Rust compiler and Node syntax checks are the authority; AFT reported no Rust diagnostics, but had no authoritative Biome report for JSON artifacts. No independent native-service review or real-agent replay is claimed.

## Deployment and safety still to design

- One service per user/security boundary and compatible protocol/asset version, not one per agent or project. Multiple projects can share grammar assets without sharing logical document identities.
- User service managers/socket activation can own start/stop on Unix; launchd/logon-task equivalents differ. Avoid ten clients racing to replace a socket. The prototype intentionally has one controlled launcher, not an untested auto-start lock algorithm.
- Authenticate/authorize local clients, restrict socket/named-pipe permissions, never expose source payloads on a public listener and do not log source/secrets. Same-UID service sharing is not isolation from other same-UID programs.
- Bound aggregate work/memory; a source-byte cap or client timeout alone does not stop regex/parse work. One stalled job can otherwise delay every agent. Worker count trades throughput for scratch memory; benchmark the actual pool rather than claiming one parser serves all requests concurrently.
- Handle server restarts, in-flight errors and protocol/version mismatch explicitly. Do not apply delayed responses to another source/card/theme.
- Package native binaries for supported OS/architectures; no unapproved installer or root dependency change. Containers, remote hosts and separate namespaces do not magically share this machine's daemon.
- Validate a native grammar/injection/locals/long-line corpus and the licensing/distribution plan before selecting an engine. Validate actual SDK/CLI/replay, physical terminal paint, update counters, lifecycle/GC and representative memory before accepting an implementation.
