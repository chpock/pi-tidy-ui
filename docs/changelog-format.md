# Changelog helper format

`scripts/release/changelog.mjs` validates authored product histories and projects their entries into release notes and extension-package Markdown. It does not choose versions, change authored files, invoke Git, publish releases or access the network.

## Product paths

The exported `changelogPaths` map has exactly two products:

| Product | Repository-relative path |
| --- | --- |
| `pi-tidy-ui` | `CHANGELOG.md` |
| `occipital` | `docs/occipital/CHANGELOG.md` |

The native history is documentation outside the compiled native-source identity. `await loadChangelog(root, product)` reads only the mapped UTF-8 file, validates its complete contents and returns the original text. It rejects unknown products, invalid root arguments, invalid contents and read failures; it never substitutes the other product's history.

## Authored Markdown

Use exactly these H2 headings, without indentation, trailing spaces or closing hashes:

```markdown
# Product changelog

Optional introductory prose.

## [Unreleased]

### Added

- Changes not yet released.

## [1.2.0] - 2026-11-03

### Changed

- A released change with an [absolute link](https://example.com/details).
```

There must be exactly one `Unreleased` entry, before every released entry. It may be empty, including a history with no releases yet. Every other H2 must contain an exact publishable SemVer and a real Gregorian calendar date in `YYYY-MM-DD` form (years `0001`–`9999`). `0.0.0` is reserved for development; build metadata (`+...`) is not supported by npm publication. Prereleases are allowed. Versions must be unique and strictly descending by full SemVer precedence, not lexical or floating-point comparison: stable `1.0.0` precedes `1.0.0-rc.10`, which precedes `1.0.0-rc.2`. Numeric components have no JavaScript safe-integer restriction. Release dates need not follow version order.

Use H3 for sections inside an entry. Unknown or malformed H2 headings, including introductory H2 headings, are errors. The scanner recognizes ATX headings and backtick/tilde fenced code blocks with up to three leading spaces. A closing fence must use the opening character, be at least as long and have no trailing text. Backtick opening-fence info cannot contain backticks. Headings inside correctly fenced code are literal content, not entry boundaries. Unclosed fences, including introductory fences, are errors. This is a restricted changelog format, not a general-purpose Markdown parser.

A single ordered scan keeps the current entry and fence state local to one parse. Entry-boundary admission validates version identity/order before finalizing the preceding body; finalization slices the normalized source lines rather than reconstructing Markdown. SemVer ordering compares numeric core components first, then the complete prerelease suffix (preserving identifier hyphens), then individual prerelease identifiers and their count.

Released bodies must contain meaningful content: nonblank code inside a fence, or text beyond headings, HTML comments, thematic rules and empty list/quote markers. Empty scaffolding is not a release description, including quoted headings and thematic rules; actual quoted prose remains valid. `### Occipital dependency` is reserved for generated output outside fenced code (also case-insensitively and with optional closing hashes); do not author that section in either history or `Unreleased`.

Author links as absolute URLs so entries work independently on GitHub, npm and in a package. The helper does not rewrite or resolve authored relative links.

## Pure projections

`parseChangelog(text)` returns an ordered array of `{ version, date, markdown }`. `Unreleased` has `date: null`; releases retain their authored date. `markdown` contains the entry's exact heading and body, including separating blank lines, with CRLF/CR normalized to LF and a final newline added when absent. Introductory content is not returned. Non-string input is rejected.

`releaseNotes(text, version, occipitalVersion?)` validates the whole history and returns only the exact requested released entry, never its neighbors or `Unreleased`. Missing or unpublishable versions fail. Without a native version its output is the entry's `markdown` unchanged. With an exact publishable native version, it preserves the entry's Markdown, adds a blank-line separator only if needed and appends this generated footer:

```markdown
### Occipital dependency

This release packages Occipital [0.3.0](https://github.com/chpock/pi-tidy-ui/releases/tag/occipital-v0.3.0). Shared services are selected by protocol compatibility, not by this packaged version.
```

The link names the exact native version/tag. The wording describes packaged dependency identity, not the version of a shared service actually selected at runtime. Supplying an invalid native version fails. Consumers can use this same projection for GitHub notes and the current npm-package entry.

`extensionChangelog(text, version, occipitalVersion)` requires both exact publishable versions and an existing current entry. It emits a short `# pi-tidy-ui changelog` heading and an absolute [full-history link](https://github.com/chpock/pi-tidy-ui/blob/main/CHANGELOG.md), followed by released history at or before the current version. It omits `Unreleased` and all future versions. Stable packages also omit every prerelease entry because Pi 1.5 compares only numeric version components. Prerelease packages may retain both stable and prerelease history at or before the current full SemVer; their caller must disable Pi's numeric-only tracking (set `pi.changelogPath` to an empty string). Only the current entry receives the native footer, using the same projection as `releaseNotes`; older entries are preserved rather than assigned today's dependency version. Pi's reader also treats column-zero `## ` lines inside code as entry boundaries. Stable package projection rejects those literal example headings rather than emitting false updates or truncating notes; indent such example lines. The canonical history and standalone release-note reader still permit fenced examples.

Behavioral coverage is in `tests/harness/delivery/changelog.test.mjs`, executed through the [prepared delivery harness and verified local scope](testing.md).
