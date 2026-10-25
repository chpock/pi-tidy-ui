# README screenshot generation

The checkout-only `npm run screenshot` command creates the preview from actual Pi output, rendered by **foot** and captured by **grim** in an active **Wayland/Hyprland** session. All maintained inputs live under [`scripts/screenshot/`](../scripts/screenshot/); previous task outputs, personal Pi sessions and model credentials are not inputs.

The current example uses **160 columns × 104 rows**, the tracked **gruvbox-dark-hard** theme, **GPT-6 Astra / openai-codex / max**, ten demonstration cache reports and the native **Working** indicator. Its private Pi settings set `editorPaddingX: 1`, `outputPad: 1` and visible thinking. The native input editor holds a one-line, unsent follow-up draft ending with “and returns”, with its real cursor at the unfinished sentence's end. It has no extra blank draft lines; the larger code example belongs to the edit-tool diff card, not the input editor. An ordinary assistant research summary precedes the user's request, rather than starting the image at an isolated user card. Compact read/find/grep/AFT-search summaries sit between the edit/write/Bash cards: consecutive one-line calls stay adjacent, while a long search query wraps and the following call receives the normal blank separator. A missing-test-file read has a completed `isError: true` result, followed by successful discovery/read calls; its red compact summary is rendered by the extension, not recolored by the screenshot script. The enlarged router edit adds query-string normalization and a JSON health response while preserving the root route and not-found behavior. One Bash card immediately after the write card shows an ordinary `&&` chain: check the router and test-file syntax, run the focused Node test with an environment assignment and quoted full test name, then inspect diff whitespace, change statistics and Git status for those files. It is a single logical command, naturally soft-wrapped into three visual rows at 160 columns rather than a shell script with arrays or control-flow blocks. The failing test short-circuits the trailing Git commands; those checks are not claimed as executed. The terminal height leaves only the normal separator above Working, accounting for the extra command row. The just-written test fails because the implementation lacks `Cache-Control: no-store`; the normal footer shows only `[exit code: 1]`, without an execution-error label. A subsequent edit adds query-parameter coverage with no removed rows, so the normal presenter uses full-width unified diff even at 160 columns. Working remains visible while the agent continues the task. Terminal background/foreground synchronization is explicitly On for the private demo; the product default remains Off.

## What is real and what is simulated

The preceding assistant reply, prompt, thinking, restored tool calls/results (including the missing-file error), model identity and cache/context figures are scripted examples, not a real model-catalog or billing claim. The offline model declares a 272,000-token window; saved assistant usage and Pi's own trailing-message estimate produce approximately **147k/272k** in the real footer. Tool summaries, wrapping, separators, thinking and draft geometry use the normal Pi/extension presenters; none are painted onto the PNG. The restored AFT call does not install or execute AFT. The failed read is also restored history, not an intentionally failing host operation. Only the router and health-test files are staged in the demo clone; the preceding home-test discovery is illustrative history, not a claim about that clone's tracked tests. The example's single Bash command actually executes against the base health test and must preserve its exit status 1. The failed assertion compares only a missing header value and the string `no-store`, not a live UI/process object. Generation records actual stdout/stderr and numeric `details.exit_code`. The scripted tool result has `isError: false`, modeling a completed command with a nonzero process status rather than a tool execution failure; the normal presenter therefore supplies the exit-only footer. No production error-handling code or renderer is changed to hide an error label. Unexpected exit codes, signals or execution errors fail generation. The later addition-only query test is staged after this command and is not rerun in the demo. The command stays inside the existing capture scope; this is demo production, not regression-suite acceptance. Pi restores the saved history without replaying those tools. One hidden custom-message turn then starts the private offline provider: it emits an empty assistant-stream start and waits for cancellation. This keeps Pi's real Working indicator active and removes Idle from the metadata. Capture saves the active frame, sends Escape, awaits the aborted stream and `agent_end`, then closes Pi. No authentication or external model request is involved.

The **rendering is native**: after draining all admitted terminal-parser work, capture retains the cell grid and an immutable copy of the corresponding ANSI bytes together, before any asynchronous output writes or Pi cleanup. Later Working animation cannot change the retained frame. foot receives that ANSI stream and draws it with its own font shaping, cell metrics, antialiasing and box drawing. It does not receive a generated SVG or an image of the UI. A bounded raw-mode replay process discards terminal-query replies and keyboard input; it executes no pasted commands. foot reports its own cell metrics through its native terminal query. After any monitor/font-scale negotiation, the owner resizes only the demo window as needed and waits for the real PTY grid to become 160 × 104 before replay. A cursor-position response acknowledges parsing of the full frame before capture. `grim -T` captures only that foot toplevel, not a rectangle containing neighboring windows.

The Working frame is a retained snapshot, not a second live Pi session running in foot. Layout, text and colors come from the captured Pi session; glyph pixels come from foot. The old SVG utility is not part of this capture path and is not an automatic fallback.

## Prerequisites

Generation currently requires Linux, an active **Hyprland with its Lua window-rule API and direct-toplevel capture support**, and the existing [verified systemd/bubblewrap containment](testing.md#local-memory-containment-and-assertion-diagnostics). The host needs `foot`, `grim`, `hyprctl`, Python 3, Bash, Git, fontconfig, ripgrep and fd. `grim -T` must be supported by both the installed tool and compositor. There is no ImageMagick/browser dependency for native capture.

Use an explicitly prepared coherent Pi graph plus an admitted same-source Occipital build. See [ordinary preparation](testing.md#requirements-and-commands) and [fresh native provisioning](testing.md#provision-optional-inputs-from-a-fresh-clone). The current font is system-installed **Cousine Nerd Font Mono**, **12 pt**, as selected by the operator's foot configuration. Fonts are not bundled.

[`tools.example.json`](../scripts/screenshot/tools.example.json) declares the extra tools at conventional Linux paths. Adjust a separate explicit copy where needed and prepare with it. Adding tools to an older descriptor requires fresh preparation, not hand-editing its receipts. Generation installs/downloads nothing.

The caller must supply `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` for the intended session, plus the user-bus access needed by the outer systemd supervisor. Only the three desktop coordinates are forwarded to the foot/grim stage. Pi retains its separate private HOME/runtime and receives no desktop or model credentials.

## Prepare and capture

Run from a checkout with its release tags. Replace absolute toolchain and output paths:

```sh
NODE=/absolute/path/to/node
RUST_ROOT=/absolute/path/to/rust-sysroot
INPUT_ROOT=/absolute/new-screenshot-inputs
RECEIPTS=/absolute/screenshot-receipts
mkdir -p "$RECEIPTS"

/usr/bin/python3 -I -S scripts/test/safe-run.py \
  --label screenshot-prepare --receipt "$RECEIPTS/prepare-01.json" \
  --limit-seconds 600 -- \
  "$NODE" scripts/test/prepare.mjs --pi-version 1.0.0 \
  --tools "$PWD/scripts/screenshot/tools.example.json" \
  --rust-root "$RUST_ROOT" --build-native --output "$INPUT_ROOT"

INPUTS="$INPUT_ROOT/inputs.json"
OUTPUT="$PWD/.test-artifacts/screenshots/foot-01"
npm run screenshot -- --inputs "$INPUTS" --output "$OUTPUT"
```

An existing matching `--native-inputs` descriptor can replace `--rust-root/--build-native` during preparation. Use new preparation receipts and a fresh screenshot output each time. Stale sources, missing prerequisites, failed sample tests, incomplete paint, changed terminal dimensions or capture failure cause an explicit failure, not a reused image.

There are two sequential scopes: Pi/history capture (120 seconds) and foot/grim rendering (60 seconds), each retaining the unchanged 2 GiB/swap-zero/128-task limits and network namespace. Native rendering needs only the local compositor sockets, not network egress. A real temporary foot window appears and may receive focus. It closes after capture. No monitor, workspace layout configuration or personal config file is rewritten.

To keep the preview floating without tiling other windows, the renderer enables one narrowly matched named runtime rule (`pi-tidy-ui-screenshot`) through Hyprland's public Lua API. It is disabled after capture; the outer owner repeats that cleanup after renderer failure. The same named rule is reused across runs rather than creating a different rule name per screenshot. The window is pinned to a single active output, preferring scale 1:1, so spanning monitors cannot change its font metrics during capture. On SIGINT/SIGTERM, the outer owner forwards the signal to the active scope supervisor, waits for it to close, disables the rule and removes its owned runtime before failing. SIGKILL or a host/compositor crash can still bypass this cleanup and leave that app-prefix-specific rule enabled; recovery is `hyprctl eval 'if _G.__pi_tidy_ui_screenshot_rule then _G.__pi_tidy_ui_screenshot_rule:set_enabled(false) end'`.

The scope bounds the owned clients, not the already-running compositor or its GPU allocations. This is local screenshot automation, not a malicious-client security sandbox. This command is not macOS/Windows or hosted compatibility acceptance.

### Show a real directory and Git branch

Prepare a dedicated clone before network-isolated capture:

```sh
mkdir -p /tmp/projects
git clone https://github.com/chpock/pi-tidy-ui.git /tmp/projects/pi-tidy-ui
npm run screenshot -- --inputs "$INPUTS" \
  --output "$PWD/.test-artifacts/screenshots/foot-project-01" \
  --workspace /tmp/projects/pi-tidy-ui
```

Do not clone over an existing directory. Later captures can reuse this dedicated clone. `--workspace` requires a separate Git root with a named branch and refuses the extension source/prepared checkout and tracked story files. It writes only untracked `src/router.ts` and `tests/health.test.ts`; those two files may be overwritten on regeneration. The retained health-test file includes the intentionally unmet cache-control assertion, matching the final failed run. Do not use a project with valuable untracked files. The screenshot opts out of unrelated terminal-test fixture seeding. Pi discovers the actual path/branch; no label is substituted by the renderer.

Without `--workspace`, the project and HOME/temp live in the neutral prepared runtime and are removed on success/failure. The explicit clone is retained. Copies of the demo source and available diagnostic outputs remain under the output directory.

## Outputs and updating the README

- `preview.png`: direct native foot-window capture. Pixel dimensions depend on foot/fontconfig and the monitor's native scale; they are not inferred from a hardcoded 10×20 cell or forced to 1088×1088. The selected 12 pt font is not reduced to 8 pt, and no bitmap resize or `grim -s` rescaling is requested.
- `preview.ansi`: actual Pi bytes retained before shutdown/reset, used by foot.
- `capture.json` / `screen.txt`: captured cell/text evidence, not rasterization inputs.
- `preview.json`: source/Node/Pi/native identities, sample-data disclosure, model/thinking/theme, requested terminal grid, actual PNG/PTY pixel dimensions, renderer/toplevel identity and activity counts. `modelRequests` counts local simulated turns; `externalModelRequests` is zero; `cancelledOfflineRequests` records cleanup.
- `terminal-colors.json`: observed OSC sets/query state at the Pi snapshot, before profile restoration.
- `foot.log`, `foot-metrics.json`, `foot-size.json`, `foot-ready.json`: native renderer diagnostics, reported font-cell metrics, actual terminal dimensions and acknowledgement.
- `scope.json`, `foot-scope.json`: verified client-resource/cleanup receipts.
- `sessions/`, `taskboard/`: generated history and example sources.

The harness retains additional disposable ANSI/events/shutdown diagnostics; `preview.json` identifies the directory. None are historical inputs to the next run. Deleted prepared inputs require preparation again. Inspect the image before explicitly replacing the maintained asset:

```sh
cp "$OUTPUT/preview.png" docs/assets/pi-tidy-ui.png
```

The maintained [`docs/assets/pi-tidy-ui.png`](assets/pi-tidy-ui.png) is the selected native foot capture of the 160×104 Gruvbox demo. README and `pi.image` reference that one asset, which is also included in the npm package. The public raw URL changes only after the updated asset is committed and pushed to `main`. No automatic replacement, commit, upload, publication or CI screenshot artifact is created.

## Editing and validation

Edit [`demo.mjs`](../scripts/screenshot/demo.mjs) for content, ordered `toolSequence` calls/results, cache/context samples, terminal dimensions, private Pi settings, editor draft, model/thinking and Working mode; [`foot.ini`](../scripts/screenshot/foot.ini) controls native font/profile appearance. Font dimensions and glyph spacing belong to foot, not custom SVG geometry. The tracked theme is a maintained snapshot of the operator's [gruvbox-dark-hard Pi theme](https://github.com/chpock/dotfiles/blob/master/.pi/agent/themes/gruvbox-dark-hard.json), not a runtime dependency on that URL or the personal home directory. It is a screenshot-generation input, not a theme installed with the extension. The README identifies this separate theme and opt-in terminal-color setting beside the image, rather than presenting those colors as installation defaults. Keep patch, tool arguments and example files consistent. With terminal-color On, readiness requires both real OSC channels; Working requires its native row and no Idle metadata; explicit workspaces require a visible actual path/branch.

After source edits refresh inside the ordinary guard, then choose a new output:

```sh
/usr/bin/python3 -I -S scripts/test/safe-run.py \
  --label screenshot-refresh --receipt "$RECEIPTS/refresh-01.json" -- \
  "$NODE" scripts/test/prepare.mjs --refresh-inputs "$INPUTS"
npm run screenshot -- --inputs "$INPUTS" \
  --output "$PWD/.test-artifacts/screenshots/foot-02"
```

Manifest/lock/tool changes need fresh preparation; changed native inputs need a new admitted helper. Actual generation is a manual integration, not an automatic CI/registry step. Pure legacy SVG controls do not certify this renderer. Once screenshot editing is complete, refresh and run the affected harness feature checks before release. The screenshot controls cover complete readiness and one immutable drained frame. Linux lifecycle controls use declared inert tool executables to exercise toplevel-only capture, renderer failure, missing acknowledgement/wrong grid and SIGINT/SIGTERM cleanup without contacting a compositor or requiring a real helper. Their sentinel PNG and simulated scope replies are orchestration fixtures, not native rendering, kernel-containment or release-admission evidence; the surrounding test runner still uses the real verified scope. A successful real foot/grim generation supplements these controls. Neither an image nor legacy SVG tests establish broader product or release acceptance.
