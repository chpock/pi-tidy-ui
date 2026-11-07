# Tool producers and presentation adapters

A **producer** is a built-in Pi tool or an extension that supplies tool arguments and results. A **tool adapter** interprets that producer's saved data for presentation. It does not execute, register or replace the tool.

The adapter boundary separates knowledge of a producer's data format from the shared machinery that shows a card. The Pi host still owns components and native callbacks; the [prepared-card pipeline](syntax/prepared-cards.md) still owns grants, syntax work, measurements and paint.

## Code and test ownership

Producer-specific modules live under `src/tool-adapters/pi/` and `src/tool-adapters/aft/`; their contracts, shared reader construction and static registry are under `src/tool-adapters/`. The production registry maps only the existing exact names `read`, `write`, `edit` and `bash` to producer readers and semantic card kinds. Adapter matching inspects the individual saved call; it does not discover installed extensions. Adding an adapter is a source-level composition change, not a runtime registration surface. Shared presentation remains reusable; producer-specific decoding stays in the adapter rather than becoming a branch in a shared presenter.

| Responsibility | Owner |
|---|---|
| Supported names, argument/result formats and interpretation | Producer adapter |
| Path and language inputs, compact argument selection | Producer adapter |
| Source/service/diagnostic freshness evidence | Producer adapter |
| Estimates over borrowed input and funded source decoding | Producer adapter |
| Pending excerpts and complete saved error sources | Producer adapter |
| Component attachment, native visibility, callbacks and restoration | [Pi host integration](host-integration.md) |
| Expansion, preview-window policy, image children and hit testing | Shared host/card machinery |
| Construction grants, source scheduling, retained measurements and paint | [Prepared cards](syntax/prepared-cards.md) |
| Bounded serialization, masking, wrapping, frames and palette application | Shared presentation primitives |

This is an internal static composition boundary, not an extension-discovery service or public runtime plugin API. It adds no producer-specific cache, preparation queue, filesystem reads or persistent records.

Producer tests follow the same ownership while retaining their execution category:

- `tests/product/tool-adapters/<producer>/<feature>/` — format and producer-specific SDK behavior;
- `tests/cli/native/tool-adapters/<producer>/<feature>/` — real CLI scenarios requiring the prepared native helper;
- `tests/cli/tool-adapters/<producer>/<feature>/` — producer CLI scenarios without that prerequisite;
- `tests/fixtures/tool-adapters/<producer>/` — saved examples and producer-specific drivers.

Shared geometry, syntax authority, retention and lifecycle tests remain in their common scopes. A shared rendering test may use a representative producer result without owning that producer's decoding rules. Preserve feature segments such as `syntax` and `bash`, and keep execution prerequisites at their existing category positions; the [test catalogue](testing.md#test-selection-and-cadence) discovers files structurally rather than registering each producer file individually.

## Resolve a call, not a name alone

The actual tool name identifies user policy and the displayed call. The static production registry matches only the existing exact names `read`, `write`, `edit` and `bash`; each selected reader supplies a semantic presentation kind for shared routing and layout accounting. This internal seam adds no new production aliases, extension discovery or public adapter-registration API.

A session can retain results from an earlier tool registration, so the active registry is not proof of who produced an old result. Recognize saved formats from the individual call; do not infer historical ownership from the currently installed extension. Recognition is deliberately separate from full validation: choosing a candidate must not split or decode the complete body. Synthetic registry names in tests exercise shared card routing, summaries, spacing and expansion, including the actual Pi tool component and retained foreign callbacks; they do not add production tool names or demonstrate loading a third-party extension.

AFT numbered read is one example of format compatibility under the existing `read` name. Its reader validates the saved range, text and every outer number before removing decoration. An unproven envelope remains literal, including numeric-looking source text. No matching file is reopened. The exact rules are in [read cards](read-card-spec.md#saved-text-numbering-and-colors). Unsupported shapes keep their existing literal or native fallback; a registry entry is not permission to interpret arbitrary data as source.

## Observe cheaply, prepare under funding

A deferred reader captures the observed argument/result references and phase values, not a mutable live component. Later source work must correspond to the identity under which it was admitted. Component updates and the existing stale-publication barriers remain authoritative.

Observation selects the relevant saved values without joining, cleaning or parsing a full body. Source, service and diagnostic identities stay separate:

- full read identity includes saved text values and metadata that controls decoding, not merely object identity or part count;
- same-object argument/result updates must invalidate changed source or diagnostics;
- result replacement retains its existing weak service identity;
- preview identity observes only the admitted prefix, so changes to a hidden suffix do not rebuild that preview;
- unchanged render/resize visits reuse the already observed input rather than repeatedly decoding it.

A preview notice denotes a non-empty producer diagnostics array, while the full view lists only entries whose severity is `error`. A warnings-only array can therefore produce the notice without a corresponding full-view error row.

The host combines the service key with the same decoded diagnostics snapshot supplied to the prepared display. A service-key method must not independently reread diagnostics while display preparation uses a retained earlier observation: a no-op expansion notification followed by explicit invalidation must still add or remove the current notice. Preview diff-format detection, like preview source construction, uses only the bounded, cleaned prefix; a hunk header in a hidden suffix cannot choose that preview's parser.

Readers expose source identity separately from service notes. A producer's `note(view)` supplies service text independently of prepared source rows; when a service-only update leaves `sourceRevision` unchanged, `CardSources` can refresh the note while reusing the prepared file view. This is conditional, not a universal no-rebuild promise: current AFT file source keys still include `truncated` and `noOp`, so changing either can advance the source revision and trigger source preparation. If a replacement reader carries unchanged semantic-source and service revisions, `CardSources` adopts that reader at the same revision, releasing superseded argument/result references while retaining prepared rows.

The reader estimates construction from borrowed strings before full preparation. The existing grant funds joining, validation, normalization, descriptors and measurement. It does not gain an unaccounted normalized copy simply by moving to another directory. Compact read still prepares no result body; width changes still reflow stored measurements; palette changes still reuse source and geometry.

Pending details use the existing **total** limit of 8192 UTF-16 units and ten rows across the entire call, with bounded part/edit visits. Giving every part its own allowance would make a many-part result unbounded before funding. Completed file errors are different: expose all saved error parts through borrowed source iteration, then fund joining and cleaning. Do not apply the pending cap to a completed error or include a failed write/edit proposal. See [expanded file errors](read-card-spec.md#expanded-file-errors).

## Presentation compatibility is not native ownership

A compatible third-party renderer can supply data for an owned card without surrendering its callbacks or renderer-local state. Conversely, matching a tool name or saved shape does not prove that a callback belongs to stock Pi.

The [lazy stock renderer mechanism](host-integration.md#lazy-stock-file-renderers) separately verifies exact native callback ownership. Only that proof permits deferring stock presentation work. Producer decoding must not broaden it, and foreign callbacks retain native visibility authority. Appearance Off, native/compact flags and restoration continue to use the actual registered name.

## Adding or changing a producer

Keep format recognition, field precedence, compact-argument selection, source/service identities and producer-specific decoding in that adapter. Pass the selected data to shared preparation and painting when it fits an existing family; do not add producer-name branches there. Add saved valid/malformed examples and producer-scoped tests, including pending/final errors and mutable updates when supported.

A genuinely new interaction or presentation family can require a shared contract change. That is different from another spelling of an existing tool or another encoding of its result. Preserve original arguments/results and replay data, and verify both format behavior and shared work/ownership invariants. Real CLI captures complement SDK controls; neither implies that an entire external extension was loaded when a controlled saved-result fixture was used.
