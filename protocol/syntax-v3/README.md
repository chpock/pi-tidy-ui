# Occipital syntax-highlight/v3 — application contract

Status: native producer, stdio/shared adapters and UI consumers use v3; the v2 paths have been removed. E3's bounded schema/resource/current-consumer observations are complete and this is the accepted implementation contract. Logical accounting is not an allocator/RSS guarantee; dense 10 MiB full-card admission and public v3 delivery are not claimed. Final evidence review and the separate release/platform gates do not change the fields below. This is the contract for the operator-approved [unified-highlighting plan](../../docs/unified-highlighting-plan.md), not a compatibility shim for v2.

## Authority and transport

- Version `3`, capability `syntax-highlight/v3`, service `syntax`. Public stdio framing, shared-service correlation, route ownership and exact-byte bounded writers are unchanged. Reject v2; never reinterpret v2 packed colors as context IDs.
- Envelope: `{v:3,ticket,instance,assets,status:"ok",body}` or `{v:3,ticket,instance,assets,status:"error",error:{code,execution}}`. Strings/identifiers, generations, source revisions, lease authority and `not_started`/`started` semantics keep existing validated bounds.
- `assets` identifies pinned Syntect/two-face/newline grammar/parser/prefix policy. `vocabulary` is a separate SHA-256 fingerprint of the schema-framed sorted trusted scope/prefix table. Changing a grammar without changing its vocabulary is still an asset change. Scope interner handles never cross the wire.
- Schema revisions: contexts1, resolver2, palette1; the 64 KiB per-line parser window remains. The subsequently approved whole-source/job volume envelope is specified under [highlighting volume policy](../../docs/syntax-highlighting-spec.md#highlighting-volume-policy). Fingerprints are lowercase 64-character SHA-256 hex; definition/rule fingerprints do not include Pi binding colors or terminal width.
- `describe` returns bounded identities, catalogue metadata, revisions and limits. It does not return a whole vocabulary, card palette or style work in the wait-only control lane. Explicit `themes.refresh` preserves parser state.

The exact descriptor body is `{kind:"descriptor",protocol_version:3,contexts_revision:1,resolver_revision:2,palette_revision:1,vocabulary:{fingerprint,count},assets,backend_version,catalogue_revision,capability,service,operations,modes,admission,profiles,diagnostic,limits,runtime}`. `assets` agrees with the header, and the vocabulary count is positive. Profiles contain only native `{id,label,fingerprint}` definitions: the existing32bundled+16custom bound remains48 after removing the Pi parser profile; an empty native catalogue does not disable client rules. `pi` remains a local saved-choice value, not an advertised native definition. Modes/admission and established limit/runtime fields retain their v2 meanings; the current consumer additionally requires advertised DATA `reply_bytes` at most512KiB before data work, since post-SDK validation cannot undo shared JSON decoding. Resolver revision2 is required exactly before candidate admission and any STYLE dispatch; revision1 or other resolver revisions reject on both transports. Resolver revision governs the shared expression attribute vocabulary, including palette-referenced styles. Contexts, palette payload and client-definition structural revisions remain1. No new descriptor keys are introduced; `line_bytes` is still a classification window, not a line-length input rejection. Data request/reply and source coverage defaults follow the linked volume policy; `styles` is removed from descriptor limits because the old packed-color count is not a bound on full-context combinations. The byte-accounted expression payload replaces that count guard. Required operations include `styles.resolve`. Palette or syntax data in a metadata body reject; metadata reads stay wait-only.

## Theme-independent sources

`highlight` and `stream.open` keep `sources:[{key,generation,source_version,hint,text}]`; no profile/theme/fingerprint fields occur in a source. Finite sources remain one-shot. `stream.open` has exactly one source; finite batches have one to eight. Keys are unique across the complete batch regardless of generation: one current incarnation per source key; the request and response reject superseded generations bundled under the same key. `stream.append` keeps instance/key/lease/generation/source_version/base_revision/base_bytes/append/final, but removes theme/profile fields. `stream.close` remains an exact lease operation.

Source body: `{kind:"source",vocabulary,sources:[...]}`. The fingerprint must match the accepted descriptor independently of the full asset identity; it applies to every reply-local context dictionary in this body. Each result contains:

- key, generation, source_version, revision, source_bytes, replace_from, committed_bytes, complete, counters, optional lease with the existing finite/open/final acknowledgement rules;
- `contexts`: reply-local front-coded full ordered contexts;
- `runs`: flat positive UTF-8 byte-length/context-ID pairs covering exactly the replacement suffix. A range cannot split a scalar. Adjacent identical context IDs are merged. Context ID0 is neutral/unclassified; positive IDs are one-based context-row positions, including parsed-empty.

An actual parse result may advance retained semantics even if a theme changed while it was in flight. It never proves a palette is ready. Successful style work does not advance source revision or prove source execution. Completed finite parser state is released; retained display semantics belong to the client.

## Context codec

A full context is an ordered list of positive portable scope IDs, preserving repeats and nesting. The dictionary rows are `[commonPrefixLength,...suffixScopeIDs]`, relative to the previous expanded row in this message. First prefix is0. `[0]` defines parsed-empty; `[previousDepth]` repeats a context without adding scopes. Repeated equivalent entries are legal and can share one client arena entry; they are not confused with context0. IDs must exist in the advertised trusted vocabulary.

Validate every row and the **sum** of expanded policy cost over the entire batch before allocating expanded typed word vectors. A row owns128 policy units, even if empty; each expanded scope word owns16 units, covering the word and canonical-key allowance. These are declared controlled-allocation policy units, not a V8/native allocator or RSS measurement. The approved policy additionally bounds the aggregate expanded scope-word count at65,536 and the complete decoded result charge at2MiB before materialization. These are whole-job limits, not a separately chosen context-count/depth ceiling; the actual frame and available byte budget can impose a smaller bound. Definitions precede references; prefixes cannot reference another message or a later row. The client does not interpret scope meaning during paint or reflow.

`vectors.json` uses a synthetic trusted vocabulary of20 entries to make boundaries independently checkable; actual shipped IDs are generated at build and tied to the advertised identity. `context-number-vectors.json` preserves literal JSON spellings to verify correctly rounded binary64 integer admission on both peers, rather than normalizing the native input through an approximate decoder before validation.

## Rule input and style resolution

`styles.resolve` is a data operation. Request fields: instance, ticket, admission/optional queue_wait_ms, vocabulary, contexts, and exactly one rule input:

- native: `{kind:"native",id,fingerprint}` referencing the immutable advertised theme definition;
- client: `{kind:"client",definition:{revision:1,binding_slots,default,rules}}` containing bounded generic rules, not daemon-owned Pi role enums. The `definition` object is exactly the four-field canonical input; the wrapper selects the input source and never enters its fingerprint.

Each client rule has exactly `{path,excludes,foreground,background,font}`: an ordered `path` of **trusted scope names**, zero or more ordered exclusion paths, and nullable foreground/background/attribute overrides. Absence is explicit `null`, not an omitted key. A non-null font is exactly `{attributes,attribute_mask}`; an explicit zero mask/value remains distinct from a null declaration. Names are dictionary lookup keys, not arbitrary selector expressions: the server validates the complete batch and resolves every name via its generated table **before** constructing scopes/selectors. Unknown names reject without interning. This avoids downloading a large scope-name table or adding a vocabulary RPC merely to express the client's small static rules. After lookup, matching uses native Syntect selectors and the common property scorer. Native/custom theme admission retains its existing separate definition/atom protections.

The client definition uses at most512 rule/selector branches,4096 paths (one main path plus every exclusion path per rule, including empty paths),256 KiB decoded selector-name bytes and4096 dot-separated atom occurrences across all names. Scope atoms themselves retain Syntect's maximum8 components. These reuse the established admitted-theme envelope, not a source-size ceiling. Empty selector paths/exclusions preserve native semantics. Exact operation validation and canonical definition hashing must be covered by Rust/TS vectors before this candidate freezes.

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
- Context expansion uses128 units/row +16/expanded word. Style materialization uses256/expression +4/context index; native palette adds128 +5×26 units. Actual typed-vector bytes and canonical arena/reference charges remain visible in retention. These allowances are not hard private-heap ceilings.
- DATA requests/replies each cap actual serialized JSON bodies at512KiB. SOURCE input/whole-batch/cumulative-stream coverage caps at64KiB UTF8 and8,192logical lines; the UI explicitly selects a scalar-safe prefix and retains full display text independently. Expanded descriptions cap65,536scope words and decoded results2MiB under existing policy accounting. The existing source-free4KiBrequest/32KiBreply caps and outer emergency framing remain distinct. The1GiB controlled data/retention pools,256MiB native state pool,eight routes andtwo physical data jobs/route remain. Parse and style work share data-job/byte authority, including encoded buffers, expanded contexts, resolver workspace and palette/table results. No dedicated unbounded style lane, whole-pool reservation per small request or count-driven cache eviction.
- Validate raw bounded data before expansion; reserve controlled growth before allocating it. Native admission must use bounded typed/borrowed visitors rather than first building an unrestricted JSON Value tree. Failure before parsing says not_started; a source failure after actual mutation cannot pretend no parse occurred. A style failure never authorizes source replay, even if its own computation started.
- Hold physical credit through actual response settlement/drain or authoritative cleanup. Yield native context matching through existing scheduler quanta and route fairness; palette caching is an optimization with byte-accounted lifetime, not a correctness dictionary. Matching-workspace accounting is additional to descriptor storage: the ancestor scoring stack owns per-depth state. Admission must also guard the pinned public Syntect scorer's `u16` depth-index arithmetic before invoking it on hostile contexts; derive that exceptional safety bound from `ATOM_LEN_BITS`, not a small example depth or palette count.
- Decoder/header allocations already performed by the shared SDK are outside this application heap claim. The approved bounded DATA envelopes are still decoded synchronously; there is no whole-process preparse/RSS guarantee for an arbitrary shared host. Keep admitted finite sources one-shot, without chunk feeding, a worker or another carrier. Coverage limits do not protect full-card display/layout or promise arbitrary-grammar execution time.

## Retained regression and acceptance controls

The accepted integration includes cross-language vectors for envelope/source/rules/style/palette, exact rule/palette fingerprints, raw pre-expansion admission, byte-credit ownership and real two-peer/metadata fairness controls. Current-consumer evidence covers the extra SOURCE→STYLE round trip, known/new-context appends, controlled allocation peaks/overlap, bounded semantic-density admission and two-client distinct-Pi-binding isolation. Retain these controls when changing the implementation. The measurements are bounded observations, not arbitrary dense 10 MiB full-card admission, private-heap/RSS or maximum-latency guarantees; historical prototype timings are not current-consumer acceptance. The old v2 implementation is removed; migrated tests preserve the corresponding behavioral goals rather than an alternate renderer.
