import "../../fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseColor, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { terminalAppearanceTracking } from "../../../src/index.ts";
import { colorToHex, rgbColor } from "@earendil-works/pi-tui";
import { resolveTerminalDefaults, parseThemeDefaults, TerminalColors, type DefaultColors } from "../../../src/terminal-colors.ts";
import { menuPage, setAppearance, setColors } from "../../helpers/menu-driver.ts";
import { RuntimeHealth } from '../../../src/runtime-health.ts';
import type { DiagnosticSink } from '../../../src/diagnostics.ts';
import { Tool, extensionHarness } from "../../fixtures/sdk-contract-support.ts";

test("terminal defaults resolve independent explicit values, own vars, zero, BOM and SDK color forms", () => {
  assert.deepEqual(resolveTerminalDefaults({ colors: { text: "ink" }, export: { pageBg: "surface" }, vars: { ink: "#abc", surface: "next", next: 0 } }),
    { foreground: "#aabbcc", background: colorToHex(parseColor(0)) });
  for (const value of ["#0af", "#00aaff", "oklch(62% 0.1 200)", "okhsl(250 60% 55%)", 255])
    assert.deepEqual(resolveTerminalDefaults({ colors: { text: value }, export: { pageBg: value } }),
      { foreground: colorToHex(parseColor(value)), background: colorToHex(parseColor(value)) });
  assert.deepEqual(parseThemeDefaults('\uFEFF{"colors":{"text":""},"export":{"pageBg":""}}'), { foreground: undefined, background: undefined });
  assert.deepEqual(resolveTerminalDefaults({ colors: {} }), { foreground: undefined, background: undefined });
  for (const vars of [{ a: "a" }, { a: "b", b: "a" }, Object.create({ a: "#fff" })])
    assert.throws(() => resolveTerminalDefaults({ vars, colors: { text: "a" } }));
  for (const value of [-1, 256, 1.5, null, {}, "#ggg", "unknown", "\x1b]11;#fff\x07"])
    assert.throws(() => resolveTerminalDefaults({ colors: { text: value } }));
  assert.throws(() => parseThemeDefaults("broken"));
});

function terminalColorFixture(query?: ConstructorParameters<typeof TerminalColors>[0]["query"], defaults?: DefaultColors, diagnostic?: DiagnosticSink) {
  const theme = {
    name: "fixture", sourcePath: "/fixture.json" as string | undefined, fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text, style: (text: string) => text,
    colors: { toolPendingBg: rgbColor(10, 11, 12), userMessageBg: rgbColor(10, 11, 12), toolDiffAdded: rgbColor(0, 255, 0), text: rgbColor(229, 229, 231) },
    getFgAnsi: (role: string): string => role === "text" ? "\x1b[39m" : "\x1b[38;2;0;255;0m",
    getBgAnsi: (_role: string): string => "\x1b[49m",
  };
  const snapshot = { enabled: true, automatic: false as boolean | undefined, configured: "fixture" as string | undefined, theme };
  let content = '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}';
  const packets: string[] = [], warnings: string[] = [], renders: boolean[] = [];
  let reads = 0, changes = 0;
  const view = new TerminalColors({ snapshot: () => snapshot, source: () => undefined, query, defaults, diagnostic,
    read(path) { assert.equal(path, "/fixture.json"); reads++; return content; },
    write: data => { packets.push(data); }, warn: message => { warnings.push(message); }, changed: (force = false) => { changes++; renders.push(force); } });
  return { view, snapshot, packets, warnings, renders, get reads() { return reads; }, get changes() { return changes; }, setContent(value: string) { content = value; } };
}

const terminalMicrotasks = async () => { await new Promise<void>(done => setImmediate(done)); };

test("terminal defaults controller applies once, preserves native theme, and performs zero warm work", async () => {
  const fixture = terminalColorFixture(), original = fixture.snapshot.theme.colors;
  fixture.view.observe(); await terminalMicrotasks();
  assert.deepEqual(fixture.packets, ["\x1b]11;#123456\x07\x1b]10;#eeeeee\x07"]);
  assert.equal(fixture.reads, 1);
  const palette = fixture.view.palette(fixture.snapshot.theme);
  assert.equal(colorToHex(palette.colors!.toolPendingBg!), "#123456");
  assert.equal(colorToHex(palette.colors!.userMessageBg!), "#123456");
  assert.equal(colorToHex(palette.colors!.text!), "#eeeeee");
  assert.equal(palette.colors!.toolDiffAdded, original.toolDiffAdded);
  assert.equal(fixture.snapshot.theme.colors, original); assert.equal(colorToHex(original.toolPendingBg), "#0a0b0c");
  const counters = fixture.view.stats();
  for (let i = 0; i < 80; i++) { fixture.view.observe(); assert.equal(fixture.view.palette(fixture.snapshot.theme), palette); }
  await terminalMicrotasks(); assert.deepEqual(fixture.view.stats(), counters); assert.equal(fixture.reads, 1);
  fixture.view.dispose(); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
  fixture.view.dispose(); assert.equal(fixture.packets.length, 2);
});

test('terminal defaults known equal background retains trusted projection identity across warm frames and later changes', async () => {
  const f = terminalColorFixture();
  f.setContent('{"colors":{"text":""},"export":{"pageBg":"#0a0b0c"}}');
  const native = f.snapshot.theme, original = native.colors;
  try {
    assert.equal(f.view.palette(native), native, 'unknown defaults must not project fallback guesses');
    f.view.observe(); await terminalMicrotasks();
    const known = f.view.palette(native);
    assert.notEqual(known.colors!.toolPendingBg, original.toolPendingBg, 'equal RGB still carries known background provenance');
    assert.equal(colorToHex(known.colors!.toolPendingBg!), '#0a0b0c');
    assert.equal(known.colors!.toolDiffAdded, original.toolDiffAdded, 'explicit native role stays owned by Pi');
    const counters = f.view.stats();
    for (let i = 0; i < 50; i++) { f.view.observe(); assert.equal(f.view.palette(native), known); }
    await terminalMicrotasks(); assert.deepEqual(f.view.stats(), counters);
    f.setContent('{"colors":{"text":""},"export":{"pageBg":"#123456"}}');
    f.view.observe(true); await terminalMicrotasks();
    const changed = f.view.palette(native);
    assert.notEqual(changed, known); assert.equal(colorToHex(changed.colors!.toolPendingBg!), '#123456');
    assert.equal(native.colors, original); assert.equal(colorToHex(original.toolPendingBg), '#0a0b0c');
    assert.equal(native.getBgAnsi('toolPendingBg'), '\x1b[49m');
  } finally { f.view.dispose(); }
});

test("terminal defaults auto/unknown guard releases synchronously and rejects queued work", async () => {
  for (const mode of [true, undefined]) {
    const fixture = terminalColorFixture(); fixture.view.observe(); await terminalMicrotasks();
    fixture.snapshot.automatic = mode; fixture.view.observe();
    assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07", "release must happen before the caller's native query");
    assert.equal(fixture.view.palette(fixture.snapshot.theme), fixture.snapshot.theme);
    await terminalMicrotasks(); assert.equal(fixture.reads, 1); assert.equal(fixture.packets.length, 2);
    fixture.view.dispose();
    const pending = terminalColorFixture(); pending.view.observe(); pending.snapshot.automatic = mode; pending.view.observe();
    await terminalMicrotasks(); assert.equal(pending.reads, 0); assert.deepEqual(pending.packets, []); pending.view.dispose();
  }
  const configured = terminalColorFixture(); configured.snapshot.configured = " light / dark "; configured.view.observe();
  await terminalMicrotasks(); assert.equal(configured.reads, 0); assert.deepEqual(configured.packets, []); configured.view.dispose();
});

test("terminal defaults missing channels release only owned channels; source errors keep the whole last-good snapshot", async () => {
  const fixture = terminalColorFixture(); fixture.view.observe(); await terminalMicrotasks();
  fixture.setContent('{"colors":{"text":"missing-var"},"export":{"pageBg":"#ffffff"}}');
  fixture.view.observe(true); await terminalMicrotasks();
  assert.equal(fixture.packets.length, 1, "partially valid metadata cannot partially publish");
  assert.equal(fixture.warnings.length, 1);
  fixture.view.observe(true); await terminalMicrotasks(); assert.equal(fixture.warnings.length, 1);
  assert.equal(colorToHex(fixture.view.palette(fixture.snapshot.theme).colors!.toolPendingBg!), "#123456");
  fixture.setContent('{"colors":{"text":""},"export":{"pageBg":"#123456"}}');
  fixture.view.observe(true); await terminalMicrotasks(); assert.equal(fixture.packets.at(-1), "\x1b]110\x07");
  fixture.setContent('{"colors":{"text":""}}'); fixture.view.observe(true); await terminalMicrotasks();
  assert.equal(fixture.packets.at(-1), "\x1b]111\x07");
  fixture.view.dispose(); assert.equal(fixture.packets.length, 3);
  const empty = terminalColorFixture(); empty.setContent('{"colors":{"text":""}}'); empty.view.observe(); await terminalMicrotasks(); empty.view.dispose();
  assert.deepEqual(empty.packets, []);
});

test("terminal defaults disabled/no-source/programmatic states have no guessed metadata or writes", async () => {
  const fixture = terminalColorFixture(); fixture.snapshot.enabled = false; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.reads, 0); assert.deepEqual(fixture.packets, []);
  fixture.snapshot.enabled = true; fixture.snapshot.theme.sourcePath = ""; fixture.snapshot.theme.name = "";
  fixture.view.observe(); await terminalMicrotasks(); assert.equal(fixture.reads, 0); assert.deepEqual(fixture.packets, []); fixture.view.dispose();
});

test("terminal defaults stale unowned-default reports cannot repaint after auto, disable or disposal", async () => {
  for (const transition of ["auto", "disable", "dispose"]) {
    const fixture = terminalColorFixture(); fixture.setContent('{"colors":{"text":""},"export":{"pageBg":"#123456"}}');
    let complete!: (value: { foreground: { r: number; g: number; b: number } }) => void;
    const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => undefined,
      read: () => '{"colors":{"text":""},"export":{"pageBg":"#123456"}}', write: data => { fixture.packets.push(data); },
      query: () => new Promise(resolve => { complete = resolve; }) });
    view.observe(); await terminalMicrotasks(); assert.equal(typeof complete, "function");
    if (transition === "auto") fixture.snapshot.automatic = true;
    else if (transition === "disable") fixture.snapshot.enabled = false;
    else view.dispose();
    view.observe(); const packets = [...fixture.packets];
    complete({ foreground: { r: 255, g: 0, b: 0 } }); await terminalMicrotasks();
    assert.deepEqual(fixture.packets, packets); assert.equal(view.palette(fixture.snapshot.theme), fixture.snapshot.theme); view.dispose(); fixture.view.dispose();
  }
});

test("terminal appearance SDK contract preserves native methods and flags, follows a live renderer proxy, and rejects drift", () => {
  const noop = () => {};
  const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false, start: noop, stop: noop,
    drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop,
    clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, ...{ setProgramStatus: noop } };
  const roots = [new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false)];
  let current = roots[0]!;
  const reference = new Proxy({}, { get: (_target, key) => Reflect.get(current, key, current),
    set() { throw new Error("Appearance observation is read-only"); }, defineProperty() { throw new Error("No receiver probe"); } });
  for (const root of roots) {
    current = root;
    const notify = root.setTerminalColorSchemeNotifications, query = root.queryTerminalColors;
    assert.equal(terminalAppearanceTracking(reference), false, "supported SDK has an initialized boolean, not an absent/falsy guess");
    root.setTerminalColorSchemeNotifications(true); assert.equal(terminalAppearanceTracking(reference), true);
    root.setTerminalColorSchemeNotifications(false); assert.equal(terminalAppearanceTracking(reference), false);
    assert.equal(root.setTerminalColorSchemeNotifications, notify); assert.equal(root.queryTerminalColors, query);
  }
  for (const value of [undefined, null, 0, 1, "false", "true", {}, () => false])
    assert.equal(terminalAppearanceTracking({ terminalColorSchemeNotificationsEnabled: value }), undefined);
  assert.equal(terminalAppearanceTracking(new Proxy({}, { get() { throw new Error("future host"); } })), undefined);
});

test("terminal defaults menu honors local/master lifetime without session-bound exit listeners", async () => {
  const h = extensionHarness(), fixture = terminalColorFixture();
  const directory = mkdtempSync(join(tmpdir(), "tidy-ui-colors-")), path = join(directory, "theme.json");
  writeFileSync(path, '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
  fixture.snapshot.theme.sourcePath = path;
  Object.assign(h.ctx.ui, { theme: fixture.snapshot.theme });
  Object.assign(h.root, { terminal: { write(data: string) { fixture.packets.push(data); } } });
  const listeners = process.listenerCount("exit"), nativeToolRender = Tool.prototype.render;
  try {
    await h.events.get("session_start")!({}, h.ctx); await terminalMicrotasks();
    assert.equal(fixture.packets.length, 1); assert.equal(process.listenerCount("exit"), listeners);
    await h.events.get("session_start")!({}, h.ctx); await terminalMicrotasks();
    assert.equal(fixture.packets.length, 1); assert.equal(process.listenerCount("exit"), listeners);
    const command = h.commands.get('tidy-ui')!.handler;
    const control = (operation: string) => operation === 'colors on' || operation === 'colors off'
      ? setColors(command, h.ctx, operation === 'colors on') : operation === 'on' || operation === 'off'
      ? setAppearance(command, h.ctx, operation === 'on') : command(operation, h.ctx);
    await control("colors off"); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
    assert.equal(process.listenerCount("exit"), listeners); assert.notEqual(Tool.prototype.render, nativeToolRender);
    await control("off"); await control("on"); await terminalMicrotasks(); assert.equal(fixture.packets.length, 2, "master on preserves the local off choice");
    await control("colors on"); await terminalMicrotasks(); assert.equal(fixture.packets.length, 3);
    h.root.terminalColorSchemeNotificationsEnabled = true;
    const observer = h.widgetComponents.get("pi-tidy-ui-terminal-colors")!;
    observer.render(80); assert.equal(fixture.packets.length, 4); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
    assert.match(await menuPage(command, h.ctx, ['Status & troubleshooting']), /automatic/u);
    await control("colors invalid"); assert.match(h.notices.at(-1)!, /Usage/u);
    assert.deepEqual(observer.render(80), []);
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); fixture.view.dispose(); rmSync(directory, { recursive: true, force: true }); }
  assert.equal(process.listenerCount("exit"), listeners);
});

test("terminal defaults partial late reports preserve previously reported channels within the same generation", async () => {
  const fixture = terminalColorFixture();
  let late!: (colors: { background?: { r: number; g: number; b: number } }) => void;
  const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => undefined,
    read: () => '{"colors":{"text":""}}', write: data => fixture.packets.push(data),
    query: async callback => { late = callback; return { foreground: { r: 17, g: 17, b: 17 } }; } });
  try {
    view.observe(); await terminalMicrotasks();
    assert.equal(colorToHex(view.palette(fixture.snapshot.theme).colors!.text!), "#111111");
    late({ background: { r: 34, g: 34, b: 34 } });
    const palette = view.palette(fixture.snapshot.theme);
    assert.equal(colorToHex(palette.colors!.text!), "#111111");
    assert.equal(colorToHex(palette.colors!.userMessageBg!), "#222222");
    assert.deepEqual(fixture.packets, []);
  } finally { view.dispose(); fixture.view.dispose(); }
});

test("terminal defaults SGR classification ignores 39/49/2 inside RGB and indexed colors", async () => {
  const fixture = terminalColorFixture();
  fixture.snapshot.theme.getFgAnsi = () => "\x1b[38;5;39m";
  fixture.snapshot.theme.getBgAnsi = () => "\x1b[48;2;2;39;49m";
  fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.palette(fixture.snapshot.theme), fixture.snapshot.theme);
  assert.deepEqual(fixture.view.stats().reports, 0); fixture.view.dispose();
  assert.deepEqual(resolveTerminalDefaults({ vars: { "#abc": "#000" }, colors: { text: "#abc" } }), { foreground: "#aabbcc", background: undefined });
});

test("terminal defaults retain known source identity on same-revision registry disappearance and diagnose read failure", async () => {
  const fixture = terminalColorFixture(); fixture.snapshot.theme.sourcePath = "";
  let listed = true, missing = false, reads = 0;
  const view = new TerminalColors({ snapshot: () => fixture.snapshot, source: () => listed ? "/fixture.json" : undefined,
    read() { reads++; if (missing) throw new Error("ENOENT fixture.json"); return '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}'; },
    write: data => fixture.packets.push(data), warn: message => fixture.warnings.push(message) });
  try {
    view.observe(); await terminalMicrotasks(); listed = false; missing = true;
    view.observe(true); await terminalMicrotasks();
    assert.equal(reads, 2); assert.equal(fixture.packets.length, 1); assert.equal(fixture.warnings.length, 1);
    fixture.snapshot.theme.name = "new-generated-source"; view.observe(); await terminalMicrotasks();
    assert.equal(reads, 2); assert.equal(fixture.packets.at(-1), "\x1b]111\x07\x1b]110\x07");
  } finally { view.dispose(); fixture.view.dispose(); }
});

test("terminal defaults local off keeps presentation RGB fresh without applying targets or reading metadata", async () => {
  const fixture = terminalColorFixture(async () => ({ background: { r: 17, g: 34, b: 51 } }));
  fixture.snapshot.theme.colors = { ...fixture.snapshot.theme.colors, userMessageBg: rgbColor(18, 52, 86) };
  Object.assign(fixture.snapshot, { presenting: true });
  fixture.view.observe(); await terminalMicrotasks();
  fixture.snapshot.enabled = false; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.status().state, "off"); assert.equal(fixture.view.stats().sourceReads, 1);
  const palette = fixture.view.palette(fixture.snapshot.theme);
  assert.equal(colorToHex(palette.colors!.userMessageBg!), "#112233");
  const after = fixture.view.stats();
  for (let frame = 0; frame < 50; frame++) { fixture.view.observe(); fixture.view.palette(fixture.snapshot.theme); }
  assert.deepEqual(fixture.view.stats(), after); assert.equal(after.reports, 1);
  fixture.snapshot.enabled = true; fixture.view.observe(); await terminalMicrotasks();
  assert.equal(fixture.view.status().state, "on"); assert.equal(fixture.view.stats().sourceReads, 2);
  fixture.view.dispose();
});

test('terminal defaults handoff keeps applied channels without reset/reapply and rejects outgoing work', async () => {
  const defaults: DefaultColors = {}, first = terminalColorFixture(undefined, defaults);
  first.view.observe(); await terminalMicrotasks();
  assert.deepEqual(defaults, { foreground: '#eeeeee', background: '#123456' });
  first.view.observe(true); first.view.dispose({ preserveDefaults: true });
  await terminalMicrotasks();
  assert.equal(first.packets.length, 1, 'shutdown does not release terminal defaults');
  const next = terminalColorFixture(undefined, defaults);
  try {
    next.view.observe(); await terminalMicrotasks();
    assert.deepEqual(next.packets, [], 'unchanged inherited defaults need no writes');
    assert.equal(next.view.stats().sets, 0);
    first.view.dispose(); assert.equal(first.packets.length, 1, 'disposed predecessor cannot release a new owner');
    next.setContent('{"colors":{"text":"#abcdef"},"export":{"pageBg":"#123456"}}');
    next.view.observe(true); await terminalMicrotasks();
    assert.deepEqual(next.packets, ['\x1b]10;#abcdef\x07']);
    next.snapshot.enabled = false; next.view.observe();
    assert.equal(next.packets.at(-1), '\x1b]111\x07\x1b]110\x07');
    assert.equal(defaults.foreground, undefined); assert.equal(defaults.background, undefined);
  } finally { first.view.dispose(); next.view.dispose(); }
});

test('terminal defaults handoff releases inherited channels before automatic-mode queries', async () => {
  const defaults: DefaultColors = { foreground: '#eeeeee', background: '#123456' };
  const next = terminalColorFixture(undefined, defaults);
  try {
    next.snapshot.automatic = true; next.view.observe();
    assert.deepEqual(next.packets, ['\x1b]111\x07\x1b]110\x07']);
    assert.equal(next.reads, 0); await terminalMicrotasks(); assert.equal(next.reads, 0);
    assert.equal(defaults.foreground, undefined); assert.equal(defaults.background, undefined);
  } finally { next.view.dispose(); }
});

test('terminal defaults process cleanup survives absent successor without retaining its observer', () => {
  const module = new URL('../../../src/terminal-colors.ts', import.meta.url).href;
  const guard = new URL('../../fixtures/test-guard.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    await import(${JSON.stringify(guard)});
    const a = await import(${JSON.stringify(module)});
    const count = process.listenerCount('exit'), defaults = a.processTerminalDefaults();
    const b = await import(${JSON.stringify(module + '?replacement')});
    if (b.processTerminalDefaults() !== defaults || process.listenerCount('exit') !== count + 1) throw Error('stacked process cleanup');
    const theme = { name:'fixed', sourcePath:'/fixture', fg:(_,s)=>s };
    let view = new a.TerminalColors({ defaults, snapshot: () => ({ enabled: true, automatic: false, theme }),
      source:()=>undefined, read:()=>'{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}', write:s=>process.stdout.write(s) });
    view.observe(); await new Promise(setImmediate);
    if (defaults.background !== '#123456' || defaults.foreground !== '#eeeeee') throw Error('defaults were not applied');
    view.dispose({ preserveDefaults: true });
    const weak = new WeakRef(view); view = null;
    let collected = false;
    for (let i=0; i<100; i++) { await new Promise(setImmediate); global.gc(); await new Promise(setImmediate); if (!weak.deref()) { collected=true; break; } }
    if (!collected) throw Error('process cleanup retained observer');
    process.stdout.write('OWNER_COLLECTED');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '\x1b]11;#123456\x07\x1b]10;#eeeeee\x07OWNER_COLLECTED\x1b]111\x07\x1b]110\x07');
});

test('terminal repaint: changed OSC channels force one frame, unchanged targets and RGB reports do not', async () => {
  const f = terminalColorFixture(async () => ({ background: { r: 10, g: 11, b: 12 } }));
  Object.assign(f.snapshot, { presenting: true });
  try {
    f.view.observe(); await terminalMicrotasks();
    assert.deepEqual(f.renders, [true], 'one combined fg/bg packet needs one forced frame');
    for (let i = 0; i < 50; i++) f.view.observe();
    f.view.observe(true); await terminalMicrotasks();
    assert.deepEqual(f.renders, [true], 'same-value retry and warm frames do not force redraw');
    f.snapshot.enabled = false; f.view.observe();
    assert.deepEqual(f.renders, [true, true], 'release redraw is requested after the synchronous reset');
    assert.equal(f.packets.at(-1), '\x1b]111\x07\x1b]110\x07');
    await terminalMicrotasks();
    assert.deepEqual(f.renders, [true, true, false], 'profile RGB repair only requests an ordinary frame');
    f.view.observe(); await terminalMicrotasks();
    assert.equal(f.renders.length, 3);
  } finally { f.view.dispose(); }
});

test('terminal repaint: production host forwards forced mode without invalidating the component tree', async () => {
  const h = extensionHarness(), f = terminalColorFixture();
  const directory = mkdtempSync(join(tmpdir(), 'tidy-ui-repaint-')), path = join(directory, 'theme.json');
  writeFileSync(path, '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
  f.snapshot.theme.sourcePath = path;
  Object.assign(h.ctx.ui, { theme: f.snapshot.theme });
  Object.assign(h.root, { terminal: { write: (data: string) => f.packets.push(data) } });
  const requests: boolean[] = [], request = h.root.requestRender, invalidate = h.root.invalidate;
  let invalidations = 0;
  h.root.requestRender = (force = false) => { requests.push(force); request.call(h.root); };
  h.root.invalidate = () => { invalidations++; invalidate.call(h.root); };
  try {
    await h.events.get('session_start')!({}, h.ctx); await terminalMicrotasks();
    assert.equal(requests.filter(Boolean).length, 1);
    const before = invalidations;
    await setColors(h.commands.get('tidy-ui')!.handler, h.ctx, false); await terminalMicrotasks();
    assert.equal(requests.filter(Boolean).length, 2);
    assert.equal(invalidations, before, 'terminal repaint does not globally invalidate component caches');
  } finally { await h.events.get('session_shutdown')!({}, h.ctx); f.view.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('runtime health: terminal-color errors notify once without journal, recover on valid data, retire on Off', async () => {
  const notices: string[] = [], health = new RuntimeHealth(message => notices.push(message));
  const f = terminalColorFixture(undefined, undefined, health.sink(() => {}));
  f.setContent('broken'); f.view.observe(); await terminalMicrotasks();
  assert.equal(health.snapshot().errors, 1); assert.equal(health.snapshot().active, 1); assert.equal(notices.length, 1);
  assert.equal(f.warnings.length, 0, 'unified health notification replaces the duplicate legacy warning');
  f.view.observe(true); await terminalMicrotasks(); assert.equal(health.snapshot().errors, 1);
  f.setContent('{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
  f.view.observe(true); await terminalMicrotasks(); assert.equal(health.snapshot().active, 0); assert.equal(health.snapshot().last?.state, 'recovered');
  f.setContent('broken'); f.view.observe(true); await terminalMicrotasks(); assert.equal(health.snapshot().active, 1);
  f.snapshot.enabled = false; f.view.observe(); assert.equal(health.snapshot().active, 0); assert.equal(health.snapshot().last?.state, 'released');
  f.view.dispose();
});

for (const target of ['no-source', 'valid-source'] as const) test(`terminal defaults: switching from broken theme to ${target} retires only its obsolete health incident`, async () => {
  const notices: string[] = [], health = new RuntimeHealth(message => notices.push(message));
  const f = terminalColorFixture(undefined, undefined, health.sink(() => {})), original = f.snapshot.theme;
  try {
    f.setContent('broken'); f.view.observe(); await terminalMicrotasks();
    assert.equal(health.snapshot().active, 1); assert.equal(f.view.status().state, 'source error');
    if (target === 'no-source') { f.snapshot.theme = { ...original, name: 'generated', sourcePath: undefined }; f.snapshot.configured = 'generated'; }
    else f.setContent('{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
    f.view.observe(true); await terminalMicrotasks();
    const state = health.snapshot(); assert.equal(state.active, 0); assert.equal(state.errors, 1);
    assert.equal(state.last?.state, target === 'no-source' ? 'released' : 'recovered');
    const warm = f.view.stats(), reads = f.reads;
    for (let i = 0; i < 20; i++) f.view.observe(); await terminalMicrotasks();
    assert.deepEqual(f.view.stats(), warm); assert.equal(f.reads, reads); assert.equal(notices.length, 1);
    f.snapshot.theme = original; f.snapshot.configured = 'fixture'; f.setContent('broken'); f.view.observe(true); await terminalMicrotasks();
    assert.equal(health.snapshot().active, 1); assert.equal(health.snapshot().errors, 2, 'same failure after abandoning its source is a new incident');
    assert.equal(notices.length, 2);
  } finally { f.view.dispose(); health.dispose(); }
});
