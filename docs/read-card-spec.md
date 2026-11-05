# Read card specification

The exact, case-sensitive `read` tool has an owned compact/full presentation. This replaces its interactive card, not the tool, filesystem access, result or saved session. It reuses the [plain file view](write-card-spec.md) and [prepared syntax pipeline](syntax-highlighting-spec.md), without diff parsing or change backgrounds.

## Presentation and input

- A newly received or restored read is normally the existing compact `→ read` summary: path and supplied arguments, no result-body excerpt. Long descriptions retain the [summary wrapping rules](tool-summary-spec.md); compact does not mean a hard one-row cutoff.
- A fullscreen primary click on a completed summary opens that component. Clicking its expanded text panel collapses it. Active selection, separator rows, exterior margins and opaque image rows are not toggle targets. Pending/partial summaries do not expand on click.
- Ctrl+O uses Pi's global expansion state to select our full read view in both regular and fullscreen terminal modes. Click and Ctrl+O share the same component expansion flag: clearing global expansion also collapses a read opened by click, without a separate remembered read choice. Regular Pi does not dispatch mouse events to cards.
- Read never enters the latest-ten automatic-full window for write/edit. It has no automatic source preview: compact has no source body; deliberate expansion requests the saved full result.
- Appearance Off and `--tidy-ui-card read` select Pi's presentation. When both policy flags name read, `--tidy-ui-compact read` retains compact-policy precedence. Intentional native hiding is preserved. Print, JSON, RPC and HTML export do not acquire this terminal card.

## Saved text, numbering and colors

A successful source view requires a usable saved path under the shared file-data contract; pending/error details do not. Its expanded card has a `→ Read <path>` heading and one numbered code pane. Read and write/edit headings share the [path-display rule](tool-summary-spec.md#filesystem-path-display): ordinary relative names stay compact, while parent ladders reaching the root display the resolved absolute name. Control-character and whitespace cleanup are shared. It uses the saved result's text parts in order, separated by LF, not `args.content`, a diff, or a fresh file read. Line-ending/control cleanup, four-column file tabs, grapheme-safe reflow, gutters and neutral surfaces are shared with other file cards. Highlighting starts from this returned excerpt alone; omitted preceding file context is not recovered from disk or reconstructed.

Stock read and unrecognized producer results remain literal. Their gutter starts at a positive safe-integer numeric `args.offset`, or 1 when that field is absent or invalid, and advances through saved text rows. Continuation, truncation and other notices remain part of the returned text, including their ordinary numbered display rows. Numeric-looking source text is never stripped by itself.

AFT-compatible numbered results have a separate saved-data boundary: `details.success === true`, string `details.content`, and positive safe-integer `start_line`, `end_line`, `lines_read` must describe one contiguous inclusive range. That content must match the start of the saved text at a line boundary. After the ordinary line-ending normalization, every declared source row must contain its exact expected decimal number preceded only by spaces and followed by `: `. Padding width is not inferred from file size or the requested range. Only after validating the entire block does preparation remove that outer prefix; source indentation, blank rows and literal inner prefixes such as `1: text` remain intact. Returned metadata supplies gutter coordinates even when `startLine`, `offset` or `limit` arguments differ. The saved result and its arguments are never rewritten.

Unnumbered rows after the verified AFT source block remain visible, unnumbered, neutral text and do not enter syntax classification. This preserves producer notices and a terminal display newline without inventing file coordinates for them. Any numbered continuation beyond `lines_read`, mismatching saved content/range or malformed row rejects the whole decode and falls back to the literal result, not partial stripping. Empty, directory and other results without a verified numbered envelope also remain literal. This recognizes a result format, not a producer package or renderer identity; it neither recovers missing source nor rereads the path.

A recognized shebang can supply a language hint only when the returned source begins at file line 1. A shebang-looking first returned row at a later offset is not first-line provenance. See [shebang hints](syntax/shebang-hints.md).

Successful text uses the same semantic classifier, Follow Pi adapter, bundled palettes and common painter as write/edit. Read does not invoke the diff parser or apply added/removed backgrounds. Unsupported languages stay readable in the selected palette's neutral code role. Native highlighting Off does not select the stock read card. A permitted public Pi classifier fallback is distinct from invoking Pi's stock read renderer; its execution authority remains with the [source controller](syntax/work.md#rendering-and-fallback).

Pending/partial reads remain compact by default. Explicit expansion shows the owned waiting/received-data detail path under the existing pending-detail bounds. A completed failed read exposes its available saved error text after ordinary funding, including errors with no usable path; errors are not classified as successful file source. Neither path silently restores the stock read card.

## Preparation, retention and refusal

Collapsed reads do not join, normalize, split, measure or classify their saved text bodies. They prepare only the bounded argument summary. Expansion and semantic updates prepare the successful full text through `CardSources`, outside terminal rendering. The construction grant accounts for returned text and row descriptors before the joined source, measurements and paint are constructed; read does not get a separate unbounded budget.

Result replacement and ordinary host invalidation refresh the current saved-text identity, including mutation inside a reused result object. AFT source identity also includes the metadata content/range that authorizes decoding, so metadata-only changes cannot retain old numbering or a stale decoded source. Splitting and validating the numbered block still occur only after the construction grant; compact rendering does not perform that scan. Obsolete preparation or late native work cannot publish an earlier body. Warm frames reuse ready text/paint; width changes reflow stored measurements without another SOURCE/STYLE request or classification. Palette changes reuse the same source and geometry under the shared publication rules.

Collapse releases the full owned display, measurements, paint and syntax demand while the Pi component and its original result remain alive. Re-expansion prepares the then-current saved data, including fresh card paint when native parsing/styles are still retained. A paused last-good-paint guard must not report success without paint after that discard. This is release of derived presentation, not deletion of conversation content or a whole-Pi heap bound. Removal, renderer transfer, native opt-out and reload follow [host ownership](host-integration.md) and [prepared-card lifetimes](syntax/prepared-cards.md).

If construction, palette input, compiled paint, geometry or detail preparation cannot be funded, show an owned bounded unavailable message. Do not bypass refusal by materializing Pi's full read card. Accepted text/measurements survive initial palette/paint refusal: later ordinary visible frames retry only the missing presentation work through the existing weak refresh at the same revision. Repeated refusal requests no further frame; first paint recovery requests one, and continued geometry refusal does not rearm the notification before a usable layout or new admission. Missing syntax within an accepted body uses neutral paint, not a claim that another classifier is safe.

## Lazy stock renderer boundary

The public `registerToolRenderer` resolver defers only an exact complete stock read call/result pair. While the owned read is presented, neither stock callback is materialized, including compact, full, pending and error states. A genuine native path delegates with the current saved arguments/result and host context. Existing native-renderer failure reporting and recovery apply to read as well as write/edit.

Stock callback identity is an ownership proof, not the producer-data contract. Compatible foreign read results can use this presenter; their callbacks and state are not rewritten, retired or cleared. A foreign self-shell can require native rendering to establish visibility and has no zero-producer-work guarantee. See [native visibility and lazy ownership](host-integration.md#native-visibility).

## Images: a host-owned opaque block

Pi creates images outside its text renderers. The adapter borrows the current public direct-child `Image` instances and their associated per-image spacing; it does not construct another image, read private image collections or call the original tool renderer to recover image rows. Pi retains image IDs, conversion, width caches, `showImages` and image-width settings.

An expanded image read shows the saved text and the host image block at the card's content origin. The image rows are opaque terminal output, not source text:

- Preserve native row order/count and literal empty reservation rows.
- Apply only safe reset/horizontal positioning before a protocol anchor; never append ordinary suffix padding or pass protocol/reservation rows through the text frame, measurer or syntax painter.
- Frame surrounding text normally, but leave image reservation rows without a continuous stripe or panel background. The opaque block is outside the panel's toggle targets; the actual text and final framed padding remain interactive.
- Read current host children on each expanded frame so public show/hide and width setters cannot be hidden by a stale text cache. Do not request `Image.render` at zero usable content width or while collapsed.
- Keep image payloads out of owned retained text/layout caches. Pi's image component owns its payload and width cache; plain host fallback text is positioned with the block rather than treated as code.

These constraints preserve Pi's Kitty reservation/cropping and iTerm cursor-accounting conventions. Supported protocols and terminal capabilities remain Pi's; its existing iTerm fullscreen fallback is not replaced. Terminals without a usable image retain the saved textual context and applicable host fallback.

A collapsed read does not paint an image, but Pi may still construct/retain its image object or start transcoder loading during normal result updates. Collapsing our card therefore releases owned text preparation, not host image data. Ordinary terminal redraw/scrollback behavior is also Pi-owned; changing card height does not promise scrollback preservation.

## Related contracts

[Summaries](tool-summary-spec.md) own compact formatting and separators. [Host integration](host-integration.md) owns dispatch, native exceptions and cleanup. [Prepared cards](syntax/prepared-cards.md) and [storage](syntax/storage.md) own funding and publication; [rendering](rendering.md) owns text/geometry reuse. [Testing](testing.md#cards-and-native-data) distinguishes SDK controls, real CLI/replay checks and observed graphical-terminal behavior.
