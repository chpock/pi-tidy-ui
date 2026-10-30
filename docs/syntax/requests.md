# Client requests, validation and settlement

The transport adapters turn a published compatible provider into correlated operations. They own request envelopes, caller waits and physical settlement; the controller separately owns whether a logical source may run or fall back. The [native request pipeline](../occipital/requests-and-resources.md) describes the other side. The [protocol](../occipital/protocol.md) is the single exact wire reference.

## A request carries a captured expectation

The source controller creates the operation and retains the facts needed to validate its eventual outcome. The transport does not decide which source version is useful.

For SOURCE, `SourceController.prepare` in `src/occipital/controller.ts` captures the submitted snapshot, provider descriptor, source incarnation, expected next revision and exact replacement text. A finite source uses `highlight`; a growing source without a lease uses `stream.open`; a source with a validated live lease uses `stream.append`.

An append has two different boundaries. Its request contains only bytes added after the last acknowledged full input. Its expected reply replaces coverage from the last committed parser boundary, which may be earlier because the previous final line was provisional. The controller therefore keeps both the acknowledged full-text basis and the committed offset. It does not validate the reply against whatever text happens to be latest when the promise resolves.

STYLE captures different data. `prepareStyles` retains the semantic views and context handles needed to interpret the result, plus the vocabulary and rule expectation. The request contains missing context descriptions and rule input, not source text. Retaining a view keeps the request interpretable after source progress; it does not guarantee that the old candidate may still be published.

Every controller job gets a unique ticket and call-local reply-size record. The broker’s generation-bound `request` is a pass-through, not another source queue or retry engine. Its reserved ticket prefix separates its metadata operations from controller operations.

## Preflight before encoding, validation before adoption

The request path checks actual JSON policy size rather than rejecting a source from a worst-case text-size multiplier. `SourceController.dispatch` uses `dataJsonBytes` with the negotiated request cap before entering the provider. The transport then enforces its own lane and encoding bounds.

`dataJsonBytes` in `src/occipital/data-json.ts` walks plain JSON values without invoking property getters or creating a source-sized JSON string. It counts escapes and UTF-8 representation, rejects cycles and unsupported object/value forms, and bounds nesting. Shared request encoding also rejects serialization hooks before calling `JSON.stringify`, then checks that the encoded size agrees. Stdio uses its own bounded encoder and adds the length frame.

Reply handling has successive responsibilities:

1. **Transport admission and correlation:** locate the outstanding call, enforce its lane’s size limit and check the basic envelope/outcome shape.
2. **Consumer size and provider validation:** `semantic-protocol.ts` checks the current negotiated cap, exact envelope, ticket, process instance and assets.
3. **Operation validation:** SOURCE verifies every expected source acknowledgement and its replacement coverage; STYLE verifies vocabulary, rule interpretation and context correspondence. STYLE results contain no palette identity or card-role colors.
4. **Controlled materialization:** only after complete validation and expanded-allocation checks are the owned numeric vectors and semantic values constructed.
5. **Retention/publication:** the controller and retention root decide whether the validated data still belongs to an eligible owner and can be funded.

A well-framed response is therefore not yet a valid source result, and a valid source result is not yet ready card paint.

For SOURCE, `semantic-source.ts` validates exact batch membership, versions, revisions, lease conditions and byte coverage. It checks scalar boundaries against the captured replacement suffix and checks the committed boundary against that supplied text. Context expansion is inspected for the complete response before typed context/range vectors are materialized. The adopted range representation uses absolute endpoints; the wire’s length pairs remain defined by the [protocol reference](../occipital/protocol.md).

For STYLE, `semantic-protocol.ts` verifies the negotiated vocabulary and rule identity before adoption. `semantic-codec.ts` then validates the complete expression/context mapping and its controlled decoded cost. Structural validity alone cannot make data from another rule interpretation interchangeable.

## Size evidence is call-local, not a payload cache

Stdio already knows the actual JSON frame-body length. Shared ingress receives a parsed SDK value and performs the bounded canonical-JSON count. Each adapter records that measurement in the current call’s `ReplySize`, together with its ticket.

`replyJsonBytes` trusts this evidence only when the ticket matches and the numeric measurement fits the consumer’s negotiated cap. It avoids another full payload traversal; it does not skip envelope, semantic or allocation validation. A direct decoder call without matching evidence performs the complete safe size check.

The record contains no response object and is not a wire field. It must not be reused as evidence for a different call. On shared transport, this remains a post-SDK boundary: the SDK can already have allocated and decoded its private frame. That is why descriptor admission rejects providers whose advertised reply policy is too large for this consumer instead of merely clamping the limit after receipt.

## Stdio: queued, handed to the pipe, replied and closed

`StdioTransport` in `src/occipital/stdio.ts` keeps bounded outstanding CONTROL and DATA records and a separate outgoing-frame writer. Admission reserves request, reply and cancellation liability before queuing.

A queued request has not necessarily reached the child. The writer marks it `handedToWrite` immediately before handing its application frame to `stdin.write`. A response for a ticket that has not reached that point is invalid correlation.

The writer waits for both the write callback and, when required, `drain` before moving to another queued frame. A reply can arrive before its write callback. In that case the reply settles the call, but the still-owned writer bytes and queue position remain accounted until the writer releases them. Response settlement is not permission to reuse memory still owned by an I/O callback.

Input framing reads the bounded length first. Before the ticket is known, the frame must fit the largest currently eligible reply lane; after decoding and correlation it must fit that particular call’s lane. Strict UTF-8 and JSON decoding precede envelope checks. Unknown, premature or malformed replies retire the transport rather than being attributed to a convenient pending request.

Retirement announces the first ending and begins termination. Pending requests remain represented until process exit; full `close()` settlement additionally follows child cleanup. This distinction supports both conservative execution evidence and the owned-factory launch guard.

## Shared: public SDK ownership and local closure

`SharedTransport` in `src/occipital/shared.ts` passes encoded bytes through the public SDK route. It drops its temporary byte alias after handing the bytes to the SDK. Application counters describe its own reservations, not the SDK’s internal copies.

The SDK’s request signal requests cancellation; it does not itself settle the request promise. The adapter therefore keeps the pending call until the SDK delivers a result or the local connection is closed. A route-close notification is matched against this route/channel or module before retirement.

Closure requests route cleanup and closes this client’s connection. It does not terminate the shared service or prove that its old computation stopped. Late SDK outcomes cannot publish through a closed adapter.

The adapters also differ in how they obtain reply-size evidence: stdio measures received bytes, whereas shared transport counts the already-parsed application value. They share consumer semantics, not identical physical I/O ownership.

## A caller’s wait can end before the operation

The transport has an optional wait-only policy for CONTROL callers. On an ordinary request, deadline expiry retires the transport with uncertain execution. For a wait-only CONTROL request, expiry rejects that caller’s wait while leaving its correlation, bytes and CONTROL slot owned until actual settlement; another metadata call cannot build an unbounded queue behind it. Current protocol negotiation uses source-free `describe`; there is no theme-catalogue operation.

Stdio sends its existing once-only cancellation frame and waits for the correlated response or child cleanup. Shared transport waits for the SDK promise or connection closure. After an expired shared CONTROL wait, an uncertain SDK rejection releases that completed record without destroying unrelated source work; explicit loss or denial still follows normal retirement.

A late metadata response can release ownership, but an expired caller cannot publish its result. This distinction prevents a short metadata wait from imposing the same deadline on unrelated source requests. Increasing the deadline or ignoring lifetime notifications would not separate those responsibilities.

## What an outcome proves

`RequestFailure.execution` describes one local attempt. A typed `not_started` failure from admission or pre-dispatch refusal is stronger than an arbitrary rejection. After handing an operation to a pipe or SDK, an unclassified exception defaults to unknown execution.

A validated remote `RemoteFault` carries the correlated operation’s execution disposition. Neither kind of no-start evidence automatically settles an older attempt for the same logical source.

`acceptRetired` lets the controller inspect a late terminal outcome for execution evidence and cleanup even when the original publication opportunity has passed. It does not waive source-owner, generation, version or palette checks. A stale successful open can require closing its returned lease while its colors are discarded.

Transport ending is another question. The first `lost`, `closed`, `uncertain` or `denied` origin controls provider recovery. In particular, the shared SDK’s pending-request `connection_lost` wrapper can cover either EOF or a local read timeout, so that wrapper alone is treated as uncertain. Typed socket/stale-route evidence and public route-close reasons are handled separately; error-message text is never a recovery signal.

Finally, the [source controller](work.md) combines these outcomes with all still-held jobs and previous unknown-work guards. That is the only place where “may use Pi fallback now” is decided.

## Protocol and resources

The application protocol is **JSON v4**, capability `syntax-highlight/v4`, with contexts revision1, resolver revision3, SOURCE-hint revision2 and generic rule-definition revision2. Attributes/masks are0..31 with subset validation. The canonical client-rule fingerprint uses the NUL-terminated `occipital-client-rules/3` domain and includes context qualification. Both transports reject older/mismatched helpers before admitting SOURCE or STYLE; a freshly built matching helper is required. Its exact contract and cross-language vectors live in [`protocol/syntax-v4/`](../occipital/protocol.md). There is no v3 compatibility route or second production painter.

- SOURCE operations carry text, grammar/source identity and incremental coverage, but no selected theme. Replies contain positive UTF-8-length/context pairs and reply-local front-coded scope contexts. A parsed empty context differs from unclassified coverage.
- `styles.resolve` carries vocabulary-qualified contexts and one bounded generic semantic rule definition, but no source text or palette. Replies factor shared style expressions; the consumer binds them to funded local palette inputs and card roles. JavaScript does not interpret scopes.
- The build-generated trusted vocabulary is tied to grammar assets. Unknown IDs/names are rejected before arbitrary scope interning; compatible provider recovery can style retained contexts without parsing again. Incompatible vocabulary/assets require an explicit cold-source transition, never reinterpretation of old IDs.
- Replies are self-contained. The client validates complete batch coverage, identities, scalar boundaries, negotiated limits and expanded storage before retained allocation. Its live-context/style sharing is an accounted optimization, not synchronized server dictionary state.
- Owned stdio keeps bounded big-endian length framing; shared calls use the public Subconscious SDK. Source and style work share physical jobs/byte credits and Occipital fairness; source-free `describe` remains independent. A style response cannot close a parser lease, clear source uncertainty or reset a source-success crash budget.

Finite admitted sources remain one-shot. New contexts can require SOURCE then STYLE; retained contexts/styles and unchanged-rule Pi rebinding avoid that work. JSON decoding remains synchronous but DATA envelopes are bounded by the [highlighting volume policy](work.md#highlighting-volume-policy); there is no chunk-feeding mode, worker/binary carrier or fast full-card rendering guarantee for enormous inputs.
