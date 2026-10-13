# Write card specification

This specification defines the interactive presentation of the exact, case-sensitive tool name `write`. pi-tidy-ui supports stock Pi and compatible third-party result shapes without identifying the producer or changing execution, arguments, results or session data. [Architecture](architecture.md) owns the host boundary; the [edit contract](edit-card-spec.md) owns the shared diff layout.

## Lifecycle and routing

Before final success, use the ordinary compact presentation: `write <path>` when `path` is a nonempty primitive string, ignoring every other argument without reading it. Otherwise use generic argument formatting. The [compact text budgets](tool-summary-spec.md) apply; long paths wrap rather than acquiring a one-row hard cut. Argument streaming uses the compact left-arrow glyph (`←`), as for edit; actual execution and partial results use the existing shared spinner. Final failure keeps the compact view with every visible segment colored `error`. Never inspect partial/failure diff metadata or paint proposed content as a successful card.

Only a final non-error result can enter the write presenter. Rendering, predecessor spacing, mouse and animation teardown share this condition. Native expansion, images and intentional native hiding remain authoritative. `--tidy-ui-card write` restores native rendering; `--tidy-ui-compact write` takes precedence and keeps every state compact. Unknown self-shell renderers retain actual-width native visibility checks; the stock-edit visibility exception is not extended to write by name or schema.

Card paths accept `path`, `file_path` or `filePath` and display absolute paths relative to the native component `cwd`. The exact compact shortcut uses only `path`, as for edit. Missing usable card paths or unavailable required source delegate to native.

## Saved source and classification

Use only the saved result and call arguments, never filesystem checks, file rereads, backup inspection or input-derived proposed diffs. Stock Pi 1.0.0 write returns a success message without diff/old-content/creation metadata; the input `content` remains available. Compatible AFT results can retain numbered `details.diff`; other producers can supply a supported single-file unified `details.patch` or `details.diff`.

A present `details.patch` takes precedence and must be a supported string patch; malformed/present unsupported metadata delegates to native, not a lower-priority diff or guessed classification. Use the shared parser's number/hunk validation. Inspect source-row kinds across the entire parsed metadata **before context projection**. Headers, hunk markers, omission markers, literal code punctuation and no-newline annotations do not count as source change signs.

| Available data | Title | Body |
| --- | --- | --- |
| Supported complete diff with any removals, including removals only | `← Replaced <path>` | Shared edit-style diff |
| Supported complete diff with additions and unchanged context, no removals | `← Edited <path>` | Shared edit-style diff |
| Supported complete diff with at least one addition and no removals or unchanged context | `← Created <path>` | Resulting diff source with original new-line numbers and syntax, without diff signs/backgrounds |
| No diff, empty supported diff, or context-only metadata without changes | `← Wrote <path>` | Supplied `args.content` with numbers and syntax |
| Explicit `details.truncated === true`, even if some diff rows survived | `← Wrote <path>` | Supplied `args.content` plus `Diff truncated by tool; showing supplied content.` |
| Present malformed/unsupported diff | Native | Native available information |

`Created` is the agreed display classification **content added from zero**, including filling an existing empty file. It is not proof that the file did not previously exist. `Edited` and `Replaced` describe the supplied change pattern, not distinct tool implementations. Do not infer these labels from message text, tool identity, addition/deletion counters or current file existence.

Without a usable diff, the old source and changed positions are unknown. Show the supplied input, not a fabricated comparison. It describes the content the agent submitted; it is not a guarantee of final bytes after producer-side formatting. Where trustworthy `details.noOp === true` accompanies absent/empty/context-only metadata, add `No changes.`. Never infer no-op solely from absent metadata. The truncated warning takes precedence over no-op. Unsupported metadata does not become a no-op merely because it has no recognized source rows.

## Body and completeness

All available changed rows remain visible: no Bash-like preview, compact 256/1024-grapheme cap, body ellipsis or hidden changed-line tail. “Complete” means all available changes, not reconstruction of the whole final file. Producer omissions/truncation cannot be repaired by pi-tidy-ui; the explicit truncated fallback states that limitation. No diff fallback can identify which submitted lines were already unchanged, so it displays all supplied content.

Plain `Created`/`Wrote` bodies are always one full-width pane. Use right-aligned new-line numbers in `dim`, one gutter space before the number and one space before code; continuation gutters are blank. Do not reserve a sign column or use added/removed tint. Preserve logical blank lines, trailing spaces and available source positions; an empty input has no invented numbered source row. Omission markers already supplied inside an additions-only diff remain visible rather than pretending missing source exists.

Syntax uses Pi's public filename language resolver and the [syntax pipeline](syntax-highlighting-spec.md), borrowing asynchronous Occipital ranges or permitted exact cached Pi fallback before wrapping. Preserve multiline state within supplied logical regions; unavailable diff gaps reset it. Native classification uses its accepted UTF-8-safe 64 KiB per-line window without removing any text. Pi palette is default and independent daemon themes are selectable. Unknown extensions use the ordinary code fallback. Sanitization/tab expansion, grapheme-safe wrapping, tiny-width gutter omission and impossible-wide-grapheme replacement follow the shared file presenter, without changing source/model/session bytes.

`Edited`/`Replaced` reuse edit numbering, signs, Multiply backgrounds, neutral empty counterparts, hunk pairing, interior omission markers and `DIFF_CONTEXT_LINES = 3`. Additions-only/removals-only diffs are unified at every width; mixed changes split only above 120 columns. Context reduction never removes changed rows. The title uses the shared Bash/edit content origin and muted foreground. Shared frame geometry follows Pi's Output padding for exterior margins with one fixed internal cell per side; neutral `toolPendingBg`, stripe and reset restoration are unchanged. Supplied flattened error diagnostics use the same display rules as edit.

## Integration, retention and verification

`src/file-card.ts` is the shared edit/write presenter: validation, source classification, highlighting, context projection, plain/diff rows and validation-only measurement. `src/index.ts` remains the sole host adapter. No tool definition override, execution interception, dedicated write-render timer, producer patch or presenter registry is introduced; native provider lifecycle is separate.

Successful write frames belong to the `cards` accounting group with Bash and edit diffs. Compact lifecycle/forced-compact views and native fallback belong to `ordinary`. Each component owns one latest layout/group/width with no admission or eviction limits; native removal/clear or owner collection releases its representation. Native updates, expansion, invalidation, width/Output-padding/theme and `cwd` guards apply unchanged. Warm retained frames do no custom source preparation/highlighting/wrapping. Spacing and rejected clicks use retained row counts or validation-only classification, never construct an unretained source body. Plain source builds do not calculate Multiply colors. See the [cache contract](render-cache-spec.md).

Completed panels reveal native details on a selection-safe fullscreen primary click inside the panel. Exterior margins, separators, selection, wheel and secondary events remain non-targets. Ctrl+O remains native; expanded write is native, not another custom full-source view. Off/shutdown/failure/reload release retention and restore owned hooks.

Follow [testing](testing.md): first-red classification/lifecycle regressions; both metadata formats, global/preprojection kinds, clearing, empty/context-only/no-op/truncated/malformed cases; saved-source versus input-source equality; all source rows and syntax without signs/tint; control/Unicode/blank-line safety; widths, both themes, native/image/hidden/override/expansion safeguards; work counters, group attribution, immediate detached-layout release and active first-write-installer GC. Real CLI controls must separately exercise actual stock file writes and explicitly isolated representative metadata fixtures, with physical cells, native input, off/on/reload, same-session replay and exact raw call/result/model/session equality. Metadata-shape coverage is not installed AFT execution.
