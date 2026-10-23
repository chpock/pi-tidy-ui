# Syntax storage, identities and lifetimes

The client separates logical source ownership from actual storage holders. This chapter explains numeric admission, retained data and release; [work](work.md) owns execution/fallback authority and [requests](requests.md) owns outstanding physical operations. Transcript rows use a [different retention policy](../render-cache-spec.md).

## Follow the storage holder, not just the source record

`SemanticRetentionPool` in `src/occipital/semantic-retention.ts` owns source entries and the context arena. `SourceController` owns the pool and exposes geometry funding to card preparation. This lets semantic data, Pi projections, measurements and compiled presentation participate in the same local logical-data authority without making the budget retain UI objects.

The allocation path is concrete:

```text
operation needing storage
    → root pressure decision, with protected generations
    → DataBudget.reserve(additional peak)
    → DataGrant
    → consume storage charge(s)
    → storage holder(s)
    → last holder releases each DataCharge
```

The peak is **additional** storage while old data may still exist. Replacing a source snapshot, growing a numeric vector or building a new palette must fund the overlap, not assume that the old allocation can be freed first.

`DataBudget` in `src/occipital/data-budget.ts` stores numbers only. `DataGrant.close` returns unused reservation; consumed storage remains charged. `DataCharge.retain` gives another holder a share of the same charge, and only the final release returns its retained credit. Closing the budget prevents new admission but does not pretend that existing holders vanished.

Not all resource counters are this budget. Controller bookkeeping and physical request/frame/workspace reservations have their own bounded authorities. Native service credits and transcript-row retention are different again. A low source-entry count is not proof that all of those liabilities are gone.

## Latest text, acknowledged basis and displayed text

A source entry can hold three snapshots:

- **Basis:** initially the admitted source seed, then the text associated with adopted semantic acknowledgement.
- **Latest:** newer observed text not yet replaced by an adopted basis.
- **Displayed:** the text belonging to the current ready presentation.

`AccountedSnapshot` in `src/occipital/semantic-capture.ts` separates snapshot metadata from the text charge. Equal text can share the underlying charge while preserving distinct version records.

`replaceSnapshot` admits a newer latest version without discarding the acknowledged basis. `installChunk` validates the captured request text against the entry and installs the corresponding semantic result. This matters when an intermediate request completes after the latest text has advanced again: its result belongs to its captured version, not automatically to latest.

Ready publication owns its own snapshot reference. Parser progress can therefore replace the basis without silently changing the text against which existing paint was prepared. Keeping that display is not a claim that current demand has been parsed.

The same principle applies to Pi fallback. Its flat payload belongs to a source snapshot and projection revision. Retention adopts an already-staged payload; it does not keep the original classifier ANSI as an additional cache.

## Committed blocks and the provisional tail

`SemanticRanges` in `src/occipital/semantic-ranges.ts` stores committed range blocks plus one current provisional tail. A validated append adds newly committed blocks and replaces the tail. It does not copy the accumulated committed prefix into a new flat vector on every update.

Each block owns its numeric ranges and a lease on the context descriptors it uses. The current-context index counts dictionary use incrementally. New committed/tail uses are added before old-tail uses are removed, so a context moving from provisional to committed data keeps its index presence.

A captured `RangeView` records the semantic revision, source version, committed extent and tail appropriate to that view. It shares the relevant prefix store and retains the needed old tail. The active source can advance while a ready display or STYLE job still holds that older view.

Consequently, the physical union can include current blocks, an older displayed tail and another tail held by a suspended reader. Source-progress statistics alone do not describe that union. Entry attribution accounts for owned views; actual charge release still follows every holder.

Disposal invalidates the current range authority immediately. It removes the current-context index and releases active ownership, but blocks or tails still needed by captured views/readers remain charged until those holders finish.

## Context descriptors and expressions have different keys

`ContextArena` in `src/occipital/context-arena.ts` interns validated ordered scope sequences under an explicit vocabulary fingerprint. A reply-local dictionary index is first translated into an arena handle. The handle is an opaque incarnation with its own lifetime; it is not a scope ID that another provider may interpret.

A **descriptor lease** owns references to those handles. Range blocks, captured views and explicit pins keep descriptor storage alive through such ownership. Cold request encoding verifies every handle against the job’s vocabulary before generating front-coded rows. Drawing and reflow do not read scope words.

An expression is stored under a live context and immutable rule fingerprint. It can contain symbolic binding references; it is not necessarily a ready terminal color. Pi colors, terminal mode and source width are absent from that expression key. A conflicting expression for the same context/rules is rejected rather than replacing an allegedly immutable interpretation.

Expressions can be cleared under pressure while descriptors remain leased. Actual clearing advances the arena’s style-invalidation revision so controller coverage witnesses cannot rely on lost data. When the final descriptor user leaves, that context’s remaining expressions and charges leave with it.

`ready-presentation.ts` owns a different representation: complete concrete roles and context styles copied into funded presentation storage. A synchronous borrowed expression does not itself lease the arena. A caller retaining materialized output must own and fund that output separately.

## Capturing a STYLE job and pinning a ready group

`captureDisplays` creates an asynchronous job’s stable semantic input. A numeric generation selects current semantic data; a display-qualified selection chooses the exact retained presentation view needed for historical recoloring. Captures include snapshot, range view, context handles and primitive identity.

The captured payload keeps its existing charges. The job funds additional capture/group/reference metadata rather than charging an imaginary second whole root. Validation is repeated after pressure/funding because nested acquisition can change what remains owned.

For a multi-segment card, captured membership is one group, and members must be complete and vocabulary-compatible. Growing Bash uses its single source slot. The capture’s private group identity prevents unrelated otherwise-similar captures from being assembled into one replacement.

Ready controller groups also pin their selection data. A Follow Pi group retains its funded selection; a native group retains the appropriate cached palette entry. Dropping a cache’s ordinary reference therefore cannot free data still owned by a ready group. This is storage pinning, not a guarantee that the group remains current.

## Pressure receipts connect data loss to work ownership

The retention root’s existing entry order is least-recently-touched first. Under pressure it skips explicitly protected generations and temporary funding pins, releases eligible entries and then checks whether enough actual credit became available.

Release returns a **receipt** naming the key, retention generation, reason, attributed storage and actual retained-credit reduction. Those last two amounts can differ: a capture may keep the snapshot and range view alive after their entry is removed.

The controller processes every receipt, including receipts produced by an admission that ultimately fails. For native entries it retires the matching lease/work association, drops affected group publication and records the resulting blocked/absent-data state. For Pi entries it invalidates the matching projection generation. It must not act on a replacement entry merely because its logical key is the same.

This coupling prevents storage pressure from becoming invisible execution-state loss. Eviction is not no-start proof and does not grant unlimited reclassification. Explicit retry, current observation and unresolved native authority still apply.

Geometry funding protects the requesting group’s current and retained source generations while choosing other victims. Where pressure arises during presentation work, retirement effects can be deferred to the controller’s scheduled continuation; freeing storage is not an excuse to perform transport cancellation inside rendering.

## Synchronous visits are transactions, not retained accessors

A visitor lends data for one synchronous callback. Its final boolean reports whether the whole operation remained valid. A callback may trigger replacement or removal; values delivered before that event are provisional.

Readers use weak owners plus primitive identity checks, and temporary holders retain charges while callback frames are suspended. Removal invalidates authority immediately, but the suspended frame’s arrays are not refunded until it exits. Escaped card accessors are cleared on unwind rather than keeping a source root or old palette reachable.

The consumer must stage output and publish only after the outer visit succeeds. A few successful inner callbacks are insufficient. On failure it releases the candidate layout/paint, leaving the existing accepted presentation intact.

For example, removing a card unregisters its group and releases its descriptor, measurement and paint receipts. Root entries can then disappear, while a dispatched request still owns its physical reservation and a currently executing visitor still owns temporary holds. Their later settlement or callback exit completes release. None can restore the removed card’s publication authority.

## Context and style lifetime

A context's identity is its vocabulary plus the **complete ordered scope sequence**, including repetition. Arena handles are opaque, non-reused incarnations, not reply-local dictionary indices or provider-global integers. Leases pin validated descriptors independently of UI/provider lifetime. Such a pin grants neither permission to parse nor permission to serialize the handle under another vocabulary; cold STYLE jobs capture and validate their exact vocabulary before encoding.

Current-source demand is indexed incrementally from newly committed block dictionaries and the replaced provisional tail. Moving a context from tail into committed data adds its new use before removing the old one; enumeration does not rescan committed ranges or accumulated prefix dictionaries. Historical recoloring instead enumerates the retained display's own context set. A visitor's result is provisional until the final validity check, so callbacks that retire or change ownership cannot publish a partial stale view.

Styles are shared by live context and immutable rules identity, not Pi colors, source text or geometry. Conflicting values for that same identity are rejected rather than overwritten. Actual expression loss advances a style-invalidation revision, requiring positive coverage witnesses to be checked again; a metadata visit alone is not eviction. Borrowed style values are not descriptor leases: retaining a concrete presentation beyond the synchronous visit requires separately funded storage. Ready publication and current parser demand therefore remain separate even when they share contexts.

The [allocation contract](#allocation-and-pressure-ownership) defines pressure, generation-qualified release receipts and the difference between attribution and actual freed bytes. Transcript latest-row retention is a different policy and must not be mistaken for syntax-data eviction.

## Allocation and pressure ownership

`DataBudget` records numeric policy credit only: it holds no source/UI owners and chooses no eviction victims. The retention root funds additional peaks by visiting least-recently-touched entries in its existing order, skipping explicitly protected/pinned generations. A successful pressure check is not reusable allocation credit: an actual grant must be reserved and consumed into storage charges. Unused grant credit is returned; shared charges live until their last owner releases them.

Every eviction returns a key/generation-qualified receipt. The controller processes receipts even when the attempted new admission ultimately fails: dropping other entries does not guarantee that captures or physical outstanding work leave enough free credit. Receipts retire matching leases, invalidate ready/display ownership and preserve refusal state; they do not authorize an endless eviction/reclassification cycle. Entry-attributed bytes and bytes actually freed are different when borrowers/captures still own storage.

Acknowledged, latest and displayed snapshots share physical text charges where possible. Committed range blocks and retained display views account their physical union, including old tails and suspended readers. Physical request captures, replacement/suffix buffers, frame families and decoded workspace remain separately funded through actual settlement; cancellation and removal cannot free them by assumption. These are logical policy charges, not V8 heap or RSS measurements. See [context and style lifetime](#context-and-style-lifetime) for the separate descriptor/index ownership.
