# Syntax highlighting

This contract describes Toolview's implemented Occipital consumer, not a claim that native packages have been published. The repository-only `docs/syntax-highlighting-plan.md` records the approved design and remaining release/acceptance gates; it is not shipped as runtime documentation.

## Surfaces and source text

- Native classification applies only to Toolview's Bash command and successful edit/write source bodies. Bash output, ordinary summaries, Markdown, user messages, the editor and native delegated cards are outside this feature.
- Bash argument updates prepare the latest command outside `render`. Pi's `setArgsComplete` finalizes the input independently of tool execution: a still-running Bash process does not require an unfinished syntax lease. Persisted completed calls use one-shot classification.
- A final native error while Bash arguments are still incomplete retires that source and attempts lease closure outside `render`, without pretending that arguments completed or a tool executed. Late replies cannot restore it; warm frames cannot reopen it. Partial error output and execution errors after argument completion do not abandon the source.
- Edit/write use validated supplied source/diff data. Old/new sides are separate logical sources; a missing diff region starts a new parser context. No file reread or invented continuity across omitted context is permitted.
- Parsing sees logical source before tab expansion and terminal normalization. Painting projects structured ranges onto existing display text, with unchanged glyphs, wrapping, gutters, context, tint, padding and mouse bounds. Existing ANSI style isolation remains authoritative.
- Classification does not modify tool arguments/results, execute tools, send model requests or alter saved conversation entries.

## Rendering and fallback

Preparation, encoding, requests and classification occur outside terminal rendering. Rendering borrows already validated ranges or an exact prepared fallback; it never waits for a daemon. Keyed coalesced source notices invalidate only affected owners, without traversing transcript history to discover changes.

The canonical `SourceController.workStatus` determines whether Pi classification is allowed. Queued, running or uncertain daemon work blocks a duplicate Pi parser within the same installed adapter. Missing state, cancellation, timeouts and provider absence are not evidence that parsing never started or has physically finished.

| Situation | Presentation |
|---|---|
| Current validated native ranges | Use the current selected/effective profile |
| Growing command with reusable committed colors | Reuse the proven prefix; display every remaining character |
| Native work not started or unavailable, Bash | Existing whole-command `toolTitle` foreground; **never call Pi's highlighter** |
| Native work not started or unavailable, file source | Pi's public highlighter once for the useful exact source/palette; retain the result |
| Native work queued/running/uncertain | Valid retained colors/proven prefix, otherwise complete uncolored text |
| Source/result cannot be retained or admitted | Complete text, with only any valid reusable classification |

Pi fallback preserves public foregrounds and bold/faint/italic/underline semantics, including SGR `22` clearing both bold and faint. File backgrounds remain Toolview-owned. Faint is local Pi projection data; the daemon's independent-theme wire contract retains its three font bits.

There is no millisecond budget, cold/warm timing gate, cooldown, sampling heuristic or per-frame classifier retry. A synchronous Pi fallback remains synchronous; moving it outside `render` does not make it an asynchronous parser. Exact source/palette reuse prevents ordinary repeated fallback work.

Pi fallback and native ranges share the existing bounded source/color retention pool. Width changes reuse classification and rebuild only required presentation. Pi-palette generation follows the public cached `theme.colors` identity, not the stable `ctx.ui.theme` proxy identity. A different independent syntax theme legitimately requires current-demand reclassification; it does not request a background replay of every retained tool.

Pi loads some grammars after its initial history paint. An early Pi fallback for such a language may remain uncolored in the exact cache even after the grammar loads, until the source, palette or presentation owner changes. This visual limitation is explicitly accepted: no readiness polling, private Pi hook or classification-cache reset on general screen invalidation is added. It does not remove text or affect native-daemon classification.

## Long lines and grammar limits

Occipital uses Syntect 5.3.0 with two-face 0.5.2 assets. These are syntax grammars, not a language server: identifier/declaration distinctions depend on the available grammar scopes and are not semantic symbol resolution or identical OpenCode highlighting.

Each logical line/provisional tail classifies at most its UTF-8-safe **64 KiB prefix**. Its entire suffix remains present as Plain. Parser state from the classified prefix carries into the next line; skipped suffixes can therefore make later context/colors inaccurate. No fabricated newline, source truncation or line-length-only rejection is used. Appends beyond an already saturated prefix add no parser calls.

For ordinary appends, completed lines are reused and only the provisional tail/new suffix is parsed. A nonappend correction, expired lease or lost daemon state permits an explicitly counted bounded full-source resynchronization. Syntect's regex call cannot be interrupted inside a line; cancellation/yielding occur between lines/phases. No hard real-time guarantee is claimed.

## Providers and lifecycle

An eligible interactive adapter starts asynchronous selection automatically. Print/JSON/RPC loading, an inactive extension or constructing the client does not start a helper.

1. Try a user-managed compatible Subconscious internal service using the public SDK/discovery contract. A connection file alone is not proof that Occipital is available.
2. If none is usable, resolve the extension-declared **exact** owned Occipital release for the actual OS/architecture/ABI. Verify the installed payload or exact cache bytes; otherwise acquire that declared artifact. Never substitute a newer cached version or query a latest release.
3. If neither provider is obtainable, keep the ordinary fallback described above. Native availability does not gate tool execution or input.

The extension and Occipital versions/releases are independent. Compatible shared-service versions need not equal the standalone pin. Owned processes have one client owner and are closed/reaped on retirement; shared clients close only their own route/connection and never terminate the shared module or peers.

Confirmed owned-process loss allows at most **two consecutive automatic restarts**. Only a validated useful current native source result resets that chain; metadata, stale results and cache reads do not. Deliberate session re-enablement permits a fresh attempt after exhaustion.

Confirmed established shared loss permits bounded reconnect and owned takeover. Record whether shared service was usable at initial startup. Only an initially shared client that fails over gets one return window: one probe per **60 seconds for 600 seconds**, at most one active probe, no catch-up burst or extension from failed probes/source changes. A successful verified return retires and reaps only its owned helper before new shared source work. Initial standalone clients have no periodic shared probes. Off/disposal clears candidates and recovery timers.

Daemon state is disposable. Replies must match provider/source/profile generations and exact replacement coverage before publication. Lease expiry/state reset and stale responses cannot paint another source/version. A transport end does not by itself prove that a shared parser did not run.

### Ownership exception

Temporary hidden/expanded/unsupported presentation and session-native-off retain the same adapter's canonical work evidence. Complete adapter removal/reinstallation, including master off/on or reload, disposes its consumer and may allocate fresh source keys. An occasional repeated highlight while old work remains unsettled is explicitly accepted there; no cross-adapter owner registry or delayed installation is introduced. Normal cleanup, weak collection and rejection of late old-owner colors still apply.

## Menu and preferences

`/toolview syntax` opens one public Pi management menu:

- **Theme:** Pi palette plus the active daemon's catalogue; show selected and effective themes separately. Listing is not a reload. A public scrolling `SelectList` keeps the selected row visible in larger catalogues.
- **Reload themes:** explicitly reload the active daemon catalogue. No watcher, update polling, daemon restart, file upload or provider selector.
- **Service status:** cached provider/lifecycle, daemon/protocol/standalone versions, selected/effective theme and bounded last issue. No source text or new source work.
- **Enable / Disable for this session:** native-only activation. Disable closes owned resources without stopping a shared module. It persists across master Toolview off/on, but a fresh extension runtime is enabled again.
- **Close / Back:** no preference change or save. Retired menu epochs cannot publish late selections/actions.

Opening/status/cancelling cannot enable a disabled provider. Pi palette remains selectable without a live catalogue. Errors are Pi UI notifications, not conversation/model messages.

Only `syntaxTheme` is persisted through the common settings reader/writer:

```json
{ "syntaxTheme": { "kind": "pi" } }
```

or `{ "syntaxTheme": { "kind": "occipital", "id": "<catalogue ID>" } }`.

The file is `join(getAgentDir(), "extensions", "pi-tidy-ui", "config.json")`; Pi resolves the agent directory and its `PI_CODING_AGENT_DIR` override. This future-facing preference path does not rename the current extension/package/command. No enablement, provider, retry, lease, source or expanded theme data is saved.

Missing configuration defaults to Pi palette without writing. Invalid/unreadable files and failed/cancelled saves report bounded errors rather than rewriting them or claiming success. Updating the one known field preserves unrelated keys, serializes writes per client and replaces a complete file. Across clients, the last published choice becomes the default for future launches; already-running clients keep their own preference. No settings watcher, database, migration or cross-process lock service is added.

An independent selected theme remains fixed across Pi theme changes. If unavailable on the current daemon, retain its saved ID, use the Pi-palette profile, and show one error for that unresolved episode. A later compatible catalogue/provider restores it on current demand. Theme definitions remain daemon-owned.

### Daemon configuration

Occipital uses the OS user-configuration resolver plus `occipital/config.json`: XDG config/HOME fallback on Linux, Library/Application Support on macOS, and RoamingAppData on Windows. `--config FILE` supplies an explicit file. `themeDirectories` resolve relative to that file's directory. Missing fresh-install configuration permits bundled themes. Catalogue refresh is explicit and failed refresh retains the last complete catalogue; successful deletion is visible at next use.

These stores are separate: extension preferences choose an opaque theme ID; daemon configuration controls its catalogue. A client does not implicitly copy definitions between providers.

## Protocol and resources

The current application protocol is versioned **JSON v2** with positive length/style pairs on the wire and codec-independent canonical ranges. Owned stdio uses bounded big-endian length framing; shared requests use the public Subconscious SDK. Encoding/decoding and run packing stay at transport boundaries so a future public binary-response API does not require rewriting parser/session/scheduler state. No speculative binary carrier or codec framework is implemented.

Current generous protective bounds are for exceptional accidental overload, not small-host requirements:

- 64 MiB supplied/cumulative UTF-8 source and independently 64 MiB actual encoded data frames; escaping/output density can prevent a boundary-size source fitting a frame.
- 1 GiB client captured-source/classification/native-bridge allowance, with no independent entry/row ceiling; in-flight codec storage is accounted separately.
- At most two unsettled client data calls, including abandoned ones, and one append per source; batches contain at most eight sources.
- Shared application ledger: 1 GiB controlled input/queue/output/checkpoint allowance, sixteen outstanding data jobs across eight routes, 4,096 leases globally/512 per route. Leases expire after five minutes idle or one hour total age; no no-op heartbeat renewals.
- Native data-call deadline: five minutes. A no-start refusal must precede source parsing; metadata has an independent lane. Catalogue read-wait expiry on a running provider does not tear down unrelated highlighting or discard its unsettled reservation.

Negotiated daemon descriptors and actual encoding checks remain authoritative. Parser heaps, Node/V8 transients, private SDK buffers and whole-process memory are not equated to application charges. The public Rust SDK retains bodies before Occipital handlers and has no aggregate pre-handler byte-refusal API; existing route/count/backpressure and application refusal are **not a hard RSS/OOM guarantee**. The approved plan preserves that qualified boundary rather than altering Subconscious or inventing a workaround. No ordinary-workload cache-thrashing limit is added.

## Delivery status and verification

The standalone helper is pinned to the verified public **Occipital `0.1.3`** release in `src/occipital/release.ts`, independently of the extension version. It includes exact URLs, SHA-256 hashes and payload-size bounds for GNU Linux x64/arm64, macOS x64/arm64 and Windows MSVC x64/arm64. Musl is not mislabeled GNU. A compatible shared service remains preferred; absent that, startup uses an exact verified installed payload or cache entry, downloading the pinned artifact when missing. No Rust toolchain, external Subconscious service, source build or latest-release lookup is required. Unavailable native capability preserves fallback.

Native npm payload names use **`@kchpock/occipital-*`**. Payloads contain the exact executable, LICENSE/third-party NOTICE and package metadata, with no JS client duplication, installer or helper-startup script. These packages are prepared but not yet published or referenced as native optional dependencies. Native-only npm publication is authorized after verifying a release compatible with the selected GNU baseline and obtaining valid npm authentication; extension publication remains separate. The working GitHub acquisition path does not depend on that npm step.

The six public binaries have release-CI protocol/build/packaging evidence. The normal installed-extension path, including the real pinned download when both optional payload and SDK are absent, has clean-consumer evidence on all six current native CI runners and both supported Node runtimes, plus physical Pi CLI evidence on GNU Linux x64. Current-runner success does not establish minimum supported OS versions. The selected GNU baseline is glibc 2.28 for both architectures; the adopted `0.1.3` executables actually require glibc 2.34, so a newly built, natively verified release is required before claiming the selected baseline. The Windows `0.1.3` binaries statically link their compiler runtime: both published executable import tables omit external VC++ runtime DLLs and their same-run native protocol checks pass. System Windows DLLs remain required. Runtime updates require a new Occipital build/release; `0.1.2` remains unchanged. GNU baseline verification/adoption and native npm delivery acceptance remain required before closing G5.

See [testing](testing.md) for reproducible unit/SDK/GC and real-CLI controls. Compare exact model/tool/session data, physical cells and explicit parser/wire/fallback/resource counters. Warm visits/width changes must add zero classifier work; distinguish legitimate correction/profile/recovery resynchronizations from ordinary appends. Test-only diagnostics are not a production footer/status journal. Run evidence and reviews belong under ignored `.test-artifacts/`; protected syntax research remains separate.
