# Occipital syntax-highlight/v4 — application contract

This reference describes the coordinated v4 native producer, stdio/shared adapters and TypeScript consumers. The [syntax specification](../syntax-highlighting-spec.md) defines product behavior; [client volume policy](../syntax/work.md#highlighting-volume-policy) defines useful classification-prefix selection, while this reference owns exact advertised limits and message-size admission. Reject older protocol and resolver interpretations rather than guessing compatibility. The published Occipital 0.2.0 / pi-tidy-ui 0.1.1 pair remains on v3 until a separately authorized release.

Controlled-allocation accounting is not an allocator/private-heap/RSS guarantee. Neither this protocol nor its bounded cooperative scheduler guarantees arbitrary-language latency or dense 10 MiB full-card admission.

## Authority and transport

### Version, identities and carriers

Application version is `4`, capability `syntax-highlight/v4`, service `syntax`. Descriptor revisions are contexts `1`, resolver `3` and SOURCE hints `2`. Generic rule definition revision `2` is carried by `styles.resolve`, not the descriptor. The consumer requires the descriptor revisions exactly before admitting SOURCE/STYLE work; resolver revision governs generic rule matching and the rule revision governs the required-nullable context qualifier. Palette identity and bindings are extension-local.

Owned stdio carries nonempty UTF-8 JSON preceded by its four-byte unsigned big-endian byte length, excluding those four bytes. Shared mode carries the application JSON through the public Subconscious internal-service route and SDK correlation, without an embedded stdio length prefix. The consumer preserves the complete SDK route handle, including its epoch.

Application `ticket` correlation is required on both carriers. Callers must not reuse tickets within a provider/helper incarnation; adapters detect active duplicates, not a permanent history of retired tickets. Source keys and leases do not replace tickets. Route ownership is transport-established, not a caller-supplied SOURCE field.

`instance` identifies the native incarnation; `assets` identifies the pinned grammar/parser asset revision. Vocabulary fingerprint is a separate identity for portable scope IDs, not a Syntect interner handle. Its hash includes the vocabulary schema, asset fingerprint and sorted trusted scope/prefix table. An asset revision therefore changes vocabulary identity even if the names stay identical. Scope interner handles never cross the wire. Definition/rule identities do not depend on Pi colors or terminal width.

### Common values and request fields

Bounds are inclusive. A bounded identifier/text value is a nonempty string within its UTF-8 byte cap, without Unicode control characters or unpaired surrogates. These restrictions apply to identifiers, names and hints, not source `text`/`append`, which may contain newlines and other valid Unicode characters.

| Value | Bound or required value |
|---|---|
| `v` | `4` |
| `op` | One of the operations below |
| `ticket`, `instance`, source `key`, `lease`, error `code` | At most 64 UTF-8 bytes |
| `assets` | Producer emits lowercase 64-character SHA-256; consumer header validation accepts bounded text up to 256 bytes and checks identity equality, not hexadecimal syntax |
| Vocabulary and effective rule fingerprints | Exactly 64 lowercase ASCII hexadecimal characters |
| `generation` | Integer `1..4294967295` |
| `source_version` | Integer `0..4294967295` |
| Source `revision`, append `base_revision` | Integer `1..4294967295` |
| Append `base_bytes` | Integer `0..4294967295`, additionally constrained by exact acknowledged state and source coverage |
| `final`, result `complete` | JSON boolean |

Ordinary native application requests use the correctly rounded IEEE-754 binary64 value of JSON numbers, followed by finite, integral and field-specific range checks. Equivalent integer-valued decimal/exponent spellings are legal. TypeScript validates parsed values. This does not widen any field's range to every safe integer.

Every ordinary request contains `v`, `op`, `ticket`. Its remaining fields are:

| Operation | Remaining request fields |
|---|---|
| `describe` | Optional `instance` |
| `highlight` | Required `instance`, `admission`, `sources`; conditional `queue_wait_ms` |
| `stream.open` | Required `instance`, `admission`, `sources`; conditional `queue_wait_ms` |
| `stream.append` | Required `instance`, `admission`, `key`, `lease`, `generation`, `source_version`, `base_revision`, `base_bytes`, `append`, `final`; conditional `queue_wait_ms` |
| `stream.close` | Required `instance`, `key`, `lease`, `generation` |
| `styles.resolve` | Required `instance`, `admission`, `vocabulary`, `contexts`, `rules`; conditional `queue_wait_ms` |

Native operation admission rejects fields not listed for that operation. CONTROL validates an optional `instance` as bounded text but does **not** compare it with the current instance. DATA requires the current instance: a SOURCE mismatch returns `restart_required`, while a STYLE mismatch returns `invalid_request`; both are no-start failures.

`styles.resolve` uses the [context codec](#context-codec) and generic [rule definition](#rule-input-and-style-resolution) below. SOURCE contains no selected palette, style rule or display identity.

### Admission and scheduling

`describe` uses the separate source-free CONTROL lane. `highlight`, all three `stream.*` operations and `styles.resolve` use DATA authority. In particular, `stream.close` is not metadata merely because it contains no source text.

For DATA operations other than close:

- `admission:"try_now"` requires absent `queue_wait_ms`. The scheduler refuses with `busy` if its worker already has scheduled turns or the requested lease is held by an unacknowledged delivery. Physical job/byte capacity can also refuse admission. This does not promise synchronous completion.
- `admission:"bounded_queue"` requires integer `queue_wait_ms` in `1..1000`, respecting any smaller advertised maximum. Physical credit is reserved before queueing; this mode does not bypass capacity.
- The queue deadline starts at submission and applies while awaiting preparation. Expiry produces `queue_expired` with `not_started`; it is not an execution deadline once preparation begins.

Close accepts neither `admission` nor `queue_wait_ms`. It still requires DATA credit and a scheduler turn, and can be refused for capacity or route loss. Each worker rotates eligible routes, preserving operation order within a route. SOURCE and STYLE share physical job/byte authority. Lease-owning delivery can block the next operation on that lease until acknowledgment or cleanup.

`quantum_ms` is cooperative: SOURCE checks line/byte/time boundaries between parser calls, never interrupting a running regex. Lease idle/age expiry is also distinct from a request deadline. Local transport deadlines and metadata wait-only behavior are adapter options, not JSON fields.

### Replies, correlation and execution disposition

The complete application envelopes are:

```text
{v:4,ticket,instance,assets,status:"ok",body}
{v:4,ticket,instance,assets,status:"error",error:{code,execution}}
```

No `op`/`service` is added to replies. Semantic decoding requires exactly the corresponding envelope fields and exactly `code`/`execution` in errors. Expected ticket and accepted-provider instance/assets are checked before accepting outcomes or materializing semantics.

`execution` is `not_started` or `started`; error code is bounded text, not a closed consumer enumeration:

- `not_started` describes only the correlated attempt, not earlier work/uncertainty for that source.
- `started` is conservative execution evidence, not proof of a particular parser call or usable commit. Empty-input completion and failures after computation/during reply encoding can be started. A batch failure is started if any member started.
- STYLE disposition describes only STYLE: it cannot prove SOURCE execution, advance parser revision, close a source lease or authorize SOURCE replay.

Malformed, uncorrelated and changed-provider replies are not validated no-start faults. Local post-dispatch timeout, abort and transport failure keep execution unknown without appropriate independent authority. Error text, absent providers and vanished JavaScript waiters do not prove replay permission.

The TypeScript boundary distinguishes validated `RemoteFault` (`execution: "not_started" | "started"`) from local `RequestFailure` (`execution: "not_started" | "unknown"`). `ProtocolError` and `SemanticError` are validation failures, not remote no-start evidence. Separately, transport lifetime records `lost`, `closed`, `uncertain` or `denied`: the first origin wins, and cleanup cannot promote uncertainty to confirmed loss. These categories do not prove parsing never started or has stopped. A pending-request shared `SubcError` with `closeReason:"connection_lost"` remains uncertain because the SDK can use that value for EOF **or** its local read timeout. See [execution authority and recovery](../syntax/providers.md#execution-authority-and-conservative-recovery).

A bounded routing probe can recover a valid ticket before full operation admission to return a correlated error; this is not successful operation validation. Without recoverable correlation, stdio terminates the invalid exchange; shared mode can return an SDK handler error instead of a fabricated application envelope.

Stdio cancellation uses a transport-only frame exactly `{v:4,cancel:ticket}`, bounded to 4 KiB. It has no separate acknowledgment and is not an application operation. Its version is decoded directly as Rust `u32`, unlike ordinary requests' binary64 numeric helper. Shared cancellation uses the SDK. Cancellation is best effort, not physical release or no-start evidence.

### Descriptor and metadata operation

`describe` returns exactly:

```text
{
  kind:"descriptor",protocol_version:4,
  contexts_revision:1,resolver_revision:3,source_hint_revision:2,
  vocabulary:{fingerprint,count},assets,backend_version,
  capability:"syntax-highlight/v4",service:"syntax",
  operations,modes,admission,limits,runtime
}
```

Metadata contains no source payload, whole vocabulary, style table or card palette.

| Field | Consumer validation and meaning |
|---|---|
| `assets` | Equals envelope `assets` |
| `vocabulary` | Exactly `{fingerprint,count}`; valid fingerprint, integer count `1..4294967295` |
| `backend_version` | Nonempty bounded text, at most 128 UTF-8 bytes; no semantic-version parser requirement |
| `source_hint_revision` | Integer `2`; defines SOURCE language selection, including absent/null/empty selector behavior and optional path-only selection. A consumer requires the exact supported revision before submitting SOURCE. |
| `operations` | Exactly the six operation names `describe`, `highlight`, `stream.open`, `stream.append`, `stream.close`, `styles.resolve`, with unique bounded strings; order is not significant |
| `modes` | Exactly `one_shot` and `growing`, unique bounded strings; order is not significant |
| `admission` | Exactly `try_now` and `bounded_queue`, unique bounded strings; order is not significant |

The SOURCE protocol has no shebang-specific field and the daemon never scans source text. A consumer may recognize an edit/write file's first-line shebang and send its selected canonical format through the ordinary `language` field. That explicit selector outranks `path`; the protocol treats it exactly like any other requested format.

`one_shot` identifies finite highlight and `growing` open/append/finalize. SOURCE has no separate `mode` field. The descriptor describes grammar/vocabulary and generic capabilities only; palette selection, rule bindings and card-role data remain local to the extension.

Published-provider rereads require unchanged instance, assets and vocabulary identity/count, plus the exact v4 revisions and operation/capability contract. There is no catalogue refresh or profile-membership negotiation. Initial candidate negotiation remains a separate acquisition path.

### Exact `limits` fields

Every key below is required; extra keys reject. Values are integers `1..4294967295`. Defaults describe the current producer, not additional consumer equality requirements. The consumer does additionally reject advertised `reply_bytes` above 512 KiB before DATA.

| Field | Default | Unit and scope |
|---|---:|---|
| `request_bytes` | 524288 | Complete serialized DATA request JSON body bytes |
| `reply_bytes` | 524288 | Complete serialized DATA reply JSON body bytes |
| `control_request_bytes` | 4096 | CONTROL request JSON body bytes |
| `control_reply_bytes` | 32768 | CONTROL reply JSON body bytes |
| `source_bytes` | 65536 | UTF-8 coverage: aggregate finite batch or cumulative stream |
| `line_bytes` | 65536 | Classified prefix window per logical line, not rejection of a longer admitted line |
| `batch_sources` | 8 | Finite source count; open still requires exactly one |
| `queue_wait_ms` | 1000 | Maximum bounded-queue wait in milliseconds |
| `state_pool_bytes` | 268435456 | Controlled retained-state pool bytes |
| `leases` | 4096 | Process-wide parser leases |
| `leases_per_route` | 512 | One route's parser leases |
| `runs` | 131072 | Run-pair count per result; wire/source/result guards can impose much smaller effective bounds |
| `idle_ms` | 300000 | Lease idle expiry interval |
| `age_ms` | 3600000 | Maximum lease age |
| `quantum_ms` | 2 | Cooperative SOURCE time quantum |
| `data_per_route` | 2 | Physically held DATA jobs per route |
| `control_per_route` | 1 | Physically held CONTROL jobs per route |
| `routes` | 8 | Process route bound |
| `workers` | 1 or 2 | Stdio uses one; shared uses available parallelism capped at two |

Native retained-state and total lease quotas are partitioned across workers; unused quota on another worker need not be available to this route. No `styles`, source-line-count, expanded-context-word-count, decoded-result-byte-count or total-DATA-pool key is added here. Those independent guards are in [Normalization and accounting](#normalization-and-accounting) and the product volume policy. The 64 MiB emergency transport ceiling is not DATA allowance.

### Exact `runtime` fields

Runtime has exactly these keys. `pid` is an integer `1..9007199254740991`; every other value is an integer `0..9007199254740991`.

| Field | Meaning and unit |
|---|---|
| `pid` | Native process ID |
| `routes` | Registered native route count |
| `leases` | Sum of worker-reported parser lease counts |
| `data_bytes` | Reserved controlled DATA bytes, including retained state and delivery/accounting ownership, not just text |
| `data_jobs` | Route-attributed physical DATA credits still held |
| `queued` | DATA credits whose preparation is not yet marked started |
| `control_bytes` | Reserved CONTROL-budget bytes |
| `control_jobs` | Physical CONTROL credits still held |

These are observations, not an atomic barrier or all-process/SDK-memory measurement. Decoding checks types/ranges, not relationships to client tickets. `data_jobs` includes credited admission, queueing, computation and held delivery. Stdio delivery guards span actual write/flush; shared guards span construction of the SDK-owned response, after which SDK/client retention may continue. A local metadata promise can also reject while physical control ownership remains. Native counters, JavaScript promises, client reservations and transport cleanup are not interchangeable.

### Unknown-field handling

- Native operation decoders reject unknown fields in CONTROL/SOURCE/STYLE requests, source entries, hints and rule wrappers, enforcing operation-specific presence. Optional does not imply arbitrary `null` is accepted.
- Routing probes ignore unrelated fields only to recover correlation before full admission.
- TypeScript request adapters check headers/bounded JSON, not every native operation-schema field; they do not universally reject unknown request fields.
- Transport reply checks establish correlation/header/outcome, not exact-key semantic validation.
- Semantic decoders reject extra keys in envelopes/errors, descriptors and structured members, SOURCE/results/counters/close acknowledgments, and STYLE/rule/expression objects.
- Descriptor-list extensibility is distinct from object-key extensibility. Post-`JSON.parse` exact-key validation also does not prove raw-wire duplicate-member rejection.

Native DATA preflight rejects structural JSON nesting beyond depth 64. That is a request guard, not a scope-context depth policy.

## Theme-independent sources

### Source input and syntax hints

Highlight/open contain `sources:[{key,generation,source_version,hint,text},...]`, with exactly those five fields per source. `text` is valid Unicode and may be empty. The daemon does not reread files or silently truncate it; callers supply intended normalized text or an explicitly selected prefix.

`hint` is an exact object with optional `language` and `path` fields. Either may be omitted or `null`. A non-null language is a string of at most 128 decoded UTF-8 bytes; the empty string means absent and selects path-based lookup. A nonempty language is an explicit format selector. A non-null path is bounded to 4,096 UTF-8 bytes and is optional, so pathless text can be highlighted using `language` alone. Wrong field types, controls and over-limit strings are `invalid_request/not_started`; a structurally valid but unsupported format is `unknown_syntax/not_started`.

1. A **nonempty language** is explicit: normalize recognized aliases case-insensitively, try the resulting syntax name, then the original language as an extension. Failure does **not** fall through to `path`.
2. If language is omitted, `null` or empty, and `path` is present, take its basename after either slash convention; try that whole basename as an extension token, then its suffix after the last dot.
3. If there is no usable selector/path, or its grammar is unsupported, return `unknown_syntax/not_started`. Do not inspect text for a format and do not implicitly select Plain Text.

The complete case-insensitive explicit-language alias table is maintained in [source engine — explicit language aliases](source-engine.md#explicit-language-aliases). It maps current aliases to exact bundled syntax names. Other explicit values are still tried as an exact syntax name and then an extension; that lookup is not promised to be case-insensitive. Plain Text must be selected explicitly.

Finite batches contain one to eight sources under any smaller advertised bound; open contains exactly one. Keys are unique across the complete batch regardless of generation. Consumers reject duplicate result keys and match by key, not result order. Aggregate finite/cumulative-stream coverage is 64 KiB UTF-8 and 8,192 logical lines, not per member/append. Empty text has zero lines; each LF terminates one and a nonempty unterminated tail adds one. A final LF adds no phantom line. Smaller advertised source limits and independent encoded-JSON caps remain authoritative.

### Source identity, revisions and leases

| Field | Role |
|---|---|
| `key` | Client source ID, echoed and checked against request |
| `generation` | Client incarnation, fixed and checked exactly for an existing lease |
| `source_version` | Client content tag; append permits the same or any higher version, not only the next integer |
| `revision` | Native operation revision: starts at 1, advances once per successful append including empty append/finalization |
| `source_bytes` | Total acknowledged UTF-8 bytes |
| `base_revision` | Exact last acknowledged parser revision |
| `base_bytes` | Exact last acknowledged total bytes, not merely committed bytes |
| `lease` | Opaque route/instance-owned continuation authority returned by open |

The current producer's lease token is a lowercase 64-character hash-shaped string, but authority comes from stored binding lookup, not token syntax. Append requires route, instance, lease, key, generation and exact acknowledgment basis. Regressing source version, missing/retired binding, mismatched basis or exhausted revision yields `restart_required`; busy parser state can yield `busy`.

Batch uniqueness does not establish a server-global latest-generation registry per client key. Open allocates a new lease; another open/finite request with the same key does not implicitly retire earlier leases. Callers close superseded continuation authority.

Lease expiry is the earlier of birth plus `age_ms` and last nonempty-input progress plus `idle_ms`. Empty appends advance revision without renewing progress time. Expiry is cooperative, not regex preemption. Route teardown, exact finalization/close and failed/cancelled work have their own lease-retirement paths.

### Operations and acknowledgments

| Operation | Successful acknowledgment |
|---|---|
| `highlight` | Per source: revision 1, `replace_from:0`, `complete:true`, committed bytes equal source bytes, **no lease field**; finite parser state released |
| `stream.open` | One result: revision 1, `replace_from:0`, `complete:false`, required nonempty new lease even for empty input |
| Append `final:false` | Same lease, revision `base_revision + 1`, bytes `base_bytes + UTF8(append)`, `complete:false`; continuation live |
| Append `final:true` | Same lease echoed and revision advanced, `complete:true`, all bytes committed; continuation retired |
| `stream.close` | Exactly `{kind:"closed"}`, no source result/revision/lease echo |

`stream.open` captures each source's validated `hint` into the parser state. `stream.append` carries continuation identity and new text, not a replacement hint; the grammar selected at open therefore remains fixed for that lease. To change the grammar, the caller must retire the old continuation and open a new source identity under the new hint.

Append's `replace_from` is prior **committed** bytes, not `base_bytes`: replacement includes the old provisional tail and appended text; preceding bytes are unchanged. Empty append/finalization are legal and may reuse tail results without a parser call/newline while still advancing operation revision.

Close retires only matching route/lease/key/generation. Absent/stale leases or mismatching key/generation are idempotent no-ops with the same closed reply if otherwise admitted. Success does not prove a live binding existed; wrong instance/malformed fields still fail. A computed SOURCE result not yet delivered retains cleanup authority: abandoned delivery can retire its affected continuation, not leave a lease inferred from an undelivered result.

### Source result body and byte coordinates

Exact SOURCE body is `{kind:"source",vocabulary,sources:[result,...]}`. Vocabulary must match the accepted descriptor independently of envelope assets and applies to every reply-local context dictionary. Each result is exactly:

```text
{
  key,generation,source_version,revision,
  source_bytes,replace_from,committed_bytes,complete,
  counters,contexts,runs
  // plus lease only under the acknowledgment rules above
}
```

The consumer checks key, generation, source version, revision, total bytes, replacement start and completion against captured expectations, plus an append lease against its prior token. Finite highlight must omit lease; final append must still echo it.

`0 <= replace_from <= committed_bytes <= source_bytes`, measured in UTF-8 byte offsets, not UTF-16, terminal columns or JSON-encoded bytes. A complete result commits all bytes; otherwise committed offset is after the suffix's last LF, or replacement start when there is none. Source coverage remains bounded.

Contexts use the [context codec](#context-codec). Runs are flat positive byte-length/context-ID pairs covering exactly the replacement suffix, never splitting a scalar; adjacent equal IDs merge. ID 0 is unclassified/neutral, while positive IDs are one-based dictionary positions including parsed-empty. Empty suffix requires empty runs. Validate the entire batch's identities, coverage, scalar boundaries, contexts and charges before expanded vectors are adopted; no partial batch adoption.

### Parser checkpoints and counters

Completed LF-terminated lines advance the retained checkpoint. Ordinary unterminated tails use cloned parser/scope state until LF commits the actual completed line. Exhausting the classified-line window freezes its prefix-derived state for the rest of that line, emitting neutral remainder. This matters for smaller `line_bytes` and does not grant extra whole-source coverage.

`counters` has exactly four integer fields in `0..9007199254740991`:

| Counter | Meaning |
|---|---|
| `committed_line_calls` | Actual completed-line-prefix parser calls in this operation |
| `committed_line_bytes` | UTF-8 bytes passed to them |
| `tail_calls` | Actual provisional-tail-prefix parser calls in this operation |
| `tail_bytes` | UTF-8 bytes passed to them |

Counters are per operation, not stream totals, coverage or scheduler turns. Reparsed tails may include previously seen bytes. Frozen-prefix reuse, neutral skipping and empty finalization do not invent parser calls.

A parse result can advance retained semantics despite a palette change in flight, but does not prove palette readiness. STYLE never advances parser revision or proves SOURCE execution. Finite parser state is released; retained display semantics belong to the client.

## Context codec

A full context is an ordered list of positive portable scope IDs, preserving repeats and nesting. The dictionary rows are `[commonPrefixLength,...suffixScopeIDs]`, relative to the previous expanded row in this message. First prefix is0. `[0]` defines parsed-empty; `[previousDepth]` repeats a context without adding scopes. Repeated equivalent entries are legal and can share one client arena entry; they are not confused with context0. IDs must exist in the advertised trusted vocabulary.

Validate every row and the **sum** of expanded policy cost over the entire batch before allocating expanded typed word vectors. A row owns128 policy units, even if empty; each expanded scope word owns16 units, covering the word and canonical-key allowance. These are declared controlled-allocation policy units, not a V8/native allocator or RSS measurement. The approved policy additionally bounds the aggregate expanded scope-word count at65,536 and the complete decoded result charge at2MiB before materialization. These are whole-job limits, not a separately chosen context-count/depth ceiling; the actual frame and available byte budget can impose a smaller bound. Definitions precede references; prefixes cannot reference another message or a later row. The client does not interpret scope meaning during paint or reflow.

`vectors.json` uses a synthetic trusted vocabulary of20 entries to make boundaries independently checkable; actual shipped IDs are generated at build and tied to the advertised identity. `context-number-vectors.json` preserves literal JSON spellings to verify correctly rounded binary64 integer admission on both peers, rather than normalizing the native input through an approximate decoder before validation.

## Rule input and style resolution

`styles.resolve` is a DATA operation. Request fields are `instance`, `ticket`, admission/optional `queue_wait_ms`, `vocabulary`, `contexts`, and `rules`, whose value is the direct `RuleDefinition` object `{revision:2,binding_slots,default,rules}`. There is no native/client wrapper and SOURCE carries no selected palette, style rule or display identity.

Every rule has exactly `{path,excludes,context,foreground,background,font}`. `context` is required and nullable. `null` preserves unqualified selector matching. A non-null context is exactly `{owner,boundaries}`: owner and each of at most16 boundary names are ordinary trusted vocabulary prefixes; they must be distinct and prefix-disjoint. The positive path is nonempty and begins with `owner`. The resolver finds the deepest stack scope matching the owner or any boundary. Only a nearest owner enables the rule, and it anchors the first positive path element. Remaining path matching preserves existing selector semantics and absolute stack-depth scoring. Exclusions are evaluated against the entire original stack. An ineligible rule contributes nothing to any property/font winner: it does not inherit, clear, or restore an ancestor style.

For TypeScript object keys, the application uses suffix-independent `meta.object-literal.key` ownership for simple identifier, quoted and numeric keys. `meta.array.literal` and `meta.template.expression` are boundaries for computed-key contents, where ordinary rules apply; a nearer nested key may own its contents at any supported depth. Callable names and the colon retain their independent existing roles. These policies are ordinary caller rules checked against the trusted grammar vocabulary; Rust has no language, region or palette names built into the matcher.

Foreground/background and font overrides are explicitly nullable. Non-null font is exactly `{attributes,attribute_mask}`; an explicit zero mask/value differs from no declaration. Names are vocabulary lookup keys, not arbitrary selector expressions. The complete batch is validated and every scope name is resolved through the generated trusted table before constructing scopes/selectors; an unknown name rejects without interning.

Keep the established limits: at most512 rules/selector branches,4096 paths (including empty paths),256 KiB decoded selector-name bytes and4096 dot-separated atom occurrences. Each owner/boundary name counts as an additional single-name path toward the same path, atom and byte totals. Scope atoms retain Syntect's maximum8 components; each context has at most16 boundaries. Compiled qualifier storage is charged before allocation. Qualified rules cannot use the unqualified single-scope cache. For each foreground/background property and each font bit, the earliest declaration in the original global rule list wins an exact score tie, including between `context:null` and qualified rules; cache partition or traversal order is not a second precedence rule. V4 vectors define exact operation validation and canonical definition hashing.

### Client rule fingerprint

Resolver revision `3` uses global declaration order to break equal exact scores for foreground, background and each font bit, irrespective of null/qualified context or single/multi selector partition. Hash bytes use SHA-256, beginning with ASCII `occipital-client-rules/3` followed by NUL. Every integer/count is unsigned32 big-endian. Every text field is its UTF-8 byte length followed by those bytes; JSON object order and whitespace do not participate.

For each rule, canonical hashing includes path count/framed names, exclusion count and each ordered exclusion path, then a one-byte context discriminator (`0` for null, `1` for non-null). A non-null context contributes the framed owner and counted ordered boundary list. Existing override-presence and canonical expression framing follows. The expression key is `foregroundKey/backgroundKey/attributes/attribute_mask`; ink keys are RGB `rR,G,B`, indexed `iN`, terminal-default `d`, binding `bN` and caller-inherit `h`, with minimal unsigned decimal integers. Thus explicit inherit differs from no override, and explicit font clear differs from a null declaration.

Definition revision is2; `binding_slots` is `0..65536`. Numeric tokens use correctly rounded IEEE754 binary64 value semantics before finite/integer/bound checks, matching the Node JSON boundary. Equivalent integer exponents/decimals are legal; fractional near-integers are not rounded a second time into acceptance. Exact raw-token controls live in `rule-number-vectors.json`. Lexical/count preflight precedes hashing, and vocabulary membership precedes selector construction. The effective rules fingerprint identifies the complete generic definition, including qualifiers; source text, selected palette, Pi colors, process/lease and geometry never enter it.
## Indexed style result

STYLE returns exactly `{kind:"styles",vocabulary,rules,styles:[expression,...],indices:[one style ID per requested context]}`. There is no returned palette, native card-role table or color-provenance payload.

An expression is `{foreground:ink,background:ink,attributes,attribute_mask}`. Ink is exactly one of:

```text
{kind:"rgb",r:0..255,g:0..255,b:0..255}
{kind:"indexed",index:0..255}
{kind:"terminal-default"}
{kind:"binding",slot:0..binding_slots-1}
{kind:"inherit"}
```

Bindings are generic caller slots, materialized by the extension from its locally selected palette. The daemon does not know Pi role names, local palette IDs or card roles. Theme color and caller inherit are not synonymous with OSC terminal-default.

Attributes: bold1, italic2, underline4, faint8, strikethrough16. Both integers are0..31; attributes must be a subset of `attribute_mask`. Zero mask inherits corresponding caller attributes. Mask bits with zero value explicitly clear them; especially faint-clear must not disappear when bindings change. The common painter normalizes and closes spans with SGR `22;23;24;29`, emits strike with SGR9, and treats SGR22 as bold/faint-only. Public Pi sampling and flat ANSI conversion preserve SGR9/29, full SGR0 and selective resets.

Style IDs are one-based table positions. The table factors exact duplicate expressions, including both colors and the complete mask/value. Duplicate or unused table entries, index0, wrong cardinality or unknown IDs reject before adopted materialization. Syntax painting ignores per-token backgrounds: structural row/card surfaces keep ownership. The extension combines indexed token expressions with a locally materialized complete role table; if no compatible semantic group is ready, it still paints neutral content from that same selected palette. A prior complete paint may remain visible while a replacement is pending. An obsolete result may settle its reservation but cannot replace the current desired generation.

Follow Pi sets only strike (`16/16`) for trusted `markup.strikethrough` contexts. The pinned Markdown parser separately scopes opening/closing `~~` as `punctuation.definition.strikethrough.begin.markdown` / `.end.markdown`; the trusted prefix rule clears only strike (`0/16`) and excludes those markers from generic punctuation foreground override. Nested emphasis, links and code retain independent styles; no token-spelling inference is performed. Other grammars follow their actual emitted contexts.

## Normalization and accounting

- The daemon resolves generic ink expressions and caller binding references only. Palette data and complete card roles are validated, funded and materialized by the extension from locally owned JSON or public Pi inputs. Owned palette files accept opaque six-digit RGB only; output quantization precedes use. Owned diff surfaces use the shared local `diffPalette` against final emitted region inks and neutral code, while token backgrounds never replace structural row ownership.
- SOURCE decoded policy charge is aggregate context charge plus512units per source result,4units per flat run-array word (8per length/context-ID pair), and `32 + 2 × vocabulary.length` for the body. The complete charge must fit both2MiB and the caller's remaining allowance before materialization. These are policy units, not measured heap bytes.
- Context expansion uses128 units/row +16/expanded word. Style materialization uses256/expression +4/context index. Actual typed-vector bytes and canonical arena/reference charges remain visible in retention. These allowances are not hard private-heap ceilings.
- DATA requests/replies each cap actual serialized JSON bodies at512KiB. SOURCE input/whole-batch/cumulative-stream coverage caps at64KiB UTF8 and8,192logical lines; the UI explicitly selects a scalar-safe prefix and retains full display text independently. Expanded descriptions cap65,536scope words and decoded results2MiB under existing policy accounting. The existing source-free4KiBrequest/32KiBreply caps and outer emergency framing remain distinct. The1GiB controlled data/retention pools,256MiB native state pool,eight routes andtwo physical data jobs/route remain. Parse and generic style work share data-job/byte authority, including encoded buffers, expanded contexts and resolver workspace. No dedicated unbounded style lane, whole-pool reservation per small request or count-driven cache eviction.
- Validate raw bounded data before expansion; reserve controlled growth before allocating it. Native admission must use bounded typed/borrowed visitors rather than first building an unrestricted JSON Value tree. Failure before parsing says not_started; a source failure after actual mutation cannot pretend no parse occurred. A style failure never authorizes source replay, even if its own computation started.
- Hold physical credit through actual response settlement/drain or authoritative cleanup. Yield native context matching through existing scheduler quanta and route fairness; resolver-side caching is an optimization with byte-accounted lifetime, not a correctness dictionary. Matching-workspace accounting is additional to descriptor storage: the ancestor scoring stack owns per-depth state. Admission must also guard the pinned public Syntect scorer's `u16` depth-index arithmetic before invoking it on hostile contexts; derive that exceptional safety bound from `ATOM_LEN_BITS`, not a small example depth or palette count.
- Decoder/header allocations already performed by the shared SDK are outside this application heap claim. The approved bounded DATA envelopes are still decoded synchronously; there is no whole-process preparse/RSS guarantee for an arbitrary shared host. Keep admitted finite sources one-shot, without chunk feeding, a worker or another carrier. Coverage limits do not protect full-card display/layout or promise arbitrary-grammar execution time.

## Validation reference

In a repository checkout, `protocol/syntax-v4/` contains `vectors.json`, `context-number-vectors.json`, `rule-vectors.json`, `rule-number-vectors.json`, `highlighting-limits.json` and `source-hint-vectors.json`. These define cross-language envelope, context, qualified-rule, expression, fingerprint, numeric-boundary and SOURCE language-selection/shebang cases. They and the executable harness are checkout-only inputs, not files adjacent to this packaged reference. [Syntax and protocol validation](../testing.md#syntax-and-palette-validation) covers retained byte-credit ownership, actual SOURCE→STYLE round trips, known/new-context appends, controlled allocation overlap, two-peer isolation and metadata fairness. Those controls do not widen the protocol into private-heap/RSS, maximum-latency or dense full-card guarantees.
