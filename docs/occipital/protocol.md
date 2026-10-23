# Occipital syntax-highlight/v3 — application contract

This reference describes the current v3 native producer, stdio/shared adapters and TypeScript consumers. The [syntax specification](../syntax-highlighting-spec.md) defines product behavior; [client volume policy](../syntax/work.md#highlighting-volume-policy) defines useful classification-prefix selection, while this reference owns exact advertised limits and message-size admission. Reject v2 rather than interpreting packed colors as context IDs. Current source compatibility does not establish public v3 delivery or release/platform acceptance; published Occipital 0.1.5 remains incompatible v2.

Controlled-allocation accounting is not an allocator/private-heap/RSS guarantee. Neither this protocol nor its bounded cooperative scheduler guarantees arbitrary-language latency or dense 10 MiB full-card admission.

## Authority and transport

### Version, identities and carriers

Application version is `3`, capability `syntax-highlight/v3`, service `syntax`. Required interpretation revisions are contexts `1`, resolver `2` and palette `1`; client-definition structural revision remains `1`. The consumer requires these descriptor revisions exactly before admitting SOURCE/STYLE work. Resolver revision governs the shared expression/font vocabulary, including palette-referenced styles.

Owned stdio carries nonempty UTF-8 JSON preceded by its four-byte unsigned big-endian byte length, excluding those four bytes. Shared mode carries the application JSON through the public Subconscious internal-service route and SDK correlation, without an embedded stdio length prefix. The consumer preserves the complete SDK route handle, including its epoch.

Application `ticket` correlation is required on both carriers. Callers must not reuse tickets within a provider/helper incarnation; adapters detect active duplicates, not a permanent history of retired tickets. Source keys and leases do not replace tickets. Route ownership is transport-established, not a caller-supplied SOURCE field.

`instance` identifies the native incarnation; `assets` identifies the pinned grammar/parser asset revision. Vocabulary fingerprint is a separate identity for portable scope IDs, not a Syntect interner handle. Its hash includes the vocabulary schema, asset fingerprint and sorted trusted scope/prefix table. An asset revision therefore changes vocabulary identity even if the names stay identical. Scope interner handles never cross the wire. Definition/rule identities do not depend on Pi colors or terminal width.

### Common values and request fields

Bounds are inclusive. A bounded identifier/text value is a nonempty string within its UTF-8 byte cap, without Unicode control characters or unpaired surrogates. These restrictions apply to identifiers, names and hints, not source `text`/`append`, which may contain newlines and other valid Unicode characters.

| Value | Bound or required value |
|---|---|
| `v` | `3` |
| `op` | One of the operations below |
| `ticket`, `instance`, source `key`, `lease`, native profile `id`, error `code` | At most 64 UTF-8 bytes |
| `assets` | Producer emits lowercase 64-character SHA-256; consumer header validation accepts bounded text up to 256 bytes and checks identity equality, not hexadecimal syntax |
| Vocabulary, native definition, effective rule and palette fingerprints | Exactly 64 lowercase ASCII hexadecimal characters |
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
| `themes.refresh` | Optional `instance` |
| `highlight` | Required `instance`, `admission`, `sources`; conditional `queue_wait_ms` |
| `stream.open` | Required `instance`, `admission`, `sources`; conditional `queue_wait_ms` |
| `stream.append` | Required `instance`, `admission`, `key`, `lease`, `generation`, `source_version`, `base_revision`, `base_bytes`, `append`, `final`; conditional `queue_wait_ms` |
| `stream.close` | Required `instance`, `key`, `lease`, `generation` |
| `styles.resolve` | Required `instance`, `admission`, `vocabulary`, `contexts`, `rules`; conditional `queue_wait_ms` |

Native operation admission rejects fields not listed for that operation. CONTROL validates an optional `instance` as bounded text but does **not** compare it with the current instance. DATA requires the current instance: a SOURCE mismatch returns `restart_required`, while a STYLE mismatch returns `invalid_request`; both are no-start failures.

`styles.resolve` uses the [context codec](#context-codec), [rule input](#rule-input-and-style-resolution) and [indexed style/palette payload](#one-indexed-style-and-card-palette-payload) below. SOURCE contains no theme, profile, palette or rule identity.

### Admission and scheduling

`describe` and `themes.refresh` use the separate source-free CONTROL lane. `highlight`, all three `stream.*` operations and `styles.resolve` use DATA authority. In particular, `stream.close` is not metadata merely because it contains no source text.

For DATA operations other than close:

- `admission:"try_now"` requires absent `queue_wait_ms`. The scheduler refuses with `busy` if its worker already has scheduled turns or the requested lease is held by an unacknowledged delivery. Physical job/byte capacity can also refuse admission. This does not promise synchronous completion.
- `admission:"bounded_queue"` requires integer `queue_wait_ms` in `1..1000`, respecting any smaller advertised maximum. Physical credit is reserved before queueing; this mode does not bypass capacity.
- The queue deadline starts at submission and applies while awaiting preparation. Expiry produces `queue_expired` with `not_started`; it is not an execution deadline once preparation begins.

Close accepts neither `admission` nor `queue_wait_ms`. It still requires DATA credit and a scheduler turn, and can be refused for capacity or route loss. Each worker rotates eligible routes, preserving operation order within a route. SOURCE and STYLE share physical job/byte authority. Lease-owning delivery can block the next operation on that lease until acknowledgment or cleanup.

`quantum_ms` is cooperative: SOURCE checks line/byte/time boundaries between parser calls, never interrupting a running regex. Lease idle/age expiry is also distinct from a request deadline. Local transport deadlines and metadata wait-only behavior are adapter options, not JSON fields.

### Replies, correlation and execution disposition

The complete application envelopes are:

```text
{v:3,ticket,instance,assets,status:"ok",body}
{v:3,ticket,instance,assets,status:"error",error:{code,execution}}
```

No `op`/`service` is added to replies. Semantic decoding requires exactly the corresponding envelope fields and exactly `code`/`execution` in errors. Expected ticket and accepted-provider instance/assets are checked before accepting outcomes or materializing semantics.

`execution` is `not_started` or `started`; error code is bounded text, not a closed consumer enumeration:

- `not_started` describes only the correlated attempt, not earlier work/uncertainty for that source.
- `started` is conservative execution evidence, not proof of a particular parser call or usable commit. Empty-input completion and failures after computation/during reply encoding can be started. A batch failure is started if any member started.
- STYLE disposition describes only STYLE: it cannot prove SOURCE execution, advance parser revision, close a source lease or authorize SOURCE replay.

Malformed, uncorrelated and changed-provider replies are not validated no-start faults. Local post-dispatch timeout, abort and transport failure keep execution unknown without appropriate independent authority. Error text, absent providers and vanished JavaScript waiters do not prove replay permission.

The TypeScript boundary distinguishes validated `RemoteFault` (`execution: "not_started" | "started"`) from local `RequestFailure` (`execution: "not_started" | "unknown"`). `ProtocolError` and `SemanticError` are validation failures, not remote no-start evidence. Separately, transport lifetime records `lost`, `closed`, `uncertain` or `denied`: the first origin wins, and cleanup cannot promote uncertainty to confirmed loss. These categories do not prove parsing never started or has stopped. A pending-request shared `SubcError` with `closeReason:"connection_lost"` remains uncertain because the SDK can use that value for EOF **or** its local read timeout. See [execution authority and recovery](../syntax/providers.md#execution-authority-and-conservative-recovery).

A bounded routing probe can recover a valid ticket before full operation admission to return a correlated error; this is not successful operation validation. Without recoverable correlation, stdio terminates the invalid exchange; shared mode can return an SDK handler error instead of a fabricated application envelope.

Stdio cancellation uses a transport-only frame exactly `{v:3,cancel:ticket}`, bounded to 4 KiB. It has no separate acknowledgment and is not an application operation. Its version is decoded directly as Rust `u32`, unlike ordinary requests' binary64 numeric helper. Shared cancellation uses the SDK. Cancellation is best effort, not physical release or no-start evidence.

### Descriptor and metadata operations

Both metadata operations return exactly:

```text
{
  kind:"descriptor",protocol_version:3,
  contexts_revision:1,resolver_revision:2,palette_revision:1,
  vocabulary:{fingerprint,count},assets,backend_version,catalogue_revision,
  capability:"syntax-highlight/v3",service:"syntax",
  operations,modes,admission,profiles,diagnostic,limits,runtime
}
```

Metadata contains no source payload, whole vocabulary, style table or card palette.

| Field | Consumer validation and meaning |
|---|---|
| `assets` | Equals envelope `assets` |
| `vocabulary` | Exactly `{fingerprint,count}`; valid fingerprint, integer count `1..4294967295` |
| `backend_version` | Nonempty bounded text, at most 128 UTF-8 bytes; no semantic-version parser requirement |
| `catalogue_revision` | Integer `0..9007199254740991`; publication identity, not parser revision |
| `operations` | Unique bounded strings, at most 16; must include all seven operations above |
| `modes` | Unique bounded strings, at most 4; must include `one_shot`, `growing` |
| `admission` | Unique bounded strings, at most 4; must include `try_now`, `bounded_queue` |
| `profiles` | At most 48; each exactly `{id,label,fingerprint}`, with unique bounded ID other than `pi`, label at most 128 UTF-8 bytes, valid fingerprint |
| `diagnostic` | `null` or nonempty bounded text, at most 256 UTF-8 bytes |

The current catalogue comprises 32 bundled definitions and at most 16 installed custom definitions. The 48-entry descriptor limit does not increase the separate custom-theme quota.

Advertised-list strings use the 64-byte cap. The producer emits these operations, two modes and two admission methods. The consumer accepts extra unique entries within caps: required-subset checks do not require order or exact list equality. An extra advertised operation does not extend the current adapters' fixed operation set.

`one_shot` identifies finite highlight and `growing` open/append/finalize. SOURCE has no separate `mode` field. `pi` is a local saved choice, not an advertised native definition. Empty native catalogues do not prohibit client-rule STYLE.

Describe reads published metadata without parsing/style work. Refresh explicitly reloads the catalogue, preserving parser state and unchanged catalogue revision. Refresh failure can return the last-valid descriptor with a non-null diagnostic rather than an error envelope.

Published-provider rereads additionally require unchanged instance, assets, vocabulary identity/count, nondecreasing catalogue revision, and unchanged profile ID/fingerprint membership if that revision is unchanged. They use local wait-only handling: waiter expiry does not complete/release the physical control request. Initial candidate negotiation is a separate acquisition path.

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
- Semantic decoders reject extra keys in envelopes/errors, descriptors and structured members, SOURCE/results/counters/close acknowledgments, and STYLE/expression/palette objects.
- Descriptor-list extensibility is distinct from object-key extensibility. Post-`JSON.parse` exact-key validation also does not prove raw-wire duplicate-member rejection.

Native DATA preflight rejects structural JSON nesting beyond depth 64. That is a request guard, not a scope-context depth policy.

## Theme-independent sources

### Source input and syntax hints

Highlight/open contain `sources:[{key,generation,source_version,hint,text},...]`, with exactly those five fields per source. `text` is valid Unicode and may be empty. The daemon does not reread files or silently truncate it; callers supply intended normalized text or an explicitly selected prefix.

`hint` contains only optional `language` and `path`, each omitted, `null`, or nonempty bounded text. Language is at most 128 decoded UTF-8 bytes; path at most 4,096.

1. With a **non-null language**, normalize recognized aliases case-insensitively, try the resulting syntax name, then the original language as extension. Failure does **not** fall through to path. Omitted or null language selects the path branch instead.
2. Otherwise take the basename after either slash convention, try that whole basename as extension token, then its suffix after the last dot.
3. Missing/unrecognized syntax returns `unknown_syntax` with `not_started`, without content sniffing or implicit Plain Text fallback.

Aliases are `typescript`/`ts`, `javascript`/`js`, `bash`/`sh`/`shell`, `makefile`/`make`, `python`/`py`, `rust`/`rs`, `json`, `plaintext`/`text`/`txt`. Explicit Plain Text works. Alias case normalization does not promise case-insensitivity for every arbitrary syntax name/extension.

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

A parse result can advance retained semantics despite a theme change in flight, but does not prove palette readiness. STYLE never advances parser revision or proves SOURCE execution. Finite parser state is released; retained display semantics belong to the client.

## Context codec

A full context is an ordered list of positive portable scope IDs, preserving repeats and nesting. The dictionary rows are `[commonPrefixLength,...suffixScopeIDs]`, relative to the previous expanded row in this message. First prefix is0. `[0]` defines parsed-empty; `[previousDepth]` repeats a context without adding scopes. Repeated equivalent entries are legal and can share one client arena entry; they are not confused with context0. IDs must exist in the advertised trusted vocabulary.

Validate every row and the **sum** of expanded policy cost over the entire batch before allocating expanded typed word vectors. A row owns128 policy units, even if empty; each expanded scope word owns16 units, covering the word and canonical-key allowance. These are declared controlled-allocation policy units, not a V8/native allocator or RSS measurement. The approved policy additionally bounds the aggregate expanded scope-word count at65,536 and the complete decoded result charge at2MiB before materialization. These are whole-job limits, not a separately chosen context-count/depth ceiling; the actual frame and available byte budget can impose a smaller bound. Definitions precede references; prefixes cannot reference another message or a later row. The client does not interpret scope meaning during paint or reflow.

`vectors.json` uses a synthetic trusted vocabulary of20 entries to make boundaries independently checkable; actual shipped IDs are generated at build and tied to the advertised identity. `context-number-vectors.json` preserves literal JSON spellings to verify correctly rounded binary64 integer admission on both peers, rather than normalizing the native input through an approximate decoder before validation.

## Rule input and style resolution

`styles.resolve` is a data operation. Request fields: instance, ticket, admission/optional queue_wait_ms, vocabulary, contexts, and exactly one rule input:

- native: `{kind:"native",id,fingerprint}` referencing the immutable advertised theme definition;
- client: `{kind:"client",definition:{revision:1,binding_slots,default,rules}}` containing bounded generic rules, not daemon-owned Pi role enums. The `definition` object is exactly the four-field canonical input; the wrapper selects the input source and never enters its fingerprint.

Each client rule has exactly `{path,excludes,foreground,background,font}`: an ordered `path` of **trusted scope names**, zero or more ordered exclusion paths, and nullable foreground/background/attribute overrides. Absence is explicit `null`, not an omitted key. A non-null font is exactly `{attributes,attribute_mask}`; an explicit zero mask/value remains distinct from a null declaration. Names are dictionary lookup keys, not arbitrary selector expressions: the server validates the complete batch and resolves every name via its generated table **before** constructing scopes/selectors. Unknown names reject without interning. This avoids downloading a large scope-name table or adding a vocabulary RPC merely to express the client's small static rules. After lookup, matching uses native Syntect selectors and the common property scorer. Native/custom theme admission retains its existing separate definition/atom protections.

The client definition uses at most512 rule/selector branches,4096 paths (one main path plus every exclusion path per rule, including empty paths),256 KiB decoded selector-name bytes and4096 dot-separated atom occurrences across all names. Scope atoms themselves retain Syntect's maximum8 components. These reuse the established admitted-theme envelope, not a source-size ceiling. Empty selector paths/exclusions preserve native semantics. Rust/TypeScript vectors define exact operation validation and canonical definition hashing alongside the field rules below.

### Client rule fingerprint

Hash bytes use SHA-256, beginning with ASCII `occipital-client-rules/2` followed by NUL. Every integer/count below is unsigned32 big-endian. Every text field is its UTF-8 byte length followed by those bytes; JSON object order and whitespace do not participate.

1. binding_slots; canonical default expression key; number of rules.
2. For each rule in order: path count and framed names; exclusion count and each exclusion path in order; one presence byte (foreground1,background2,font4, set for non-null declarations); canonical expression key with absent overrides represented as inherit/inherit/0/0.
3. An expression key is `foregroundKey/backgroundKey/attributes/attribute_mask`. Ink keys: RGB `rR,G,B`, indexed `iN`, terminal-default `d`, binding `bN`, caller-inherit `h`; all integers are minimal unsigned decimal. Thus real explicit inherit and no override differ through the presence byte, and explicit font clear cannot collapse into mask0/null.

Client definition revision is1; binding_slots is0..65536. Numeric tokens use correctly rounded IEEE754 binary64 value semantics before finite/integer/bound checks, matching the Node JSON boundary; equivalent integer exponents/decimals are legal, fractional near-integers may not be rounded a second time into acceptance. Exact raw-token controls live in `rule-number-vectors.json`. Lexical/count preflight precedes hashing and native membership lookup precedes constructing selectors. Scope names may be encoded differently in JSON but resolve to the same validated UTF-8 key. A native definition's advertised immutable fingerprint remains a separate reference input. Effective native rules fingerprint is SHA-256 of ASCII `occipital-native-rules/2` + NUL + the64lowercase-ASCII-hex definition fingerprint; native palette fingerprint uses `occipital-native-palette/2` with the same framing. These interpretation revisions change when their respective semantics change; source, Pi colors, native process/lease and geometry never enter either hash.

Both rule inputs compile to one resolver with native strict-greater scoring, stable tie order, inheritance, explicit font replacement and ordered scope semantics. A parsed-empty context uses the iterator base, not global selector evaluation. New uncached rules may require style work; local Pi binding-color changes do not.

## One indexed style and card-palette payload

Style body:

```text
{kind:"styles", vocabulary, rules, styles:[expression,...],
 indices:[one style ID per requested context], palette:null|nativePalette}
```

An expression is `{foreground:ink,background:ink,attributes,attribute_mask}`. Ink is exactly one of:

```text
{kind:"rgb",r:0..255,g:0..255,b:0..255}
{kind:"indexed",index:0..255}
{kind:"terminal-default"}
{kind:"binding",slot:0..binding_slots-1}
{kind:"inherit"}
```

Native results contain only the first three forms, including all service regions; no Pi binding or caller-inherit can leak into native cards. Client rules can produce any form. Slot IDs are generic unsigned16-bit bindings supplied/materialized through Pi's public API, not a daemon enum of theme roles. Theme color and caller inherit are not synonymous with OSC terminal-default.

Attributes: bold1, italic2, underline4, faint8, strikethrough16. Both integers are0..31; attributes must be a subset of attribute_mask. Zero mask inherits corresponding binding/caller attributes. Mask bits with zero value explicitly clear them; especially faint-clear must not disappear when bindings change. Every native expression uses mask31, preserving its native bits while clearing unrelated inherited attributes, including faint and unsupported native strike. Native expressions cannot enable strike; Syntect's original enabled font bits and authored colors are unchanged. The common painter normalizes and closes spans with SGR `22;23;24;29`, emits strike with SGR9, and treats SGR22 as bold/faint-only. Public Pi prefix sampling and flat ANSI conversion preserve SGR9/29, full SGR0 and selective resets.

Style IDs are one-based table positions. The table factors exact duplicate expressions, including both colors and the complete mask/value. Duplicate or unused table entries, index0, wrong cardinality or unknown IDs reject before adopted materialization. A native palette shares this very same table rather than adding a second service-color representation. Syntax painting ignores per-token backgrounds: structural row/card surfaces keep ownership.

Native palette: `{revision:1,fingerprint,slots:[26 style IDs],origins:[26 origin bytes]}`. Slot order is fixed:

```text
panel plain code output empty padding service muted footer reminder
 overflow diagnostic title prompt frame error errorFrame warning gutter numbers
 addedCode addedGutter addedSign removedCode removedGutter removedSign
```

Every palette style has explicit native colors and mask31. Each origin byte has foreground origin in bits0–1, background origin in bits2–3 and font origin in bit4:0 means theme/default,1 derived,2 terminal-dependent for colors only. Value3 or reserved high bits reject. Palette fingerprint identifies the exact immutable native definition plus palette schema/derivation revision, not source text, contexts, Pi colors or geometry. Native resolution with zero contexts still returns the complete palette; unknown/empty sources need no parser to get it. Client-rule results have palette:null because the same final card-role adapter is materialized locally from Pi, including when the daemon is absent.

Retained syntax and all service colors become visible together per card. An old complete presentation can remain displayed while a replacement is pending. An obsolete result may settle its reservation but cannot replace the current desired generation.

Follow Pi sets only strike (`16/16`) for trusted `markup.strikethrough` contexts. The pinned Markdown parser separately scopes opening/closing `~~` as `punctuation.definition.strikethrough.begin.markdown` / `.end.markdown`; the trusted prefix rule clears only strike (`0/16`) and excludes those markers from generic punctuation foreground override. Nested emphasis, links and code retain independent styles; no token-spelling inference is performed. Other grammars follow their actual emitted contexts.

## Normalization and accounting

- Native color normalization preserves existing terminal semantics: alpha0 means indexed red-channel value, alpha1 terminal-default, alpha2..255 opaque RGB. Missing base uses documented native `Highlighter.get_default`; never substitute Pi or guess terminal RGB. Contrast of symbolic/indexed values remains explicitly terminal-dependent.
- Card-palette derivation runs in Rust from native settings/hints and actual native ink constraints. Token backgrounds are inputs/hints only, not an escape from diff-row ownership. Follow Pi's bounded local role adapter is not a second scope matcher.
- SOURCE decoded policy charge is aggregate context charge plus512units per source result,4units per flat run-array word (8per length/context-ID pair), and `32 + 2 × vocabulary.length` for the body. The complete charge must fit both2MiB and the caller's remaining allowance before materialization. These are policy units, not measured heap bytes.
- Context expansion uses128 units/row +16/expanded word. Style materialization uses256/expression +4/context index; native palette adds128 +5×26 units. Actual typed-vector bytes and canonical arena/reference charges remain visible in retention. These allowances are not hard private-heap ceilings.
- DATA requests/replies each cap actual serialized JSON bodies at512KiB. SOURCE input/whole-batch/cumulative-stream coverage caps at64KiB UTF8 and8,192logical lines; the UI explicitly selects a scalar-safe prefix and retains full display text independently. Expanded descriptions cap65,536scope words and decoded results2MiB under existing policy accounting. The existing source-free4KiBrequest/32KiBreply caps and outer emergency framing remain distinct. The1GiB controlled data/retention pools,256MiB native state pool,eight routes andtwo physical data jobs/route remain. Parse and style work share data-job/byte authority, including encoded buffers, expanded contexts, resolver workspace and palette/table results. No dedicated unbounded style lane, whole-pool reservation per small request or count-driven cache eviction.
- Validate raw bounded data before expansion; reserve controlled growth before allocating it. Native admission must use bounded typed/borrowed visitors rather than first building an unrestricted JSON Value tree. Failure before parsing says not_started; a source failure after actual mutation cannot pretend no parse occurred. A style failure never authorizes source replay, even if its own computation started.
- Hold physical credit through actual response settlement/drain or authoritative cleanup. Yield native context matching through existing scheduler quanta and route fairness; palette caching is an optimization with byte-accounted lifetime, not a correctness dictionary. Matching-workspace accounting is additional to descriptor storage: the ancestor scoring stack owns per-depth state. Admission must also guard the pinned public Syntect scorer's `u16` depth-index arithmetic before invoking it on hostile contexts; derive that exceptional safety bound from `ATOM_LEN_BITS`, not a small example depth or palette count.
- Decoder/header allocations already performed by the shared SDK are outside this application heap claim. The approved bounded DATA envelopes are still decoded synchronously; there is no whole-process preparse/RSS guarantee for an arbitrary shared host. Keep admitted finite sources one-shot, without chunk feeding, a worker or another carrier. Coverage limits do not protect full-card display/layout or promise arbitrary-grammar execution time.

## Validation reference

In a repository checkout, `protocol/syntax-v3/` contains `vectors.json`, `context-number-vectors.json`, `rule-vectors.json`, `rule-number-vectors.json` and `highlighting-limits.json`. These define cross-language envelope, context, rule, expression, palette, fingerprint and numeric-boundary cases. They and the executable harness are checkout-only inputs, not files adjacent to this packaged reference. [Syntax and protocol validation](../testing.md#syntax-and-palette-validation) covers retained byte-credit ownership, actual SOURCE→STYLE round trips, known/new-context appends, controlled allocation overlap, two-peer isolation and metadata fairness. Those controls do not widen the protocol into private-heap/RSS, maximum-latency or dense full-card guarantees.
