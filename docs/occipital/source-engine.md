# Source engine and incremental parsing

SOURCE owns theme-free parsing of supplied text. It does not read hint paths, select a useful UI prefix, resolve styles or paint terminal rows. Its output records UTF-8 byte coverage and complete ordered scope contexts. See the [daemon overview](README.md), [request execution](requests-and-resources.md) and exact [source contract](protocol.md#theme-independent-sources).

## The identities behind a continuation

`source_service.rs` separates caller identity from parser identity. A **lease** is permission to continue a particular retained parser state; it is not simply a reusable source name.

The layers are:

- The process instance identifies the running daemon.
- A server-created route scope identifies a transport binding assigned to one worker.
- The source service gives each route binding an incarnation, allowing a queued job to detect that its route was closed or replaced.
- The caller supplies a source key, generation and source version. These values are retained in the service binding and returned with results.
- An open creates an opaque external lease. The service derives it from process/service identity and a monotonically advancing lease sequence.
- The engine maintains a separate internal lease incarnation and a serial for the current busy operation.

The service uses the external lease string as the engine key. It does not use the caller’s source key as a global replaceable slot. Opening the same caller key again creates another continuation, subject to admission; it does not implicitly retire the earlier lease.

Append first locates the binding within the requesting route. It requires the same caller key/generation and a source version no older than the binding’s current version. The engine then requires the matching internal lease, an idle slot and the exact acknowledged revision and byte count. A matching key alone cannot recover lost parser state.

An idle engine slot owns its checkpoint. Starting an append moves that state into worker-local `Work` and leaves a busy marker containing the operation serial and expiry. Both completion and retirement check the lease and busy serial. Old work cannot publish into or remove a newer incarnation merely because a key happens to match.

## Finite batches and preparation

`source_request.rs` validates and measures the complete wire batch before allocating owned source strings. `source_service.rs::start` then checks aggregate source cost and resolves every member’s syntax before constructing any parser `Work`.

Thus an unknown syntax in a later member is discovered before parsing an earlier member. This is a preparation property, not a guarantee that every possible batch failure is `not_started`: parser errors and output-growth failures can occur after execution begins.

Preparation creates pending work for the batch in input order. The service subsequently advances one current member at a time. Completed member results remain in the job while the next member runs. Their context-word and decoded-result charges reduce the remaining allowance for later members.

Only when all members finish does the service return a batch body for encoding. There is no partial-success batch publication. If preparation fails after constructing some pending work, or execution fails after producing some results, explicit discard tears down the job’s remaining work and affected continuation authority.

## Language selection

Occipital uses supplied hints, never file reads or content sniffing. A nonempty explicit `language` wins over `path`: recognized aliases are normalized case-insensitively, then syntax name and extension lookup are tried. An unknown explicit language does **not** fall through to the path. An omitted, null or empty language permits path selection; `path` is optional, and a pathless source can still be selected by explicit language. With no usable selector/path, or when its grammar is unknown, SOURCE returns `unknown_syntax/not_started`, not an implicit Plain Text parse; Plain Text must be explicit.

The complete explicit-language alias table is maintained here so protocol readers have one authoritative mapping:

### Explicit language aliases

The aliases below are matched case-insensitively and map to the exact bundled Syntect syntax name. This table describes explicit `hint.language` values, not filename extensions.

| Accepted aliases | Bundled syntax |
|---|---|
| `typescript`, `ts` | TypeScript |
| `javascript`, `js` | JavaScript |
| `bash`, `sh`, `shell` | Bourne Again Shell (bash) |
| `awk` | AWK |
| `clojure` | Clojure |
| `coffeescript` | CoffeeScript |
| `elixir` | Elixir |
| `erlang` | Erlang |
| `groovy` | Groovy |
| `haskell` | Haskell |
| `java` | Java |
| `julia` | Julia |
| `kotlin` | Kotlin |
| `ocaml` | OCaml |
| `perl` | Perl |
| `php` | PHP |
| `powershell` | PowerShell |
| `python`, `py` | Python |
| `r` | R |
| `racket` | Racket |
| `ruby` | Ruby |
| `rust`, `rs` | Rust |
| `scala` | Scala |
| `swift` | Swift |
| `tcl` | Tcl |
| `makefile`, `make` | Makefile |
| `json` | JSON |
| `plaintext`, `text`, `txt` | Plain Text |

If the explicit value is not one of these aliases, Occipital still tries it as an exact syntax name and then as a syntax extension. Do not infer case-insensitive matching for those arbitrary names/extensions. `hint.path` uses filename lookup instead; wire bounds and that fallback are defined in the [protocol reference](protocol.md).

A consumer may derive a canonical format from a file's first-line shebang and place it in the same `language` field. Occipital does not know the value came from a shebang, nor does it scan source text; there is no second override channel. The nonempty `hint.language` value is the sole explicit selector and wins over `path`. In Toolview's edit/write producer, a recognized shebang fills that field, so it wins over the filename extension. A caller that explicitly supplies `language: "text"` selects Plain Text; the daemon cannot distinguish that from any other explicit value. Toolview's separate Pi path classification is not sent as the Occipital selector. An unsupported explicit selector returns `unknown_syntax/not_started` rather than falling through to `path`; a malformed field is `invalid_request/not_started`. The client owns shebang recognition and alias mapping; see [shebang-derived language selection](../syntax/shebang-hints.md). Descriptor `source_hint_revision` ensures a client and helper agree on absent/null/empty language and optional-path semantics before SOURCE work is sent.

## Grammar and classified-line limits

Occipital uses Syntect 5.3.0 with two-face 0.5.2 assets. These are syntax grammars, not a language server: identifier/declaration distinctions depend on grammar scopes, not semantic symbol resolution or identical OpenCode highlighting. [Assets and vocabulary](assets.md) explain how these inputs are built and identified.

The UTF-8-safe **64 KiB classified-line window** bounds classified bytes within one logical line around a non-preemptible parser call. A real LF starts the next line's window; it does not replenish a whole-request source limit or the consumer's whole-source prefix budget. Those are separate checks, and the daemon refuses input outside admitted source policy. None of these checks authorizes truncating a user's display. The consumer selects its useful classification prefix while retaining the full display, as described in [volume policy](../syntax/work.md#highlighting-volume-policy).

Within admitted input, bytes after a classified line prefix retain explicit unclassified coverage. The consumer paints that coverage with its ready neutral role and preserves whole graphemes. Prefix-derived parser state does not pretend that omitted text was parsed. A smaller engine line window makes the frozen-tail behavior below independently observable; it is not a new CLI setting.

## Checkpoints, provisional tails and replacement output

A **checkpoint** is the retained parser state and scope stack after completed lines. An ordinary unterminated line is a **provisional tail**: its current bytes are parsed using a clone of that checkpoint, so later appended text can change the interpretation of the whole unfinished line.

`semantic_engine.rs::State` therefore keeps distinct values for:

- Total accepted source bytes.
- Bytes committed through actual completed lines.
- Retained raw tail prefix and total tail length.
- The tail’s latest classified window.
- Parser/scope state and whether the current line’s prefix has been frozen.
- Revision, creation time and last source-progress time.

It does not retain all completed source text or every historical range. The next operation begins replacement output at the previous committed boundary. The consumer combines that replacement with its already-retained earlier result according to the [protocol](protocol.md).

### Worked ordinary append

Assume a recognized syntax, sufficient admission and a line window larger than the following ASCII text. The example describes byte boundaries, not grammar-specific scope names.

1. Open with `a\nbc`. The engine parses the completed `a\n` into the checkpoint, then parses `bc` against cloned state. Total coverage is four bytes; the committed boundary is two. The reply starts at byte zero and includes the provisional tail.
2. Append `d\nx` using the previous acknowledgment. The unfinished line is now `bcd\n`. It is parsed from the checkpoint after `a\n`, replacing the earlier provisional `bc` classification. The checkpoint advances to byte six. The new `x` tail is parsed against cloned state. Total coverage is seven bytes, and this reply replaces from byte two.
3. Finalize with an empty append. The engine re-emits the retained classification for `x`, replacing from byte six. It reports all seven bytes committed and retires the continuation. There is no parser call and no fabricated final LF.

The first two operations each have a completed-line parse and a tail parse. The empty finalization has neither. The reply-local context IDs can differ between operations: reusing a classified tail does not mean reusing a previous reply’s dictionary numbering.

A nonfinal empty append similarly reuses the retained tail result. It advances the accepted revision but does not refresh source-progress time.

### Worked frozen tail

The classified-line window is a parser guard, not an instruction to reject every longer supplied line. To illustrate the separate states, consider an engine with a three-byte window and a larger admitted whole-source allowance. This is an illustrative engine setting, not a production default or a configuration option.

1. Open `ab`. Its two-byte tail is provisional.
2. Append `cd`. The engine parses only `abc`, using the prior checkpoint clone. The classified prefix has reached its window, so that clone becomes the frozen parser/scope state for this line. The stored classified window covers `abc`; `d` is represented as unclassified coverage.
3. Append `e\nz`. The completed first line is `abcde\n`. The engine re-emits the frozen `abc` classification and unclassified coverage for `de\n`; it does not parse the frozen prefix again or supply the omitted suffix to Syntect. It advances the completed-byte boundary through that real LF, clears the tail window, and parses the new tail `z` from the prefix-derived state.

The parser state after such a line is deliberately prefix-derived. It is not a claim that the unclassified remainder was parsed or that the following state equals an unlimited full-line parse. UTF-8 boundary selection can freeze a prefix before the nominal byte ceiling when the next scalar would not fit.

## From parser operations to contexts and ranges

Syntect returns ordered scope-stack operations at byte positions. A **scope stack** is the complete ordered nesting of syntax scopes at a position, not a single color category.

`semantic_engine.rs::apply_operations` emits the span before each operation using the current stack, applies that operation, and finally emits the remaining span. Operation positions must be monotonic, within the supplied string and on UTF-8 boundaries.

Zero-length spans produce no range, but their operations still run. Multiple operations at one position, or operations at the end of a line, can change the state of later text. Discarding an operation because it has no immediately visible bytes would change parsing semantics.

The stack wrapper handles push/pop and Syntect clear/restore behavior. Clearing scopes can retain a saved stack for a later restore, so its allocation accounting includes saved stacks and their headers as well as the currently visible stack. Restoring without a corresponding clear is an error. Pushed native scopes must be representable by the trusted vocabulary.

For each positive parsed span, the emitter converts the complete native scope stack into portable vocabulary IDs. It deduplicates equal paths using a hash index with exact path comparison; hash equality alone is not identity. New paths receive reply-local context IDs in discovery order. Their encoded rows reuse the common prefix of the preceding dictionary row, without creating a persistent dictionary shared with the consumer.

Adjacent spans with the same context ID merge. Different contexts remain distinct even if a particular theme would assign them equal colors. SOURCE does not resolve colors.

A successfully parsed empty stack receives a positive context ID for an empty context. Context zero instead marks unclassified bytes. This distinction survives later STYLE resolution: parsed-empty uses the resolver’s base expression; unclassified coverage is not submitted as a parsed context.

A retained tail window stores complete paths and runs. When reused, it is inserted into the new emitter’s dictionary and its IDs are remapped. `semantic_reply.rs` then serializes the resulting run pairs directly. The exact encoding is defined in the [protocol reference](protocol.md).

## Completion, discard and expiry

Finishing accepted work updates total bytes and revision. Nonempty appended input updates source-progress time; empty input does not. A nonfinal operation returns the parser state to an idle slot. Finalization removes its engine slot and service binding.

`stream.close` removes a binding only when the route, lease, key and generation match. A missing or nonmatching binding still receives the closed response without closing somebody else’s continuation. Close is cleanup, not proof that earlier work never executed.

Errors and cancellation use `source_service.rs::discard`, not merely a Rust destructor for the job. The service records affected external/internal lease pairs separately from pending work so it can retire a continuation even after parsing finished and its reply is waiting for delivery. The scheduler’s [delivery ownership](requests-and-resources.md) prevents a later append from overtaking that decision.

Expiry is the earlier of the idle-progress deadline and the absolute age deadline. Source progress can extend the former but never the latter. Busy markers retain expiry too; queueing or executing an append does not suspend the lifetime bound.

The worker advances the engine’s monotonic clock at cooperative scheduler boundaries. Expired slots are removed, and later work fails its active-incarnation check. This does not interrupt an in-progress regex. The worker also uses the nearest expiry as a sleep deadline, so idle continuation cleanup does not require an unrelated future source request.

The service prunes bindings against live engine leases. Both tables preserve increasing incarnation order, permitting a merge-like pass rather than a fresh full slot search for every binding or another persistent lookup index. Empty tables release their vector capacity; partially occupied capacity remains part of retained-state accounting.

### Reading parser counters

`protocol.rs` defines the per-operation counters returned with SOURCE results. Completed-line calls count actual parser invocations on committed line prefixes. Tail calls count provisional parsing; tail-byte totals include bytes replayed when a growing unfinished line is parsed again.

A frozen prefix reused without parsing and an empty finalization can therefore advance coverage or finish authority without increasing those parser-call counters. Conversely, one visible unfinished line can account for several tail calls across appends. Counters describe work performed, not a separate proof of delivered or published paint.
