# Bash card specification

This is the default presentation for the exact tool name `bash`; other shell/tool names keep their existing policy. It supplements [tool-summary-spec.md](tool-summary-spec.md), whose argument-summary rules do not apply inside this card.

## 1. Scope and policy

Change presentation only: no tool registration/replacement, execution interception, result rewriting, additional session entries, subprocesses, polling or file reads. Off restores the original Pi rendering. Images and intentionally hidden native components retain native behavior. Non-terminal modes remain unaffected.

By default `bash` uses this card both collapsed and expanded. An explicit `--toolview-card bash` requests the original native card; `--toolview-compact bash` keeps the existing compact override and takes precedence. Invalid/non-string command arguments fall back to native presentation; an empty string command is displayable. During argument streaming the card updates when a string command is available.

## 2. Command and comments

Show the entire supplied command, without an argument-length or row cap. Prepend `$ ` once, before its first character. Preserve supplied newlines and indentation. Every subsequent logical or soft-wrapped row starts at the card content origin; add no continuation prefix or alignment spaces. This differs deliberately from ordinary summaries.

Optional comments precede the command in this order:

1. `# <description>` when `description` is a nonempty human-readable string after label sanitization. Render it as one logical comment line, soft-wrapped if needed.
2. `# Running in <directory>` only when a nonempty string `workdir` was explicitly supplied and its resolved path differs from the component's session working directory. Resolve relative paths against that directory and display the absolute, normalized path. Do not inspect the command for `cd`, resolve symlinks, query the filesystem, or infer runtime changes made by other extensions. Equivalent `.`/absolute current-directory paths produce no comment. If the base directory needed for an explicit workdir is unavailable, retain native rendering rather than inventing a path.

If any comment exists, insert exactly one empty content row between the comment group and `$ `. Omit this separator otherwise. No tool name, named-parameter list, duration or success/checkmark is added.

## 3. Terminal-style layout and safety

Use the [shared OpenCode-style card frame](card-frame-spec.md): exterior left/right margins P from Pi's Output padding (0 or 1, default 1), left-only `┃` border, and one internal column on each side, plus one top/bottom padding row. At widths >=2P+4 the content origin is column P+2 and its width is the component width minus 2P+3, excluding both internal and both exterior columns. Narrow widths adapt as specified by the shared frame, preserving at least one content column; width zero returns no rows. The adapter adds one outside transcript separator when a visible preceding sibling exists.

Hard-wrap printable text by terminal cell width, preserving spaces rather than using word wrapping. Use Unicode grapheme segmentation and the host's visible-width measurement; never split a combining sequence or wide glyph. A glyph wider than the entire available content width is displayed as a replacement character so the component still fits. Tabs expand to eight-column tab stops relative to the content origin, including the `$ ` prefix on the first command row. This is a text presentation, not a terminal emulator.

Display-only sanitization removes terminal escape/control sequences, bidi controls and zero-width spaces; retain Unicode joining marks used by graphemes (including emoji ZWJ sequences); normalize CRLF and standalone CR to logical line breaks. Preserve other printable characters, newlines and indentation. Incoming ANSI colors are not executed or retained: use the agreed semantic foregrounds. Arguments, result content and stored data are never changed.

## 4. Output and streaming

Output means the text content returned by the tool, in content-block order, joined with newlines. It does not mean raw stdout reconstructed from other sources. Display partial results as they arrive through Pi's existing updates; do not append overlapping snapshots, rerun commands, or poll. Final results replace partial snapshots.

After display-only sanitization, an output consisting only of whitespace produces no output section. Remove whitespace-only logical rows from the two edges; preserve interior blank rows and the indentation/trailing spaces of nonempty rows, subject only to the presentation exceptions below. Do not recognize or remove task messages, `(no output)`, exit descriptions, compression summaries or other semantic output fragments.

One semantic exception is an exact duplicate of the card's own **final nonzero exit footer**. Derive the complete plain, unwrapped footer from the persisted metadata as in section 5 before inspecting output. After ordinary trailing-edge blank removal, remove one terminal logical row only if it equals that footer byte-for-byte after the existing display sanitization and its immediately preceding logical row is whitespace-only. The removed blank separator is then an output-edge blank, so trim the remaining edge blanks normally. Eligible footers are `[exit code: N]` and `[exit code: N; error: execution failed]`. Do not trim the footer row itself to make it match, remove an interior occurrence, repeat the removal, or infer a code/error from text. Missing separators, unequal text/codes, indentation/trailing spaces, partial results, zero/unknown/string codes and error-only literals remain ordinary output. Apply the exception in both collapsed and expanded cards, before wrapping/cutoff/overflow detection; when the duplicate was the only output there is no output section. Raw result content, model content and session data remain unchanged.

A second approved semantic display exception handles one exact terminal timeout block. Only for a final result with persisted numeric `details.exit_code === 124`, after ordinary trailing-edge blank removal, recognize the two consecutive logical rows `[command timed out]` then `[exit code: 124]` when their immediately preceding logical row is whitespace-only. Match each row byte-for-byte after the existing display sanitization; do not trim its indentation/trailing spaces, accept a gap between the pair, or match an interior pair. Remove the two rows and trim the remaining output-edge blanks normally, then use `[exit code: 124; error: command timed out]` as the single completion footer, whether or not `isError` is true. Apply this before wrapping/cutoff/overflow detection in collapsed and expanded cards. Partial results, unknown/string/other codes, code 124 alone, unseparated or mismatching pairs retain their ordinary policy. Remove at most one terminal block of either kind per presentation; do not rescan a newly exposed suffix. The ordinary exit-duplicate exception still applies independently when the timeout pair does not match.

This timeout rule is explicitly a presentation convention, not producer detection or reliable process-cause classification. AFT supplies the timeout marker in text but no supported persisted timeout-cause field. A command printing the identical separated terminal pair with code 124 is indistinguishable and receives the same display. Reliable classification would require a structured persisted cause from the producer. Never derive an exit code from output, treat every code 124 as a timeout, or rewrite result/model/session data.

For nonempty output, add exactly one empty content row after the command, then show the first **10 visual rows after wrapping**. When more rows are available, remove whitespace-only rows from the **end of that ten-row preview** and append `… (Click to expand)` immediately after the remaining preview. Do not backfill removed rows with hidden later text; preserve interior preview blanks. This also applies to whitespace-only soft-wrapped rows. If the entire preview is blank, show only the hint after the normal command/output separator. At very narrow widths only this hint may be shortened to fit. Expanded cards show all available visual output rows (including those interior blanks) and omit the hint. The command/comments are never subject to the output limit.

Expansion exposes only text already supplied by the tool. Do not read `output_path`/other files, undo compression, reconstruct upstream truncation, or fabricate missing earlier output. AFT background/task-id messages are ordinary output, not a separate inferred process status. Successful background launch means the tool call returned, not that the underlying process exited.

## 5. Completion footer

Derive the exit code and error flag only from structured metadata, never from result text. Section 4's exact timeout-pair convention may enrich the display label, but supplies no status metadata; ordinary duplicate removal compares against the already-derived footer. The supported persisted numeric source is `result.details.exit_code`, a finite integer. Missing/null/string codes are unknown, not zero. Pi 1.0.0's built-in bash provides a live `structuredContent.exit_code` but does not save structuredContent in tool-result messages; intentionally do not use that transient field so live/history presentation agrees without changing serialization. Built-in nonzero exits still expose the persisted `isError` flag and their original diagnostic text.

Only after a final result:

- Section 4's exact timeout block matches: `[exit code: 124; error: command timed out]`, taking precedence over the generic error label.
- Otherwise, nonzero known code, no error flag: `[exit code: N]`.
- `result.isError === true`, zero/unknown code: `[error: execution failed]`.
- Both: `[exit code: N; error: execution failed]`.
- Zero/unknown code and no error flag: omit the footer.

Except for section 4's exact timeout-pair convention, the error label is intentionally generic: the tool API has no separate reliable error-message field. Do not invent a timeout duration from command arguments. Actual diagnostics remain unchanged in the output section except for section 4's two exact terminal-block removals. Insert exactly one empty content row before a present footer, even if there is no output. Wrap the complete footer when needed; never include it in the output preview count. Partial updates produce no completion footer.

## 6. Theme roles and interaction

- `$ `: `dim`.
- Command: `toolTitle`.
- Comments: `muted`.
- Output: `toolOutput`.
- Expansion hint: `dim`.
- Completion footer: `error`.
- Panel body background: `toolPendingBg` regardless of execution state; excludes the stripe cell.
- Border: `borderMuted`, or `error` foreground for final error flag/nonzero known code, exactly matching the completion footer. The stripe's background is terminal default in both cases. Error changes the stripe foreground, not its background or the panel body.
- No hover highlighting, pointer state or dedicated input interception, as specified by the shared frame. No synthetic spinner or process-state text is appended to the command.

Read the active theme at rendering time, including after theme changes. Apply colors after plain-text layout to avoid Pi 1.0.0's ANSI word-boundary defect. Strip utility-generated control sequences from the shortened static hint before styling it: Pi's truncator inserts full SGR resets even for plain input, which must not cancel the hint foreground or enclosing panel background.

Fullscreen primary-button clicks anywhere in an interactive panel toggle the component's existing `expanded` state when additional output is hidden or available output can be collapsed. This includes comments, command, footer, border and internal padding, and works during streaming. Exterior margins and the outside transcript separator are not targets. Active text selection suppresses toggling; press/drag/release/wheel/non-primary events retain host behavior. No raw terminal input is observed and no hover state is maintained. Recompute panel geometry after updates, resize, Output padding changes and expansion. Ctrl+O continues using Pi's global expanded state and works in regular mode, where the terminal owns mouse input. See the shared-frame specification for lifecycle and pointer rules.

The [component-owned render-cache contract](render-cache-spec.md) governs reuse/invalidation and optional diagnostics. Collapsed output wrapping stops when eleven visual rows prove overflow rather than computing all hidden rows; trimming preview-edge blanks does not search farther for replacement rows. Expanded output is built on demand. Repeated frames at unchanged width/padding/state reuse body rows and geometry; real width or Output padding changes rebuild once, keeping safe physical columns and click routing.

## 7. Verification gate

Follow the shared [testing and coverage guide](testing.md), retaining existing summary/lifecycle controls. Cover exact command indentation/wrapping, optional comments and equivalent workdirs, whitespace-only output, 10/11 visual-row boundary, partial/final replacement, literal status/task-looking output, exact/mismatching/unseparated/partial terminal footer duplicates and timeout pairs (including numeric-code guards, pair spacing/indentation, one-block-only removal, timeout-only output and partial-to-final replacement) without raw-data changes, preview-edge versus interior/expanded blank rows, metadata footer combinations, semantic colors/backgrounds, adaptive spacing, native opt-out, compact override, hidden/image fallback and unchanged result/session data. Separate actual built-in execution from deterministic AFT-shaped fixtures and do not claim the latter executes the installed AFT runtime.
