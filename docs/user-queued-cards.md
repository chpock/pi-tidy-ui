# User messages and queued-message projection

These two presenters share appearance and frame geometry, but consume different representations. User cards reframe native Markdown output. Queued cards prepare complete plain text before selecting a bounded preview. Neither changes message/queue ownership. See [host integration](host-integration.md) and [text representations](rendering.md).

## Internal representations and projection

### Native Markdown rows

`renderUserCard` asks the original renderer for `contentWidth + 2 × nativePadding`, so Markdown itself receives the final text width after removing its padding. It validates native top/end zone rows, removes only their geometric padding and frames the remaining ANSI-bearing rows. OSC133 A is attached to the new top padding; B/C remain ordered on the new bottom padding. Outside transcript separators stay outside those zones.

This is a row projection, not Markdown parsing. Native transformations, links and code colors have already run. Image-protocol content or an impossible tiny-width text projection returns a native rendering at the real component width; an incompatible zone/row contract is an integration failure, not permission to guess source boundaries.

### Prepared queued cards

`prepareQueuedCard` produces a `QueuedCard` with three fields:

| Field | Meaning |
| --- | --- |
| `rows` | Complete framed body, internal separator, wrapped metadata and bottom padding at the current width |
| `bodyRows` | Count of plain wrapped message rows, distinct from metadata/decorations |
| `ellipsis` | Up to five prepainted possible final rows for a clipped body |

Plain text is normalized and grapheme/cell-wrapped once. Metadata is assembled as badge/space/parenthesis/hint spans, wrapped as plain text and recolored by span intersection. Badge padding belongs to its text and width; it is not an external decoration added after wrapping.

`projectQueuedCards` then receives these prepared objects plus terminal height. It computes the whole-block total, reduces only per-card body counts under the soft policy below and assembles arrays from existing strings. It does not rewrap/repaint text, retain prior height states or modify the native queue. The original native Container still renders its existing children through call-local overrides, maintaining Pi's own geometry/child-reference state.

For example, two six-row bodies with four decoration/metadata rows each require 22 rows including leading/inter-card separators. With a 10-row soft budget, reducing both bodies to one row still needs 12. Both cards and all metadata remain; the soft budget intentionally cannot exclude a queued message. This example assumes each metadata section fits one row; narrow widths can require more.

## User-message cards

Ordinary native `UserMessageComponent` instances use the same geometry and terminal-default stripe/exterior background as Bash. Use `customMessageLabel` for the stripe foreground and `userMessageBg` for the panel. Retain native `userMessageText` and semantic Markdown foregrounds/attributes inside; do not recolor syntax or links uniformly. No Bash command prefix, title, footer, truncation, expansion, spinner or hover behavior applies to user cards. Custom/skill/branch/compaction/assistant messages and separate image attachments remain native.

The sole adapter identifies and validates the current user-component contract, without importing private classes. The native component has one public-host `Markdown` child, numeric horizontal padding and one vertical padding row per edge. Ask its original renderer for content width plus twice its native horizontal padding: native Markdown and its registered transformers then receive exactly the frame's content width. Remove only those known geometric padding rows/columns with ANSI-aware column slicing, not whitespace trimming or source re-parsing. Keep full Markdown output, literal escapes, ordered-list numbering, syntax highlighting, links, Unicode and interior empty rows. Do not mutate the component, its children, text, native padding or Markdown options to render a card.

Move the native OSC 133 start and end/final zones to the new top/bottom padding rows, preserving their order and keeping transcript separators outside them. Empty native output stays empty; width zero paints nothing. Reuse an already supplied native blank separator; otherwise add one outside row after a visible predecessor. Cached predecessor metadata avoids recursive user-card rendering.

Native Kitty/iTerm2 image-protocol rows and native wide glyphs that cannot fit the tiny frame content allocation delegate to the original renderer at the real width, without clipping or disabling other pi-tidy-ui presentations. This preserves upstream rendering, including upstream tiny-width limitations; actual graphical-terminal display is not an emulated acceptance claim.

User cards add no mouse handler, input interception, clock or stateful pointer paint. Native selection/copy and tool keyboard expansion remain native. Restore user rendering/invalidation descriptors only while still owned by pi-tidy-ui. Persistent wrappers are created in a prototype-only scope, never the first user's installer scope. Weak user-component state owns its latest layout strings, without budget/count eviction; global accounting retains only numbers and weak entry references, never a user, parent, Markdown component, rendered string or callback. Native container removal/clear releases removed user layouts immediately. See the [cache contract](render-cache-spec.md).

## Queued-message cards

Unsent Steering and Follow-up messages stay in Pi's existing pending area **above the editor**, not in transcript history. Each message has a separate user-colored card in Pi's native order, including messages queued during compaction. Once Pi consumes an item its preview disappears; ordinary history presentation begins only when Pi actually submits it. Native delivery modes, edit-all behavior, queue data and session/model contents are unchanged. Cards add no click action, input interception, timer, scrolling surface or separate queue.

- Use shared Output-padding geometry, `customMessageLabel` stripe, `userMessageBg` panel and `userMessageText` plain text, not Markdown. Preserve logical newlines/indentation and wrap by terminal columns/graphemes. Expand tabs and remove terminal/bidi controls for display only, using the same plain-text primitives as Bash. A glyph wider than the tiny available content width becomes a display replacement character; raw queued text stays intact.
- Separate cards by one outside empty row; retain Pi's existing leading empty row. Each card has top/bottom panel padding, message text, one empty internal separator, then metadata.
- Metadata begins `QUEUED · Steering` or `QUEUED · Follow-up`. The label is a badge with one empty cell on each side; both padding cells share its background and count toward metadata wrapping. The entire badge has background equal to the user-card stripe color and foreground equal to the panel color. Only the last card appends ` (<native key> to edit all queued messages)`, without a separate arrow/hint row. Parentheses use `dim`, their contents `muted`, matching existing metadata. Read the shortcut from Pi's current hint rather than hardcoding Alt+Up. It edits **all** queued messages, regardless of which card carries it.
- Metadata wraps at narrow widths; it is never removed by the vertical text budget. Its wrapped rows count as decoration. Width zero returns no queue rows.

### Soft height budget

Use `max(10, floor(tui.terminal.rows / 3))` for the **whole queued-card block**, including leading/inter-card separators, panel padding, internal separators and wrapped metadata. This is a screen-height policy, not a claim to know current free space after sibling allocation. Appended native pending Bash/foreign components are outside this budget and remain unchanged.

First prepare the full text at the current content width. If all cards fit, show all text. Otherwise sweep cards from first to last, reducing any longer body to at most **5** visible text rows. Stop immediately after the first reduction that makes the whole block fit; later cards need not be reduced. If still too tall, sweep with caps **4, 3, 2, 1**, in that order. Never expand an already-shorter body to a cap. A clipped body adds `…` at the end of its last retained text row, within that row's column width, not on an extra row. Interior/empty logical rows count toward the body height. Changing width/height always starts from the original prepared body, not a previously clipped result.

At least one text row per card remains. If the minimum cards and complete metadata exceed the budget, accept overflow: **never exclude a card to meet this policy**. Pi still owns final layout/clipping: fullscreen may hide part of an oversized pending block; regular-mode rows can leave the visible screen. No simultaneous physical-visibility or independent queue-scrolling guarantee is made.

### Native boundary and retention

The sole adapter reuses its owned `Container.render` observer. Require the verified seven plain managed root containers, the pending slot, owned methods and one stock `Spacer` returning exactly one empty row. Recognize only a contiguous native prefix of exact public `TruncatedText` instances with stock render/invalidate methods: `Steering: …` / `Follow-up: …`, ending with the native edit-all hint. Full text requires the approved private-field read: an own string-valued `TruncatedText.text` **data descriptor**, never a getter. No public queue-content API exists in the supported host. Do not import a private class, replace children, patch `TruncatedText` globally or touch agent/session queues. Feed each prepared block through a **call-local public render override** on its existing native item; the hint supplies zero rows, and the spacer's already-observed rows are reused. Always execute the original `Container.render` so Pi refreshes its own mouse geometry and strong child-reference snapshot. Returning a synthesized container result without that call would retain an old natively rendered queue after later rebuilds. No private container state is read/written. Restore exact own/inherited render descriptors in `finally`, only while still owned; immutable/incompatible method slots remain native. Render any subsequent pending components normally, once, including at zero width. Unknown shapes, changed owners, missing public terminal height or malformed prefix/hint remain native; unexpected rendering failures restore pi-tidy-ui through its existing failure path.

Each native queued item weakly owns one latest prepared full card plus at most five possible ellipsized ending rows. Width, Output padding, theme callbacks/colors, native text and the last-card hint invalidate that preparation. Warm and height-only renders merely select/assemble existing rows: no body wrapping/painting or added render requests. Native queue rebuild/removal, explicit cache clear/off/shutdown and owner collection release these layouts under the existing component-owned lifecycle. `/tidy-ui` → **Status & troubleshooting → Display cache** includes them as ordinary `byKind.queued` entries; reported rows include retained full/ellipsis rows, not just currently displayed prefixes. There is no retained clip-level or height-history cache.
