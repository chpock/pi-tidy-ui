# Occipital internals

Occipital is a persistent, theme-independent syntax service. It accepts **supplied source text**, parses it with bundled Syntect grammars, and resolves portable scope contexts against a caller-supplied generic style definition. It can run as an owned stdin/stdout helper or as a user-managed shared module. Neither mode requires Pi as a host.

The daemon does not execute source, read the files named by source hints, select palettes, decide which transcript rows are visible, measure terminal columns, paint ANSI or manage Pi settings. Those are consumer responsibilities. Toolview is one consumer; its [highlighting pipeline](../syntax-highlighting-spec.md) is documented separately.

## Start here

| Question | Chapter |
|---|---|
| How is the executable started; who owns threads, pipes and routes? | [Runtime and transports](runtime.md) |
| How does a request enter the worker, receive turns and release resources? | [Requests and resources](requests-and-resources.md) |
| How do finite parsing, checkpoints and provisional tails work? | [Source engine](source-engine.md) |
| What can a generic rule definition express? | [Application protocol](protocol.md) |
| Where do grammar assets, scope IDs and fingerprints come from? | [Assets and maintenance](assets.md) |
| How is a binary built, selected and distributed? | [Release delivery](../releases.md) |

The protocol reference is the exact source for wire fields, advertised limits, numeric interpretation and operation semantics. Source paths are checkout-relative. The manual is packaged; source, test harness and conformance fixtures require a repository checkout.

## Theme-independent computation

```text
supplied text + syntax hint
        │
        ▼
SOURCE: parser state → byte ranges + ordered scope contexts
        │                                     │
        │                       generic rule definition
        │                                     │
        └─────────────────► STYLE: common property resolver
                                              │
                                              ▼
                                indexed style expressions
                                              │
                                              ▼
                            caller binding, layout and paint
```

SOURCE is theme-free. A palette or rule change does not invalidate parser checkpoints or require new source text. STYLE is source-free: it receives vocabulary-qualified contexts and a generic definition, not text to parse. The Rust resolver uses trusted scope-name lookup and Syntect matching; context-qualified rules can restrict a path to its nearest owner without introducing a language-specific matcher or parser pass. Caller bindings are opaque numeric references. Rust has no knowledge of Pi's `mdHeading`, `syntaxKeyword`, local palette IDs or card-role names.

A context is an **ordered full scope stack**, not a language token category. An empty parsed context still proves classified coverage. Unclassified text has no such proof and must not be represented by inventing an empty classified context. Replies carry self-contained context/style tables; there is no synchronized per-client dictionary protocol.

This separation lets consumers reuse parsing across recoloring, reuse styles for repeated contexts, and retain geometry independently. It keeps grammar/selector interpretation on one implementation side rather than recreating Syntect matching in JavaScript.

## Runtime topology and state ownership

```text
stdio carrier                         shared SDK carrier
reader → route facade                 SDK callbacks → route facades
                  \                   /
                   ingress + shared credit
                     │             │
                CONTROL           DATA
                     │             │
                describe     route-affine parser worker
                                   scheduler → SOURCE / STYLE
                                             │
                                             ▼
                                   credited encoded delivery
                                             │
                              pipe flush / SDK ownership handoff
```

| Lifetime | State and owner |
|---|---|
| Process | Instance identity, immutable grammar/vocabulary assets and shared physical-credit ledger |
| Parser worker | Syntect state slots, scheduler/route queues, source-service bindings, compiled generic definitions and active work |
| Route | Revocable authority to use that worker; external streaming leases cannot be used from another route |
| Request | Correlation, input/preparation, cancellation/deadline state, result construction and physical reservation |
| Delivery | Encoded reply and enough authority/credit to finish or abandon its handoff safely |
| Consumer | Palette/settings, UI usefulness, logical source versions, retained results and final presentation |

Parser work is constructed, mutated and destroyed on its owning worker. The asynchronous runtime handles transport/control orchestration, not arbitrary concurrent mutation of parser objects. Revoking a route makes its authority unusable even when a delayed callback still holds a facade.

## Walkthrough for another consumer

1. Start the framed helper, or bind the advertised internal service through the public shared SDK. Stdio is **not JSON-lines** and is not a command that prints colored input.
2. Send `describe`. Admit the exact v4 capability/revisions, asset and vocabulary identities, result bounds and operations before using the provider.
3. Choose supplied logical source text, its client identity/version and a syntax hint. For finite text, send `highlight`; a path is only a syntax hint, so source bytes must be supplied. Streaming uses `stream.open` and acknowledged `stream.append` transitions.
4. Validate the SOURCE reply's correlation, source/version, byte coverage and context table before retaining it. Byte offsets are UTF-8 scalar boundaries, not UTF-16 positions or terminal columns.
5. Send missing contexts to `styles.resolve` with the current generic rule definition and its bindings. The daemon returns indexed expressions only; the consumer materializes palette/card roles locally.
6. Validate those expressions and indices, bind local colors, then measure/reflow/paint according to the consumer's own presentation policy.
7. Close streaming work when no longer useful. Cancellation is a request to stop work, not proof that nothing ran. Keep resource ownership until actual transport settlement.

The [protocol operations](protocol.md#source-input-and-syntax-hints) give exact request/response shapes; [request execution](requests-and-resources.md) explains when observable stages occur. Finite work needs no retained streaming lease. A compatible style request can reuse source contexts, but incompatible assets/vocabulary must not reinterpret old IDs.

## Configuration and observation boundaries

Occipital has no theme or profile catalogue and no theme-refresh operation. The consumer's locally selected palette is separate from the daemon's readiness and SOURCE/STYLE lifecycle. Source paths and palette selection never trigger daemon file reads. `describe` reports daemon capabilities and runtime counters only; it cannot prove that a consumer displayed a result.

Fatal executable errors emit a safe code on stderr and exit nonzero. Descriptor/runtime fields expose application state and cumulative counters; they are not a full daemon log, a terminal screenshot or whole-process RSS accounting. Toolview's journal and runtime-health UI belong to the [extension diagnostics layer](../debug-logging-spec.md).

Controlled budgets bound admitted application work and retained logical data. They do not preempt a running regular expression or account for every parser/allocator/SDK byte. See [resource guarantees](requests-and-resources.md) before interpreting a limit as a time, security or physical-memory guarantee.

## Implementation boundaries

- `main.rs`, `actor.rs`, `stdio.rs`, `shared.rs`, `frame.rs`: process, workers, routes and carriers.
- `ingress.rs`, `runtime_request.rs`, `source_request.rs`, `style_request.rs`, `request.rs`, `wire.rs`: admission and typed operation construction.
- `scheduler.rs`, `credit.rs`, `reply.rs`, `semantic_reply.rs`, `semantic_description.rs`, `limits.rs`: scheduling, physical credit, delivery and observations.
- `source_service.rs`, `semantic_engine.rs`, `semantic.rs`, `protocol.rs`: source identity, parsing, contexts and common semantic values.
- `resolver.rs`, `style_rules.rs`, `style_work.rs`: generic rules, context qualification, resolver scoring and bounded work.
- `build.rs`, `vocabulary_build.rs`, `vocabulary.rs`: build-time grammar assets and portable trusted scope IDs.

These paths are relative to `crates/occipital/` (`src/` for runtime modules). The crate uses Syntect with Oniguruma and pinned Two-Face grammar assets; dependency and generated-identity details belong to [assets and maintenance](assets.md). Return to the [extension manual](../README.md).
