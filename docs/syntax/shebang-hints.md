# Shebang-derived source hints

A shebang can select a grammar when a successful `edit` or `write` card exposes the file's first source line. The extension recognizes a reviewed interpreter spelling and sends the resulting canonical format through the existing `hint.language` field. The protocol describes only a requested language; it does not know whether the caller obtained that value from a shebang or another source. No interpreter is executed, and Occipital never searches source text for a shebang.

The wire interpretation is versioned by [`source_hint_revision`](../occipital/protocol.md#descriptor-and-metadata-operations). This chapter owns the client alias table and when the hint is attached; [the Occipital source engine](../occipital/source-engine.md) owns grammar precedence and parser state.

## Where the first line comes from

`prepareFileCard` receives completed file-tool input and produces numbered source rows before the display sanitization pass. The original row text is available at that boundary, including terminal controls which the displayed/parser text may subsequently remove. The detector runs against the original row; it must not turn ordinary text containing a control character into a valid shebang by first deleting that character.

The saved card coordinates are authoritative:

- For a numbered patch, `old=1` and `next=1` independently identify the first lines of the old and new file. A context row can identify line 1 on both sides. A hunk beginning at line 8 cannot.
- For supplied `write` content, `next=1` identifies its first file line.
- Each side's detected format is attached as `hint.language` to every prepared source fragment for that side, including fragments after omitted ranges. A gap interrupts parser text continuity, not the identity of the file whose grammar is being selected.

If exactly one side yields a recognized shebang, its canonical format is assigned to both sides: the side without a recognized shebang is treated as having the same format. If both sides yield recognized shebangs, keep their formats independent. If neither does, no explicit language is supplied and Occipital can use the filename path. This is a producer decision about the versions being compared, not a protocol-level shebang fallback.

A failed/incomplete tool operation or unsupported patch produces no file source and therefore no shebang work. The extension does not read the target file, infer a missing first line from another card, or inspect later hunks.

## Detector and maintained interpreter map

The input is exactly one source row, without its line ending. `MAX_SHEBANG_BYTES` is **1,024 UTF-8 bytes**. A longer row is ignored, not truncated and partially interpreted. One trailing CR is accepted for CRLF-normalized input. A candidate must start at byte/string offset zero with `#!`; BOM, leading whitespace, embedded line breaks, NUL or control characters other than horizontal tab reject the candidate. Spaces and tabs are accepted as separators after `#!` and between the command and optional argument; they are not removed from inside a token. Command names are case-sensitive.

The client uses a curated interpreter-to-Syntect map, not an open-ended executable database. Other reviewed names are:

| Canonical format | Interpreter command basenames |
|---|---|
| `awk` | `awk`, `gawk`, `mawk`, `nawk` |
| `bash` | `bash`, `sh`, `dash`, `ash`, `ksh`, `zsh` |
| `coffeescript` | `coffee` |
| `clojure` | `clojure`, `bb` |
| `elixir` | `elixir`, `iex` |
| `erlang` | `erl`, `erlc`, `escript` |
| `groovy` | `groovy` |
| `haskell` | `ghci`, `runghc`, `runhaskell`, `runhugs` |
| `java` | `java`, `jshell` |
| `julia` | `julia` |
| `kotlin` | `kotlin`, `kotlinc` |
| `lua` | `lua`, `luajit` |
| `ocaml` | `ocaml`, `ocamlrun` |
| `perl` | `perl` |
| `php` | `php` |
| `powershell` | `pwsh`, `powershell` |
| `python` | `python`, `python2`, `python3`, `pypy`, `pypy2`, `pypy3` |
| `r` | `Rscript` |
| `racket` | `racket`, `raco` |
| `ruby` | `ruby`, `jruby`, `truffleruby`, `macruby`, `rake`, `rbx` |
| `rust` | `rust-script` |
| `scala` | `scala` |
| `swift` | `swift` |
| `tcl` | `tclsh`, `wish` |
| `typescript` | `tsx`, `ts-node`, `ts-node-esm` |
| `javascript` | `node`, `nodejs` |

Direct paths use Unix `/` separators and are reduced to the final path component before lookup; backslash-separated and drive-letter paths are not accepted. Only these numeric version forms are normalized; each suffix component is decimal:

| Interpreter family | Accepted versioned basenames |
|---|---|
| Python | `python2[.N…]`, `python3[.N…]` |
| PyPy | `pypy[.N…]`, `pypy2[.N…]`, `pypy3[.N…]` |
| Node | `nodeN[.N…]`, `nodejsN[.N…]` |
| Ruby | `rubyN[.N…]` |
| Lua | `luaN[.N…]` |
| Perl | `perlN[.N…]` |
| AWK | `awkN[.N…]`, `gawkN[.N…]`, `mawkN[.N…]`, `nawkN[.N…]` |
| PowerShell | `pwshN[.N…]` |

Here `N` is one or more ASCII decimal digits; `[.N…]` means zero or more dot-separated numeric components. The implementation accepts only the shown families, not arbitrary suffix stripping. No shell is invoked and executable arguments do not alter the selected grammar.

The alias list is informed by GitHub Linguist's [`languages.yml`](https://github.com/github-linguist/linguist/blob/73ee9a3b277f398c37ca4ab0dea0193849de6460/lib/linguist/languages.yml) and [`shebang.rb`](https://github.com/github-linguist/linguist/blob/73ee9a3b277f398c37ca4ab0dea0193849de6460/lib/linguist/shebang.rb), pinned at commit `73ee9a3b277f398c37ca4ab0dea0193849de6460`. Linguist is a discovery reference, not a runtime dependency or a promise to support every interpreter it knows. Each alias is deliberately accepted only if it resolves to one canonical grammar shipped in this Occipital build. When adding an alias, verify that exact grammar is present and has one unambiguous meaning; update the detector tests and bump `source_hint_revision` if wire interpretation changes.

## `/usr/bin/env` forms

A direct path to `env` is recognized by its basename. Two bounded forms are supported:

1. Plain `env` followed by exactly one command word, such as `#!/usr/bin/env python3`. Extra words are not treated as arguments to the command: on systems following the kernel shebang contract they are part of one optional argument, not shell-tokenized words.
2. `env -S` followed by simple whitespace-separated words, such as `#!/usr/bin/env -S python3 -u`. Only the first word after `-S` chooses the grammar. The supported subset has no quotes, escapes, variable assignments/substitutions, leading options or option-processing before the command. If the detector cannot determine one command with this subset, it returns no hint.

GNU `env -S` has a richer split-string grammar; this extension intentionally does not reproduce its quoting/escape/variable semantics. Unsupported but otherwise valid shebangs simply do not provide this optional hint. The implementation does not claim to validate whether a shebang will execute on a particular operating system.

## SOURCE precedence and failure behavior

The producer passes a recognized shebang format as the existing `hint.language` selector. Occipital does not distinguish this from a format selected by another caller. Resolution is:

1. A non-empty `language` is explicit and has priority over the path. Occipital tries its known aliases, syntax names and extensions. If it does not resolve, the result is `unknown_syntax/not_started`; the daemon does not silently fall through to the path.
2. An omitted, null or empty `language` means no explicit selector. Occipital then uses the optional path basename/extension if present.
3. If neither selector resolves a grammar—including a pathless text with no explicit language—the result is `unknown_syntax/not_started`. There is no arbitrary content sniffing or implicit Plain Text selection; Plain Text must be selected explicitly.

Consequently, a detected shebang overrides even a recognized file extension such as `.txt`, and a generic explicit language also works without any path. A malformed field shape is `invalid_request/not_started`, not an unknown format. `unknown_syntax/not_started` is an expected no-start outcome: retain the currently permitted Pi/native-neutral fallback rather than reporting a daemon failure. Started parse failures, transport errors, busy/limit refusals and malformed replies keep their distinct behavior; selecting a language does not retry or mask them.

## Source identity and diff painting

The selected `language` is part of SOURCE identity alongside text version and path. If the first line changes its recognized format while the displayed body stays the same, the owner advances its SOURCE identity and parses under the new grammar. A warm frame, width change or unrelated card does not itself create another SOURCE request. Styling and geometry identities remain independent of the grammar selector.

For a streaming SOURCE, `stream.open` captures `language` with the parser state; `stream.append` cannot replace it. A changed selector requires the caller to retire that continuation and open a new source identity. File cards derive the selector from a shebang; other callers can provide an explicit language directly, including pathless text.

For a one-sided recognized shebang, both diff sources share the same hint. When both versions have different recognized shebangs, each SOURCE is resolved independently. In split view, removed rows and shared context on the left use the old source; added rows and shared context on the right use the new source. In unified view, a shared context row appears once and uses the new-side source. This makes a format change visible on both sides without duplicating a unified row.

## Versioning and compatibility

The descriptor's exact integer `source_hint_revision: 2` advertises this interpretation. A consumer accepts only the revision it implements and must reject a helper with revision 1 before sending SOURCE requests. Revision 2 defines the existing generic `language` selector's absent/null/empty behavior, its priority over an optional path and pathless operation. It is distinct from contexts, resolver and palette revisions. Changes to the SOURCE wire interpretation require a coordinated TypeScript/Rust update, a `source_hint_revision` bump and a matching helper rebuild. Expanding only the client’s interpreter aliases to an already-supported canonical language requires detector/protocol-vector and end-to-end tests; it does not by itself change the daemon’s wire interpretation. Historical published Occipital v2 binaries remain immutable and are not made compatible by this source change.

The canonical wire contract is [Occipital protocol](../occipital/protocol.md#source-input-and-syntax-hints); extension-side capture and identity are detailed in [prepared cards](prepared-cards.md) and [SOURCE scheduling](work.md). Validation procedures remain in [testing](../testing.md#syntax-and-palette-validation).
