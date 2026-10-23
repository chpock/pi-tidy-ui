# Occipital internals

Occipital is a persistent native syntax service. It accepts **supplied source text**, parses it with bundled Syntect grammars, and resolves the resulting scope contexts against a native theme or caller-supplied style rules. It can run as an owned stdin/stdout helper or as a user-managed shared module. Neither mode requires Pi as a host.

The daemon does not execute source, read the files named by source hints, decide which transcript rows are visible, measure terminal columns, paint ANSI, or manage Pi settings. Those are consumer responsibilities. Toolview is one consumer; its [highlighting pipeline](../syntax-highlighting-spec.md) is documented separately.

## Start here

| Question | Chapter |
|---|---|
| How is the executable started; who owns threads, pipes and routes? | [Runtime and transports](runtime.md) |
| How does a request enter the worker, receive turns and release resources? | [Requests and resources](requests-and-resources.md) |
| How do finite parsing, checkpoints and provisional tails work? | [Source engine](source-engine.md) |
| How are contexts matched, fonts combined and native card colors obtained? | [Rules and palettes](styles-and-palettes.md) |
| How are configuration and custom themes loaded and updated? | [Catalogue and admission](catalogue.md) |
| Where do grammar assets, scope IDs and fingerprints come from? | [Assets and maintenance](assets.md) |
| What exactly can another consumer send and receive? | [Application protocol](protocol.md) |
| How is a binary built, selected and distributed? | [Release delivery](../releases.md) |

The chapters explain mechanisms and reasons; the protocol is the single exact reference for wire fields, advertised limits, numeric interpretation and operation semantics. Source paths are checkout-relative. The manual is packaged; source, test harness and conformance fixtures need a repository checkout.

## Two independent computations

```text
supplied text + syntax hint
        │
        ▼
SOURCE: parser state → byte ranges + ordered scope contexts
        │                                     │
        │                       native theme OR generic rules
        │                                     │
        └─────────────────► STYLE: common property resolver
                                              │
                                              ▼
                             indexed style expressions + palette
                                              │
                                              ▼
                             consumer binding, layout and painting
```

SOURCE is theme-free. A change of colors does not invalidate the parser checkpoint or require new source text. STYLE is source-free: it receives vocabulary-qualified contexts and a rule identity, not text to parse. Both native and generic rules use the same resolver. Generic bindings are opaque numeric references supplied by the caller; the daemon has no knowledge of Pi's `mdHeading`, `syntaxKeyword` or other role names.

A context is an **ordered full scope stack**, not a language token category. An empty parsed context still proves classified coverage. Unclassified text has no such proof and must not be represented by inventing an empty classified context. Replies carry self-contained context/style tables; there is no synchronized per-client dictionary protocol.

This separation lets a consumer reuse parsing across recoloring, reuse styles for repeated contexts, and retain geometry independently of either. It also keeps grammar/selector interpretation on one implementation side rather than recreating Syntect matching in JavaScript.

## Runtime topology and state ownership

```text
stdio carrier                         shared SDK carrier
reader → route facade                 SDK callbacks → route facades
                  \                   /
                   ingress + shared credit
                     │             │
                CONTROL           DATA
                     │             │
             catalogue authority   route-affine parser worker
                     │             │
             immutable snapshots   scheduler → SOURCE / STYLE work
                     └────────────►│
                                   ▼
                           credited encoded delivery
                                   │
                    pipe flush / SDK ownership handoff
```

| Lifetime | State and owner |
|---|---|
| Process | Instance identity, immutable grammar/vocabulary assets, bundled profiles, catalogue/admission history, shared physical-credit ledger |
| Parser worker | Syntect state slots, scheduler/route queues, source-service bindings, lazily compiled native definitions and active work |
| Route | Revocable authority to use that worker; external streaming leases cannot be used from another route |
| Request | Correlation, input/preparation, cancellation/deadline state, result construction and physical reservation |
| Delivery | Encoded reply and enough authority/credit to finish or abandon its handoff safely |
| Consumer | UI usefulness, selected theme, logical source versions, retained results and final presentation |

Parser work is constructed, mutated and destroyed on its owning worker. The asynchronous runtime handles transport/control orchestration, not arbitrary concurrent mutation of parser objects. Revoking a route makes its authority unusable even when a delayed callback still holds a facade.

## Walkthrough for another consumer

1. Start the framed helper, or bind the advertised internal service through the public shared SDK. Stdio is **not JSON-lines** and is not a command that prints colored input.
2. Send `describe`. Admit the exact capability/revisions, asset and vocabulary identities, result bounds and available theme definitions before using the provider. An executable hash or product version is not protocol negotiation.
3. Choose a supplied logical source, its client identity/version and a syntax hint. For a finite source, send `highlight`. A path is a syntax hint only; supply the text explicitly. Streaming instead uses `stream.open` and acknowledged `stream.append` transitions.
4. Validate the SOURCE reply's correlation, source/version, byte coverage and context table before retaining it. Byte offsets are UTF-8 scalar boundaries, not UTF-16 positions or terminal columns.
5. Send missing contexts to `styles.resolve` with either a current native definition fingerprint or a bounded generic rule declaration. Native definitions come from the catalogue, not from an arbitrary theme path in this request.
6. Validate the indexed expressions and complete palette. Bind any generic color references locally, then measure/reflow/paint according to the consumer's own presentation policy.
7. Close streaming work when no longer useful. Cancellation is a request to stop work, not proof that nothing ran. Keep outstanding resource ownership until the transport's actual settlement boundary.

The [protocol operations](protocol.md#operations-and-acknowledgments) give exact request/response shapes; [request execution](requests-and-resources.md) explains when the observable stages occur. Finite work needs no retained streaming lease. A compatible style request can reuse source contexts, but incompatible assets/vocabulary must not reinterpret old IDs.

## Configuration and observation boundaries

Daemon configuration controls the custom-theme catalogue. A consumer's saved theme ID and preview state are separate. A successful `describe` may report a catalogue issue while the service and its last-valid catalogue remain usable. Catalogue refresh is explicit; source paths and theme selection do not trigger arbitrary file reads on each request.

Fatal executable errors emit a safe code on stderr and exit nonzero. Descriptor/runtime fields expose application state and cumulative counters. These are not a full daemon log, a terminal screenshot, proof that a consumer displayed a result, or whole-process RSS accounting. Toolview's journal and runtime-health UI belong to the [extension diagnostics layer](../debug-logging-spec.md).

The controlled budgets bound admitted application work and retained logical data. They do not preempt a running regular expression or account for every parser/allocator/SDK byte. See [resource guarantees](requests-and-resources.md) before interpreting a limit as a time, security or physical-memory guarantee.

## Implementation boundaries

- `main.rs`, `actor.rs`, `stdio.rs`, `shared.rs`, `frame.rs`: process, workers, routes and carriers.
- `ingress.rs`, `runtime_request.rs`, `source_request.rs`, `style_request.rs`, `request.rs`, `wire.rs`: admission and typed operation construction.
- `scheduler.rs`, `credit.rs`, `reply.rs`, `semantic_reply.rs`, `semantic_description.rs`, `limits.rs`: scheduling, physical credit, delivery and observations.
- `source_service.rs`, `semantic_engine.rs`, `semantic.rs`, `protocol.rs`: source identity, parsing, contexts and common semantic values.
- `resolver.rs`, `style_rules.rs`, `style_work.rs`, `native_definitions.rs`, `native_palette.rs`: rule compilation, property resolution and palette construction.
- `control.rs`, `catalogue.rs`, `admission.rs`, `profile.rs`: immutable catalogue publication and safe custom-theme admission.
- `build.rs`, `vocabulary_build.rs`, `vocabulary.rs`: build-time assets and portable trusted scope IDs.

These paths are relative to `crates/occipital/` (`src/` for runtime modules). The crate uses Syntect with Oniguruma and pinned Two-Face assets; dependency and generated-identity details belong to [assets and maintenance](assets.md). Return to the [extension manual](../README.md).
