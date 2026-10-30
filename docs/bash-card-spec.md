# Bash cards: command and service preparation

Bash has two independent inputs: the normalized command is syntax source, while already-returned output/metadata are service presentation. `src/bash-card.ts` prepares those logical values; the common [prepared-card pipeline](syntax/prepared-cards.md) measures and paints them. The [streaming contract](bash-streaming-contract.md) separately owns parser/checkpoint and historical-paint authority.

## Internal flow

```text
args.command -> normalized complete command -> measured command / SOURCE demand

text result blocks + result metadata
  -> remove one metadata-qualified raw task annotation
  -> normalize joined blocks and establish trustworthy block boundaries
  -> recognize complete final reminder suffix
  -> select ordinary-output range and metadata-derived footer
  -> measure useful service rows -> common scene / complete palette / paint
```

`BashService` is a frozen width-independent object. `output` retains the normalized rows; `[first,last)` selects ordinary output and `[reminder,end)` selects reminders. `description`, directory `heading`, `footer` and `error` are separate service facts. Tail conventions adjust ranges rather than passing service/output text into the command parser.

Order matters. Task annotation recognition uses an exact metadata-qualified **raw** whole row before sanitization can manufacture a match. Joined normalization remains authoritative; if cross-block control sequences erase or change the independently reconstructed boundaries, the apparent reminder suffix stays ordinary output. A final complete, nonnested reminder must respect original block boundaries. Only afterward do the narrowly specified timeout/duplicate-footer rules alter the ordinary-output range. The exact accepted strings and error evidence are defined below, not generalized into producer identification.

The prepared owner tracks command and service revisions independently. Equal command text can reuse measurement; a true suffix can extend measured data. Service regions compare their own text and reuse unchanged measurements. A new execution result can therefore change the footer without reparsing an unchanged command.

Complete service text remains available even when collapsed. Because every logical row contributes at least one visual row, each collapsed output/reminder section needs measurements for at most eleven logical rows to prove the ten-row preview overflow. Expansion prepares the missing measurements before render. Width-dependent reflow stops at the necessary visual overflow proof; this is bounded display work, not removal of hidden output or a count of all hidden visual rows.

The host resolves an explicit Bash working directory against a valid native cwd without inspecting the filesystem. Directory context and description never become command source. Prefix compatibility for an evolving command is a separate UTF-8/scalar proof, not the result of comparing already wrapped or colored terminal strings.

This is the default presentation for the exact tool name `bash`; other shell/tool names keep their existing policy. It supplements [tool-summary-spec.md](tool-summary-spec.md), whose argument-summary rules do not apply inside this card.

## 1. Scope and policy

Change presentation only: no tool registration/replacement, execution interception, result rewriting, additional session entries, subprocesses, polling or file reads. Off restores the original Pi rendering. Images and intentionally hidden native components retain native behavior. Non-terminal modes remain unaffected.

By default `bash` uses this card both collapsed and expanded. An explicit `--tidy-ui-card bash` requests the original native card; `--tidy-ui-compact bash` keeps the existing compact override and takes precedence. Invalid/non-string command arguments fall back to native presentation; an empty string command is displayable. During argument streaming the card updates when a string command is available.

## 2. Command and comments

Show the entire supplied command, without an argument-length or row cap. Prepend `$ ` once, before its first character. Preserve supplied newlines and indentation. Every subsequent logical or soft-wrapped row starts at the card content origin; add no continuation prefix or alignment spaces. This differs deliberately from ordinary summaries.

Optional comments precede the command in this order:

1. `# <description>` when `description` is a nonempty human-readable string after label sanitization. Render it as one logical comment line, soft-wrapped if needed.
2. `# Running in <directory>` only when a nonempty string `workdir` was explicitly supplied and its resolved path differs from the component's session working directory. Resolve relative paths against that directory and display the absolute, normalized path. Do not inspect the command for `cd`, resolve symlinks, query the filesystem, or infer runtime changes made by other extensions. Equivalent `.`/absolute current-directory paths produce no comment. Every nonempty string workdir requires the native render context's `cwd` to be an absolute string, including when workdir itself is absolute: the context is needed to decide whether the directory differs. If that context is unavailable or relative, retain native rendering rather than inventing a path.

Comments use the same hard-wrapped content layout as the command. A long absolute working directory may span physical rows; wrapping does not change or truncate the logical path.

If any comment exists, insert exactly one empty content row between the comment group and `$ `. Omit this separator otherwise. No tool name, named-parameter list, duration or success/checkmark is added.

## 3. Terminal-style layout and safety

Use the [shared OpenCode-style card frame](card-frame-spec.md): exterior left/right margins P from Pi's Output padding (0 or 1, default 1), left-only `┃` border, and one internal column on each side, plus one top/bottom padding row. At widths >=2P+4 the content origin is column P+2 and its width is the component width minus 2P+3, excluding both internal and both exterior columns. Narrow widths adapt as specified by the shared frame, preserving at least one content column; width zero returns no rows. The adapter adds one outside transcript separator when a visible preceding sibling exists.

Hard-wrap printable text by terminal cell width, preserving spaces rather than using word wrapping. Use Unicode grapheme segmentation and the host's visible-width measurement; never split a combining sequence or wide glyph. A glyph wider than the entire available content width is displayed as a replacement character so the component still fits. Tabs expand to eight-column tab stops relative to the content origin, including the `$ ` prefix on the first command row. This is a text presentation, not a terminal emulator.

Display-only sanitization removes terminal escape/control sequences, bidi controls and zero-width spaces; retain Unicode joining marks used by graphemes (including emoji ZWJ sequences); normalize CRLF and standalone CR to logical line breaks. Preserve other printable characters, newlines and indentation. Incoming ANSI colors are not executed or retained: use the agreed semantic foregrounds. Arguments, result content and stored data are never changed.

Optional native command syntax follows the [syntax contract](syntax-highlighting-spec.md). Logical preparation and gradual/final classification occur outside render. First `blockText` normalizes CRLF/CR and removes display-forbidden terminal/bidi controls; that normalized command is the syntax source and historical-prefix comparison basis. Tabs and newlines remain logical characters until measured layout expands tabs and wraps rows. Parsing offsets refer to normalized source, never raw streamed JSON, prompt columns or expanded-tab cells. Valid structured foregrounds use Pi palette or the selected independent daemon theme; command geometry and full text remain unchanged. For streaming/corrections, the [Bash streaming contract](bash-streaming-contract.md) preserves historical matching-prefix styles, including provisional ones, without treating them as current-source parsing proof. Its compatibility check runs outside render when the prepared command or validated basis changes; rendering consumes the cached, identity-guarded prefix proof. New glyphs use the ready palette's command-neutral role (`toolTitle` under Follow Pi), with the whole-grapheme first-scalar exception. Without a compatible native basis, the entire command uses that neutral role; never invoke Pi's highlighter for Bash. Output/comments/footer use their semantic roles from the same ready palette and are not syntax sources. Argument completion is independent of process completion.

## 4. Output and streaming

Output means the text content returned by the tool, in content-block order, joined with newlines. It does not mean raw stdout reconstructed from other sources. Display partial results as they arrive through Pi's existing updates; do not append overlapping snapshots, rerun commands, or poll. Final results replace partial snapshots.

After display-only sanitization, an output consisting only of whitespace produces no output section. Remove whitespace-only logical rows from the two edges; preserve interior blank rows and the indentation/trailing spaces of nonempty rows, subject only to the presentation exceptions below. Apart from the narrowly specified display exceptions below (including the own-task annotation), do not recognize or remove task messages, `(no output)`, exit descriptions, compression summaries or other semantic output fragments.

One semantic exception is an exact duplicate of the card's own **final nonzero exit footer**. Derive the complete plain, unwrapped footer from the persisted metadata as in section 5 before inspecting output. After ordinary trailing-edge blank removal, remove one terminal logical row only if it equals that footer byte-for-byte after the existing display sanitization and its immediately preceding logical row is whitespace-only. The removed blank separator is then an output-edge blank, so trim the remaining edge blanks normally. Eligible footers are `[exit code: N]` and `[exit code: N; error: execution failed]`. Do not trim the footer row itself to make it match, remove an interior occurrence, repeat the removal, or infer a code/error from text. Missing separators, unequal text/codes, indentation/trailing spaces, partial results, zero/unknown/string codes and error-only literals remain ordinary output. Apply the exception in both collapsed and expanded cards, before wrapping/cutoff/overflow detection; when the duplicate was the only output there is no output section. Raw result content, model content and session data remain unchanged.

A second approved semantic display exception handles one exact terminal timeout block. Only for a final result with persisted numeric `details.exit_code === 124`, after ordinary trailing-edge blank removal, recognize the two consecutive logical rows `[command timed out]` then `[exit code: 124]` when their immediately preceding logical row is whitespace-only. Match each row byte-for-byte after the existing display sanitization; do not trim its indentation/trailing spaces, accept a gap between the pair, or match an interior pair. Remove the two rows and trim the remaining output-edge blanks normally, then use `[exit code: 124; error: command timed out]` as the single completion footer, whether or not `isError` is true. Apply this before wrapping/cutoff/overflow detection in collapsed and expanded cards. Partial results, unknown/string/other codes, code 124 alone, unseparated or mismatching pairs retain their ordinary policy. Remove at most one terminal block of either kind per presentation; do not rescan a newly exposed suffix. The ordinary exit-duplicate exception still applies independently when the timeout pair does not match.

This timeout rule is explicitly a presentation convention, not producer detection or reliable process-cause classification. AFT supplies the timeout marker in text but no supported persisted timeout-cause field. A command printing the identical separated terminal pair with code 124 is indistinguishable and receives the same display. Reliable classification would require a structured persisted cause from the producer. Never derive an exit code from output, treat every code 124 as a timeout, or rewrite result/model/session data.

For nonempty output, add exactly one empty content row after the command, then show the first **10 visual rows after wrapping**. When more rows are available, remove whitespace-only rows from the **end of that ten-row preview** and append `… (Click to expand)` immediately after the remaining preview. Do not backfill removed rows with hidden later text; preserve interior preview blanks. This also applies to whitespace-only soft-wrapped rows. If the entire preview is blank, show only the hint after the normal command/output separator. At very narrow widths only this hint may be shortened to fit. Expanded cards show all available visual output rows (including those interior blanks) and omit the hint. The command/comments are never subject to the output limit.

Expansion exposes only text already supplied by the tool. Do not read `output_path`/other files, undo compression, reconstruct upstream truncation, or fabricate missing earlier output. AFT background-launch and task-status messages are ordinary output, not a separate inferred process status. Successful background launch means the tool call returned, not that the underlying process exited.

### AFT task annotations

AFT 0.60.0 appends one `[task bash-<16 lowercase hex digits>]` row to a final foreground result; `runon` may use `[task bash-<id> (job <nonempty token>)]`. It follows exit/timeout diagnostics, precedes any `shown N of M lines (cap)` trailer, and may be followed by Pi-plugin reminders. The same ID is persisted as `result.details.task_id`. See the pinned [native formatter](https://github.com/cortexkit/aft/blob/988f4f3e52b9b825ad71cc75e41352dc6856efa4/crates/aft/src/commands/bash_orchestrate.rs#L946-L1067) and [Pi result mapping](https://github.com/cortexkit/aft/blob/988f4f3e52b9b825ad71cc75e41352dc6856efa4/packages/pi-plugin/src/tools/bash.ts#L949-L976).

For final results with that exact structured task-ID format, omit at most one matching annotation: the last exact raw whole logical row naming that same ID in one text block. The optional job token has no whitespace or parentheses/brackets. Recognition happens before display sanitization; indentation, trailing spaces, inline fragments, ANSI-decorated literals, other IDs, absent/invalid metadata and fragments split across content blocks remain ordinary text. Earlier identical rows also remain literal. This is a metadata-qualified presentation convention, not authenticated provenance of the text.

Remove the annotation and one adjoining line separator without inventing a blank row, including at text-block boundaries and CRLF/standalone-CR edges. A task-only text block contributes no output. Then apply the existing joined sanitization, reminder extraction and strict exit/timeout rules unchanged. The annotation consumes no preview rows, cannot create an expansion hint, and is never rendered in either collapsed or expanded cards. Cap trailers and background-launch/status prose remain ordinary output; do not search behind them for exit status. Command arguments, tool/model/session data and native opt-out rendering stay unchanged. Partial snapshots retain their ordinary output policy because AFT adds this annotation only to terminal replies.

### Trailing system reminders

For final results only, separate a contiguous terminal group of complete `<system-reminder>` blocks before applying the existing exit/timeout rules. AFT can append a separate text content block containing several reminders, or embed a reminder at the end of an existing block. Keep the existing joined-text sanitization/CRLF semantics, while preserving text-block provenance for recognition; never pair an opening in one block with a closing in another. If a cross-block terminal-control sequence makes those boundaries ambiguous after sanitization, keep the tail ordinary rather than guessing. Tags must occupy exact whole logical rows after sanitization, without trimming indentation or trailing spaces. Blocks may be adjacent or separated by whitespace-only rows. The first embedded opening must be at the start of its content block or preceded by a whitespace-only row. Remove only the blank separators exposed at the ordinary output edge; preserve order, tag text, body indentation and interior blank rows within the reminder group.

Do not extract interior reminders or scan past trailing ordinary text. Incomplete, malformed or nested candidates stay ordinary output; never salvage an inner fragment of a nested/unclosed block. Indented tag literals inside a reminder remain body text. Identical valid suffixes printed by a command receive the same presentation: this is a text-layout convention, not authenticated AFT provenance. Partial snapshots stay ordinary output until the final replacement.

After separation, run section 4's strict exit/timeout handling once on the remaining output. Do not search for earlier status rows or broaden matching for timeout-reason text. Plain cap trailers such as `shown N of M lines (cap)`, launch/background messages, recovery/compression notices and Git/search/schema hints remain ordinary output, even when they prevent a preceding exit/timeout match. Reminder contents may describe unrelated tasks: they never supply the current command's exit code, error flag, timeout cause or border state.

Render the reminder group after the completion footer, or after ordinary output if no footer exists, inside the same frame with one empty separator row and `muted` foreground, like the command comments. These are agent-facing notes, not operator warnings. Keep the original tags visible. It has its own first-ten-visual-row preview, including tag rows, independent of the ordinary output preview; use the same trailing-preview-blank and `dim` expansion-hint policy. Both sections share the component's existing expanded state. A reminder-only overflow makes the whole panel expandable; expanded view exposes all supplied rows of both sections. Command/comments/footer do not consume either preview budget. No new result fields, notification queue, producer interception, file reads or separate reminder cache are introduced. Decompose output, task annotations, reminders and completion labels during width-independent lifecycle preparation outside render. Reuse prepared service data while its service revision is unchanged; resizing or recoloring does not rerun this recognition.

## 5. Completion footer

Derive the exit code and error flag only from structured metadata, never from result text. Section 4's exact timeout-pair convention may enrich the display label, but supplies no status metadata; ordinary duplicate removal compares against the already-derived footer. The supported persisted numeric source is `result.details.exit_code`, a finite integer. Missing/null/string codes are unknown, not zero. Pi 1.0.0's built-in bash provides a live `structuredContent.exit_code` but does not save structuredContent in tool-result messages; intentionally do not use that transient field so live/history presentation agrees without changing serialization. Built-in nonzero exits still expose the persisted `isError` flag and their original diagnostic text.

Only after a final result:

- Section 4's exact timeout block matches: `[exit code: 124; error: command timed out]`, taking precedence over the generic error label.
- Otherwise, nonzero known code, no error flag: `[exit code: N]`.
- `result.isError === true`, known execution/result phase, zero/unknown code: `[error: execution failed]`.
- Known interrupted argument formation: `[error: incomplete tool call]`.
- Error with unknown lifecycle phase: `[error: tool call failed]`.
- Nonzero numeric code and error flag: `[exit code: N; error: execution failed]`.
- Zero/unknown code and no error flag: omit the footer.

Positive execution evidence is `executionStarted === true`, persisted `role: "toolResult"`, or a finite integer persisted `details.exit_code`, including zero. Check it before `argsComplete === false`; `argsComplete === true` alone does not establish execution. Reconstructed Pi components default those flags to false, so they cannot contradict a saved tool result; saved results also establish finite input for replay syntax. Restored interrupted calls likewise have finite saved display text, even though their Bash arguments remain incomplete; one native classification does not execute them or change this label. With no such execution/result evidence, explicit incomplete arguments identify formation failure; absent lifecycle information stays unknown. These phase labels do not infer the error's underlying cause: the tool API has no separate reliable cause field. Do not invent a timeout duration from command arguments. Actual diagnostics remain unchanged except for section 4's two exact terminal-block removals, omission of the metadata-qualified AFT task annotation and the separate presentation of a valid trailing reminder group. Insert exactly one empty content row before a present footer, even if there is no output. Wrap the complete footer when needed; never include it in the output preview count. Partial updates produce no completion footer.

## 6. Theme roles and interaction

The following role names describe **Follow Pi**. A selected independent theme supplies or derives the corresponding complete card palette, including command-neutral text, output, reminders, frame and footer; it does not mix native code colors with a Pi panel. Exterior/stripe backgrounds remain terminal-default. See the [syntax contract](syntax/prepared-cards.md#palette-and-geometry-independence).

- `$ `: `dim`.
- Command: `toolTitle`.
- Comments: `muted`.
- Output: `toolOutput`.
- Expansion hint: `dim`.
- Completion footer: `error`.
- Trailing system-reminder section: `muted`; it never changes the border state.
- Panel body background: `toolPendingBg` regardless of execution state; excludes the stripe cell.
- Border: `borderMuted`, or `error` foreground for final error flag/nonzero known code, exactly matching the completion footer. The stripe's background is terminal default in both cases. Error changes the stripe foreground, not its background or the panel body.
- No hover highlighting, pointer state or dedicated input interception, as specified by the shared frame. No synthetic spinner or process-state text is appended to the command.

Sample/materialize the active palette outside render and publish its prepared roles together with ready syntax. Render consumes those literal styles and color-free measured rows, with no theme callbacks or ANSI-to-layout round trip. A theme change repaints without remeasuring/reflowing; a width change reflows without new parsing/style requests or glyph-width measurement. Shortened hints use prepared plain fragments, preserving their foreground and panel background across explicit resets.

Fullscreen primary-button clicks anywhere in an interactive panel toggle the component's existing `expanded` state when additional output/reminder rows are hidden or available text can be collapsed. This includes comments, command, footer, reminders, border and internal padding, and works during streaming. Exterior margins and the outside transcript separator are not targets. Active text selection suppresses toggling; press/drag/release/wheel/non-primary events retain host behavior. No raw terminal input is observed and no hover state is maintained. Recompute panel geometry after updates, resize, Output padding changes and expansion. Ctrl+O continues using Pi's global expanded state and works in regular mode, where the terminal owns mouse input. See the shared-frame specification for lifecycle and pointer rules.

The [component-owned render-cache contract](render-cache-spec.md) governs reuse/invalidation and optional diagnostics. Each collapsed output/reminder section stops wrapping when eleven visual rows prove overflow rather than computing all hidden rows; trimming preview-edge blanks does not search farther for replacement rows. Expanded output is built on demand. Repeated frames at unchanged width/padding/state reuse body rows and geometry; real width or Output padding changes rebuild once, keeping safe physical columns and click routing.

## 7. Related contracts

The [streaming contract](bash-streaming-contract.md) defines display continuity and work ownership. [Card validation](testing.md#cards-and-native-data) defines the corresponding native-data and physical-terminal checks.
