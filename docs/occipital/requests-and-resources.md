# Request execution and resource ownership

A native request passes through several different completion points: validation, admission, preparation, computation, encoding and transport delivery. Finishing computation does not release its physical request slot or establish that a continuation’s reply was delivered.

This chapter follows those transitions. The [protocol reference](protocol.md) owns exact request fields, execution dispositions, accounting definitions and numeric defaults. The [runtime chapter](runtime.md) describes the threads and transport frontends; the [source engine](source-engine.md) and [style resolver](styles-and-palettes.md) describe the computations.

## One request from ingress to delivery

Consider a valid `stream.open` on an already-bound route:

1. The transport supplies a complete application body to `actor.rs` through `Route::receive`.
2. `ingress.rs` inspects a borrowed routing header and selects the DATA lane.
3. `scheduler.rs` reserves a physical route job and decoding allowance. `runtime_request.rs` and `source_request.rs` validate the complete operation before allocating its owned source payload.
4. The route submits the owned request to its assigned parser worker. The worker places it in that route’s queue.
5. When the route receives a turn, `source_service.rs` prepares a job and creates its continuation binding. The parser state itself remains worker-local.
6. `semantic_engine.rs` advances the job through cooperative parsing turns. Other eligible routes can receive turns between them.
7. The scheduler transfers any newly retained state allowance to its persistent state owner, then constructs and encodes the result.
8. The encoded `Delivery` keeps the original physical slot. Separate worker-owned acknowledgment metadata identifies the continuation whose reply is pending.
9. A successful direct flush or public SDK ownership handoff acknowledges the delivery. The worker then releases acknowledgment metadata. Abandoning the delivery instead causes the worker to discard the affected continuation.

A finite `highlight` follows the same request and delivery path without leaving a parser continuation. `styles.resolve` uses the same DATA authority and scheduler, but prepares a resolver job rather than mutating SOURCE state.

## Routing is not authoritative validation

The routing probe in `ingress.rs` answers a deliberately small question: which operation and correlation ticket does this body appear to contain? It borrows raw JSON values rather than constructing a general JSON tree or materializing source text. It handles valid JSON escapes in field names and tickets.

Before that probe, a quote- and escape-aware scanner bounds nesting. This is separate from typed request validation: the raw/ignored-value JSON scanner has its own nesting storage, so a later typed decoder’s recursion guard is not sufficient protection for the earlier probe.

A recovered ticket permits a correlated refusal; it does not make the request valid. The authoritative decoders subsequently check operation shape, required and forbidden fields, identity, numbers, strings and operation-specific limits. `wire.rs` supplies the shared primitive checks. Numeric checks follow the protocol’s JSON number interpretation rather than assuming that integer-valued inputs must use integer-looking tokens.

### SOURCE allocation

`source_request.rs` first measures the supplied source strings and their aggregate logical-line count. It also validates source identities and rejects duplicate keys within a finite batch. Only after the complete plan passes and the owner grants additional capacity does it construct owned source strings.

This prevents a valid early member of a batch from causing unbounded owned allocation before an invalid later member is encountered. The borrowed scan still operates within an already-admitted frame and decoding allowance; it is not a claim that the transport received the request without allocating any bytes.

### STYLE allocation

STYLE retains the admitted raw frame while queued. `style_request.rs` inspects the rule input and context dictionary without expanding the dictionary into owned scope arrays. `semantic.rs` counts the expanded context words, including copied prefixes, and charges each row even when that row contains no scope words.

When the worker receives the request’s turn, `scheduler.rs::prepare_styles` inspects that immutable frame again and reserves the combined plan before compiling caller rules or materializing contexts. The second inspection occurs at the ownership boundary where the resulting objects will be created; borrowed plans do not cross threads or outlive their frame.

## Separate CONTROL and DATA lanes

`describe` and `themes.refresh` use CONTROL admission. SOURCE operations and STYLE use DATA admission. Each lane has its own request/reply bounds, physical slots and byte reservations.

The separation lets a route obtain metadata while its DATA slots remain occupied by computation or undelivered results. It does not make refresh unlimited: a refresh waiting behind another refresh still owns its admitted control slot and allowance. Catalogue execution and publication are described in [the catalogue chapter](catalogue.md).

`semantic_description.rs` builds descriptors from the published catalogue, configured engine limits and runtime counters. It does not parse source, resolve scopes or prepare every native palette merely to answer a metadata request. The counters describe their particular owners; a descriptor is not a barrier proving that all previously submitted DATA work has settled.

## What a credit owns

`credit.rs` implements the shared reservation ledger. A `Credit` is an ownership guard: while the guard exists, its byte allowance remains charged. A route-associated credit also owns one physical DATA or CONTROL job slot.

There are two different uses of the ledger:

- **Request ownership:** a route-associated credit follows an unsettled operation.
- **Persistent ownership:** a credit without a route pays for retained state, compiled definitions or accounting metadata without claiming another physical request slot.

The queued-job counter is a subset of unsettled jobs. Moving a request into preparation marks its credit started and removes it from the queued count; it does not free the job slot.

Byte allowance can grow before allocation, shrink after objects are destroyed, or transfer to another owner in the same ledger. A transfer moves already-admitted bytes without first releasing and then reacquiring them. Physical job ownership does not transfer with those bytes.

### Moving work into retained state

A growing SOURCE operation can leave an idle parser checkpoint, binding strings and table capacity behind. That retained memory must outlive the request.

The scheduler compares the source service’s current persistent ownership with its existing idle-state credit. Net growth is transferred from the job that admitted it. The job records the transfer so subsequent absolute work-reservation callbacks do not charge those bytes a second time.

This reconciliation also runs on failure. A failed preparation can destroy its parser work while leaving reusable vector capacity in a service table. Shrinking the request straight to a small error envelope would leave that surviving capacity unfunded. The scheduler first transfers its admitted persistent growth, then reduces the error delivery.

“Idle-state credit” does not mean every byte it pays for belongs to an idle parser. Route/binding metadata and slot capacity remain persistent service ownership while a parser state is temporarily moved into a busy job.

## Queue ordering and computational turns

Each worker’s scheduler keeps a FIFO queue for each route and a separate rotation of routes eligible for a turn. An unfinished job returns to the front of its route’s queue; the route returns to the back of the rotation. Later operations on that route therefore do not overtake it.

This is native route fairness, not the consumer’s newest-card-first scheduling policy.

`try_now` refuses rather than joining an existing worker turn sequence. It also refuses a mutation whose lease is still held by an unacknowledged earlier SOURCE delivery. `bounded_queue` may wait, but its deadline applies while the operation is still awaiting preparation. It is not a timer that interrupts an operation after preparation begins.

A full worker mailbox can also produce a correlated `busy` refusal for an already-admitted submission. That refusal still follows the credited reply path; mailbox rejection is not an excuse to detach bytes from their owner.

### Turn boundaries

A SOURCE turn advances the current source within the engine’s line/byte/elapsed-time quantum. The checks occur between parsing units. A single regex call is not preemptible, and the engine permits useful progress before yielding.

A STYLE turn resolves one requested context. Native-definition compilation, caller-rule compilation, context expansion and final JSON encoding are separate bounded phases, not secretly subdivided into one-context turns. Consequently, the quantum is not a hard upper bound on every worker action.

For a finite SOURCE batch, the service advances members in input order. Completing one member does not stream a partial batch reply; its result remains owned while later members run.

### Waiting for an earlier delivery

The scheduler can compute a new checkpoint before its reply has been handed off. It therefore retains the completed SOURCE job’s affected-lease metadata in an `unhanded` collection.

If the next queued operation targets that lease, the route is blocked until the earlier receipt is settled. The scheduler skips such a route while considering other routes. If no route can progress, the worker can block until a receipt wakeup or the next real expiry instead of polling the same blocked queue.

## Encoding and transport delivery

`semantic_reply.rs` supplies typed result bodies; `reply.rs` writes the common envelope directly through a bounded JSON writer. SOURCE run pairs are serialized directly rather than first being copied into an intermediate JSON value tree.

The writer checks the encoded ceiling while writing. When its output vector needs more capacity, it grows the request’s allowance before reserving that capacity. Structured results and encoded bytes can coexist during serialization, so both must remain funded until the structured reply is destroyed.

For a successful SOURCE result, the scheduler then:

1. Removes no-longer-needed completed-job buffers.
2. Transfers the affected-lease acknowledgment allowance to a worker-owned guard.
3. Funds replacement acknowledgment-vector capacity before old and new buffers coexist.
4. Reduces the original route credit to the actual encoded buffer capacity.
5. Sends a `Delivery` containing the bytes, receipt and original physical credit.

A `Ticket` initially owns automatic cancellation. Successfully taking its delivery transfers that responsibility to the delivery; destroying the consumed ticket must not cancel the returned result.

### The delivery boundary differs by carrier

For direct mode, `stdio.rs` calls the delivery’s flush completion only after the frame has been written and flushed. The buffer is destroyed before its native credit is released.

For shared mode, `shared.rs` constructs the public SDK’s owning response object before acknowledging the native handoff. Subsequent SDK/router buffering is a different ownership boundary. Native handoff does not prove that a remote consumer received, validated or published the result.

Acknowledgment changes only a pending receipt to committed. If cancellation already won, a later flush or handoff does not turn that cancelled receipt into success. On its next cleanup turn, the worker discards the affected SOURCE continuation.

## Failure and pressure

A refusal before computational work starts can report `not_started`. Once a source job has started, later errors retain that execution disposition. STYLE jobs also carry an execution disposition through preparation, computation and encoding. This flag describes execution authority, not whether a visible result was delivered or whether a parser counter is nonzero.

The important cleanup paths are:

- **Invalid or unadmitted request:** no parser job is created. Any acquired temporary guards are released with their owned data.
- **Queued cancellation or expiry:** the scheduler removes the request and produces its bounded error delivery.
- **SOURCE preparation or execution failure:** the service explicitly discards affected continuation authority, including partially completed work.
- **STYLE failure:** partial contexts, cursor and result data are destroyed, but the physical credit is returned to the scheduler for error delivery rather than released early.
- **Encoding failure:** a successful computation is not published as a partial result. SOURCE cleanup still retires any affected continuation.
- **Abandoned encoded SOURCE delivery:** its receipt causes worker-side continuation discard.
- **Route closure:** queued operations are rejected, route-owned source state is closed, and unhanded results for that route are cancelled.

Capacity pressure is reported at the boundary that cannot obtain its allowance. The ledger does not make arbitrary live ownership reclaimable. Dropping an unrelated waiter does not free a still-owned physical job; a compiled native definition retained by running STYLE work also remains funded after its cache entry is removed.

The native paths do not promise a general least-recently-used eviction pass to make every new request succeed. State expiry, explicit close, route teardown, completed delivery and definition ownership release have their own mechanisms. A caller must handle the resulting refusal rather than treating absent immediate capacity as permission to duplicate work.

## Which cost each guard protects

The exact defaults and accounting definitions are in the [protocol reference](protocol.md). Their enforcement points serve different purposes:

| Protection | Cost bounded and enforcement point |
|---|---|
| Outer framing | Carrier capture before application interpretation; direct framing is in `frame.rs` |
| DATA and CONTROL body bounds | Complete serialized application messages, including envelopes; checked at ingress and during reply encoding |
| Physical route/global jobs | Concurrent ownership of admitted work and undelivered results; reserved in `credit.rs` |
| Queue bounds and wait deadlines | Unprepared work awaiting a worker turn; enforced by `scheduler.rs` |
| Source bytes and logical lines | Supplied classification workload, including aggregate finite batches and cumulative appends; enforced by request/service/engine checks |
| Classified-line window | The amount passed to a non-preemptible line parser; excess supplied coverage is represented as unclassified, not silently omitted |
| Expanded context words and decoded-result charge | Compact input can expand substantially, and empty rows still consume storage; checked before STYLE expansion and during SOURCE/STYLE result construction |
| Selector and workspace bounds | Rule compilation and matching storage, including depth before native selector calls |
| Lease counts and retained-state allowance | Long-lived continuation ownership; checked by the engine and reconciled by the scheduler |
| Catalogue/admission limits | Filesystem enumeration, raw definitions, structured expansion and process-lifetime custom-scope interning; owned by the catalogue subsystem |

These are controlled application allowances, not measurements of whole-process memory. Grammar assets, private parser heaps, allocator behavior and private SDK buffers are not interchangeable with ledger bytes. In particular, the public shared SDK can receive or decode data before application admission runs. Producer-side bounded encoding and consumer negotiation remain necessary; post-decode validation cannot undo an earlier large decode.

The daemon refuses source beyond its policy. It does not choose a useful prefix from arbitrary UI text. Prefix selection and retention of the full display text belong to the consumer.
