# Communication with a shared syntax-highlighting daemon

**Research date:** 2026-10-07. **Status:** source/documentation-based selection report; not an implementation approval. No performance tests, POC, service installation or service execution were performed for this report.

**Companion report:** [Rust highlighting-library selection](daemon-library-selection.md). The older [shared-service study](shared-service.md) establishes the topology motivation and contains separately conducted experiments; its numbers are not measurements of Subconscious.

## Recommendation

**Use CortexKit Subconscious, through its public TypeScript consumer SDK and Rust module SDK. Make highlighting an internal presentation service, not an LLM tool and not an MCP subprocess per agent.**

This is the strongest fit for this operator's environment because AFT and Magic Context already use the CortexKit ecosystem, and Subconscious supplies the part that a socket library does not: per-user daemon ownership, module launching/supervision, authenticated discovery, concurrent routes, bounded forwarding and reconnect/lifecycle semantics. There is no evidence here that its transport is faster than a direct local socket, and speed is not the basis of this recommendation.

The runner-up is a small dedicated local-socket daemon using `interprocess`/Tokio with a Node `net` client. Prefer that only if depending on Subconscious becomes unacceptable or its actual module/SDK contract cannot satisfy the application. It is simpler as a standalone stack, but substantially more application-owned lifecycle work in this already-CortexKit deployment.

**Subconscious does not require Rust.** It is a process protocol, not a Rust plugin ABI, and its repository also supplies a TypeScript provider and a Swift client. Rust is nevertheless the natural implementation choice here because both the module SDK and the leading native highlighters are Rust libraries. Choosing it should not be justified by a nonexistent Go/C++ prohibition. [C1–C3]

## 1. Separate the three decisions

A transport moves bytes; an RPC protocol matches requests and responses; a process framework discovers, starts and supervises the shared worker. These are not interchangeable alternatives.

| Layer | Examples | What it does not decide |
|---|---|---|
| Transport | Unix-domain socket, Windows named pipe, loopback TCP | Source revisions, RPC errors, module ownership |
| Application protocol | Length-prefixed JSON, typed binary frames, HTTP/JSON, gRPC/Protobuf | Whether ten agents share one worker |
| Process framework | Subconscious; alternatively an application-owned daemon plus OS service manager | Highlighting quality, worker CPU scheduling, source preservation |

Subconscious currently uses **authenticated loopback TCP plus a fixed binary envelope**, not Unix sockets. Its use is therefore not a choice of "Subconscious instead of TCP". The full choice is its transport/protocol/supervisor stack instead of owning that stack ourselves. [C1, C4]

A child binary connected by stdin/stdout remains a **per-parent sidecar** unless an independent shared service exists behind it. Neither writing the child in Rust nor multiplexing requests within one child makes it shared between independent agents. A per-agent bridge to a daemon is possible, but the public Node SDK avoids adding such a bridge solely for highlighting.

## 2. Requirements for this project

1. Independent agents under the same user can reuse one loaded highlighting module across projects.
2. Calls are asynchronous and happen outside pi-tidy-ui's synchronous rendering path.
3. Source text and syntax ranges are preserved exactly; terminals, line wrapping and diff backgrounds remain client-owned.
4. Replies can arrive out of order, and source/theme revisions prevent stale replies from repainting a card.
5. A disconnected agent, restart or incompatible version fails explicitly without blocking rendering.
6. The system bounds queued work, result/source retention and native CPU work; adding clients must not create one heavy highlighter process per client.
7. Source can contain credentials. It stays within the local user boundary, is not exposed as a public listener or logged as ordinary telemetry.
8. Supported platform deployment does not require changing Pi or AFT internals.

These requirements do not need browser access, remote multi-tenant hosting, a message broker, a general editor protocol or a semantic-language-server fleet.

## 3. Options and trade-offs

| Option | Benefits for this workload | Work/limitations | Verdict |
|---|---|---|---|
| **Subconscious + public SDKs** | Existing agent-focused process framework; same-user discovery/authentication, module supervision, multiplexed routes, typed lifecycle/errors, wire-level JSON/binary envelope | Young alpha ecosystem; coordinate compatible daemon/SDK versions; module must still own bounded CPU work and source revisions | **Recommended in this environment** |
| **Unix socket / Windows named pipe + framed application RPC** | Small local-only stack; OS endpoint permissions; Rust `interprocess` offers Unix/Windows and Tokio support; Node `net` speaks both endpoint kinds | Own framing/schema, singleton deployment, discovery, auth policy, request correlation, queue policy, restart/reconnect and updates; platform endpoint names differ | Best standalone alternative |
| **Loopback TCP + small framed RPC** | Same network API on all three desktop OSes; easy Node/Rust connectivity; no Unix socket path limitations | Own port discovery, authentication and lifecycle; loopback alone is not authorization | Reasonable if implementing a standalone protocol; Subconscious already supplies this form |
| **HTTP/JSON on loopback** | Very easy inspection and familiar HTTP client/server libraries; unary requests fit snapshots; versioned endpoint/schema can be simple | Still needs a daemon manager and local auth/discovery; JSON size and status conventions are application decisions; growing documents need explicit revision/state APIs | Viable, but duplicates infrastructure already available |
| **gRPC/Protobuf** | Generated typed interfaces, unary and streaming calls, deadlines/cancellation, standardized error model; Rust Tonic/Prost and Node gRPC ecosystem | Extra schema/code-generation/runtime ownership; does not supervise/start a singleton; does not interrupt native parsing merely because an RPC is cancelled | Useful for a wider cross-language service, not justified for this local feature |
| **Connect RPC** | HTTP-based typed Protobuf/JSON APIs, stable TypeScript/Go clients and gRPC interoperability | Official introductory runtime list does not offer a Rust server SDK; verify any chosen Rust implementation separately rather than assuming Go parity; still lacks local process supervision | No advantage over Subconscious for this Rust module |
| **Shared-memory ring buffers / broker / editor protocol** | Potentially useful for specialized zero-copy or distributed/editor workloads | Shared memory adds ownership, synchronization and recovery work; a broker adds another service; LSP/MCP introduce unrelated surfaces | Not justified by current requirements |

No relative latency or memory ranking for these transports is inferred from documentation. Different payload representations, worker queues and startup policies would dominate any unfair comparison. [T1–T5]

## 4. What Subconscious actually supplies

### 4.1 Process shape

```text
agent A / pi-tidy-ui ── public TypeScript SDK ──┐
agent B / pi-tidy-ui ── public TypeScript SDK ──┼── ck-subc (per user)
agent C / pi-tidy-ui ── public TypeScript SDK ──┘       │
                                                    └── one supervised Rust highlighting module
                                                         shared grammars / queries
                                                         bounded worker-local parse state
```

The **router daemon and highlighting module are separate processes**. "One shared daemon" here means one per-user routing daemon and one shared highlighting module, not linking a new syntax engine into the Subconscious daemon itself. Other CortexKit modules remain separate. Multiple routes/binds must not create another copy of the highlighting executable. The module's identity/launch policy is part of its eventual deployment contract. [C1, C2]

Projects/sessions can have separate bind identities while the process reuses grammar assets. A project root in a route identity is not evidence of a per-project process, nor a reason for the highlighter to read files from disk. Source is supplied by the client.

### 4.2 Transport, framing and security

The current sources define:

- Wire protocol **v2**, with a **21-byte header** carrying body length, version/type/flags, channel, route epoch and correlation ID.
- A **64 MiB frame-body ceiling** in the SDK/protocol. This is a transport ceiling, not a recommended source or response limit. JSON escaping and a dense token response also consume the allowance.
- The **wire protocol** supports JSON payloads or opaque binary payloads. A small framed header does **not** make JSON token arrays zero-copy or make every request binary. Actual SDK reply support must be checked separately; see below.
- HMAC-SHA256 authentication with server proof and daemon identity verification, using a daemon connection record containing endpoint(s) and a shared secret.
- On Unix, connection-file ownership and owner-only permissions are checked. On Windows, the implementation relies on the per-user directory ACL rather than claiming equivalent Unix mode checks.
- Route handles bound to the connection and epoch; replies match correlation identifiers, not arrival order.

Use the public SDK's discovery/configuration facilities and the compatible installed fleet contract; do not hardcode a filename from old README examples. The repository explicitly describes `docs/` as working design history, and some README installation/source-only examples lag current package exports. Never copy authentication or envelope implementations into pi-tidy-ui. [C3–C5]

HMAC authentication protects access within the intended local user trust boundary. It is **not** encrypted remote transport, isolation from every same-user program or authorization to publish the listener externally.

### 4.3 Consumer and module API

The TypeScript SDK exposes `SubcClient`, catalog/route operations, `request`, managed `call`/`callBinary`, cancellation, route closure and reconnect-aware call handling. The Rust `subc-client-rs` SDK supports serving as a module as well as consuming other modules. This is enough to make a presentation-only service without advertising a syntax-highlighting tool to the model. [C2, C3]

**Prefer the explicit `internal_service` role with `agent_facing: false`**, not a fake tool provider. Its public consumer path is `routeOpen({ kind: "internal_service", module_id, service_id }, identity)` followed by `request(handle, ...)`. Current managed `call`/`callBinary` accept only management-surface or tool-provider targets, so they do **not** provide managed internal-service recovery. A small client adapter must reconnect and reopen this explicit route. Representing highlighting as a management-query surface would instead be a deliberate semantic decision, not a shortcut justified by `call()` convenience. No production `syntax.highlight` module/capability is claimed to exist. [C3]

Avoid using the MCP gateway as the normal pi-tidy-ui path: an extension already running in Node can directly consume the daemon. MCP compatibility is valuable for model-facing tool fleets, but our operation changes presentation and must not add model calls, session records or another per-agent shim process.

**SDK limitation found by source inspection:** the published TypeScript provider builds response/stream flags with `binary=false`; the inspected Rust serve path likewise sends `HandlerOutcome::Response` and `RequestCtx::emit` with `data_flags()` whose binary bit is false. The Node consumer decodes replies from the reply's binary bit, not from the request option. Thus a `Uint8Array`/`Vec<u8>` handler result and the presence of `callBinary` do not prove arbitrary binary reply interoperability. JSON-encoded spans are a supported-shaped candidate; promising compact opaque replies requires a public supported path or an upstream correction verified separately. This is a source finding, not a runtime reproduction or permission to patch Subconscious. [C2, C3, C7]

### 4.4 Limits, cancellation and fairness

Subconscious provides transport admission/priority, flow-control/forwarding bounds, typed route failures and SDK timeout/reconnect machinery. These are valuable, but the module still needs its own application limits. `AbortSignal` emits best-effort cancellation and does **not** immediately reject the request promise; completion or another terminal condition settles it. `timeoutMs` is applied to route-open waiting and then the response wait, not conserved as one end-to-end deadline. [C3]

| Framework capability | Separate highlighter responsibility |
|---|---|
| Correlation and connection/route epochs | Exact document/source and palette revisions |
| Priority/admission and bounded forwarding | Bounded CPU worker pool, per-client fairness, superseded-update coalescing |
| Cancel frames and request timeout | Connecting cancellation to the engine's actual parse/query work |
| Route/module closure and restart handling | Dropping document states and refusing stale result publication |
| Frame length limit | Source/result/cache limits appropriate to available memory |
| Opaque payload routing | Stable syntax-result schema and validation of UTF-8 ranges |

A client timeout, dropped response or cancelled Rust async future does not forcibly stop a synchronous C parser, regex engine or a `spawn_blocking` job. Check and propagate the actual engine's cancellation/budget API. Even gRPC has this application obligation; the transport is not a CPU preemption mechanism. [C2–C4, T4]

Managed reconnect can reopen its supported route types, but our explicit internal-service adapter must reopen its own route and neither path reconstructs application document state automatically. A new daemon/module incarnation requires a full source snapshot or an explicit state-reestablishment exchange. A stale route handle is not the same thing as a stale source revision.

## 5. Application contract recommended for later design

These are constraints for a separately authorized design, not a POC or a new generalized protocol framework.

- **One module identity across workspaces.** Use one compatible user-level highlighting process; keep source/document namespaces separate by client/session. Do not choose a project-bound executable topology by accident.
- **Supply source, not a reread instruction.** The service highlights exactly the saved/submitted text passed to it; filenames are language hints, not permission to load current disk contents.
- **Start with a clear snapshot operation.** A growing-code API may use retained state later, but only if the selected library really supports it and old/new source equality is verified. Transport streaming alone is not incremental highlighting.
- **Return syntax ranges/categories independently of layout.** Prefer UTF-8 byte ranges plus category/style identifiers in a versioned JSON reply for the inspected SDK surface. Node can map those ranges to the original source and Pi's palette. Returning final foreground-only ANSI is possible, but must not reset diff backgrounds or introduce layout. Compact binary replies are not assumed available through today's serve helpers.
- **Keep presentation in pi-tidy-ui.** Frame dimensions, wrapping, signs, line numbers, diff backgrounds and mouse geometry stay where they are. The daemon is not a replacement TUI renderer.
- **Validate reply identity.** Source revision/hash, grammar/engine revision and applicable palette revision must match before publication. Width-only changes reuse classification without new RPC.
- **Bound work and release state.** Avoid letting one agent monopolize the module. Dispose client/document state on completion, disconnect and reload; do not persist source caches by default.
- **No heavyweight hidden fallback.** A missing daemon must have explicitly agreed pending/unavailable behavior, not silently load Shiki or another full engine in every agent.
- **Use framework-owned lifecycle.** Register/package a module and use normal CortexKit deployment. Do not make ten extensions race to install, upgrade or replace a shared service.

The existing async-precompute integration constraint is explained in [shared-service.md](shared-service.md#integration-constraints-for-pi-tidy-ui). No framework choice makes a synchronous render callback awaitable.

## 6. Maturity and remaining decisions

Subconscious is **young and labelled alpha**, not a general-purpose decade-old RPC standard. The public repository was created in June 2026; observed GitHub counts are only **2 stars / 3 forks** on the research date. These counts do not establish reliability or invalidate its fit. Its meaningful advantage is actual reuse in this operator's agent ecosystem and the explicit module/route/lifecycle contracts, not market popularity. [C1, C6]

Observed published SDKs:

| Surface | Version inspected | Qualification |
|---|---|---|
| `@cortexkit/subc-client` | **0.21.0**, Node >=18, MIT | npm release `gitHead` `97378601cd01e99e888347a6995011d58fd69fc7`; current package exports built `dist` |
| `subc-client-rs` | **0.26.1**, MIT, published 2026-10-03 | Separately versioned Rust crate, not the same version number as the daemon/protocol |
| SDK installed alongside the operator's extensions | **0.13.1** | Older than the published/current snapshot; for example, its Unix connection-file checks omit the newer UID-owner check |
| Fresh repository source | `02e164740a53efd09949d1a3dcfb445767075a49` | Contains protocol-crate 0.29.2 changes newer than the npm release head; do not equate moving master with an installed release |

**Before implementation:** establish the compatible fleet/SDK versions, the module's singleton launch/registration policy, deployment/update ownership, supported platform set, application payload/version/error schema and unavailable-service behavior. These are not reasons to repeat a whole transport benchmark or to add locks/migrations/speculative abstractions now.

**Decision:** Subconscious is the recommended communication/process framework for this environment. Its alpha/version-coordination risk should be explicitly accepted. Keep the transport layer out of syntax-engine selection; neither requires changing the other if the public module contract remains adequate.

## 7. Sources and authority

All repository source links below are pinned where the behavior matters. API popularity/version endpoints are date-sensitive observations, not permanent promises. Published SDK source/version must be checked again at implementation time.

- **C1 — Subconscious architecture, process separation, platforms, alpha deployment:** [pinned README](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/README.md).
- **C2 — Rust serve/consume SDK:** [pinned client source](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/crates/subc-client-rs/src/lib.rs), [published 0.26.1 documentation](https://docs.rs/subc-client-rs/0.26.1/subc_client_rs/), [crate metadata](https://crates.io/api/v1/crates/subc-client-rs).
- **C3 — TypeScript SDK surfaces/provider:** [README](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/README.md), [client.ts](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/src/client.ts), [provider.ts](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/src/provider.ts), [published npm metadata](https://registry.npmjs.org/@cortexkit/subc-client/latest).
- **C4 — Envelope and transport implementation:** [Rust protocol](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/crates/subc-protocol/src/lib.rs), [TypeScript envelope constants](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/src/envelope.ts#L1-L24), [transport directory](https://github.com/cortexkit/subconscious/tree/02e164740a53efd09949d1a3dcfb445767075a49/crates/subc-transport/src).
- **C5 — Discovery/authentication file checks:** [connection-file.ts](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/src/connection-file.ts#L66-L149), [auth.ts](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/clients/subc-client/src/auth.ts).
- **C6 — Dated repository metadata:** [GitHub API](https://api.github.com/repos/cortexkit/subconscious).
- **C7 — Published provider and actual Rust reply flag path:** [published TS provider 0.21.0](https://unpkg.com/@cortexkit/subc-client@0.21.0/src/provider.ts), [Rust response path](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/crates/subc-client-rs/src/lib.rs#L1934-L1961), [Rust data flags](https://github.com/cortexkit/subconscious/blob/02e164740a53efd09949d1a3dcfb445767075a49/crates/subc-client-rs/src/lib.rs#L2294-L2300).
- **T1 — Node local/TCP socket API:** [official `node:net` documentation, pinned to Node 22.19.0](https://github.com/nodejs/node/blob/v22.19.0/doc/api/net.md); covers Unix-domain sockets and Windows named pipes as IPC endpoints.
- **T2 — Cross-platform Rust local sockets:** [interprocess local_socket](https://docs.rs/interprocess/latest/interprocess/local_socket/index.html), [Tokio local sockets](https://docs.rs/interprocess/latest/interprocess/local_socket/tokio/index.html).
- **T3 — Rust TCP/local networking and HTTP implementation options:** [Tokio net](https://docs.rs/tokio/latest/tokio/net/), [Axum](https://docs.rs/axum/latest/axum/). These are libraries, not a singleton supervisor.
- **T4 — gRPC semantics/tooling:** [official core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/), [cancellation guide](https://grpc.io/docs/guides/cancellation/), [Tonic](https://docs.rs/tonic/latest/tonic/), [Node grpc-js](https://github.com/grpc/grpc-node/tree/master/packages/grpc-js).
- **T5 — Connect's stated runtime support/protocol scope:** [official introduction](https://connectrpc.com/docs/introduction/).

## 8. Independent evidence audit and closure

A fresh-context source auditor independently read the completed report and authoritative sources on 2026-10-07. It supported the Subconscious recommendation, process separation, explicit internal-service routing/recovery, cooperative cancellation, timeout qualification and binary-reply limitation. No decision-critical positive claim was contradicted. Runtime interoperability, installed-fleet compatibility and actual singleton deployment were deliberately not tested.

| Written finding | Disposition |
|---|---|
| Literal escaped newlines broke prose and the installed-SDK table row | Corrected to actual line breaks; subsequent Markdown validation passed |
| Binary serve replies must not be inferred from `Vec<u8>`/`callBinary` | Independently confirmed against Rust reply flags, published TS provider and Node decoding; retained explicitly in section 4.3 |
| Alpha/SDK-version and deployment gates remain | Retained as implementation decisions, not falsely closed by source research |

The auditor's overall two-report verdict was **corrections required** for these formatting fixes plus the library report's repository-date wording and concrete GPL packaging distinction. Parent closure is recorded here and in the companion report; this is not a claim that a second independent runtime or post-correction review was performed.
