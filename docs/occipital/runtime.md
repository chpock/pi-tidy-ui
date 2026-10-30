# Runtime, routes and transports

This chapter follows Occipital from executable entry to shutdown. [Request execution](requests-and-resources.md) starts once a route has accepted a body; the [protocol](protocol.md) defines the body and carrier precisely.

## Executable entry

```text
occipital [--stdio | --subc CONNECTION_FILE]
```

Without a mode argument, the executable selects persistent stdio. `--stdio` selects it explicitly. `--subc` consumes the supervisor's nonempty connection-file argument; the public SDK remains responsible for reading that file and verifying the launch contract. Duplicate mode flags, missing required arguments and unknown arguments fail with an `arguments` fault. Occipital has no theme configuration flag. `--version` prints the compiled package version; `--help` prints usage and exits.

Shared mode is an explicitly configured **user-managed module**. Occipital does not discover, start or install a Subconscious supervisor. Toolview's selection of a shared service or an owned helper is [client policy](../syntax/providers.md), not executable startup behavior.

### Startup order

1. Parse arguments before creating runtime resources.
2. In shared mode, call the public SDK launch-nonce reader before creating sockets or parser threads. It caches and closes the inherited launch descriptor; the later SDK handshake uses the cached value.
3. Construct a two-worker Tokio runtime named `occipital-io`.
4. Generate a random 16-byte instance nonce and format an `occipital-…` instance identity. A new process is a new authority, even with identical parser assets.
5. Construct the parser actor pool with default limits and initialize the finite trusted scope-handle table. Direct mode gets one parser worker; shared mode gets `min(available_parallelism, 2)`, falling back to one.
6. Construct the request authority from the worker-pool handle, instance and limits.
7. Bind the direct route and run the stdio frontend, or serve the shared module. The main task selects frontend completion against Ctrl+C.

The pool owns thread completion/join handles. Its transport-facing `PoolHandle` contains a weak hub reference; transport facades cannot keep worker-join authority alive indefinitely. Construction failure signals already-created workers to stop and reports failure rather than publishing a partial pool.

## Thread topology

| Execution context | Responsibility |
|---|---|
| Tokio runtime workers | Carrier orchestration, cancellation waits, descriptor control and asynchronous replies |
| One or two fixed parser threads | Create, mutate and destroy worker-local parser/style work; own source slots, route scheduler and compiled generic-rule cache |
| Stdio reader thread | Blocking length-framed stdin reads and bounded handoff to the async frontend |
| Stdio writer thread | Serialized framed stdout writes, flush and delivery acknowledgment |

The parser actor is not spawned per request. Oniguruma/Syntect work stays on its owning thread; a bounded native turn does not make a single regex call preemptible. Immutable grammar/vocabulary assets are shared, while per-worker lease/state quotas are divided so their sum stays within process limits.

The worker loop observes stop/route revocation, advances the scheduler, publishes its current lease count, then receives messages. While work is runnable it uses nonblocking receive between turns. When only expiry remains it waits until the next expiry; otherwise it blocks for a message. There is no recurring idle wake merely to rescan an empty worker.

## Route authority and affinity

Binding allocates a monotonically increasing route incarnation and assigns it to the worker with the fewest currently registered routes; equal counts select the first worker in pool order. The hub reserves that registry entry before sending the worker's bind message, then waits for its acknowledgment and rechecks process liveness. This is route-count balancing, not measured parser-load balancing or migration of existing leases. Subsequent source/style work for that route stays on that worker. A streaming lease is therefore qualified by process and route authority, not merely by an externally visible lease string.

The hub bounds its route registry. A route facade carries liveness shared with the worker; closing/dropping it revokes access and wakes cleanup. Delayed callbacks may still hold facade values, but revocation prevents them from becoming a new live route. The worker prunes dead routes and retires their queues/bindings/leases on its own thread.

Worker affinity avoids moving parser state across threads. Route rotation inside a worker provides fairness among clients; affinity is not a promise of one thread per client or of globally parallel parsing for every request. See [scheduling](requests-and-resources.md#queue-ordering-and-computational-turns).

## Persistent stdio frontend

### Framing and bounded handoff

Each message is a four-byte unsigned big-endian body length followed by exactly that many UTF-8 JSON bytes. Zero-length or over-ceiling frames are rejected before allocating a body. EOF before the first header byte is a clean end; a partial header/body is an error. Interrupted reads retry the first-byte read. Writes check the same carrier constraints, write the header and body, then flush.

The emergency carrier ceiling is not DATA admission. After framing, the smaller application CONTROL/DATA policies still apply. Their exact values and direct cancellation message are in the [protocol](protocol.md#version-identities-and-carriers).

Input and output handoff channels each have one queued slot. At most one raw frame is queued and one is reader-owned outside already credited decoded jobs. On output, both queued and writer-owned successful replies remain credited. The active dispatch-task cap and duplicate ticket checks prevent the frontend from turning bounded worker admission into an unbounded collection of waiting task bodies.

The async dispatcher retains each request's cancellation token in a ticket registry. A direct cancellation message signals that token; it does not itself produce a success result or free a worker slot. DATA dispatch signals its native ticket once and continues waiting for settlement. `describe` is a bounded source-free observation; canceling its waiter does not create a DATA result or prove that no work was dispatched.

### Delivery is a separate stage

The worker returning bytes is not equivalent to successful pipe delivery:

1. A DATA `Delivery` or CONTROL guard moves into an `Outgoing` packet.
2. The single writer writes and flushes the frame.
3. Only successful flush commits the delivery/control receipt.
4. The async dispatch waits for the writer's receipt before dropping its ticket and completing.

Cancellation can arrive while waiting for worker output, output-channel space or flush acknowledgment. The dispatch still retains corresponding physical ownership. A failed write/drop uses the abandonment path; it must not leave a usable parser continuation whose successful acknowledgment was never handed off.

Reader completion, writer failure or frontend failure revokes the route, cancels outstanding request waits and retires the authority. These pipe threads exist for the process carrier rather than as a general pool of indefinitely queued blocking jobs. The owned-process consumer supplies its own finite termination/reap boundary if the process cannot finish cooperatively.

## Shared SDK frontend

`shared.rs` registers an internal, non-agent-facing bulk service with the existing public SDK. It advertises exactly `describe`, `highlight`, `stream.open`, `stream.append`, `stream.close` and `styles.resolve`; exact service/capability names are in the [protocol](protocol.md#version-identities-and-carriers).

- `on_bind` accepts only the expected internal-service target and a live authority, then allocates a native route. The complete SDK route handle is the mapping key. A duplicate or late bind closes the tentative route and is rejected.
- A request retrieves its bound route and checks cancellation before ingress. DATA cancellation is signaled once while still awaiting the native ticket. `describe` reads the fixed source-free descriptor.
- `on_route_gone` removes and closes that route.
- Draining or connection end retires the authority and closes all mapped routes.
- The return path from `serve` repeats cleanup, because an SDK error need not deliver a connection-end callback.

The native guard is retained until the actual SDK response enum owns the bytes. `reply.handoff(HandlerOutcome::Response)` is the application delivery boundary. It proves **SDK ownership handoff**, not physical receipt by a remote client or presentation of the result. SDK ingress/egress retention is a separate allowance, not secretly part of the application's credited byte ledger.

The daemon never uses cancellation or route disappearance as permission to mutate another client's route. A shared process outlives an individual consumer according to the supervisor's lifecycle; a consumer stopping its own terminal does not stop this process.

## Descriptor control lane

`describe` uses source-free CONTROL authority so capability negotiation and bounded runtime observations do not depend on DATA queue completion. The descriptor is fixed for the process incarnation: grammar/vocabulary identity and protocol revisions do not change during its lifetime. There is no filesystem theme load, mutable catalogue publication or profile refresh. Palette selection and preview are local consumer responsibilities.

## Shutdown and reporting

After frontend completion or Ctrl+C, `main` retires the authority, then awaits cooperative actor shutdown. Shutdown sets the shared stop flag, wakes workers and awaits their completion and OS-thread join; all worker-local state is destroyed there. The final result preserves frontend failure and otherwise reports a failed worker join as `worker_gone`.

After the async run returns, Tokio gets a 200 ms shutdown timeout. This bounds runtime teardown; it is **not** a 200 ms parser-kill guarantee, because parser joins occur earlier. An in-progress regex can delay cooperative shutdown. The owned-helper controller can separately kill and reap the process; shared clients do not acquire that authority.

Fatal startup/runtime failure writes only `occipital stopped: <safe-code>` to stderr and exits with status 1. It does not put source text, raw OS/socket/authentication errors or diagnostic banners on the framed stdout stream. The descriptor reports protocol, asset, vocabulary, limit and runtime identities, not palette-file or catalogue state. See [diagnostic boundaries](README.md#configuration-and-observation-boundaries).

## Implementation map

`crates/occipital/src/main.rs` composes the process; `actor.rs` owns worker/route authority; `stdio.rs` and `shared.rs` adapt carriers; `frame.rs` handles direct framing; `control.rs` serves the fixed descriptor. None of these files chooses Toolview palette selection, visibility, fallback or UI retry policy.
