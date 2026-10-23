# Configuration, theme catalogue and admission

The daemon owns its theme files and catalogue independently of extension preferences. Toolview saves a selected opaque ID; it does not configure the daemon by writing its own settings file. The catalogue supplies immutable native definitions to STYLE, never to SOURCE. Start with the [runtime](runtime.md) for launch/configuration ownership.

## Control execution and publication

`control.rs::Authority` owns the process catalogue and a separately accessible published snapshot. Initial catalogue construction occurs at startup. After startup, only explicit refresh reads catalogue files; `describe` uses the published snapshot.

Refresh requests are serialized through an asynchronous gate. Their filesystem and theme-admission work runs through `spawn_blocking`, not on a parser worker. The blocking task accesses the one process-lifetime `Catalogue`, preserving its admission counters and failed-definition memo across requests.

The published snapshot has a different lock from the mutable catalogue. A `describe` can therefore read the last published catalogue while a refresh is building its replacement. DATA workers continue using immutable snapshots and definitions rather than waiting for directory reads.

After the blocking task returns, the authority checks process liveness again. A changed revision is published through the actor pool’s shared snapshot generation; workers reconcile that generation before their next scheduler tick. There is no sequence of individually sent theme updates that could leave a worker with half a catalogue.

Publication is whole-snapshot replacement, not a synchronous barrier requiring every worker to switch at exactly the same instant. A STYLE job already holding an immutable prepared definition can finish with it. SOURCE continuations remain unchanged.

A catalogue build failure returns the last-valid snapshot together with its new bounded diagnostic. `themes.refresh` can consequently return a descriptor for the retained catalogue rather than replacing it with an empty one. Blocking-task failure and a retired authority use the control-error path instead. Filesystem error strings, selectors and paths are not exposed in catalogue diagnostics.

Caller cancellation does not make a started blocking filesystem operation preemptible. Releasing a caller’s wait must not be confused with rolling back cumulative admission or proving that refresh did not execute.

## Building a complete candidate

`catalogue.rs` separates discovery, raw reading, admission and publication.

First it fixes the configuration path relative to the launch location, including after an unsuccessful lookup. With no explicit override it uses the OS configuration resolver rather than treating the current working directory as an implicit configuration root.

It then reads and validates configuration, resolves directory roots and enumerates them nonrecursively. The visited-entry bound counts directory entries, not only accepted theme files. Candidate files are collected into deterministic ID order before their definitions are admitted.

The bounded reader checks file type before opening, then checks the opened file’s metadata. It limits bytes actually read, not merely the size reported by earlier metadata: a growing file cannot cause an unbounded `read_to_end` allocation. These checks support bounded ordinary file reading; they are not a claim of a race-free filesystem snapshot or a wall-clock deadline for every filesystem operation.

All candidate raw definitions are read under the aggregate bound before theme parsing begins. Each is hashed and processed as follows:

- If the current snapshot has the same ID and content fingerprint, reuse its immutable profile.
- If its digest is a remembered charged admission failure, reject it without consuming another admission attempt.
- Otherwise, pass it through the process-lifetime admission gate and construct an immutable custom profile.

The candidate begins with bundled descriptors and adds every admitted custom entry. Only after the entire build succeeds are descriptors compared with the published snapshot. Equal descriptors preserve the current snapshot object and revision. Changed descriptors produce a new revision and complete snapshot.

A later-file failure can occur after earlier definitions consumed admission. Publication remains transactional, but admission costs do not roll back. In particular, a successfully admitted definition in an abandoned candidate is not silently installed in an unlimited historical cache for future reuse.

## Why custom admission precedes native parsing

Native selector construction can intern scope atoms before returning an error. **Interning** adds names to Syntect’s process-global repository; dropping the resulting theme does not remove those names. Validating only after native theme construction would therefore be too late to bound repeated attempts.

`admission.rs::Admission` has no reset or clone operation. Its staged charges are:

1. An attempt.
2. Raw definition bytes.
3. Decoded selector-name bytes and atom occurrences.

Each stage is checked before its corresponding work. If a later stage fails, earlier charges remain. Within the selector stage, both byte and atom checks must succeed before their new totals are installed. Repeated atom occurrences count even if their spelling was already seen; this is a conservative admission envelope, not an estimate of newly interned unique atoms.

Before selector measurement, structural preflight bounds the representation itself. Only afterward does the code deserialize the plist to the same general value representation used for native theme loading, measure the complete selector material, and validate theme structure and styles. The temporary value tree is destroyed before calling the public `ThemeSet` loader.

A malformed later selector therefore cannot leave earlier valid selectors from that definition newly interned through this admission path. The gate covers custom definitions admitted here, not every possible user of Syntect’s global repository.

### Format-specific structural preflight

Binary plist input is scanned as events before building a value tree. A small binary file can refer repeatedly to the same nested object, producing a much larger expanded event stream; raw file size and cycle detection alone do not bound that expansion. The scanner charges collection nesting, events and expanded scalar payload.

For nonbinary input, the code distinguishes an initial OpenStep/ASCII dictionary from XML without retrying a failed XML framing check as another format. Both formats then pass through the bounded plist event scan.

XML additionally receives a full-document framing pass in `check_xml`. It checks balanced elements, one root, declaration/doctype placement, attributes and references before plist decoding. DTDs are not fetched or expanded. This pass is structural validation, not a second implementation of theme semantics.

After structural acceptance, the semantic checks cover the complete settings array, selector paths and exclusions, scope atom depth, colors and fonts. Only then may Syntect construct native selectors.

## Reuse and lifetime boundaries

The catalogue reuses successful definitions only from its current snapshot. Its failed-definition memo is bounded by charged lifetime attempts. Removing a theme or losing a candidate does not refund custom interning costs.

Bundled profiles have a different lifetime: `profile.rs` loads them lazily into a process-wide cache. Merely enumerating bundled descriptors does not load every theme. Custom profiles are owned by snapshots and other live references, rather than appended forever to that bundled cache.

Worker-local compiled resolvers and palettes form a third layer. Their cache is keyed by advertised ID plus definition fingerprint, and running STYLE jobs retain their own prepared owners. See [prepared native definitions](styles-and-palettes.md#prepared-native-definitions-and-their-owners) for their accounting and publication behavior.

This separation explains why the following observations can all be correct at once: a refresh removed an advertised theme, a previously started STYLE job finished with that theme, its compiled memory remained live until that job released it, and unrelated SOURCE leases were never restarted.

## Daemon configuration

Occipital uses the OS user-configuration resolver plus `occipital/config.json`: XDG config/HOME fallback on Linux, Library/Application Support on macOS, and RoamingAppData on Windows. `--config FILE` supplies an explicit file. `themeDirectories` resolve relative to that file's directory. Missing fresh-install configuration permits bundled themes. Catalogue refresh is explicit and failed refresh retains the last complete catalogue; successful deletion is visible at next use.

These stores are separate: extension preferences choose an opaque theme ID; daemon configuration controls its catalogue. A client does not implicitly copy definitions between providers.

The daemon's JSON object admits only optional `themeDirectories`, an array of directory strings. Absent configuration/field selects `themes` beside the config file; an explicit empty array selects bundled themes only. Present `null`, unknown fields and invalid arrays are rejected. Relative directories are canonicalized beneath the config directory; parent traversal, escaping relative paths, duplicate canonical roots and symlink `.tmTheme` files are rejected. Explicit absolute directories are allowed and are not required to lie beneath the config directory. Enumeration is nonrecursive and considers exact `.tmTheme` files. A missing default directory is tolerated only while it has never been observed; its later disappearance is a refresh failure, not an empty successful catalogue.

Custom IDs are `custom:` plus 56 SHA-256 hex digits over the domain `occipital-custom-v1` followed by NUL, canonical-root native bytes, NUL and filename UTF-8. They identify a location, not content: editing bytes changes the full SHA-256 definition fingerprint, while moving/renaming a theme can change its ID. Labels come from the filename stem, replace control characters with spaces and truncate at a UTF-8 boundary. Clients use IDs, not labels, as identity.

Refresh constructs a complete bounded candidate before atomic publication. An unchanged candidate preserves the snapshot and revision; failure preserves the last-valid snapshot **and already-consumed admission charges**. STYLE resolves immutable advertised theme identities rather than rereading theme paths on requests; SOURCE remains theme-free. Unchanged live definitions reuse their existing profile. Failed charged admissions are remembered by definition digest; there is no successful retired-definition cache that pretends dropping a Theme undoes Syntect interning.

| Catalogue boundary | Limit |
| --- | --- |
| Custom themes / one definition | 16 / 128 KiB |
| Aggregate candidate definitions / config file | 2 MiB / 16 KiB |
| Configured directories / total visited entries | 8 / 1,024 |
| Path / label bytes | 4,096 / 128 |
| Per-definition union branches / selector paths | 512 / 4,096 |
| Scope atom depth | Syntect maximum 8 |
| Plist nesting / expanded events / expanded scalar payload | 128 / 8,192 / 128 KiB |
| Process-lifetime attempts / definition bytes | 64 / 8 MiB |
| Process-lifetime decoded selector bytes / atom occurrences | 256 KiB / 4,096 |

These are fixed component guards, not config knobs. Admission charges attempt, then raw definition bytes, then decoded selector bytes and atom occurrences before their respective unsafe parsing/interning boundaries. Denied later stages do not refund earlier stages; failed refresh/removing a theme cannot reclaim global interned atoms. Repeated and empty interior atoms count as occurrences rather than distinct names. Structural validation precedes native selector construction because construction itself can intern before reporting an error. This authority covers custom definitions, not bundled assets or unrelated users of Syntect's global atom repository.
