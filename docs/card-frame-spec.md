# Shared card frame specification

This specification defines the shared frame for Bash, user-message, queued-message, main editor, [edit cards](edit-card-spec.md) and [write cards](write-card-spec.md). Other tool cards and native expanded results are unchanged. The common host/module boundaries are described in [architecture](architecture.md).

## Scope and architecture

One pi-tidy-ui adapter owns live-host hooks, runtime lifecycle and mouse routing. The shared frame is a pure layout/painting module independent of tools, commands, results, expansion and host component classes. Callers supply already styled content rendered for its reported content width and painting callbacks. Bash, edit/write and user-message presenters supply their own content and paint; Bash toggles its custom output and completed edit/write cards expand to native content. All use the same frame and sole host adapter, without another extension or another set of container/input hooks. There is no plugin registry, new tool execution, session format, global theme modification or external shared package.

## Reference and geometry

Source reference: OpenCode `907b3bc518fa48e90e8ec24dd327d13eee71c36c`, `packages/tui/src/routes/session/index.tsx`: transcript horizontal padding at 1178 and `BlockTool` at 1994–2044; `packages/tui/src/ui/border.ts` supplies `┃`. This is inspected source, not a claimed screenshot comparison. pi-tidy-ui keeps one internal column per side and follows Pi's Output padding for exterior transcript margins; this is not a claim of literal OpenCode spacing.

Transcript cards use Pi's **Output padding** (`outputPad`), whose native values are 0 and 1 (default 1), for both exterior margins P. Changing the setting applies on ordinary renders without reload. All transcript presenters read effective settings through the public API. User cards additionally retain the native component's live padding to request and strip its Markdown geometry, without changing that component. This preserves Markdown wrapping/update behavior even if Pi's `/settings` assigns user messages a selected value while a project override leaves the effective setting different. Tool layout keys and file height measurement include P; a padding change cannot reuse old-width rows or stale panel hit bounds. No settings writes, polling or settings-input interception are added. Main input and its widget still use the independent **Editor padding** setting; the session footer and native renderers are not reframed by Output padding.

For component width W >= 2P + 4:

- Leave P exterior columns on each side, outside panel painting and click targets. At P=0 the stripe is at the left edge and the last internal padding cell reaches the right edge.
- The panel occupies W - 2P columns. Only its left border exists: a one-cell `┃`, including on its top/bottom padding rows. No top/right/bottom border is drawn.
- Inside the panel leave one column after the left border and one column on the right. Content starts at zero-based column P + 2 and has width W - 2P - 3. Both internal columns belong to the painted, clickable panel; neither belongs to the content width. At default P=1 these are column 3 and W - 5; P=0 uses column 2 and W - 3.
- Add one panel padding row above and below the content. Paint the panel body, including internal padding, top/bottom content rows and the space after short content. The stripe cell and exterior columns keep terminal-default background. The stripe remains part of the logical panel/click bounds despite its separate paint.
- Transcript separation is owned by the adapter: one outside empty row when a visible preceding sibling exists; no duplicated separator, and no separator at width zero.
- Comments, command, output, hint and footer share the content origin. Do not copy OpenCode's additional title indentation, spinner, command/output truncation or content policy.

At width zero return no rows. When the normal frame cannot fit, keep at least one content column: allocate the remaining columns first to the border (up to one), then balanced internal padding (up to one per side, extra odd column on the left), then balanced exterior margins (up to P per side, extra odd column on the right). P=0 never reserves exterior columns. Never truncate commands to preserve decoration. Recompute geometry for every width and current Output padding. Callers wrap body text at the resulting content width; framing itself does not rewrap or silently clip body rows.

## Paint

Prepared Bash/edit/write frames use literal roles from the card's ready palette, sampled or resolved before render. Owned palettes derive those colors from their bundled data and do not read Pi theme tokens. Under Follow Pi the mappings are:

- Panel body (everything after the stripe): `toolPendingBg` for every execution state, including errors.
- Ordinary border: `borderMuted` foreground, mapped to the prepared `frame` role.
- Final failed call: `error` foreground for both the prepared `errorFrame` stripe and completion footer, not a background token interpreted as foreground. Failure means final `isError=true` or a known nonzero persisted exit code, matching the Bash footer. Partial snapshots do not signal final failure.

For either palette, the stripe background remains terminal-default in ordinary and error states, not the panel color or a theme background token. Begin each frame row with an SGR background reset (`49`), and explicitly reset the prepared stripe role's background before its glyph so neither inherited nor supplied background leaks into the stripe. Its prepared foreground and attributes remain intact.

No hover highlighting or hover state. Pointer motion, focus changes and moving between cards do not alter panel paint or request pi-tidy-ui redraws. This is an intentional deviation from the OpenCode reference, accepted after unstable hover behavior.

Terminal-default synchronization can change the meaning of SGR 39/49 without updating Pi's cached concrete colors. Diff RGB arithmetic and the input half-block use pi-tidy-ui's latest requested/reported concrete projection, while semantic styles and Pi Theme objects stay unchanged; local Off samples released Pi default colors when needed for the remaining presentation. See the [terminal-color contract](terminal-colors-spec.md).

The generic frame receives paint callbacks instead of selecting theme roles or inspecting execution state. Its border callback styles the stripe foreground; its panel callback receives only body/internal padding. Prepared Bash/edit/write cards instead provide precompiled literal roles and do not sample an ambient theme during render. Under Follow Pi the failed stripe matches the error footer, the ordinary border follows `borderMuted`, the stripe background is default and the panel body stays neutral. Owned palettes use their corresponding local roles, never Pi donors.

### Framing APIs and ANSI responsibility

`src/card-frame.ts` exposes two paths with the same geometry but different input contracts:

| API | Caller supplies | Frame responsibility |
|---|---|---|
| `frameRows` | Styled strings and panel/stripe callbacks | Add top/bottom padding, measure child widths, reject overflow, pad/frame rows and restore enclosing panel paint after standalone SGR `0` or `49` |
| `frameMeasuredRow` | One completely painted child row and its already measured cell count | Validate a safe-integer count within content width, then pad/frame that row without scanning child ANSI or restoring parent paint across its resets |

Native child strings are shallow ANSI wrappers, not a background stack. The generic `frameRows` path preserves original reset sequences and child colors, then reapplies panel paint to the following fragment. User/queued projections use this path. It never paints the stripe/exterior with the panel callback.

Prepared Bash/edit/write use `frameMeasuredRow`; the common painter already emits complete body cells, structural diff/neutral surfaces and explicit attribute closure. It produces its own top/bottom rows and neutral counterparts/padding. The measured frame does not repair arbitrary incomplete child paint. Neither API silently truncates oversized content or wraps a caller's row to mask an invalid measurement. The exact source/layout/paint flow is in [rendering](rendering.md#two-framing-apis-two-input-contracts).

## Pointer behavior and lifecycle

An expandable card means hidden output exists, or expanded available output can be collapsed. All panel cells, including its border, internal padding, command/comments, footer and top/bottom padding rows, are click targets for that card. Exterior margins and the outside transcript separator are not. Empty/nonexpandable cards are not interactive. Neither expandable nor nonexpandable cards have hover paint.

Toggle only on a normalized primary-button click and only when Pi has no active text selection. Leave press, drag, release, wheel and secondary-button handling to the host; do not capture input. Ctrl+O and regular-mode keyboard behavior remain native. The host generates clicks separately from selection drags.

The host translates normalized component-local coordinates and subtracts an outside transcript separator before applying panel bounds. It refreshes native geometry before delegating back to native mouse handling. There are no raw-input listeners, private viewport-input wrappers or hover cleanup. Exact descriptor ownership, update notifications, stable-TUI renderer transfer and required/optional host checks are in [host integration](host-integration.md); frame code owns none of those hooks.

## User-message cards

Native Markdown reframing, paired widths, OSC 133 zone placement, image/tiny-width delegation and retained-row ownership are specified in [user-message projection](user-queued-cards.md#user-message-cards).

## Queued-message cards

Native pending-slot recognition, full plain-text preparation, adaptive height selection, badge/hint paint and exact temporary overrides are specified in [queued-message projection](user-queued-cards.md#queued-message-cards).

## Main input editor

The stock-editor projection has its own [editor chapter](editor.md): paired native widths, sentinels, cursor-safe slices, normalized mouse translation and foreign-owner boundaries. It uses the same visual geometry but keeps Pi's editing engine.

## Below-editor metadata, working directory and native activity

[Metadata and native activity](editor.md#below-editor-metadata-working-directory-and-native-activity) describes model/thinking/Idle, cwd fitting, the bottom edge and native status placement. [Host Git metadata](host-integration.md#directory-metadata-service) owns asynchronous repository discovery and watches; these are not frame operations.

## Related contracts

See [rendering](rendering.md), [editor](editor.md), [user/queued cards](user-queued-cards.md) and [frame/editor validation](testing.md#frames-queued-messages-and-stock-editor). The [manual index](README.md) provides the full subsystem map.
