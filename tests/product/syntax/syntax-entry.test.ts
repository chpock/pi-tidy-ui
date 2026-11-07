import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalOptions } from '../../../src/debug-log.ts';
import { setImmediate as turn } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Container, Image, Spacer, Text, colorToHex, getCapabilities, setCapabilities, type Component, type TerminalColorMode } from '@earendil-works/pi-tui';
import { cardGeometry } from '../../../src/card-frame.ts';
import { visibleWidth } from '@earendil-works/pi-tui';
import { hasHostInk } from '../../fixtures/host-cells.ts';
import { Theme, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type ToolRendererResolver, type ToolRenderers } from '@earendil-works/pi-coding-agent';
import tidyUi, { debugLoggingDiagnostics, type TidyUiRuntimeOptions } from '../../../src/index.ts';
import { SourceController } from '../../../src/occipital/controller.ts';
import { CardSources, type CardDisplayInput } from '../../../src/syntax/cards.ts';
import { SyntaxRuntime } from '../../../src/syntax/runtime.ts';
import { ExpectedOwnedUnavailable } from '../../../src/occipital/owned-startup.ts';
import { samplePiCardPalette } from '../../../src/syntax/pi-palette.ts';
import { sampleOwnedPalette } from '../../../src/themes/owned-palette.ts';
import { menuPage, withMenu, setAppearance, setLogging } from '../../helpers/menu-driver.ts';
import { ExtensionSettings, themePreferenceFromSettings, type SettingsLoadResult, type SettingsPatch, type LocalPreferences } from '../../../src/settings.ts';
import { FilePreviewState } from '../../../src/file-preview-state.ts';
import { createLazyNativeRendererResolver, DeferredRenderer, isDeferredStockFilePair } from '../../../src/syntax/lazy-native-renderers.ts';
import { extensionHarness as sharedExtensionHarness } from '../../fixtures/sdk-contract-support.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const themes = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);
class UI extends Container { requests = 0; selection = false; requestRender() { this.requests++; } hasActiveSelection() { return this.selection; } }
const cleanups: (() => Promise<void>)[] = [];
function plainRows(rows: readonly string[]): string { return rows.join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ''); }
function fixture(mode = 'tui', logging: false | Omit<JournalOptions, 'warn' | 'enabled'> = false,
  settings?: Pick<ExtensionSettings, 'load' | 'update'> & Partial<Pick<ExtensionSettings, 'watch'>>,
  localPreferences: LocalPreferences = { appearanceEnabled: true, loggingEnabled: true },
  cardPreparation?: TidyUiRuntimeOptions['cardPreparation'],
  themePreference: SettingsLoadResult['themePreference'] = { kind: 'pi', variant: 'dark' }) {
  const root = new UI(), events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const rendererResolvers: ToolRendererResolver[] = [];
  const counts = { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 }, notices: string[] = [];
  const flags = new Map<string, string>();
  let saved: SettingsLoadResult = { ok: true, themePreference }, view = '';
  const store = settings ?? { async load() { counts.load++; return { ...saved }; },
    async update(patch: SettingsPatch) { counts.saves++; const { syntaxTheme, syntaxThemeVariant, ...switches } = patch;
      const current = saved.themePreference.kind === 'pi' ? { kind: 'pi' as const }
        : { kind: 'theme' as const, id: saved.themePreference.id };
      saved = { ...saved, ...switches, themePreference: themePreferenceFromSettings(syntaxTheme ?? current,
        syntaxThemeVariant ?? saved.themePreference.variant) }; return { ok: true as const }; } };
  const ctx = { mode, hasUI: mode === 'tui', cwd: '/tmp', isIdle: () => true,
    sessionManager: { getSessionId: () => 'entry-fixture', getSessionFile: () => '/example/entry-fixture.jsonl',
      getSessionName: () => { throw Error('Logging must not scan history for a session name'); } }, ui: { theme: themes.theme,
      getEditorComponent: () => undefined, notify: (message: string) => notices.push(message),
      setWidget(_name: string, factory?: (tui: UI) => unknown) { factory?.(root); } } } as unknown as ExtensionContext;
  const pi = { registerToolRenderer: (resolver: ToolRendererResolver) => { rendererResolvers.push(resolver); },
    on: (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => { events.set(name, callback); },
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => { commands.set(name, command); },
    registerFlag() {}, getFlag: (name: string) => flags.get(name), getSettings: () => ({}), getThinkingLevel: () => 'off' } as unknown as ExtensionAPI;
  const ready = tidyUi(pi, { logging, settings: store, localPreferences, terminalDefaults: {}, syntax: () => {
    counts.constructed++;
    return { standaloneVersion: 'fixture',
      provider: { async tryShared() { counts.shared++; return undefined; }, async acquireOwned() { counts.owned++; throw new ExpectedOwnedUnavailable(); } } };
  }, cardPreparation });
  const command = (args: string) => commands.get('tidy-ui')!.handler(args, ctx);
  const stop = async () => { await events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, ctx); await settled(); };
  cleanups.push(stop);
  return { root, ctx, counts, notices, events, rendererResolvers, ready, stop,
    setFlag(name: string, value: string) { flags.set(name, value); }, get view() { return view; },
    start: (event: unknown = { type: 'session_start', reason: 'startup' }) => events.get('session_start')!(event, ctx), command,
    async page(...path: string[]) { return view = await menuPage(commands.get('tidy-ui')!.handler, ctx, path); },
    async appearance(value: boolean) { return view = await setAppearance(commands.get('tidy-ui')!.handler, ctx, value); },
    async recording(value: boolean) { return view = await setLogging(commands.get('tidy-ui')!.handler, ctx, value); } };
}
function rendererSet(base: ReturnType<typeof createWriteToolDefinition> | ReturnType<typeof createEditToolDefinition> | ReturnType<typeof createReadToolDefinition>): ToolRenderers {
  return { renderShell: base.renderShell,
    renderCall: base.renderCall as unknown as ToolRenderers['renderCall'],
    renderResult: base.renderResult as unknown as ToolRenderers['renderResult'] };
}
function writeSource(tag: string): string {
  return Array.from({ length: 14 }, (_, index) => `const ${tag}_row_${index} = ${index};`).join('\n') + '\n';
}
function resolvedFileToolDefinition(h: ReturnType<typeof fixture>, name: 'write' | 'edit') {
  const base = name === 'write' ? createWriteToolDefinition('/tmp') : createEditToolDefinition('/tmp');
  const resolver = h.rendererResolvers[0]!;
  return { ...base, ...(resolver(name, () => rendererSet(base)) ?? {}) };
}
function writeToolDefinition(h: ReturnType<typeof fixture>) {
  return resolvedFileToolDefinition(h, 'write') as ReturnType<typeof createWriteToolDefinition>;
}
function editToolDefinition(h: ReturnType<typeof fixture>) {
  return resolvedFileToolDefinition(h, 'edit') as ReturnType<typeof createEditToolDefinition>;
}
type ReadRendererCalls = { call: number; result: number };
function readToolDefinition(h: ReturnType<typeof fixture>, calls?: ReadRendererCalls) {
  const base = createReadToolDefinition('/tmp');
  const resolved = h.rendererResolvers[0]!('read', () => rendererSet(base));
  if (resolved || !calls) return { ...base, ...resolved } as unknown as ReturnType<typeof createReadToolDefinition>;
  return {
    ...base,
    ...(base.renderCall ? { renderCall: (...args: Parameters<NonNullable<typeof base.renderCall>>) => {
      calls.call++; return base.renderCall!(...args);
    } } : {}),
    ...(base.renderResult ? { renderResult: (...args: Parameters<NonNullable<typeof base.renderResult>>) => {
      calls.result++; return base.renderResult!(...args);
    } } : {}),
  };
}
function readOwner(h: ReturnType<typeof fixture>, id: string, args: Record<string, unknown> = { path: `${id}.ts`, offset: 41 },
  calls?: ReadRendererCalls) {
  const tool = new ToolExecutionComponent('read', id, args, undefined, readToolDefinition(h, calls),
    h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  h.root.addChild(tool);
  return tool;
}
function writeOwner(h: ReturnType<typeof fixture>, id: string, content: string) {
  const tool = new ToolExecutionComponent('write', id, { path: `${id}.ts`, content }, undefined,
    writeToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  h.root.addChild(tool);
  return tool;
}
function editOwner(h: ReturnType<typeof fixture>, id: string, path = `${id}.ts`) {
  const tool = new ToolExecutionComponent('edit', id, { path, oldText: 'before', newText: 'after' }, undefined,
    editToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  h.root.addChild(tool);
  return tool;
}
function liveToolString(tool: ToolExecutionComponent, field: 'toolCallId' | 'toolName', label: 'id' | 'name'): string {
  const value = Reflect.get(tool, field);
  if (typeof value !== 'string') throw new TypeError(`fixture tool call has no ${label}`);
  return value;
}
function liveToolCallId(tool: ToolExecutionComponent): string {
  return liveToolString(tool, 'toolCallId', 'id');
}
function liveToolName(tool: ToolExecutionComponent): string {
  return liveToolString(tool, 'toolName', 'name');
}
function completeLiveFile(h: ReturnType<typeof fixture>, tool: ToolExecutionComponent,
  result: { content: []; isError: false; details?: { diff: string } } = { content: [], isError: false }) {
  tool.markExecutionStarted();
  h.events.get('tool_execution_end')!({ type: 'tool_execution_end', toolCallId: liveToolCallId(tool),
    toolName: liveToolName(tool), result, isError: false }, h.ctx);
  tool.updateResult(result, false);
}
function completeLiveEdit(h: ReturnType<typeof fixture>, tool: ToolExecutionComponent) {
  completeLiveFile(h, tool, { content: [], isError: false, details: { diff: '@@ -1 +1 @@\n-before\n+after' } });
}
function completeLiveWrite(h: ReturnType<typeof fixture>, tool: ToolExecutionComponent) { completeLiveFile(h, tool); }
function clickFile(tool: ToolExecutionComponent, y = 2) {
  return tool.handleMouse({ type: 'click', button: 'left', x: 5, y, screenX: 5, screenY: y,
    width: 80, height: 40, shift: false, alt: false, ctrl: false });
}
function clickFileSummary(tool: ToolExecutionComponent) {
  return clickFile(tool, 0) ?? clickFile(tool, 1);
}
async function settled() { for (let i = 0; i < 5; i++) await turn(); }
function observeNextRequest(root: UI) {
  const original = root.requestRender.bind(root), restore = () => { root.requestRender = original; };
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { restore(); reject(new Error('native edit preflight did not request its owning host render')); }, 1000);
    root.requestRender = function () { original(); clearTimeout(timeout); restore(); resolve(); };
  });
  return { ready, restore };
}
function weakDeferredInner(wrapper: object): WeakRef<object> {
  const inner = Reflect.get(wrapper, 'component') ?? Reflect.get(wrapper, 'inner') ?? (Reflect.get(wrapper, 'children') as Component[] | undefined)?.[0];
  assert.ok(inner && typeof Reflect.get(inner, 'render') === 'function', `capture the materialized native child from ${Reflect.get(wrapper, 'constructor')?.name} with keys ${Reflect.ownKeys(wrapper).join(',')}`);
  return new WeakRef(inner as object);
}
function observeNativeRendererCalls(tool: ToolExecutionComponent, callbackCalls?: ReadRendererCalls) {
  const calls = { call: 0, result: 0 }, seen = new WeakSet<object>(), invoked = new WeakSet<object>();
  const install = () => {
    for (const [slot, field] of [['call', 'callRendererComponent'], ['result', 'resultRendererComponent']] as const) {
      const component = Reflect.get(tool, field) as Component | undefined;
      if (!component || seen.has(component)) continue;
      seen.add(component);
      const render = component.render.bind(component);
      component.render = width => { calls[slot]++; return render(width); };
      if (component instanceof DeferredRenderer && callbackCalls && !invoked.has(component)) {
        invoked.add(component);
        const invoke = Reflect.get(component, 'invoke');
        if (typeof invoke === 'function') Reflect.set(component, 'invoke', () => {
          callbackCalls[slot]++; return invoke();
        });
      }
    }
  };
  install();
  return { calls, install };
}
function assertNativeRendererCold(tool: ToolExecutionComponent, slot: 'call' | 'result', message: string) {
  const wrapper = Reflect.get(tool, slot === 'call' ? 'callRendererComponent' : 'resultRendererComponent');
  assert.ok(wrapper instanceof DeferredRenderer, `${message}: public lazy wrapper remains installed`);
  assert.equal(Reflect.get(wrapper, 'component'), undefined, `${message}: Pi component has not been materialized`);
  assert.equal(Reflect.get(Reflect.get(wrapper, 'owner'), slot === 'call' ? 'callInner' : 'resultInner'), undefined,
    `${message}: owner retains no native inner component`);
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test('expanded read uses saved text, keeps stock callbacks cold, and retains Pi fallbacks', async () => {
  const preparations: unknown[] = [];
  const h = fixture('tui', false, undefined, undefined, receipt => preparations.push(receipt));
  try {
    await h.ready; await h.start();
    const args = { path: 'read-saved-text.ts', offset: 41 }, callbacks = { call: 0, result: 0 };
    const owner = readOwner(h, 'read-saved-text', args, callbacks), native = observeNativeRendererCalls(owner, callbacks);
    owner.setArgsComplete();
    const result = { content: [{ type: 'text' as const, text: 'const READ_SAVED_SENTINEL = 41;\nconst secondLine = READ_SAVED_SENTINEL + 1;\n[Showing lines 41-42 of 100. Use offset=43 to continue.]' }], isError: false };
    owner.updateResult(result, false);  native.install();

    const collapsed = plainRows(owner.render(80));
    assert.match(collapsed, /→ read read-saved-text\.ts \[offset=41\]/u, 'active collapsed read uses the existing owned compact summary');
    assert.doesNotMatch(collapsed, /READ_SAVED_SENTINEL/u);
    assert.equal(preparations.length, 0, 'collapsed read does not prepare or classify saved result text');
    assert.equal(native.calls.result, 0, 'the owned compact read does not render Pi result components');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'owned compact read invokes neither stock renderer callback');

    h.root.selection = true;
    assert.equal(clickFileSummary(owner)?.handled, undefined, 'active terminal selection prevents compact read toggling');
    assert.equal(Reflect.get(owner, 'expanded'), false, 'selection leaves compact read state unchanged');
    h.root.selection = false;
    assert.equal(clickFileSummary(owner)?.handled, true, 'the compact read summary is a click target');
    assert.equal(Reflect.get(owner, 'expanded'), true, 'clicking the read summary opens the owned full card');
     native.install();
    await settled();
    const expanded = plainRows(owner.render(80));
    assert.match(expanded, /→ Read/u);
    assert.match(expanded, /41.*READ_SAVED_SENTINEL/u);
    assert.match(expanded, /42.*secondLine/u);
    assert.match(expanded, /\[Showing lines 41-42 of 100\. Use offset=43 to continue\.\]/u);
    assert.doesNotMatch(expanded, /^\s*(?:\+|-) /mu, 'read uses a single plain-code pane, not a diff');
    assert.equal(Reflect.get(owner, 'args'), args, 'rendering retains the exact saved arguments');
    assert.equal(Reflect.get(owner, 'result'), result, 'rendering retains the exact saved tool result');
    assert.equal(preparations.some(value => (value as { phase?: unknown }).phase === 'updated'), true,
      'expanded read prepares its saved body through CardSources');
    assert.equal(native.calls.result, 0, 'the expanded owned read does not render Pi result components');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'owned expanded read invokes neither stock renderer callback');

    assert.equal(clickFile(owner, 2)?.handled, true, 'clicking the full read card collapses it');
    assert.equal(Reflect.get(owner, 'expanded'), false);
     native.install();
    await settled();
    const collapsedAgain = plainRows(owner.render(80));
    assert.match(collapsedAgain, /→ read read-saved-text\.ts \[offset=41\]/u);
    assert.doesNotMatch(collapsedAgain, /READ_SAVED_SENTINEL/u, 'collapse hides the full presentation');

    await h.appearance(false);
    owner.setExpanded(true);  native.install();
    const offRows = owner.render(80).join('\n');
    assert.match(offRows, /READ_SAVED_SENTINEL/u, 'Appearance Off retains Pi saved-result presentation');
    assert.ok(native.calls.result > 0, 'Appearance Off is a positive native result-render control');
    assert.ok(callbacks.call > 0 && callbacks.result > 0, `Appearance Off positively invokes both stock callbacks: ${JSON.stringify(callbacks)}`);
  } finally { await h.stop(); }
});

test('pending and failed read cards stay owned when saved arguments have no path', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const pendingCalls = { call: 0, result: 0 }, pending = readOwner(h, 'read-no-path-pending', {}, pendingCalls);
    pending.setArgsComplete(); pending.setExpanded(true); await settled();
    const pendingRows = plainRows(pending.render(80));
    assert.ok(pendingRows.includes('→ Read') && pendingRows.includes('Waiting for file content.'));
    assert.deepEqual(pendingCalls, { call: 0, result: 0 });

    const errorCalls = { call: 0, result: 0 }, failed = readOwner(h, 'read-no-path-error', {}, errorCalls);
    failed.setArgsComplete(); failed.updateResult({ content: [{ type: 'text', text: 'READ_ERROR_WITHOUT_PATH' }], isError: true }, false);
    failed.setExpanded(true); await settled();
    const failedRows = plainRows(failed.render(80));
    assert.ok(failedRows.includes('→ Read') && failedRows.includes('READ_ERROR_WITHOUT_PATH'));
    assert.deepEqual(errorCalls, { call: 0, result: 0 }, 'a final error without a path cannot escape through stock renderers');
  } finally { await h.stop(); }
});

test('expanded pending read keeps its bounded waiting detail without invoking stock callbacks', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-pending', { path: 'pending-read.ts' }, callbacks);
    owner.setArgsComplete(); owner.setExpanded(true); await settled();
    const rows = plainRows(owner.render(80));
    assert.match(rows, /→ Read/u);
    assert.match(rows, /Waiting for file content\./u);
    assert.deepEqual(callbacks, { call: 0, result: 0 });
  } finally { await h.stop(); }
});

test('expanded read failures show saved error text while stock callbacks stay cold', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const args = { offset: 23 };
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-error', args, callbacks), native = observeNativeRendererCalls(owner, callbacks); owner.setArgsComplete();
    const result = { content: [{ type: 'text' as const, text: 'READ_ERROR_BODY\nREAD_ERROR_STACK' }], isError: true };
    owner.updateResult(result, false);
    assert.doesNotMatch(owner.render(80).join('\n'), /READ_ERROR_BODY|READ_ERROR_STACK/u);
    native.install();
    assert.equal(native.calls.result, 0, 'collapsed read error does not render Pi result components');
    owner.setExpanded(true);  native.install(); await settled();
    const rows = plainRows(owner.render(80));
    assert.match(rows, /→ Read/u); assert.match(rows, /READ_ERROR_BODY/u); assert.match(rows, /READ_ERROR_STACK/u);
    assert.equal(Reflect.get(owner, 'args'), args); assert.equal(Reflect.get(owner, 'result'), result);
    assert.equal(native.calls.result, 0, 'expanded read error does not render Pi result components');
    assert.equal(native.calls.call, 0, 'expanded read error does not render Pi call components');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'owned read error invokes neither stock renderer callback');
  } finally { await h.stop(); }
});

test('read source updates and result invalidation prepare only current saved text', async () => {
  const preparations: unknown[] = [];
  const h = fixture('tui', false, undefined, undefined, receipt => preparations.push(receipt));
  try {
    await h.ready; await h.start();
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-refresh', { path: 'read-refresh.ts', offset: 7 }, callbacks), native = observeNativeRendererCalls(owner, callbacks);
    owner.setArgsComplete();
    const result = { content: [{ type: 'text' as const, text: 'const READ_VERSION_A = 1;' }], isError: false };
    owner.updateResult(result, false);  native.install(); owner.setExpanded(true); await settled();
    assert.match(owner.render(100).join('\n'), /7.*READ_VERSION_A/u);
    const preparedA = preparations.filter(value => (value as { phase?: unknown }).phase === 'updated').length;
    assert.ok(preparedA > 0, 'the initial expanded result is prepared');

    owner.updateResult({ content: [{ type: 'text' as const, text: 'const READ_VERSION_B = 2;' }], isError: false }, false);
     native.install(); await settled();
    const bRows = owner.render(100).join('\n');
    assert.match(bRows, /7.*READ_VERSION_B/u);
    assert.doesNotMatch(bRows, /READ_VERSION_A/u, 'same-path result replacement never revives old text');
    const preparedB = preparations.filter(value => (value as { phase?: unknown }).phase === 'updated').length;
    assert.equal(preparedB, preparedA + 1, 'one changed saved result creates one source update');

    const beforeUnchangedInvalidation = preparations.filter(value => (value as { phase?: unknown }).phase === 'updated').length;
    owner.invalidate(); native.install(); await settled();
    const unchangedRows = owner.render(100).join('\n');
    assert.match(unchangedRows, /7.*READ_VERSION_B/u);
    assert.doesNotMatch(unchangedRows, /READ_VERSION_A/u);
    assert.equal(preparations.filter(value => (value as { phase?: unknown }).phase === 'updated').length, beforeUnchangedInvalidation,
      'ordinary invalidation with unchanged saved result text reuses the read source token');
    const beforeWarm = preparations.length;
    owner.render(100); owner.render(58);
    assert.equal(preparations.length, beforeWarm, 'warm and width-only renders do not reprepare SOURCE');

    const currentResult = Reflect.get(owner, 'result') as { content: { type: string; text?: string }[] };
    currentResult.content[0]!.text = 'const READ_VERSION_C = 3;';
    owner.invalidate();  native.install(); await settled();
    const cRows = owner.render(100).join('\n');
    assert.match(cRows, /7.*READ_VERSION_C/u);
    assert.doesNotMatch(cRows, /READ_VERSION_A|READ_VERSION_B/u, 'native invalidation reads mutated saved result text');
    const preparedC = preparations.filter(value => (value as { phase?: unknown }).phase === 'updated').length;
    assert.equal(preparedC, preparedB + 1, 'same-object text mutation creates one new source update');

    owner.setExpanded(false);  await settled(); owner.render(80);
    owner.updateResult({ content: [{ type: 'text' as const, text: 'const READ_HIDDEN_D = 4;' }], isError: false }, false);
     native.install(); await settled(); owner.setExpanded(true);  native.install(); await settled();
    const dRows = owner.render(100).join('\n');
    assert.match(dRows, /7.*READ_HIDDEN_D/u);
    assert.doesNotMatch(dRows, /READ_VERSION_A|READ_VERSION_B|READ_VERSION_C/u, 'hidden updates cannot revive prior sources');
  } finally { await h.stop(); }
});

test('AFT read metadata-only invalidation refreshes source numbering and preserves literal stock fallback', async () => {
  const preparations: unknown[] = [], h = fixture('tui', false, undefined, undefined, value => preparations.push(value));
  try {
    await h.ready; await h.start();
    const owner = readOwner(h, 'aft-read-metadata', { path: 'saved.md', startLine: '41', offset: 900 });
    const text = '41: ## Saved heading\n42: original source';
    const details = { success: true, content: text, text, start_line: 41, end_line: 42, lines_read: 2 };
    owner.setArgsComplete(); owner.updateResult({ content: [{ type: 'text', text }], details, isError: false }, false);
    owner.setExpanded(true); await settled();
    const first = plainRows(owner.render(100));
    assert.match(first, /┃\s+41\s+## Saved heading/u);
    assert.doesNotMatch(first, /41: ## Saved heading/u);

    details.success = false; owner.invalidate(); await settled();
    const literal = plainRows(owner.render(100));
    assert.match(literal, /┃\s+900\s+41: ## Saved heading/u, 'the same saved text with invalidated metadata is not decoded using stale coordinates');
    details.success = true; owner.invalidate(); await settled();
    details.content = 'UNRELATED_METADATA_CONTENT'; owner.invalidate(); await settled();
    assert.match(plainRows(owner.render(100)), /┃\s+900\s+41: ## Saved heading/u, 'content-correlation changes alone invalidate decoded source');
    details.content = text; owner.invalidate(); await settled();
    assert.match(plainRows(owner.render(100)), /┃\s+41\s+## Saved heading/u);
    details.start_line = 42; details.end_line = 43; owner.invalidate(); await settled();
    assert.match(plainRows(owner.render(100)), /┃\s+900\s+41: ## Saved heading/u, 'coordinate-only changes must be validated against current saved prefixes');
    details.start_line = 41; details.end_line = 42; owner.invalidate(); await settled();
    details.lines_read = 1; details.end_line = 41; owner.invalidate(); await settled();
    assert.match(plainRows(owner.render(100)), /┃\s+900\s+41: ## Saved heading/u, 'a coherent count/range change cannot reuse a previously decoded full block');
    details.lines_read = 2; details.end_line = 42; owner.invalidate(); await settled();
    const restored = plainRows(owner.render(100));
    assert.match(restored, /┃\s+41\s+## Saved heading/u);
    assert.doesNotMatch(restored, /41: ## Saved heading/u);
    const count = preparations.length;
    owner.invalidate(); await settled(); owner.render(100); owner.render(58);
    assert.equal(preparations.length, count, 'unchanged valid metadata, warm frames and width changes retain prepared source');
  } finally { await h.stop(); }
});

test('expanded text-only read does not borrow Pi constructor spacers', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const owner = readOwner(h, 'read-text-only-spacer', { path: 'plain.ts' });
    owner.setArgsComplete(); owner.updateResult({ content: [{ type: 'text', text: 'const PLAIN_READ = true;' }], isError: false }, false); owner.setExpanded(true);
    const spacer = owner.children.find((child): child is Spacer => child instanceof Spacer);
    assert.ok(spacer, 'Pi supplies the constructor spacer in its public child list');
    let spacerCalls = 0;
    Reflect.set(spacer, 'render', () => { spacerCalls++; return ['READ_CONSTRUCTOR_SPACER']; });
    const rows = plainRows(owner.render(80));
    assert.match(rows, /const PLAIN_READ = true;/u);
    assert.doesNotMatch(rows, /READ_CONSTRUCTOR_SPACER/u, 'text-only read output excludes the constructor spacer');
    assert.equal(spacerCalls, 0, 'a text-only expanded read does not borrow the unrelated constructor spacer');
  } finally { await h.stop(); }
});

for (const failed of [false, true]) test(`expanded ${failed ? 'failed' : 'successful'} read reuses public Pi image children as unpadded protocol rows`, async () => {
  const previous = getCapabilities(); setCapabilities({ ...previous, images: 'kitty' });
  const h = fixture();
  try {
    await h.ready; await h.start();
    h.root.addChild(new Text('preceding visible row\nsecond visible row'));
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-image', { path: 'photo.png', offset: 1 }, callbacks), native = observeNativeRendererCalls(owner, callbacks);
    owner.setShowImages(true); owner.setImageWidthCells(30);
    owner.updateResult({ content: [
      { type: 'text', text: 'Read image: photo.png' },
      { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', mimeType: 'image/png' },
    ], isError: failed }, false);
    const initialImages = owner.children.filter((child): child is Image => child instanceof Image);
    assert.equal(initialImages.length, 1, 'the SDK owns and supplies the public image child');
    const renderedWidths: number[] = [], nativeRows: string[][] = [], observedImages = new WeakSet<Image>();
    const observeImage = (image: Image) => {
      if (observedImages.has(image)) return;
      observedImages.add(image);
      const originalRender = image.render.bind(image) as (width: number) => string[];
      image.render = width => { renderedWidths.push(width); const rows = originalRender(width); nativeRows.push(rows); return rows; };
    };
    observeImage(initialImages[0]!);
    owner.render(80); native.install();
    assert.equal(renderedWidths.length, 0, 'collapsed read does not paint its image child');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'owned image read does not invoke Pi text callbacks');
    owner.setExpanded(true);
    const images = owner.children.filter((child): child is Image => child instanceof Image);
    const spacers = owner.children.filter((child): child is Spacer => child instanceof Spacer);
    assert.equal(images.length, 1, 'expansion uses one current public image child');
    for (const image of images) observeImage(image);
    assert.ok(spacers.length > 0, 'the SDK supplies public reservation spacers around the image');
    const image = images[0]!;
    const imageIndex = owner.children.indexOf(image), imageSpacer = owner.children[imageIndex - 1];
    assert.ok(imageSpacer instanceof Spacer, 'Pi inserts the image reservation spacer immediately before its public Image child');
    const constructorSpacer = spacers.find(spacer => owner.children.indexOf(spacer) < imageIndex - 1);
    assert.ok(constructorSpacer, 'Pi also supplies an unrelated constructor spacer before the image block');
    const spacerRows = new Map<Spacer, string[]>(), spacerCalls = new Map<Spacer, number>();
    for (const spacer of spacers) {
      const reservation = spacer.render(cardGeometry(80).contentWidth);
      spacerRows.set(spacer, reservation); spacerCalls.set(spacer, 0);
      Reflect.set(spacer, 'render', () => { spacerCalls.set(spacer, spacerCalls.get(spacer)! + 1); return reservation; });
    }
    const rows = owner.render(80);
    const geometry = cardGeometry(80);
    assert.deepEqual(renderedWidths, [geometry.contentWidth], 'the existing Image renders only at useful inner width');
    assert.equal(spacerCalls.get(imageSpacer), 1, 'the image block borrows its own immediately preceding reservation spacer');
    assert.equal(spacerCalls.get(constructorSpacer), 0, 'the unrelated Pi constructor spacer is not added to the card');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'expanded image read remains in our saved-text presentation');
    const imageProtocolRows = nativeRows[0]!.filter(row => row.includes('\x1b_G') || row.includes('\x1b]1337;File='));
    assert.ok(nativeRows[0]!.length > 1, 'the fixture exercises a multi-row native image block');
    assert.ok(imageProtocolRows.length > 0, 'Pi produces a native Kitty or iTerm image protocol row');
    const prefix = `\x1b[0m\x1b[${geometry.contentX}C`;
    const expectedImageBlock = [...spacerRows.get(imageSpacer)!, ...nativeRows[0]!.map(row => !row ? ''
      : row.includes('\x1b_G') || row.includes('\x1b]1337;File=') ? prefix + row : row)];
    const firstProtocolInBlock = expectedImageBlock.findIndex(row => row.includes(prefix) && (row.includes('\x1b_G') || row.includes('\x1b]1337;File=')));
    const firstProtocolInOutput = rows.findIndex(row => row.includes(prefix) && (row.includes('\x1b_G') || row.includes('\x1b]1337;File=')));
    assert.ok(firstProtocolInBlock >= 0 && firstProtocolInOutput >= firstProtocolInBlock, 'the image protocol block is present in the card');
    const blockStart = firstProtocolInOutput - firstProtocolInBlock;
    assert.deepEqual(rows.slice(blockStart, blockStart + expectedImageBlock.length), expectedImageBlock,
      'image reservation rows, protocol continuations and surrounding order exactly match the current Pi child block');
    assert.ok(spacerRows.get(imageSpacer)!.length > 0 && spacerRows.get(imageSpacer)!.every(row => row === ''), 'the image reservation consists of literal empty rows');
    const imageProtocolRow = rows.findIndex(row => row.includes(prefix) && (row.includes('\x1b_G') || row.includes('\x1b]1337;File=')));
    const imageEvent = (y: number, height = rows.length, x = geometry.contentX) => owner.handleMouse({ type: 'click', button: 'left', x, y,
      screenX: x, screenY: y, width: 80, height, shift: false, alt: false, ctrl: false });
    assert.ok(imageProtocolRow >= 0, 'the owned output exposes the image row coordinate for hit testing');
    assert.equal(imageEvent(imageProtocolRow)?.handled, undefined, 'opaque protocol image rows are not hit-test targets');
    assert.equal(Reflect.get(owner, 'expanded'), true, 'clicking an image row cannot collapse the read');
    const plainFallbackImage = image.render;
    Reflect.set(image, 'render', () => ['plain image fallback']);
    const fallbackRows = plainRows(owner.render(80));
    assert.ok(fallbackRows.includes(`${' '.repeat(geometry.contentX)}plain image fallback`),
      'non-protocol image fallback aligns with the content column without framing');
    Reflect.set(image, 'render', plainFallbackImage);
    const interactiveRows = owner.render(80);
    assert.equal(interactiveRows[0], '', 'a multi-row predecessor contributes the ordinary nonzero separator');
    const textRow = interactiveRows.findIndex(row => row.includes('Read image: photo.png'));
    assert.ok(textRow >= 0);
    assert.equal(imageEvent(textRow, interactiveRows.length)?.handled, true, 'ordinary saved text rows remain clickable');
    assert.equal(Reflect.get(owner, 'expanded'), false, 'clicking saved text collapses the read');
    owner.setExpanded(true);
    const expandedRows = owner.render(80), bottomPaddingY = expandedRows.length - 1;
    assert.equal(imageEvent(0, expandedRows.length)?.handled, undefined, 'the nonzero predecessor separator is not a border hit');
    assert.equal(imageEvent(bottomPaddingY, expandedRows.length, 0)?.handled, undefined, 'exterior margin rows remain outside the hit target');
    assert.equal(Reflect.get(owner, 'expanded'), true);
    h.root.selection = true;
    assert.equal(imageEvent(bottomPaddingY, expandedRows.length)?.handled, undefined, 'active selection suppresses bottom-border toggling');
    assert.equal(Reflect.get(owner, 'expanded'), true);
    h.root.selection = false;
    assert.equal(imageEvent(bottomPaddingY, expandedRows.length)?.handled, true,
      'the actual final framed padding row remains clickable after the opaque image block and predecessor gap');
    assert.equal(Reflect.get(owner, 'expanded'), false, 'the bottom border collapses the expanded read');
    owner.setExpanded(true);
    const beforeZero = renderedWidths.length;
    assert.equal(cardGeometry(0).contentWidth, 0, 'the test width has no usable image content columns');
    owner.render(0);
    assert.equal(renderedWidths.length, beforeZero, 'zero usable content width never calls Image.render');
    owner.setShowImages(false);
    const hiddenImageRows = plainRows(owner.render(80));
    assert.equal(owner.children.filter(child => child instanceof Image).length, 0, 'Pi may rebuild the current image children when images are hidden');
    assert.match(hiddenImageRows, /Read image: photo\.png/u, 'saved textual context remains visible when images are hidden');
    assert.equal(hiddenImageRows.includes('\x1b_G') || hiddenImageRows.includes('\x1b]1337;File='), false);
    owner.setShowImages(true);
    owner.setImageWidthCells(35);
    assert.equal(owner.children.filter(child => child instanceof Image).length, 1, 'the rebuilt Pi display supplies one image child, not a duplicate');
    const rebuiltImage = owner.children.find((child): child is Image => child instanceof Image)!;
    Reflect.set(rebuiltImage, 'render', (imageWidth: number) => { renderedWidths.push(imageWidth); return []; });
    owner.render(80);
    assert.equal(renderedWidths.at(-1), cardGeometry(80).contentWidth, 'the current image child after both public setters is observed on the next expanded frame');
    owner.setExpanded(false); const beforeCollapse = renderedWidths.length; owner.render(80);
    assert.equal(renderedWidths.length, beforeCollapse, 'collapsed image is not rendered');
  } finally { await h.stop(); setCapabilities(previous); }
});

test('hidden foreign self-rendered reads preserve visible predecessor spacing before the next card', async () => {
  const preparations: unknown[] = [], h = fixture('tui', false, undefined, undefined, receipt => preparations.push(receipt));
  try {
    await h.ready; await h.start();
    h.root.addChild(new Text('visible predecessor'));
    const stock = createReadToolDefinition('/tmp');
    const foreign = { ...stock, renderShell: 'self' as const,
      renderCall: () => new Container(), renderResult: () => new Container() };
    const hidden = new ToolExecutionComponent('read', 'foreign-empty-read', { path: 'short.ts' }, undefined,
      foreign, h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(hidden);
    hidden.updateResult({ content: [{ type: 'text', text: 'hidden foreign content' }], isError: false }, false);
    assert.deepEqual(hidden.render(120), [], 'an empty foreign self shell remains genuinely hidden when collapsed');

    const next = readOwner(h, 'after-hidden-read', { path: 'next.ts' });
    next.updateResult({ content: [{ type: 'text', text: 'const NEXT_READ = true;' }], isError: false }, false);
    const compactAfterHidden = next.render(120);
    assert.equal(compactAfterHidden[0], '', 'a one-row compact successor preserves the preceding visible-message separator');

    hidden.setExpanded(true);
    assert.deepEqual(hidden.render(120), [], 'an empty foreign self shell remains genuinely hidden when expanded');
    assert.equal(next.render(120)[0], '', 'a hidden expanded read does not replace preceding-visible geometry');
    assert.equal(preparations.some(value => (value as { phase?: unknown; call?: unknown }).phase === 'updated' &&
      (value as { call?: unknown }).call === 'foreign-empty-read'), false, 'a hidden foreign shell does not admit read preparation');
  } finally { await h.stop(); }
});

test('collapsed foreign read hit-testing uses the current self-shell visibility', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start(); h.root.addChild(new Text('visible predecessor'));
    const stock = createReadToolDefinition('/tmp');
    const foreign = { ...stock, renderShell: 'self' as const,
      renderCall: () => new Container(), renderResult: () => new Container() };
    const expected = readOwner(h, 'visible-predecessor-next-read', { path: 'next.ts' });
    expected.updateResult({ content: [{ type: 'text', text: 'const NEXT_READ = true;' }], isError: false }, false);
    const expectedRows = expected.render(120);
    h.root.removeChild(expected);

    const hidden = new ToolExecutionComponent('read', 'collapsed-empty-read', { path: 'short.ts' }, undefined,
      foreign, h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(hidden);
    hidden.updateResult({ content: [{ type: 'text', text: 'hidden foreign content' }], isError: false }, false);
    assert.deepEqual(hidden.render(120), [], 'an empty foreign self shell remains genuinely hidden when collapsed');
    const next = readOwner(h, 'after-collapsed-hidden-read', { path: 'next.ts' });
    next.updateResult({ content: [{ type: 'text', text: 'const NEXT_READ = true;' }], isError: false }, false);
    assert.deepEqual(next.render(120), expectedRows, 'the collapsed hidden foreign summary adds no extra row or phantom spacing');
  } finally { await h.stop(); }
});

test('expanded foreign read hit-testing skips a now-empty prepared self shell', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start(); h.root.addChild(new Text('visible predecessor'));
    const compactBefore = readOwner(h, 'compact-before-hidden-read', { path: 'compact-before.ts' });
    compactBefore.updateResult({ content: [{ type: 'text', text: 'const COMPACT_BEFORE = true;' }], isError: false }, false);
    compactBefore.render(100);
    const call = new Container(), result = new Container();
    call.addChild(new Text('foreign call')); result.addChild(new Text('foreign result'));
    const stock = createReadToolDefinition('/tmp');
    const foreign = { ...stock, renderShell: 'self' as const, renderCall: () => call, renderResult: () => result };
    const hidden = new ToolExecutionComponent('read', 'expanded-empty-read', { path: 'hidden.ts' }, undefined,
      foreign, h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(hidden);
    hidden.updateResult({ content: [{ type: 'text', text: 'const HIDDEN_FULL_READ = true;' }], isError: false }, false);
    hidden.render(100); hidden.setExpanded(true); await settled();
    assert.match(hidden.render(100).join('\\n'), /HIDDEN_FULL_READ/u, 'the foreign read first becomes a genuinely prepared full card');
    call.clear(); result.clear();
    const next = readOwner(h, 'after-expanded-hidden-read', { path: 'next-expanded.ts' });
    next.updateResult({ content: [{ type: 'text', text: 'const NEXT_EXPANDED_READ = true;' }], isError: false }, false);
    const rows = next.render(100);
    assert.notEqual(rows[0], '', 'an empty previously prepared foreign shell contributes no full-card separator');
  } finally { await h.stop(); }
});

test('compatible foreign self-rendered read defers cold source preparation outside render', async () => {
  const h = fixture();
  const updateDisplay = CardSources.prototype.updateDisplay;
  let inRender = false, renderStackUpdates = 0, updates = 0;
  CardSources.prototype.updateDisplay = function(owner, input) {
    updates++; if (inRender) renderStackUpdates++;
    return updateDisplay.call(this, owner, input);
  };
  try {
    await h.ready; await h.start();
    const stock = createReadToolDefinition('/tmp'), calls = { call: 0, result: 0 };
    const foreign = { ...stock, renderShell: 'self' as const,
      renderCall: () => { calls.call++; return new Text('foreign read call'); },
      renderResult: () => { calls.result++; return new Text('foreign read result'); } };
    const owner = new ToolExecutionComponent('read', 'foreign-visible-read', { path: 'foreign.ts', offset: 7 }, undefined,
      foreign, h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(owner);
    owner.updateResult({ content: [{ type: 'text', text: 'const FOREIGN_READ_BODY = true;' }], isError: false }, false);
    owner.setExpanded(true);
    inRender = true;
    const initialRows = plainRows(owner.render(100));
    inRender = false;
    assert.equal(renderStackUpdates, 0, 'first visible foreign frame never calls CardSources.updateDisplay synchronously');
    assert.equal(updates, 0, 'cold display construction waits until after the component render returns');
    assert.doesNotMatch(initialRows, /FOREIGN_READ_BODY/u, 'unprepared saved body is not copied through a render fallback');

    const following = readOwner(h, 'following-foreign-read', { path: 'following.ts' });
    following.updateResult({ content: [{ type: 'text', text: 'const FOLLOWING_READ = true;' }], isError: false }, false);
    updates = 0; renderStackUpdates = 0; inRender = true;
    const predecessorMeasuredRows = plainRows(following.render(100));
    inRender = false;
    assert.match(predecessorMeasuredRows, /following\.ts/u, 'the following compact read itself remains visible');
    assert.equal(renderStackUpdates, 0, 'previousLayout/fileMeasure never admits the cold preceding read during render');
    assert.equal(updates, 0, 'predecessor geometry observes no cold source preparation');

    await turn(); await settled();
    assert.ok(updates > 0, 'the existing owner work path admits deferred preparation after visibility discovery');
    const rows = plainRows(owner.render(100));
    assert.match(rows, /→ Read/u);
    assert.match(rows, /7.*FOREIGN_READ_BODY/u, 'the compatible foreign read displays only the saved result text');
    assert.equal(renderStackUpdates, 0, 'the post-render admission remains outside every render stack');
    assert.ok(calls.call > 0 && calls.result > 0, 'visibility probing uses the foreign renderer callbacks without replacing them');
  } finally { CardSources.prototype.updateDisplay = updateDisplay; await h.stop(); }
});

test('read is excluded from the write/edit rolling automatic-full window', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const writes = Array.from({ length: 10 }, (_, index) => writeOwner(h, `read-window-${index}`, writeSource(`read_window_${index}`)));
    for (const owner of writes) completeLiveWrite(h, owner);
    const read = readOwner(h, 'read-window-read');
    read.updateResult({ content: [{ type: 'text', text: 'const READ_WINDOW_ONLY = true;' }], isError: false }, false);
    completeLiveFile(h, read);
    h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
    for (const [index, owner] of writes.entries())
      assert.match(owner.render(100).join('\n'), new RegExp(`read_window_${index}_row_13`), 'read does not consume one of ten automatic write slots');
    assert.doesNotMatch(read.render(100).join('\n'), /READ_WINDOW_ONLY/u, 'read stays a collapsed summary by default');
  } finally { await h.stop(); }
});

test('compact read policy keeps its precedence when native and compact flags both name read', async () => {
  const h = fixture(); h.setFlag('tidy-ui-compact', 'read'); h.setFlag('tidy-ui-card', 'read');
  try {
    await h.ready; await h.start();
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-compact-native-priority', { path: 'priority.ts' }, callbacks);
    owner.updateResult({ content: [{ type: 'text', text: 'const READ_PRIORITY = true;' }], isError: false }, false);
    const collapsed = plainRows(owner.render(80));
    assert.match(collapsed, /→ read priority\.ts/u, 'compact mode remains visible ahead of the native full-card override');
    assert.doesNotMatch(collapsed, /READ_PRIORITY/u);
    assert.deepEqual(callbacks, { call: 0, result: 0 });
    owner.setExpanded(true);
    const expanded = plainRows(owner.render(80));
    assert.match(expanded, /→ Read/u, 'combined flags still allow the manual owned full view');
    assert.match(expanded, /READ_PRIORITY/u, 'the explicit compact setting does not force the expanded body back to summary');
    assert.deepEqual(callbacks, { call: 0, result: 0 }, 'expanded combined-flag read still owns both stock callbacks');
  } finally { await h.stop(); }
});

test('explicit native read override keeps Pi renderers', async () => {
  const h = fixture(); h.setFlag('tidy-ui-card', 'read');
  try {
    await h.ready; await h.start();
    const callbacks = { call: 0, result: 0 }, owner = readOwner(h, 'read-native-override', { path: 'read-native-override.ts', offset: 41 }, callbacks);
    const native = observeNativeRendererCalls(owner, callbacks);
    owner.updateResult({ content: [{ type: 'text', text: 'const READ_NATIVE_OVERRIDE = true;' }], isError: false }, false);
    owner.setExpanded(true); native.install();
    const rows = plainRows(owner.render(80));
    assert.match(rows, /READ_NATIVE_OVERRIDE/u);
    assert.match(rows, /read read-native-override\.ts/u, 'explicit override keeps the stock read call presentation');
    assert.ok(callbacks.call > 0 && callbacks.result > 0, `explicit override invokes the native renderer callbacks: ${JSON.stringify(callbacks)}`);
  } finally { await h.stop(); }
});

test('unsupported host without public tool-renderer registration is rejected before hooks, flags, commands or preference IO', () => {
  const calls = { hooks: 0, flags: 0, commands: 0, settings: 0 };
  const unsupported = {
    on() { calls.hooks++; }, registerFlag() { calls.flags++; }, registerCommand() { calls.commands++; },
    getFlag() {}, getSettings: () => ({}), getThinkingLevel: () => 'off',
  } as unknown as ExtensionAPI;
  assert.throws(() => tidyUi(unsupported, { localPreferences: { appearanceEnabled: true, loggingEnabled: false },
    settings: { async load() { calls.settings++; return { ok: true, themePreference: { kind: 'pi', variant: 'dark' } }; }, async update() { return { ok: true }; } } }),
  /Pi 1\.0\.1.*registerToolRenderer/u);
  assert.deepEqual(calls, { hooks: 0, flags: 0, commands: 0, settings: 0 });
});

test('shared SDK extension fixture supports public renderer resolver registration', () => {
  const harness = sharedExtensionHarness();
  assert.equal(harness.toolRendererResolvers.length, 1);
  assert.equal(typeof harness.toolRendererResolvers[0], 'function');
});

test('public renderer resolver is installed before session use and wraps only exact stock write/edit pairs', async () => {
  const h = fixture();
  try {
    await h.ready;
    assert.equal(h.rendererResolvers.length, 1);
    assert.equal(h.counts.constructed, 0);
    const resolver = h.rendererResolvers[0]!;
    const write = createWriteToolDefinition('/tmp'), edit = createEditToolDefinition('/tmp');
    const stock: Record<'write' | 'edit', ToolRenderers> = { write: rendererSet(write), edit: rendererSet(edit) };
    for (const name of ['write', 'edit'] as const) {
      const base = stock[name], wrapped = resolver(name, () => base);
      assert.ok(wrapped);
      assert.equal(wrapped.renderShell, base.renderShell);
      assert.notEqual(wrapped.renderCall, base.renderCall);
      assert.notEqual(wrapped.renderResult, base.renderResult);
    }
    const foreignCall = (() => { throw new Error('foreign renderer must not be wrapped'); }) as NonNullable<ToolRenderers['renderCall']>;
    const foreign = { ...stock.write, renderCall: foreignCall };
    assert.equal(resolver('write', () => foreign), foreign);
    const mixed = { ...stock.edit, renderResult: foreignCall as unknown as NonNullable<ToolRenderers['renderResult']> };
    assert.equal(resolver('edit', () => mixed), mixed);
    assert.equal(resolver('bash', () => stock.write), stock.write);
    await h.start();
    assert.equal(h.counts.constructed, 1, 'renderer boundary is ready before session-driven syntax construction');
  } finally { await h.stop(); }
});

test('complete deferred stock pair proof rejects absent and foreign callbacks', () => {
  const stock = rendererSet(createWriteToolDefinition('/tmp'));
  const pair = createLazyNativeRendererResolver()('write', () => stock)!;
  const foreign = () => new Text('foreign');
  for (const [call, result, expected] of [
    [pair.renderCall, pair.renderResult, true], [pair.renderCall, undefined, false],
    [foreign, undefined, false], [foreign, pair.renderResult, false],
    [pair.renderCall, foreign, false], [undefined, undefined, false],
  ] as const) assert.equal(isDeferredStockFilePair(call, result), expected, 'membership requires both registered callbacks');
});

test('stock write/edit callbacks remain lazy through component updates and prepare only on native render', async () => {
  const h = fixture(), editRoot = await fs.mkdtemp(join(tmpdir(), 'tidy-ui-native-edit-')), editPath = join(editRoot, 'file.ts');
  await fs.writeFile(editPath, 'const value = 1;\n');
  let nativeStyleCalls = 0;
  const themeKey = Symbol.for('@earendil-works/pi-coding-agent:theme');
  const activeTheme = (globalThis as Record<PropertyKey, any>)[themeKey];
  assert.ok(activeTheme);
  const descriptor = Object.getOwnPropertyDescriptor(activeTheme, 'fg');
  const originalFg = activeTheme.fg.bind(activeTheme);
  Object.defineProperty(activeTheme, 'fg', { configurable: true, writable: true,
    value: (...args: Parameters<typeof themes.theme.fg>) => { nativeStyleCalls++; return originalFg(...args); } });
  try {
    await h.ready;
    const resolver = h.rendererResolvers[0]!;
    const write = createWriteToolDefinition('/tmp'), edit = createEditToolDefinition('/tmp');
    const resolved = (name: 'write' | 'edit', base: typeof write | typeof edit) => {
      const stock = rendererSet(base);
      return { ...base, ...(resolver(name, () => stock) ?? stock) } as typeof base;
    };
    const make = (name: 'write' | 'edit', id: string, args: Record<string, unknown>, definition: typeof write | typeof edit) =>
      new ToolExecutionComponent(name, id, args, undefined, resolved(name, definition), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');

    const writeTool = make('write', 'lazy-write', { path: '/tmp/lazy-write.ts', content: 'const latest = 2;\n' }, write);
    const editTool = make('edit', 'lazy-edit', { path: editPath, oldText: '1', newText: '2' }, edit);
    const editState = (Reflect.get(editTool, 'getRenderContext') as () => { state: Record<string, unknown> }).call(editTool).state;
    const foreignCallComponent = new Container(); foreignCallComponent.addChild(new Text('host-owned state'));
    editState.callComponent = foreignCallComponent;
    assert.equal(nativeStyleCalls, 0, 'construction invokes no stock call renderer');
    writeTool.updateArgs({ path: '/tmp/lazy-write.ts', content: 'const streamed = 3;\n' });
    editTool.updateArgs({ path: editPath, oldText: '1', newText: '2' });
    writeTool.markExecutionStarted(); editTool.markExecutionStarted();
    writeTool.setArgsComplete(); editTool.setArgsComplete();
    writeTool.invalidate(); editTool.invalidate();
    assert.equal(nativeStyleCalls, 0, 'argument streaming and invalidation stay lazy');

    const editPreviewWait = observeNextRequest(h.root);
    const writeCallRows = writeTool.render(80), editCallRows = editTool.render(80);
    assert.ok(nativeStyleCalls > 0, 'native call display materializes the stock callbacks');
    assert.ok(writeCallRows.join('\n').includes('lazy-write.ts') && writeCallRows.join('\n').includes('streamed'));
    assert.ok(editCallRows.join('\n').includes('file.ts'));
    const nativeWriteInnerRef = weakDeferredInner(Reflect.get(writeTool, 'callRendererComponent') as object);
    const nativeEditInnerRef = weakDeferredInner(Reflect.get(editTool, 'callRendererComponent') as object);
    await editPreviewWait.ready;
    editPreviewWait.restore();
    const nativeWriteInner = nativeWriteInnerRef.deref(), nativeEditInner = nativeEditInnerRef.deref();
    assert.ok(nativeWriteInner && nativeEditInner);
    assert.ok(Reflect.get(nativeEditInner, 'preview'), 'native edit preflight completes on a real temporary file');
    const callPrepared = nativeStyleCalls;
    writeTool.updateArgs({ path: '/tmp/lazy-write.ts', content: 'const updated = 4;\n' });
    assert.equal(nativeStyleCalls, callPrepared, 'write callback replacement remains lazy before render');
    const updatedWriteRows = writeTool.render(80);
    assert.equal(weakDeferredInner(Reflect.get(writeTool, 'callRendererComponent') as object).deref(), nativeWriteInner,
      'native write retains its component/cache when Pi replaces the callback');
    assert.ok(updatedWriteRows.join('\n').includes('updated'));
    const beforeEditUpdate = nativeStyleCalls;
    editTool.updateArgs({ path: editPath, oldText: '1', newText: '3' });
    assert.equal(nativeStyleCalls, beforeEditUpdate, 'native callback replacement remains lazy before render');
    const updatedEditWait = observeNextRequest(h.root);
    const updatedEditRows = editTool.render(80);
    assert.equal(weakDeferredInner(Reflect.get(editTool, 'callRendererComponent') as object).deref(), nativeEditInner,
      'edit keeps the stock call component and preflight state across callback replacement');
    assert.ok(updatedEditRows.join('\n').includes('file.ts'));
    await updatedEditWait.ready;
    updatedEditWait.restore();
    assert.ok(Reflect.get(nativeEditInner, 'preview'), 'updated edit settles its own preview in the reused native component');
    const settledEditRequests = h.root.requests;
    editTool.render(80);
    await settled();
    assert.equal(h.root.requests, settledEditRequests, 'a later native paint reuses the completed edit preview without restarting preflight');
    const completedDiff = '--- a/file.ts\n+++ b/file.ts\n@@\n-const value = 3;\n+const value = RESULT-DIFF-VALUE;\n';
    editTool.updateResult({ content: [], details: { diff: completedDiff }, isError: false }, false);
    const completedEditRows = editTool.render(80).join('\n');
    assert.ok(completedEditRows.includes('RESULT-DIFF-VALUE'), `the first completed edit frame includes its accepted result diff: ${completedEditRows}`);
    assert.equal(editState.callComponent, foreignCallComponent);
    assert.equal(foreignCallComponent.children.length, 1, 'the stock edit renderer never adopts inherited host component state');
    assert.ok(foreignCallComponent.render(80).join('\n').includes('host-owned state'));
    const beforeResultUpdate = nativeStyleCalls;
    writeTool.updateResult({ content: [{ type: 'text', text: 'write failed deliberately' }], isError: true });
    editTool.updateResult({ content: [{ type: 'text', text: 'edit failed deliberately' }], isError: true });
    assert.equal(nativeStyleCalls, beforeResultUpdate, 'result updates also stay lazy');

    const writeRows = writeTool.render(80), editRows = editTool.render(80);
    assert.ok(nativeStyleCalls > beforeResultUpdate, 'native result display materializes result callbacks');
    assert.ok(writeRows.join('\n').includes('write failed deliberately'));
    assert.ok(editRows.join('\n').includes('edit failed deliberately'), `native edit result rows: ${JSON.stringify(editRows)}`);
    const prepared = nativeStyleCalls;
    writeTool.render(80); editTool.render(80);
    assert.equal(nativeStyleCalls, prepared, 'unchanged native frames reuse materialized components');
  } finally {
    if (descriptor) Object.defineProperty(activeTheme, 'fg', descriptor);
    else delete activeTheme.fg;
    await h.stop();
    await fs.rm(editRoot, { recursive: true, force: true });
  }
});

test('same toolCallId in HTML export and a live TUI component keeps distinct lazy-renderer owners', async () => {
  const h = fixture(); let nativeStyleCalls = 0;
  const themeKey = Symbol.for('@earendil-works/pi-coding-agent:theme');
  const activeTheme = (globalThis as Record<PropertyKey, any>)[themeKey];
  assert.ok(activeTheme);
  const descriptor = Object.getOwnPropertyDescriptor(activeTheme, 'fg');
  const originalFg = activeTheme.fg.bind(activeTheme);
  Object.defineProperty(activeTheme, 'fg', { configurable: true, writable: true,
    value: (...args: Parameters<typeof themes.theme.fg>) => { nativeStyleCalls++; return originalFg(...args); } });
  try {
    await h.ready;
    const base = createWriteToolDefinition('/tmp'), stock = rendererSet(base), resolver = h.rendererResolvers[0]!;
    const wrapped = resolver('write', () => stock)!;
    const args = { path: '/tmp/shared-owner.ts', content: 'const owner = "live";\n' };
    const live = new ToolExecutionComponent('write', 'same-owner-id', args, undefined, wrapped,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    live.updateResult({ content: [{ type: 'text', text: 'write result for separate export state' }], isError: false });
    h.root.addChild(live);
    const liveRows = live.render(80);
    assert.ok(liveRows.join('\n').includes('shared-owner.ts'));
    const afterLive = nativeStyleCalls;
    assert.ok(afterLive > 0, 'the live TUI renderer is materialized');

    const { createToolHtmlRenderer } = await import(pathToFileURL(resolve(dist, 'core/export-html/tool-renderer.js')).href);
    const html = createToolHtmlRenderer({
      getToolRenderers(name: string) {
        return name === 'write' ? resolver('write', () => rendererSet(createWriteToolDefinition('/tmp'))) : undefined;
      }, theme: themes.theme, cwd: '/tmp', width: 80,
    });
    const call = html.renderCall('same-owner-id', 'write', args);
    const result = html.renderResult('same-owner-id', 'write', [{ type: 'text', text: 'separate HTML result' }], undefined, true);
    assert.ok(call?.includes('shared-owner.ts'));
    assert.ok(result?.expanded?.includes('separate HTML result'));
    assert.ok(nativeStyleCalls > afterLive, 'the real HTML exporter invokes its own stock callbacks');
    const afterHtml = nativeStyleCalls;
    live.render(80);
    assert.equal(nativeStyleCalls, afterHtml, 'HTML export with a matching id does not evict the live TUI renderer');
  } finally {
    if (descriptor) Object.defineProperty(activeTheme, 'fg', descriptor);
    else delete activeTheme.fg;
    await h.stop();
  }
});

test('same read toolCallId in HTML export and the live TUI keeps separate lazy-renderer owners', async () => {
  const h = fixture(); let nativeStyleCalls = 0;
  const themeKey = Symbol.for('@earendil-works/pi-coding-agent:theme');
  const activeTheme = (globalThis as Record<PropertyKey, any>)[themeKey];
  assert.ok(activeTheme);
  const descriptor = Object.getOwnPropertyDescriptor(activeTheme, 'fg');
  const originalFg = activeTheme.fg.bind(activeTheme);
  Object.defineProperty(activeTheme, 'fg', { configurable: true, writable: true,
    value: (...args: Parameters<typeof themes.theme.fg>) => { nativeStyleCalls++; return originalFg(...args); } });
  try {
    await h.ready;
    const resolver = h.rendererResolvers[0]!;
    const wrapped = resolver('read', () => rendererSet(createReadToolDefinition('/tmp')))!;
    const args = { path: '/tmp/shared-read-owner.ts' };
    const live = new ToolExecutionComponent('read', 'same-read-owner-id', args, undefined, wrapped,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    live.updateResult({ content: [{ type: 'text', text: 'const savedReadOwner = "live";\n' }], isError: false });
    live.setExpanded(true);
    h.root.addChild(live);
    const liveRows = live.render(80);
    assert.ok(liveRows.join('\n').includes('savedReadOwner'));
    const afterLive = nativeStyleCalls;

    const { createToolHtmlRenderer } = await import(pathToFileURL(resolve(dist, 'core/export-html/tool-renderer.js')).href);
    const html = createToolHtmlRenderer({
      getToolRenderers(name: string) {
        return name === 'read' ? resolver('read', () => rendererSet(createReadToolDefinition('/tmp'))) : undefined;
      }, theme: themes.theme, cwd: '/tmp', width: 80,
    });
    const call = html.renderCall('same-read-owner-id', 'read', args);
    const result = html.renderResult('same-read-owner-id', 'read', [{ type: 'text', text: 'separate HTML read result' }], undefined, true);
    assert.ok(call?.includes('shared-read-owner.ts'));
    assert.ok(result?.expanded?.includes('separate HTML read result'));
    assert.ok(nativeStyleCalls > afterLive, 'the real HTML exporter invokes its own stock read callbacks');
    const afterHtml = nativeStyleCalls;
    const liveAgain = live.render(80);
    assert.ok(liveAgain.join('\n').includes('savedReadOwner'));
    assert.ok(!liveAgain.join('\n').includes('separate HTML read result'));
    assert.equal(nativeStyleCalls, afterHtml, 'HTML export with a matching read id neither evicts nor revives the live renderer');
  } finally {
    if (descriptor) Object.defineProperty(activeTheme, 'fg', descriptor);
    else delete activeTheme.fg;
    await h.stop();
  }
});

test('file preview host identity ignores hidden suffixes and follows changed source metadata', async () => {
  const preparations: Parameters<NonNullable<TidyUiRuntimeOptions['cardPreparation']>>[0][] = [];
  const h = fixture('tui', false, undefined, undefined, event => preparations.push(event));
  try {
    await h.ready; await h.start();
    const source = writeSource('identity');
    const tool = writeOwner(h, 'file-source-identity', source);
    tool.setArgsComplete();
    tool.updateResult({ content: [], isError: false }, false);
    h.root.render(120); await settled();
    assert.equal((clickFile(tool, 2) as { handled?: boolean } | undefined)?.handled, true, 'select the user-owned full view from the default preview');
    assert.equal((clickFile(tool, 2) as { handled?: boolean } | undefined)?.handled, true, 'return to the bounded preview before testing identity');
    await settled();
    const sourceIdentities = () => new Set(preparations.filter(event => event.phase === 'updated').map(event => event.update)).size;
    const initialUpdates = sourceIdentities();
    assert.ok(initialUpdates > 0, 'the initial file source was accepted');

    let reads = 0, rejectWarmRead = false;
    const boundedInput: Record<string, unknown> = { path: 'file-source-identity.ts' };
    Object.defineProperty(boundedInput, 'content', { get() {
      if (rejectWarmRead) throw new Error('warm file preview reread the saved source');
      reads++; return `${source}\n${'hidden suffix '.repeat(1000)}`;
    } });
    tool.updateArgs(boundedInput); h.root.render(120); await settled();
    assert.equal(sourceIdentities(), initialUpdates, 'a new args object with only hidden suffix changes reuses the bounded preview');
    tool.updateResult({ content: [], isError: false }, false); h.root.render(120); await settled();
    reads = 0; rejectWarmRead = true;
    try {
      for (const width of [120, 120, 72, 72]) h.root.render(width);
      assert.equal(reads, 0, 'same-prefix args/result replacement refreshes the raw guard before width-only warm frames');
    } finally { rejectWarmRead = false; }
    assert.equal(sourceIdentities(), initialUpdates, 'hidden-only args and result replacements do not rebuild file source');

    tool.updateArgs({ path: 'file-source-identity.ts', content: `${source.replace('identity_row_0', 'visible_change')}\n${'hidden suffix '.repeat(1000)}` });
    h.root.render(120); await settled();
    assert.equal(sourceIdentities(), initialUpdates + 1, 'a visible preview-prefix change is adopted');
    assert.ok(h.root.render(120).join('\n').includes('visible_change'));

    const patch = '@@ -1,1 +1,1 @@\n-const old_saved_value = 0;\n+const selected_patch_value = 1;';
    tool.updateResult({ content: [], isError: false, details: { patch,
      diff: '@@ -1,1 +1,1 @@\n-const old_diff_value = 0;\n+const ignored_diff_value = 1;' } }, false);
    h.root.render(120); await settled();
    assert.equal(sourceIdentities(), initialUpdates + 2, 'a new result object carrying selected saved-patch metadata changes the source identity');
    let output = h.root.render(120).join('\n');
    assert.ok(output.includes('selected_patch_value'), `saved patch wins over its alternate diff: ${output}`);
    assert.ok(!output.includes('ignored_diff_value'));

    const replacementPatch = '@@ -1,1 +1,1 @@\n-const previous_saved_value = 0;\n+const latest_saved_value = 2;';
    tool.updateResult({ content: [], isError: false, details: { patch: replacementPatch } }, false);
    h.root.render(120); await settled();
    assert.equal(sourceIdentities(), initialUpdates + 3, 'a same-args changed saved patch refreshes its visible source');
    output = h.root.render(120).join('\n');
    assert.ok(output.includes('latest_saved_value'), `latest saved diff is prepared: ${output}`);
    assert.ok(!output.includes('selected_patch_value'));

    tool.updateResult({ content: [], isError: false, details: { patch, truncated: true, noOp: true } }, false);
    h.root.render(120); await settled();
    output = h.root.render(120).join('\n');
    assert.ok(output.includes('visible_change'), `truncated output returns to the supplied content: ${output}`);
    assert.ok(!output.includes('selected_patch_value'));
    assert.ok(output.includes('Diff truncated by tool'));
    assert.ok(output.includes('visible_change'));
  } finally { await h.stop(); }
});

test('warm bounded file renders do not reread, segment or reclassify saved source', async (t) => {
  const preparations: Parameters<NonNullable<TidyUiRuntimeOptions['cardPreparation']>>[0][] = [];
  const h = fixture('tui', false, undefined, undefined, event => preparations.push(event));
  let segmentationCalls = 0, segmentedUnits = 0;
  const segment = Intl.Segmenter.prototype.segment;
  try {
    await h.ready; await h.start();
    t.mock.method(Intl.Segmenter.prototype, 'segment', function (this: Intl.Segmenter, text: string) {
      segmentationCalls++;
      const iterator = segment.call(this, text);
      return { [Symbol.iterator]: function* () { for (const item of iterator) { segmentedUnits++; yield item; } } };
    });
    const content = writeSource('warm'), args: Record<string, unknown> = { path: 'warm-file.ts' };
    let reads = 0;
    Object.defineProperty(args, 'content', { enumerable: true, get() { reads++; return content; } });
    const definition = writeToolDefinition(h);
    const tool = new ToolExecutionComponent('write', 'warm-file-preview', args,
      undefined, definition, h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool);
    tool.setArgsComplete(); tool.updateResult({ content: [], isError: false }, false);
    h.root.render(120); await settled();
    assert.ok(reads > 0, 'cold admission reads the bounded source');
    const coldSourceUpdates = preparations.filter(event => event.phase === 'updated').length;
    assert.ok(segmentationCalls > 0 && segmentedUnits > 0, 'cold prepared rows are measured from segmented source glyphs');
    reads = 0; segmentationCalls = 0; segmentedUnits = 0;
    h.root.render(120);
    h.root.render(72);
    h.root.render(72);
    assert.equal(reads, 0, 'same-width and resized warm frames reuse the bounded source snapshot');
    assert.equal(segmentationCalls, 0, 'warm and resized frames do not construct another measurement');
    assert.equal(segmentedUnits, 0, 'warm and resized frames do not segment source glyphs');
    assert.equal(preparations.filter(event => event.phase === 'updated').length, coldSourceUpdates, 'warm and resized frames do not reclassify the file source');

    const lines = content.split('\\n');
    const replacement = [...lines.slice(0, 10), ...Array.from({ length: 4 }, (_, i) => `const changed_hidden_tail_${i} = ${i};`), ''].join('\n');
    const nextArgs: Record<string, unknown> = { path: 'warm-file.ts' }; let nextReads = 0;
    Object.defineProperty(nextArgs, 'content', { enumerable: true, get() { nextReads++; return replacement; } });
    tool.updateArgs(nextArgs as never); await settled();
    assert.ok(nextReads > 0, 'hidden-suffix replacement refreshes the current bounded raw-source guard');
    assert.equal(preparations.filter(event => event.phase === 'updated').length, coldSourceUpdates, 'same selected prefix keeps its source identity');
    reads = 0; nextReads = 0; segmentationCalls = 0; segmentedUnits = 0;
    for (const width of [120, 120, 72, 72]) h.root.render(width);
    assert.equal(nextReads, 0, 'warm frames do not reread the replacement argument');
    assert.equal(segmentationCalls, 0, 'warm frames after hidden-only argument replacement do not create new measurement');
    assert.equal(segmentedUnits, 0, 'warm frames after hidden-only argument replacement do no grapheme work');

    tool.updateResult({ content: [], isError: false, details: { diagnostics: [] } }, false); await settled();
    assert.ok(nextReads > 0, 'result replacement refreshes the weak source input guard once');
    nextReads = 0; segmentationCalls = 0; segmentedUnits = 0;
    for (const width of [120, 120, 72, 72]) h.root.render(width);
    assert.equal(nextReads, 0, 'warm frames do not reread the refreshed result-backed source guard');
    assert.equal(segmentationCalls, 0, 'result-only hidden replacement performs no repeated measurement');
    assert.equal(segmentedUnits, 0, 'result-only hidden replacement performs no repeated segmentation');
  } finally { await h.stop(); }
});

test('an ineligible streamed file update is re-adopted from the same source identity when complete again', async () => {
  const preparations: ({ phase: string; call: string } & Record<string, unknown>)[] = [];
  const h = fixture('tui', false, undefined, undefined, event => preparations.push(event));
  try {
    await h.ready; await h.start();
    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const source = writeSource('reattach'), tool = writeOwner(h, 'reattach-file', source);
    completeLiveWrite(h, tool); h.root.render(120); await settled();
    const before = preparations.filter(event => event.phase === 'updated' && event.call === 'reattach-file').length;
    tool.updateArgs({ content: source } as unknown as Parameters<typeof tool.updateArgs>[0]);
    h.root.render(120); await settled();
    tool.updateArgs({ path: 'reattach.ts', content: source });
    h.root.render(120); await settled();
    const after = preparations.filter(event => event.phase === 'updated' && event.call === 'reattach-file').length;
    assert.ok(after > before, 'the same owner/source identity must be prepared again after an ineligible interval');
    assert.match(tool.render(120).join(String.fromCharCode(10)), /reattach_row_13/, 'the previously applied file returns to its full successful view');
  } finally { await h.stop(); }
});

test('hidden-only argument replacement refreshes warm source cache without rescanning the saved content', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const prefix = 'x'.repeat(8192);
    const makeArgs = (suffix: string, count: { reads: number }) => {
      const args: Record<string, unknown> = { path: 'hidden-argument.ts' };
      Object.defineProperty(args, 'content', { enumerable: true, get() { count.reads++; return `${prefix}${suffix}`; } });
      return args;
    };
    const firstReads = { reads: 0 }, nextReads = { reads: 0 };
    const tool = new ToolExecutionComponent('write', 'hidden-argument-preview', makeArgs('-first', firstReads), undefined,
      writeToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool); tool.setArgsComplete(); tool.updateResult({ content: [], isError: false }, false);
    h.root.render(120); await settled();
    firstReads.reads = 0;
    tool.updateArgs(makeArgs('-second-hidden-suffix', nextReads)); await settled();
    assert.ok(nextReads.reads > 0, 'the changed args callback computes its bounded preview window');
    nextReads.reads = 0;
    for (const width of [120, 120, 72, 72]) h.root.render(width);
    assert.equal(nextReads.reads, 0, 'warm frames and resizes reuse the refreshed same-prefix source snapshot');

    tool.updateResult({ content: [], isError: false, details: { diagnostics: [] } }, false); await settled();
    assert.ok(nextReads.reads > 0, 'a result-only host update also refreshes the selected source snapshot once');
    nextReads.reads = 0;
    for (const width of [120, 120, 72, 72]) h.root.render(width);
    assert.equal(nextReads.reads, 0, 'the new result reference does not make subsequent frames reread unchanged file content');
  } finally { await h.stop(); }
});


test('hidden-only saved patch result replacement refreshes warm source cache without re-reading it', async () => {
  const preparations: ({ phase: string; call: string } & Record<string, unknown>)[] = [];
  const h = fixture('tui', false, undefined, undefined, event => preparations.push(event));
  try {
    await h.ready; await h.start();
    const newline = String.fromCharCode(10);
    const prefix = ['@@ -1,19 +1,19 @@', '-const old_value = 0;', '+const selected_value = 1;', ...Array.from({ length: 18 }, (_, i) => ` context_${i}`)].join(newline);
    const changedPrefix = ['@@ -1,19 +1,19 @@', '-const old_value = 0;', '+const selected_value = 2;', ...Array.from({ length: 18 }, (_, i) => ` context_${i}`)].join(newline);
    const makeResult = (suffix: string, count: { reads: number }, source = prefix) => {
      const details: Record<string, unknown> = {};
      Object.defineProperty(details, 'patch', { enumerable: true, get() { count.reads++; return `${source}${newline}@@ -30 +30 @@${newline} context_${suffix}`; } });
      return { content: [], isError: false, details };
    };
    const firstReads = { reads: 0 }, nextReads = { reads: 0 }, args = { path: 'hidden-result.ts', oldText: '', newText: '' };
    const tool = new ToolExecutionComponent('edit', 'hidden-result-preview', args, undefined,
      editToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool); tool.setArgsComplete(); tool.updateResult(makeResult('hidden-first', firstReads), false); h.root.render(120); await settled();
    firstReads.reads = 0;
    tool.updateResult(makeResult('hidden-next', nextReads), false); await settled();
    assert.ok(nextReads.reads > 0, 'the changed result callback updates its bounded source guard');
    assert.ok(preparations.some(event => event.phase === 'updated' && event.call === 'hidden-result-preview'), 'the edit source was prepared before warm checks');
    nextReads.reads = 0;
    for (const width of [120, 120, 72, 72]) h.root.render(width);
    assert.equal(nextReads.reads, 0, 'warm frames and resize reuse the new result reference when the selected patch is unchanged');

    const beforeVisibleChange = preparations.filter(event => event.phase === 'updated' && event.call === 'hidden-result-preview').length;
    nextReads.reads = 0;
    tool.updateResult(makeResult('visible-change', nextReads, changedPrefix), false); await settled();
    assert.ok(nextReads.reads > 0, 'the source snapshot inspects the visible replacement prefix');
    assert.ok(preparations.filter(event => event.phase === 'updated' && event.call === 'hidden-result-preview').length > beforeVisibleChange,
      'a changed row inside the selected patch prefix receives new source identity');
    const visibleRows = tool.render(120).join(newline);
    assert.match(visibleRows, /selected_value = 2/u);
    assert.doesNotMatch(visibleRows, /selected_value = 1/u, 'visible selected-source changes cannot reuse stale prepared rows');
  } finally { await h.stop(); }
});

test('custom argument updates preserve native batching and keep retained stock leaves current', async t => {
  const h = fixture();
  try {
    await h.ready;
    const native = writeOwner(h, 'native-argument-baseline', 'const initial = 0;');
    const prototype = Object.getPrototypeOf(native) as { updateDisplay(...args: unknown[]): unknown };
    const originalUpdate = prototype.updateDisplay, updates = new WeakMap<object, number>();
    t.mock.method(prototype, 'updateDisplay', function(this: ToolExecutionComponent, ...args: unknown[]) {
      updates.set(this, (updates.get(this) ?? 0) + 1);
      return originalUpdate.apply(this, args);
    });
    const nativeBefore = updates.get(native) ?? 0;
    native.updateArgs({ path: 'native-argument-baseline.ts', content: 'const next = 1;' });
    const nativeDelta = (updates.get(native) ?? 0) - nativeBefore;
    h.root.clear();

    await h.start();
    const tool = writeOwner(h, 'current-argument-owner', 'const initial = 0;');
    completeLiveWrite(h, tool); h.root.render(80); await settled();
    const before = updates.get(tool) ?? 0;
    let nativePreparations = 0;
    const materialize = DeferredRenderer.prototype.materialize;
    t.mock.method(DeferredRenderer.prototype, 'materialize', function(this: DeferredRenderer) {
      if (Reflect.get(this, 'invoke') && !Reflect.get(this, 'disposed') && !Reflect.get(this, 'component')) nativePreparations++;
      materialize.call(this);
    });
    for (let i = 1; i <= 3; i++) tool.updateArgs({ path: `current-argument-${i}.ts`, content: `const latest_${i} = ${i};` });
    const customDelta = (updates.get(tool) ?? 0) - before;
    assert.equal(customDelta, nativeDelta * 3, 'the adapter adds no native composition to the SDK update contract');
    h.root.render(80); await settled();
    assert.match(tool.render(80).join('\n'), /latest_3/u);
    const customPreparations = nativePreparations;
    assert.equal(customPreparations, 0, 'custom frames never materialize either stock slot');

    const retainedCall = Reflect.get(tool, 'callRendererComponent') as Component;
    const retainedResult = Reflect.get(tool, 'resultRendererComponent') as Component;
    const currentNative = retainedCall.render(80).join('\n');
    assert.match(currentNative, /current-argument-3\.ts/u);
    assert.match(currentNative, /latest_3/u, 'a retained lazy leaf uses current arguments without a native host flush');
    assert.deepEqual(retainedResult.render(80), []);
    assert.equal(nativePreparations, 2, 'genuine native access prepares the shared call/result pair once');
    console.log(JSON.stringify({ borrowedArguments: { nativeCompositionPerUpdate: nativeDelta, compositionsForThreeCustomUpdates: customDelta,
      customPreparations, preparationsAfterNativeAccess: nativePreparations } }));
  } finally { await h.stop(); }
});

for (const replaceCall of [false, true]) test(`removing a stock result renderer excludes the retained owner from argument synchronization${replaceCall ? ' with a foreign call' : ''}`, async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const stock = rendererSet(createWriteToolDefinition('/tmp'));
    const definition: ToolRenderers = { ...stock, ...h.rendererResolvers[0]!('write', () => stock) };
    const tool = new ToolExecutionComponent('write', 'incomplete-stock-pair',
      { path: 'incomplete-stock-pair.ts', content: 'const callback_generation_before = 1;' }, undefined, definition,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool); completeLiveWrite(h, tool); h.root.render(80); await settled();
    const previousCall = Reflect.get(tool, 'callRendererComponent');
    if (replaceCall) {
      const call = definition.renderCall!;
      definition.renderCall = (args, theme, context) => call(args, theme, context);
    }
    Reflect.deleteProperty(definition, 'renderResult');
    tool.updateArgs({ path: 'incomplete-stock-pair.ts', content: 'const callback_generation_after = 2;' });
    h.root.render(80); await settled();
    const currentCall = Reflect.get(tool, 'callRendererComponent') as Component;
    const nativeRows = currentCall.render(80).join('\n');
    const expected = currentCall === previousCall ? /callback_generation_before/u : /callback_generation_after/u;
    assert.match(nativeRows, expected, 'an incomplete pair changes arguments only through an actual native callback generation');
  } finally { await h.stop(); }
});

test('same-prefix argument and patch replacement releases old raw guards while owners stay live', { skip: !global.gc }, async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const selectedRows = Array.from({ length: 10 }, (_, i) => `const selected_row_${i} = ${i};`).join('\n') + '\\n';
    const write = writeOwner(h, 'raw-guard-write', selectedRows + 'const old_write_tail = 1;\\n'.repeat(3));
    write.setArgsComplete(); write.updateResult({ content: [], isError: false }, false); h.root.render(120); await settled();
    let oldArgs: object | undefined = Reflect.get(write, 'args') as object;
    const oldArgsRef = new WeakRef(oldArgs);
    write.updateArgs({ path: 'raw-guard-write.ts', content: selectedRows + 'const new_write_tail = 2;\\n'.repeat(3) });
    h.root.render(120); await settled(); oldArgs = undefined;

    const patch = (tail: string) => ['@@ -1,18 +1,18 @@', '-const old = 0;', '+const next = 1;',
      ...Array.from({ length: 17 }, (_, i) => ` context_${i}${i >= 7 ? tail : ''}`)].join('\n');
    const edit = new ToolExecutionComponent('edit', 'raw-guard-edit', { path: 'raw-guard-edit.ts', oldText: '', newText: '' }, undefined,
      editToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(edit); edit.setArgsComplete();
    let oldResult: object | undefined = { content: [], isError: false, details: { patch: patch('_old') } };
    edit.updateResult(oldResult as never, false); h.root.render(120); await settled();
    const oldResultRef = new WeakRef(oldResult);
    edit.updateResult({ content: [], isError: false, details: { patch: patch('_new') } }, false);
    h.root.render(120); await settled(); oldResult = undefined;

    for (let attempt = 0; attempt < 40 && (oldArgsRef.deref() || oldResultRef.deref()); attempt++) {
      await turn(); global.gc!(); await turn();
    }
    assert.equal(oldArgsRef.deref(), undefined, 'same-preview argument replacement refreshes its weak raw-source guard');
    assert.equal(oldResultRef.deref(), undefined, 'same-preview saved-patch replacement refreshes its weak raw-source guard');
    assert.equal(h.root.children.includes(write), true, 'the write owner remains attached');
    assert.equal(h.root.children.includes(edit), true, 'the edit owner remains attached');
  } finally { await h.stop(); }
});

test('full write tracks the content fallback when saved patch metadata contains only context', async () => {
  const preparations: ({ phase: string; call: string } & Record<string, unknown>)[] = [];
  const h = fixture('tui', false, undefined, undefined, event => preparations.push(event));
  try {
    await h.ready; await h.start();
    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const first = writeSource('fallback_first'), tool = writeOwner(h, 'full-content-fallback', first);
    tool.markExecutionStarted();
    const result = { content: [], isError: false, details: { patch: '@@ -1,1 +1,1 @@\n context_only' } };
    h.events.get('tool_execution_end')!({ type: 'tool_execution_end', toolCallId: liveToolCallId(tool), toolName: 'write', result, isError: false }, h.ctx);
    tool.updateResult(result, false); h.root.render(120); await settled();
    assert.ok(tool.render(120).some(row => row.includes('fallback_first_row_0')), 'valid context-only saved metadata falls back to supplied write content');
    const before = preparations.filter(event => event.phase === 'updated' && event.call === 'full-content-fallback').length;
    const next = writeSource('fallback_next'); tool.updateArgs({ path: 'full-content-fallback.ts', content: next }); tool.setArgsComplete();
    h.root.render(120); await settled();
    assert.ok(preparations.filter(event => event.phase === 'updated' && event.call === 'full-content-fallback').length > before,
      'full-mode identity includes possible fallback content even when the selected saved patch is unchanged');
    assert.ok(tool.render(120).some(row => row.includes('fallback_next_row_0')), 'new full-mode fallback content replaces the old code display');
  } finally { await h.stop(); }
});

test('ineligible file ownership releases superseded argument and result snapshots', { skip: !global.gc }, async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const tool = writeOwner(h, 'ineligible-source-release', writeSource('before_ineligible'));
    completeLiveWrite(h, tool);
    h.root.render(80); await settled();
    let oldArgs: object | undefined = Reflect.get(tool, 'args') as object;
    let oldResult: object | undefined = Reflect.get(tool, 'result') as object;
    const oldArgsRef = new WeakRef(oldArgs), oldResultRef = new WeakRef(oldResult);

    tool.updateResult({ content: [{ type: 'text', text: 'failed' }], isError: true }, false);
    tool.updateArgs({ path: 'after.ts', content: 'const after = true;\\n' });
    h.root.render(80); await settled();
    oldArgs = undefined; oldResult = undefined;
    for (let attempt = 0; attempt < 40 && (oldArgsRef.deref() || oldResultRef.deref()); attempt++) {
      await turn(); global.gc!(); await turn();
    }
    assert.equal(oldArgsRef.deref(), undefined, 'the live host keeps the replacement args, not the previous full input snapshot');
    assert.equal(oldResultRef.deref(), undefined, 'ineligible state keeps no previous result object solely as an identity key');
    assert.equal(h.root.children.includes(tool), true, 'the host owner stays alive while obsolete input objects are collected');
  } finally { await h.stop(); }
});

test('custom preview takeover releases superseded native children while the host retains its old layout', { skip: !global.gc }, async () => {
  const preparations: Parameters<NonNullable<TidyUiRuntimeOptions['cardPreparation']>>[0][] = [];
  const h = fixture('tui', false, {
    async load() { return { ok: true, themePreference: { kind: 'theme', id: 'gruvbox', variant: 'dark' }, nativeHighlightingEnabled: false }; },
    async update() { return { ok: true }; },
  }, { appearanceEnabled: true, loggingEnabled: false }, event => preparations.push(event));
  try {
    await h.ready;
    const base = createWriteToolDefinition('/tmp'), resolver = h.rendererResolvers[0]!;
    const wrapped = resolver('write', () => rendererSet(base))!;
    const tool = new ToolExecutionComponent('write', 'replacement-release-id',
      { path: '/tmp/before.ts', content: 'const before = true;\n' }, undefined, wrapped,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool);
    tool.setArgsComplete();
    tool.setExpanded(false);
    assert.ok(h.root.render(80).join('\n').includes('before.ts'));
    const oldWrapper = Reflect.get(tool, 'callRendererComponent') as object;
    const oldInnerRef = weakDeferredInner(oldWrapper);

    tool.updateArgs({ path: '/tmp/after.ts', content: 'const after = true;\n' });
    const latestNativeCall = h.root.render(80).join('\n');
    const updatedWrapper = Reflect.get(tool, 'callRendererComponent') as object;
    assert.notEqual(updatedWrapper, oldWrapper, 'Pi replaces the callback by the next native argument-update frame');
    assert.ok(latestNativeCall.includes('after.ts'), `current native file preview: ${latestNativeCall}`);
    assert.equal(weakDeferredInner(updatedWrapper).deref(), oldInnerRef.deref(), 'native callback replacement reuses the stock write component while rendering remains native');
    tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false);
    h.root.render(80);
    const nativeCallBeforeAttachRef = weakDeferredInner(Reflect.get(tool, 'callRendererComponent') as object);
    const nativeResultBeforeAttachRef = weakDeferredInner(Reflect.get(tool, 'resultRendererComponent') as object);
    const nativeSuccessfulResultRows = (Reflect.get(tool, 'resultRendererComponent') as Component).render(80);
    assert.deepEqual(nativeSuccessfulResultRows, [], 'Pi 1.0.1 write renderer intentionally presents no body for successful results');
    assert.ok(nativeResultBeforeAttachRef.deref(), 'the successful native result callback materializes its real component');

    await h.start();
    await h.appearance(false);
    tool.setExpanded(true);
    assert.ok(h.root.render(80).join('\n').includes('after.ts'), 'disabled appearance reaches the complete stock native call');
    const currentNativeCallRef = weakDeferredInner(Reflect.get(tool, 'callRendererComponent') as object);
    const currentNativeResultRef = weakDeferredInner(Reflect.get(tool, 'resultRendererComponent') as object);
    assert.equal(currentNativeCallRef.deref(), nativeCallBeforeAttachRef.deref(), 'native attachment reuses the latest stock write call component');
    assert.equal(currentNativeResultRef.deref(), nativeResultBeforeAttachRef.deref(), 'native attachment reuses the current stock result component');
    let retainedNativeCall = currentNativeCallRef.deref();
    let retainedNativeResult = currentNativeResultRef.deref();
    await h.appearance(true);
    tool.setExpanded(false);
    const currentCallWrapper = Reflect.get(tool, 'callRendererComponent') as object;
    const currentResultWrapper = Reflect.get(tool, 'resultRendererComponent') as object;
    assert.equal(currentNativeCallRef.deref(), retainedNativeCall, 'the live owner preserves its native call component through callback replacement');
    assert.equal(currentNativeResultRef.deref(), retainedNativeResult, 'the live owner preserves native result cache through callback replacement');
    const currentCallWrapperRef = new WeakRef(currentCallWrapper);
    const currentResultWrapperRef = new WeakRef(currentResultWrapper);
    const currentCallInnerRef = new WeakRef(retainedNativeCall!);
    const currentResultInnerRef = new WeakRef(retainedNativeResult!);
    const originalUpdateDisplay = Reflect.get(tool, 'updateDisplay') as (...args: unknown[]) => unknown;
    let displayUpdates = 0;
    Reflect.set(tool, 'updateDisplay', function (this: ToolExecutionComponent, ...args: unknown[]) {
      displayUpdates++;
      return originalUpdateDisplay.apply(this, args);
    });

    h.root.render(80);
    await settled();
    const preview = h.root.render(80).join('\n');
    assert.ok(preview.includes('after.ts'), `current custom file preview: ${preview}`);
    assert.ok(preparations.some(event => event.tool === 'write' && event.phase === 'prepared'),
      `the registered renderer selected a prepared custom file presentation: ${JSON.stringify({ preparations, counts: h.counts })}`);
    assert.equal(h.root.children.includes(tool), true, 'the live host component remains attached during release');
    assert.equal(displayUpdates, 0, 'custom takeover does not request a Pi display update');
    assert.equal(Reflect.get(tool, 'callRendererComponent'), currentCallWrapper, 'custom takeover does not regenerate the current call wrapper');
    assert.equal(Reflect.get(tool, 'resultRendererComponent'), currentResultWrapper, 'custom takeover does not regenerate the current result wrapper');
    assert.ok(currentCallWrapperRef.deref() && currentResultWrapperRef.deref(), 'the live Pi layout retains the current deferred leaves during takeover');
    retainedNativeCall = undefined; retainedNativeResult = undefined;

    for (let attempt = 0; attempt < 40 && (currentCallInnerRef.deref() || currentResultInnerRef.deref()); attempt++) { await turn(); global.gc!(); await turn(); }
    assert.equal(currentCallInnerRef.deref(), undefined, 'custom takeover releases the native call cache while the live host retains its deferred leaf');
    assert.equal(currentResultInnerRef.deref(), undefined, 'custom takeover releases the native result cache while the live host retains its deferred leaf');

    await h.appearance(false);
    displayUpdates = 0;
    Reflect.set(tool, 'expanded', true);
    const fallback = h.root.render(80).join('\n');
    assert.equal(displayUpdates, 0, 'native fallback render is reached without updateDisplay');
    assert.ok(fallback.includes('after.ts'), `native fallback rematerializes current source without updateDisplay: ${fallback}`);
    const fallbackResult = Reflect.get(tool, 'resultRendererComponent') as Component;
    assert.deepEqual(fallbackResult.render(80), nativeSuccessfulResultRows, 'native fallback preserves Pi’s exact empty presentation for a successful write result');
    assert.ok(weakDeferredInner(fallbackResult).deref(), 'native fallback rematerializes the current result callback without updateDisplay');
  } finally { await h.stop(); }
});

test('native renderer failures use bounded reported fallbacks and recover on the next callback generation', async () => {
  const h = fixture('tui', false, undefined, { appearanceEnabled: true, loggingEnabled: false });
  try {
    await h.ready;
    await h.start();
    const base = createWriteToolDefinition('/tmp'), resolver = h.rendererResolvers[0]!;
    const context = { toolCallId: 'bounded-failure-id', state: {}, argsComplete: true, isPartial: false, expanded: false, isError: true, cwd: '/tmp' } as Parameters<NonNullable<ToolRenderers['renderCall']>>[2];
    const failingTheme = new Proxy(themes.theme, { get(target, key, receiver) {
      if (key === 'fg') return () => { throw new Error('PRIVATE_RENDERER_EXCEPTION'); };
      return Reflect.get(target, key, receiver);
    } });
    const wrapped = resolver('write', () => rendererSet(base))!;
    const callRows = wrapped.renderCall!({ path: `/tmp/${'p'.repeat(5000)}.ts`, content: 'PRIVATE_CALL_CONTENT' }, failingTheme, context).render(80);
    const resultRows = wrapped.renderResult!({ content: [{ type: 'text', text: `PRIVATE_RESULT_${'r'.repeat(5000)}` }], details: undefined },
      { expanded: false, isPartial: false }, failingTheme, context).render(80);
    assert.match(callRows.join('\n'), /Native write preview unavailable/u);
    assert.match(resultRows.join('\n'), /Native file result unavailable/u);
    assert.ok(callRows.join('\n').length < 1000 && resultRows.join('\n').length < 1000);
    assert.doesNotMatch(`${callRows.join('\n')}\n${resultRows.join('\n')}\n${h.notices.join('\n')}`, /PRIVATE_/u);
    await settled();
    await h.page('Status & troubleshooting');
    assert.match(h.view, /Problems detected/u);
    assert.match(h.view, /appearance.*native_renderer/u);

    const recovered = resolver('write', () => rendererSet(base))!;
    const recoveredCall = recovered.renderCall!({ path: '/tmp/recovered.ts', content: 'const recovered = true;\n' }, themes.theme, context).render(80).join('\n');
    const recoveredResult = recovered.renderResult!({ content: [{ type: 'text', text: 'recovered native result' }], details: undefined },
      { expanded: false, isPartial: false }, themes.theme, context).render(80).join('\n');
    assert.match(recoveredCall, /recovered\.ts/u);
    assert.match(recoveredResult, /recovered native result/u);
    await h.page('Status & troubleshooting');
    assert.match(h.view, /No active runtime errors/u);

    const readBase = createReadToolDefinition('/tmp');
    const readContext = { ...context, toolCallId: 'bounded-read-failure-id', state: {}, args: { path: '/tmp/read.ts' } } as Parameters<NonNullable<ToolRenderers['renderResult']>>[3];
    const wrappedRead = resolver('read', () => rendererSet(readBase))!;
    const readRows = wrappedRead.renderResult!({ content: [{ type: 'text', text: 'PRIVATE_READ_RESULT' }], details: undefined },
      { expanded: false, isPartial: false }, failingTheme, readContext).render(80).join('\n');
    assert.match(readRows, /Native file result unavailable/u);
    assert.doesNotMatch(readRows, /PRIVATE_READ_RESULT|PRIVATE_RENDERER_EXCEPTION/u);
    await settled();
    await h.page('Status & troubleshooting');
    assert.match(h.view, /appearance.*native_renderer/u, 'read callback failures use the existing native renderer diagnostic reporter');
  } finally { await h.stop(); }
});

test('entry starts syntax only asynchronously after eligible interactive adapter attachment', async () => {
  const h = fixture(); assert.deepEqual(h.counts, { constructed: 0, load: 1, saves: 0, shared: 0, owned: 0 });
  const starting = h.start(); assert.equal(h.counts.constructed, 0); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 1);
  await starting; assert.equal(h.counts.constructed, 1);
  await settled(); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1); assert.equal(h.counts.owned, 1);
  await h.start(); h.root.render(80); await settled(); assert.equal(h.counts.constructed, 1); assert.equal(h.counts.shared, 1);
});

test('entry print/json/rpc modes restore preferences for logging but never construct syntax or open a menu', async () => {
  for (const mode of ['print', 'json', 'rpc']) {
    const h = fixture(mode); await h.start(); await h.command(''); await settled();
    assert.equal(h.counts.constructed, 0); assert.equal(h.counts.shared, 0); assert.equal(h.counts.load, 1);
    assert.match(h.notices.at(-1)!, /terminal mode/);
  }
});

async function observeTerminalDefaults(h: ReturnType<typeof fixture>, directory: string) {
  const path = join(directory, 'theme.json'), packets: string[] = [];
  await fs.writeFile(path, '{"colors":{"text":"#eeeeee"},"export":{"pageBg":"#123456"}}');
  Object.assign(h.ctx.ui, { theme: Object.assign(themes.getThemeByName('dark')!, { sourcePath: path }) });
  Object.assign(h.root, { terminalColorSchemeNotificationsEnabled: false,
    terminal: { start() {}, stop() {}, write(data: string) { packets.push(data); } } });
  return packets;
}

for (const [name, contents, enabled] of [
  ['missing configuration', undefined, false],
  ['empty configuration', '{}', false],
  ['legacy theme-only configuration', '{"syntaxTheme":{"kind":"pi"}}', false],
  ['saved On', '{"terminalColorsEnabled":true}', true],
  ['saved Off', '{"terminalColorsEnabled":false}', false],
  ['invalid configuration', '{"terminalColorsEnabled":"true"}', false],
] as const) test(`entry terminal colors: ${name} respects the opt-in default without writing preferences`, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-colors-default-')), file = join(directory, 'config.json');
  if (contents !== undefined) await fs.writeFile(file, contents);
  const h = fixture('tui', false, new ExtensionSettings({ file }));
  const packets = await observeTerminalDefaults(h, directory);
  try {
    await h.start(); await settled();
    await h.page(); assert.match(h.view, new RegExp(`Set terminal colors from Pi theme\\s+${enabled ? 'On' : 'Off'}`));
    await h.page('Status & troubleshooting'); assert.match(h.view, /Use Occipital highlighting\s+On/);
    assert.equal(packets.some(packet => /\x1b\](?:10|11);[^?]/u.test(packet)), enabled, 'only a saved On may set terminal defaults');
    if (!enabled) assert.equal(packets.length, 0, 'default Off must not set or reset unowned channels');
    if (contents === undefined) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(file, 'utf8'), contents, 'loading defaults must not rewrite configuration');
  } finally { await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry terminal colors: removing a shared preference releases colors without writing or disabling highlighting', async () => {
  let changed!: (value: SettingsLoadResult) => void, saves = 0;
  const h = fixture('tui', false, {
    async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: true }; },
    async update() { saves++; return { ok: true }; }, watch(callback) { changed = callback; return () => {}; },
  });
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-colors-shared-'));
  const packets = await observeTerminalDefaults(h, directory);
  try {
    await h.start(); await settled(); assert.ok(packets.some(packet => packet.includes('\x1b]11;')));
    changed({ ok: true, themePreference: { kind: 'pi', variant: 'dark' } }); await settled();
    assert.equal(packets.at(-1), '\x1b]111\x07\x1b]110\x07');
    await h.page(); assert.match(h.view, /Set terminal colors from Pi theme\s+Off/);
    await h.page('Status & troubleshooting'); assert.match(h.view, /Use Occipital highlighting\s+On/);
    assert.equal(saves, 0);
  } finally { await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry native disable is saved and survives master off/on without provider reactivation or duplicate loads', async () => {
  const h = fixture(); await h.start(); await settled();
  await h.page('Status & troubleshooting', 'Use Occipital highlighting');
  assert.equal(h.counts.saves, 1);
  await h.appearance(false); const before = { ...h.counts };
  await h.appearance(true); await settled();
  assert.equal(h.counts.constructed, before.constructed + 1); assert.equal(h.counts.load, before.load);
  assert.equal(h.counts.shared, before.shared); assert.equal(h.counts.owned, before.owned); assert.equal(h.counts.saves, 1);
});

test('entry root/status while master-off never construct syntax; theme page never starts a provider', async () => {
  const h = fixture(); await h.appearance(false);
  await h.page('Status & troubleshooting', 'Highlighting service details');
  assert.equal(h.counts.constructed, 0); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 0);
  await h.page('Code color theme'); await settled();
  assert.equal(h.counts.constructed, 1); assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 0); assert.equal(h.counts.owned, 0);
});

test('entry uses prepared file path and preserves actual SDK args/results on warm and resized frames', async () => {
  const h = fixture();
  const tool = new ToolExecutionComponent('write', 'entry-write', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    writeToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const args = JSON.stringify(Reflect.get(tool, 'args')), result = JSON.stringify(Reflect.get(tool, 'result'));
  const original = SourceController.prototype.adoptPiFlat;
  let stores = 0, inRender = false, storesInRender = 0;
  SourceController.prototype.adoptPiFlat = function (...parameters) {
    stores++; if (inRender) storesInRender++;
    return original.apply(this, parameters);
  };
  const render = (width: number) => { inRender = true; try { return h.root.render(width); } finally { inRender = false; } };
  try {
    await h.start(); render(80); assert.equal(stores, 0); await settled(); const before = { ...h.counts };
    assert.equal(stores, 1, 'one prepared public Pi bridge, not the legacy render classifier');
    for (const width of [80, 60, 100, 80]) render(width);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(stores, 1); assert.equal(storesInRender, 0);
    assert.equal(JSON.stringify(Reflect.get(tool, 'args')), args); assert.equal(JSON.stringify(Reflect.get(tool, 'result')), result);
  } finally { SourceController.prototype.adoptPiFlat = original; }
});


test('entry projects trusted terminal backgrounds into prepared Pi input without replacing public foreground bindings', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-entry-colors-')), path = join(directory, 'theme.json');
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg: Record<string, string> = {}, bg: Record<string, string> = {}, stock: Theme = themes.getThemeByName('dark')!;
  for (const [role, color] of Object.entries(stock.colors))
    (backgrounds.has(role) ? bg : fg)[role] = colorToHex(color);
  Object.assign(fg, { text: '', toolOutput: '#eeeeee', dim: '', muted: '', toolDiffAdded: '#00ff00', toolDiffRemoved: '#ff0000' });
  for (const role of Object.keys(fg)) if (role.startsWith('syntax')) fg[role] = '#eeeeee';
  Object.assign(bg, { toolPendingBg: '', toolSuccessBg: '#2d4935', toolErrorBg: '#492d35' });
  themes.setTerminalColors({ foreground: { r: 229, g: 229, b: 231 }, background: { r: 10, g: 11, b: 12 } });
  const original = SyntaxRuntime.prototype.preparePaletteInput, originalVisit = CardSources.prototype.visit;
  const preparedPaints: { mode: string; opens: readonly string[] }[] = [];
  CardSources.prototype.visit = function (this: CardSources<object>, owner: object, consume) {
    return originalVisit.call(this, owner, (display, paint) => {
      preparedPaints.push({ mode: paint.mode, opens: Object.values(paint.roles).map(style => style.open) }); consume(display, paint);
    });
  } as typeof CardSources.prototype.visit;
  try {
    for (const [background, mode] of [['#123456', 'truecolor'], ['#0a0b0c', 'truecolor'], ['#123456', '256color']] as const) {
      await fs.writeFile(path, JSON.stringify({ colors: { text: '#eeeeee' }, export: { pageBg: background } }));
      const h = fixture('tui', false, { async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: true }; },
        async update() { return { ok: true }; } }), theme = new Theme(fg as never, bg as never, mode, { name: 'entry-colors', sourcePath: path, dim: ['dim', 'muted'] });
      Object.assign(h.ctx.ui, { theme });
      Object.assign(h.root, { terminalColorSchemeNotificationsEnabled: false, terminal: { start() {}, stop() {}, write() {} } });
      const nativeColors = theme.colors, nativePrefix = theme.getBgAnsi('toolPendingBg');
      const tool = new ToolExecutionComponent('write', 'entry-colors-write', { path: 'tiny.txt', content: 'TRUSTED_COLOR' }, undefined,
        writeToolDefinition(h), h.root as never, '/tmp');
      tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
      const samples: { roles: ReturnType<typeof samplePiCardPalette>; mode: string; foregrounds: string[] }[] = [];
      SyntaxRuntime.prototype.preparePaletteInput = function (palette, input, revision, mode, funding) {
        if (palette.kind === 'pi' && input) samples.push({ roles: samplePiCardPalette(input, mode), mode,
          foregrounds: (['toolOutput', 'dim', 'muted'] as const).map(role => input.getFgAnsi(role)) });
        return original.call(this, palette, input, revision, mode, funding);
      };
      try {
        await h.start(); await settled(); h.root.render(80); await settled();
        const rows = h.root.render(80);
        assert.ok(rows.some(row => row.includes('TRUSTED_COLOR'))); assert.ok(samples.length > 0);
        const sample = samples.at(-1)!;
        const explicit = new Theme(fg as never, { ...bg, toolPendingBg: background } as never, mode, { dim: ['dim', 'muted'] });
        const expected = samplePiCardPalette(explicit, mode);
        assert.deepEqual(sample.roles.panel.background, expected.panel.background, 'known default must not be mistaken for an unknown terminal default');
        assert.equal(sample.roles.panel.background.kind, mode === 'truecolor' ? 'rgb' : 'indexed');
        const readyPaints = preparedPaints.filter(paint => paint.mode === mode);
        assert.ok(readyPaints.length > 0, 'the installed card published its final compiled paint');
        if (mode === '256color') assert.ok(readyPaints.every(paint => paint.opens.every(open => !/\x1b\[(?:38|48);2;/.test(open))),
          'compiled card roles follow the current public mode, independent of Pi UI chrome');
        assert.equal(sample.roles.prompt.foreground.kind, 'terminal-default');
        assert.equal(sample.roles.prompt.attributes, 8, 'raw faint must not be reapplied to an already blended RGB');
        assert.equal(sample.mode, theme.getColorMode());
        assert.deepEqual(sample.foregrounds, (['toolOutput', 'dim', 'muted'] as const).map(role => theme.getFgAnsi(role)));
        assert.deepEqual(sample.roles.addedCode.background, expected.addedCode.background, 'known equal-default and explicit background derive the same tint');
        if (background === '#123456' && mode === 'truecolor') {
          assert.deepEqual(sample.roles.panel.background, { kind: 'rgb', r: 18, g: 52, b: 86 }, 'the declared concrete background is projected exactly');
          assert.notDeepEqual(sample.roles.addedCode.background, sample.roles.panel.background, 'known foreground constraints still admit a structural tint');
        }
        const before = samples.length;
        for (const width of [80, 60, 100, 80]) h.root.render(width);
        await settled(); assert.equal(samples.length, before, 'warm/resize never resample the public Pi bindings');
        assert.equal(theme.colors, nativeColors); assert.equal(theme.getBgAnsi('toolPendingBg'), nativePrefix);
        assert.equal(nativePrefix, '\x1b[49m'); assert.equal(colorToHex(theme.colors.toolPendingBg), '#0a0b0c');
      } finally { await h.stop(); }
    }
  } finally {
    SyntaxRuntime.prototype.preparePaletteInput = original; CardSources.prototype.visit = originalVisit; themes.setTerminalColors({});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('entry paints a saved owned palette from its installer-local input owner without a Pi preparation callback', async () => {
  const h = fixture('tui', false, { async load() { return { ok: true, themePreference: { kind: 'theme', id: 'gruvbox', variant: 'dark' }, nativeHighlightingEnabled: false }; },
    async update() { return { ok: true }; } });
  const tool = new ToolExecutionComponent('write', 'entry-owned-write', { path: 'owned.ts', content: 'const ownedInput = 1;' }, undefined,
    writeToolDefinition(h), h.root as never, '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const expected = sampleOwnedPalette('gruvbox-dark', themes.theme.getColorMode()).compiledRoles.code.open;
  try {
    await h.start(); h.root.render(80); await settled();
    const rows = h.root.render(80);
    assert.ok(rows.some(row => row.includes('const ownedInput = 1;')));
    assert.ok(rows.some(row => row.includes(expected)), 'the actual installed card paints from its local owned-palette input owner');
    assert.equal(h.counts.shared, 0); assert.equal(h.counts.owned, 0, 'Native Off still paints the selected local palette');
  } finally { await h.stop(); }
});

test('entry logging controls use public session metadata, remain alive while presentation is off, and contain no bodies', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-entry-log-'));
  const h = fixture('tui', { root: directory });
  try {
    await h.start(); await settled();
    await h.events.get('session_info_changed')!({ name: 'Readable session' }, h.ctx);
    await h.page('Status & troubleshooting', 'Diagnostic logs');
    assert.match(h.view, /entry-fixture/);
    assert.match(h.view, /Readable session/);
    await h.appearance(false);
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /snapshot/i);
    await h.recording(false);
    assert.match(h.view, /off/i);
    await h.recording(true);
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    const names = await fs.readdir(directory);
    assert.ok(names.every(name => /\.log(?:\.1)?$/u.test(name)), names.join(', '));
    assert.equal(names.filter(name => name.endsWith('.closed.log')).length, 1);
    const body = await fs.readFile(join(directory, names.find(name => name.endsWith('.closed.log'))!), 'utf8');
    assert.match(body, /Pi session: \/example\/entry-fixture\.jsonl/);
    assert.match(body, /Pi session name changed; name=Readable session/);
    assert.match(body, /Snapshot.*presentation=false/i);
    assert.match(body, /capture disabled/i); assert.match(body, /capture resumed/i);
    assert.match(await fs.readFile(join(directory, 'sessions.log'), 'utf8'), /session=entry-fixture/);
    const filesBefore = await fs.readdir(directory);
    await h.command('logs list');
    assert.match(h.notices.at(-1)!, /Usage:.*tidy-ui/u);
    assert.deepEqual(await fs.readdir(directory), filesBefore);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test('entry logging escapes UI session metadata and separates switch/resume/reload runs without history scans', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-session-events-')), h = fixture('tui', { root });
  try {
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const first = debugLoggingDiagnostics()!;
    assert.equal(first.session, 'entry-fixture'); assert.equal(first.state, 'active');
    await h.events.get('session_info_changed')!({ name: 'name\nforged\x1b[31m' }, h.ctx);
    await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /name\\nforged\\x1b\[31m/);
    assert.equal(h.view.includes('name\nforged'), false);
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.equal(debugLoggingDiagnostics()!.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'resume' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'other-session' });
    await h.start({ type: 'session_start', reason: 'resume' }); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const second = debugLoggingDiagnostics()!;
    assert.equal(second.session, 'other-session'); assert.notEqual(second.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx);
    Object.assign(h.ctx.sessionManager, { getSessionId: () => 'entry-fixture' });
    await h.start({ type: 'session_start', reason: 'resume' }); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); const resumed = debugLoggingDiagnostics()!;
    assert.equal(resumed.session, first.session); assert.notEqual(resumed.run, first.run);
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    const common = await fs.readFile(join(root, 'sessions.log'), 'utf8');
    assert.equal((common.match(/Session started:/gu) ?? []).length, 3);
    assert.equal((common.match(/Session ended:/gu) ?? []).length, 3);
    assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.closed.log')).length, 3);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('entry logging failure and disabled snapshot are truthful, isolate presentation, and retry only on explicit on', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-entry-error-'));
  let refuse = false;
  const io = { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), writev = handle.writev.bind(handle);
    handle.writev = <T extends readonly NodeJS.ArrayBufferView[]>(buffers: T, position?: number) => {
      if (refuse) throw Object.assign(Error('PRIVATE_DISK_ERROR_BODY'), { code: 'ENOSPC' });
      return writev(buffers, position);
    };
    return handle;
  } };
  const h = fixture('tui', { root, io });
  try {
    await h.start(); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); await settled(); const before = { ...h.counts }, initial = debugLoggingDiagnostics()!;
    await h.recording(false); const disabled = debugLoggingDiagnostics()!;
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.match(h.view, /Snapshot not written.*off/i);
    assert.equal(debugLoggingDiagnostics()!.records, disabled.records); assert.equal(debugLoggingDiagnostics()!.writes, disabled.writes);
    await h.recording(true); refuse = true;
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot'); assert.match(h.view, /snapshot could not be written/i); assert.match(h.view, /ENOSPC/);
    const failed = debugLoggingDiagnostics()!;
    assert.equal(failed.state, 'failed'); assert.equal(failed.pendingBytes, 0); assert.equal(failed.inFlightBytes, 0); assert.equal(failed.timer, false);
    assert.equal(h.notices.filter(message => message.includes('Debug logging stopped')).length, 1);
    assert.match(h.notices.find(message => message.includes('Debug logging stopped'))!, /^\[pi-tidy-ui\] Debug logging stopped/u);
    assert.equal(h.notices.some(message => message.includes('PRIVATE_DISK_ERROR_BODY')), false);
    for (let i = 0; i < 50; i++) h.root.render(80);
    await settled(); assert.deepEqual(h.counts, before); assert.equal(debugLoggingDiagnostics()!.writes, failed.writes);
    refuse = false; await h.recording(true); await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.equal(debugLoggingDiagnostics()!.state, 'active'); assert.equal(debugLoggingDiagnostics()!.run, initial.run);
    assert.notEqual(debugLoggingDiagnostics()!.path, initial.path); assert.deepEqual(h.counts, before);
  } finally {
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('logging review H3: explicit snapshot includes existing Git and owned fallback-animation aggregates', async t => {
  let release!: () => void;
  const opening = new Promise<void>(resolve => { release = resolve; });
  const root = await fs.mkdtemp(join(tmpdir(), 'tidy-log-snapshot-'));
  const h = fixture('tui', { root, io: { ...fs, async open(...args: Parameters<typeof fs.open>) {
    await opening; return fs.open(...args);
  } } });
  try {
    await h.start(); assert.equal(debugLoggingDiagnostics()!.state, 'starting');
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /Snapshot not written.*unavailable/u);
    assert.equal(debugLoggingDiagnostics()!.state, 'starting');
    release();
    await t.waitFor(() => assert.equal(debugLoggingDiagnostics()!.state, 'active'));
    await h.page('Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot');
    assert.match(h.view, /Done\./u);
    const status = debugLoggingDiagnostics()!;
    const text = await fs.readFile(status.path, 'utf8');
    assert.match(text, /\[git\].*Snapshot.*queries=/);
    assert.match(text, /\[animation\].*Snapshot.*wakes=0.*requests=0/);
  } finally {
    release();
    await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('entry public streaming identities separate quick live abort from restored terminal cards without history lookup', async () => {
  const h = fixture(), observed: { text: string; complete: boolean }[] = [];
  const prepare = CardSources.prototype.prepare;
  CardSources.prototype.prepare = function (ticket) {
    const state = Reflect.get(ticket, 'state') as WeakRef<{ input?: CardDisplayInput }>;
    const input = state.deref()?.input;
    if (input?.kind === 'bash') observed.push({ text: String(input.args.command), complete: input.complete });
    return prepare.call(this, ticket);
  };
  const tool = (id: string, text: string) => {
    const node = new ToolExecutionComponent('bash', id, { command: text }, undefined, undefined,
      h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(node); return node;
  };
  const abort = (node: ToolExecutionComponent) => node.updateResult({ content: [{ type: 'text', text: 'Operation aborted' }], isError: true }, false);
  const stream = async (id: string, kind: string) => {
    const message = { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: ": 'live" } }] };
    await h.events.get('message_start')!({ type: 'message_start', message }, h.ctx);
    await h.events.get('message_update')!({ type: 'message_update', message,
      assistantMessageEvent: { type: kind, contentIndex: 0, partial: message } }, h.ctx);
  };
  try {
    await h.start(); await settled();
    const restored = tool('restored', ": 'saved"); abort(restored);
    h.root.render(80); await settled();
    assert.deepEqual(observed, [{ text: ": 'saved", complete: true }]);
    const baseline = observed.length;
    for (const kind of ['toolcall_start', 'toolcall_delta', 'toolcall_end']) {
      await stream(`live-${kind}`, kind);
      const live = tool(`live-${kind}`, ": 'live");
      await h.events.get('message_end')!({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } }, h.ctx);
      abort(live); h.root.render(80); await settled();
      assert.equal(observed.length, baseline, 'quick live abort starts no classifier, even before its first useful frame');
      await h.events.get('agent_end')!({ type: 'agent_end' }, h.ctx);
      h.root.removeChild(live);
      const reopened = tool(`live-${kind}`, ": 'reopened"); abort(reopened);
      h.root.render(80); await settled();
      assert.deepEqual(observed.at(-1), { text: ": 'reopened", complete: true }, 'agent-end releases only primitive live IDs; same ID/new owner is static');
      h.root.removeChild(reopened); observed.length = baseline;
    }
    for (let i = 0; i < 100; i++) h.root.render(80);
    await settled(); assert.equal(observed.length, baseline);
    assert.equal(Reflect.get(restored, 'argsComplete'), false); assert.equal(Reflect.get(restored, 'executionStarted'), false);
  } finally { CardSources.prototype.prepare = prepare; }
});

test('entry persists shared preferences; a same-process runtime restores local Off before any provider or log IO', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-preferences-entry-'));
  const file = join(directory, 'config.json'), store = new ExtensionSettings({ file });
  await store.update({ terminalColorsEnabled: true });
  const local = { appearanceEnabled: true, loggingEnabled: true };
  const first = fixture('tui', { root: join(directory, 'first-logs') }, store, local);
  try {
    await first.start(); await settled();
    await first.page('Status & troubleshooting', 'Use Occipital highlighting');
    await first.page('Set terminal colors from Pi theme');
    await first.recording(false); await first.appearance(false);
    await first.page('Code color theme', 'Follow Pi theme');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { syntaxTheme: { kind: 'pi' }, syntaxThemeVariant: 'dark',
      terminalColorsEnabled: false, nativeHighlightingEnabled: false });
    await first.stop();
    const nextRoot = join(directory, 'restored-logs');
    const next = fixture('tui', { root: nextRoot }, new ExtensionSettings({ file }), local);
    await next.start(); await settled();
    assert.equal(next.counts.constructed, 0); assert.equal(next.counts.shared, 0); assert.equal(next.counts.owned, 0);
    const log = debugLoggingDiagnostics()!;
    assert.equal(log.capture, false); assert.equal(log.writes, 0); assert.equal(log.scans, 0); assert.equal(log.timer, false);
    await assert.rejects(fs.stat(nextRoot), { code: 'ENOENT' });
    await next.page(); assert.match(next.view, /Tidy UI appearance\s+Off/); assert.match(next.view, /Set terminal colors from Pi theme\s+Off/);
    await next.page('Status & troubleshooting'); assert.match(next.view, /Use Occipital highlighting\s+Off/);
    assert.equal(next.counts.constructed, 0);
    await next.page('Code color theme'); assert.equal(next.counts.constructed, 1); assert.equal(next.counts.shared, 0);
    await next.appearance(true); await settled(); assert.equal(next.counts.shared, 0); assert.equal(next.counts.owned, 0);
    await next.page('Status & troubleshooting', 'Use Occipital highlighting'); await settled();
    assert.equal(next.counts.shared, 1); assert.equal(next.counts.owned, 1);
    assert.equal(debugLoggingDiagnostics()!.writes, 0); await next.stop();
  } finally { await first.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry failed switch persistence reports applied-but-unsaved without undoing the live choice', async () => {
  let saves = 0;
  const store = { async load(): Promise<SettingsLoadResult> { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: false }; },
    async update() { saves++; return { ok: false as const, issue: { code: 'write-failed' as const, message: 'Settings could not be saved.' } }; } };
  const h = fixture('tui', false, store); await h.start();
  await h.page('Set terminal colors from Pi theme');
  assert.match(h.view, /Set terminal colors from Pi theme\s+On/); assert.match(h.view, /Applied for now, but not saved/);
  assert.equal(saves, 1); await h.stop();
  const fresh = fixture('tui', false, store); await fresh.start(); await fresh.page();
  assert.match(fresh.view, /Set terminal colors from Pi theme\s+Off/); assert.equal(fresh.counts.constructed, 1);
});

test('entry one overlay survives native generation changes and master off/on, using the new syntax owner afterward', async () => {
  const h = fixture(); await h.start(); await settled();
  let mounts = 0;
  await withMenu(async (args, ctx) => { mounts++; await h.command(args); }, h.ctx, async menu => {
    await menu.select('Status & troubleshooting'); await menu.select('Use Occipital highlighting');
    await menu.key('\x1b'); await menu.select('Tidy UI appearance');
    assert.match(menu.text(), /Tidy UI appearance\s+Off/);
    await menu.select('Tidy UI appearance'); assert.match(menu.text(), /Tidy UI appearance\s+On/);
    await menu.select('Code color theme'); await menu.select('Follow Pi theme');
    assert.match(menu.text(), /Code color theme\s+Follow Pi/);
    assert.doesNotMatch(menu.text(), /Applying|Applied and saved|Choices are saved automatically/);
  });
  assert.equal(mounts, 1); assert.equal(h.counts.constructed, 2); assert.equal(h.counts.saves, 2);
  assert.equal(h.counts.load, 1); assert.equal(h.counts.shared, 1);
});

test('entry shutdown aborts a pending switch save and closes the overlay; late completion cannot notify or restart anything', async () => {
  let release!: (value: { ok: true }) => void, signal: AbortSignal | undefined;
  const saving = new Promise<{ ok: true }>(resolve => { release = resolve; });
  const h = fixture('tui', false, {
    async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: false }; },
    update(_patch, options) { signal = options?.signal; return saving; },
  });
  await h.start();
  await withMenu((_args, _ctx) => h.command(''), h.ctx, async menu => {
    const changing = menu.select('Set terminal colors from Pi theme'); await turn();
    assert.equal(signal?.aborted, false);
    await h.stop(); assert.equal(signal?.aborted, true);
    const before = { ...h.counts }, notices = [...h.notices];
    release({ ok: true }); await changing; await settled();
    assert.deepEqual(h.counts, before); assert.deepEqual(h.notices, notices); assert.equal(menu.text(), '');
  });
});

test('entry a retired pending initial load cannot install UI, open logs, start providers, or emit a stale warning', async () => {
  let release!: (value: SettingsLoadResult) => void;
  const loading = new Promise<SettingsLoadResult>(resolve => { release = resolve; });
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-retired-start-')), logs = join(directory, 'logs');
  const h = fixture('tui', { root: logs }, { load: () => loading, async update() { return { ok: true }; } });
  try {
    const starting = h.start(); await h.stop();
    release({ ok: false, themePreference: { kind: 'pi', variant: 'dark' }, issue: { code: 'invalid-json', message: 'Settings JSON could not be read.' } });
    await starting; await settled();
    assert.deepEqual(h.counts, { constructed: 0, load: 0, saves: 0, shared: 0, owned: 0 });
    assert.equal(h.notices.length, 0); await assert.rejects(fs.stat(logs), { code: 'ENOENT' });
  } finally { await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('latest local appearance choice wins across popup reopening while older cleanup is pending without config writes', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-switch-order-'));
  const disk = new ExtensionSettings({ file: join(directory, 'config.json') });
  const saves: Promise<unknown>[] = [];
  const store = { load: () => disk.load(), update(...args: Parameters<ExtensionSettings['update']>) {
    const operation = disk.update(...args); saves.push(operation); return operation;
  } };
  let release!: () => void, entered!: () => void;
  const heldCleanup = new Promise<void>(resolve => { release = resolve; });
  const disposing = new Promise<void>(resolve => { entered = resolve; });
  const original = SyntaxRuntime.prototype.dispose; let first = true;
  SyntaxRuntime.prototype.dispose = function () {
    const stopped = original.call(this);
    if (!first) return stopped;
    first = false; entered(); return Promise.all([stopped, heldCleanup]).then(() => {});
  };
  try {
    const h = fixture('tui', false, store); await h.start(); await settled();
    await withMenu(() => h.command(''), h.ctx, async menu => {
      await menu.key('\x1b[A'); menu.input('\r'); await disposing; menu.input('\x03');
    });
    await h.appearance(true);
    assert.equal(saves.length, 0, 'local confirmation never enters the config writer while older cleanup remains held');
    release(); await settled(); await Promise.all(saves);
    assert.equal(saves.length, 0, 'neither confirmation nor cleanup writes a local preference');
    await assert.rejects(fs.stat(disk.file), { code: 'ENOENT' });
    await h.page(); assert.match(h.view, /Tidy UI appearance\s+On/);
    const restored = fixture('tui', false, store); await restored.start(); await restored.page();
    assert.match(restored.view, /Tidy UI appearance\s+On/);
  } finally { release(); SyntaxRuntime.prototype.dispose = original; await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry gives the same overlay live per-page sizing without remounts or preference/provider side effects', async () => {
  const h = fixture(); await h.start(); await settled(); const before = { ...h.counts };
  let mounts = 0;
  await withMenu(async args => { mounts++; await h.command(args); }, h.ctx, async menu => {
    const root = menu.width(); assert.ok(root < 72);
    for (let i = 0; i < 10; i++) { await menu.key('\x1b[B'); assert.equal(menu.width(), root); }
    await menu.select('Status & troubleshooting'); const support = menu.width();
    assert.notEqual(support, root, 'one live options object exposes the new page width');
    await menu.select('Highlighting service details');
    assert.ok(menu.width() < 50);
    await menu.key('\x1b'); assert.equal(menu.width(), support);
    await menu.key('\x1b'); assert.equal(menu.width(), root);
  });
  assert.equal(mounts, 1); assert.deepEqual(h.counts, before);
});


test('entry discards an unconfirmed theme preview when a session shuts down and constructs its next runtime', async () => {
  let saves = 0;
  const original = { kind: 'theme' as const, id: 'saved-independent-theme' };
  const h = fixture('tui', false, { load: async () => ({ ok: true, themePreference: themePreferenceFromSettings(original, 'dark') }),
    update: async () => { saves++; return { ok: true }; } });
  await h.start(); await settled();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme');
    assert.match(menu.text(), /Selected: saved-independent-theme/);
    // The missing owned palette is intentionally not fabricated as a row.
    await menu.key('\x1b[B'); await menu.key('\x1b[A');
    assert.match(menu.text(), /Selected: Follow Pi/);
    assert.equal(saves, 0);
    await h.stop();
  });
  await h.start({ type: 'session_start', reason: 'resume' }); await settled();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme');
    assert.match(menu.text(), /Selected: saved-independent-theme/);
  });
  assert.equal(saves, 0);
});

test('settings policy: appearance and diagnostic recording are process-local actions without config writes', async () => {
  const h = fixture(); await h.start();
  await h.appearance(false); await h.recording(false);
  assert.equal(h.counts.saves, 0);
  await h.page(); assert.match(h.view, /Tidy UI appearance\s+Off/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Record diagnostic logs\s+Off/);
});

test('settings sync: external shared fields apply without saves, local flags stay local, and retired callbacks cannot act', async () => {
  let changed!: (value: SettingsLoadResult) => void, stops = 0, saves = 0;
  const h = fixture('tui', false, { load: async () => ({ ok: true, themePreference: { kind: 'pi', variant: 'dark' } }),
    async update() { saves++; return { ok: true }; }, watch(callback) { changed = callback; return () => { stops++; }; } });
  await h.start(); await h.appearance(false); await h.recording(false);
  changed({ ok: true, themePreference: { kind: 'theme', id: 'peer-B', variant: 'dark' }, terminalColorsEnabled: false, nativeHighlightingEnabled: false });
  await h.page(); assert.match(h.view, /Tidy UI appearance\s+Off/); assert.match(h.view, /Set terminal colors from Pi theme\s+Off/); assert.match(h.view, /peer-B/);
  await h.page('Status & troubleshooting'); assert.match(h.view, /Use Occipital highlighting\s+Off/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Record diagnostic logs\s+Off/);
  changed({ ok: false, themePreference: { kind: 'pi', variant: 'dark' }, issue: { code: 'invalid-json', message: 'Settings contain invalid JSON or UTF-8.' } });
  await h.page(); assert.match(h.view, /peer-B/); assert.equal(saves, 0);
  await h.stop(); assert.equal(stops, 1); const counts = { ...h.counts }, warnings = [...h.notices];
  changed({ ok: true, themePreference: { kind: 'pi', variant: 'dark' }, nativeHighlightingEnabled: true }); await settled();
  assert.deepEqual(h.counts, counts); assert.deepEqual(h.notices, warnings); assert.equal(saves, 0);
});

test('settings policy: reload restores local flags from process memory while a fresh process owner starts On', async () => {
  const memory = { appearanceEnabled: true, loggingEnabled: true };
  const first = fixture('tui', false, undefined, memory); await first.start();
  await first.appearance(false); await first.recording(false); await first.stop();
  const reloaded = fixture('tui', false, undefined, memory); await reloaded.start(); await reloaded.page();
  assert.match(reloaded.view, /Tidy UI appearance\s+Off/); assert.equal(reloaded.counts.constructed, 0);
  await reloaded.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(reloaded.view, /Record diagnostic logs\s+Off/);
  assert.equal(first.counts.saves + reloaded.counts.saves, 0); await reloaded.stop();
  const fresh = fixture(); await fresh.start(); await fresh.page();
  assert.match(fresh.view, /Tidy UI appearance\s+On/);
  await fresh.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(fresh.view, /Record diagnostic logs\s+On/);
});

test('settings sync: entry preserves an unconfirmed preview and Esc uses the latest peer confirmation without writes', async () => {
  let changed!: (value: SettingsLoadResult) => void, saves = 0;
  const h = fixture('tui', false, { load: async () => ({ ok: true, themePreference: { kind: 'theme', id: 'saved-A', variant: 'dark' } }),
    async update() { saves++; return { ok: true }; }, watch(callback) { changed = callback; return () => {}; } });
  await h.start();
  await withMenu(h.command, h.ctx, async menu => {
    await menu.select('Code color theme'); await menu.key('\x1b[B'); await menu.key('\x1b[A');
    assert.match(menu.text(), /Selected: Follow Pi/);
    changed({ ok: true, themePreference: { kind: 'theme', id: 'peer-B', variant: 'dark' } }); await settled();
    assert.match(menu.text(), /Selected: Follow Pi/); assert.equal(saves, 0);
    await menu.key('\x1b'); assert.match(menu.text(), /peer-B/);
  });
  assert.equal(saves, 0);
});

test('zero-width owned successful, pending, error, and expanded files never materialize stock renderers', async () => {
  const h = fixture(), stockRender = ToolExecutionComponent.prototype.render; await h.start();
  const pending = writeOwner(h, 'zero-pending', writeSource('pending'));
  assert.deepEqual(pending.render(0), []);
  assertNativeRendererCold(pending, 'call', 'zero-width pending preview');
  pending.setExpanded(true);
  assert.deepEqual(pending.render(0), []);
  assertNativeRendererCold(pending, 'call', 'zero-width expanded pending preview');

  const failed = writeOwner(h, 'zero-error', writeSource('error'));
  failed.updateResult({ content: [{ type: 'text', text: 'failure detail' }], isError: true }, false);
  failed.setExpanded(true);
  assert.deepEqual(failed.render(0), []);
  assertNativeRendererCold(failed, 'call', 'zero-width expanded error call');
  assertNativeRendererCold(failed, 'result', 'zero-width expanded error result');

  const succeeded = writeOwner(h, 'zero-success', writeSource('success'));
  completeLiveWrite(h, succeeded);
  assert.deepEqual(succeeded.render(0), []);
  assertNativeRendererCold(succeeded, 'call', 'zero-width successful preview call');
  assertNativeRendererCold(succeeded, 'result', 'zero-width successful preview result');
  succeeded.setExpanded(true);
  assert.deepEqual(succeeded.render(0), []);
  assertNativeRendererCold(succeeded, 'call', 'zero-width successful full call');
  assertNativeRendererCold(succeeded, 'result', 'zero-width successful full result');

  h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
  const denied = writeOwner(h, 'preview-funding-denied', writeSource('denied'));
  completeLiveWrite(h, denied);
  assert.ok(denied.render(80).length > 0, 'positive-width precondition prepares the original complete owner');
  const geometryFunding = SourceController.prototype.geometryFunding; let deniedCalls = 0;
  SourceController.prototype.geometryFunding = () => { deniedCalls++; return undefined; };
  try {
    assert.deepEqual(clickFile(denied), { handled: true }, 'the file card switches from full to bounded preview');
    const fallback = denied.render(80).join('\n');
    assert.match(fallback, /File preview unavailable within the current geometry budget/u, 'an unprepared bounded layout refuses closed instead of retaining the earlier full display');
    assert.match(fallback, /Click to expand/u);
    assert.doesNotMatch(fallback, /denied_row_13/u, 'geometry refusal never falls through to native full source');
    assertNativeRendererCold(denied, 'call', 'unfunded owned preview remains custom');
    assertNativeRendererCold(denied, 'result', 'unfunded owned preview remains custom');
    assert.ok(deniedCalls > 0);
  } finally { SourceController.prototype.geometryFunding = geometryFunding; }

  const control = writeOwner(h, 'zero-native-control', writeSource('native'));
  const nativeRows = stockRender.call(control, 80);
  assert.ok(nativeRows.some(row => row.includes('native_row_0')), 'positive stock-path control proves this fixture would materialize source at useful width');

  const missingPath = writeOwner(h, 'zero-missing-path-native', writeSource('missing_path'));
  missingPath.updateArgs({ content: writeSource('missing_path'), path: undefined }); completeLiveWrite(h, missingPath);
  missingPath.render(0);
  const nativeCall = Reflect.get(missingPath, 'callRendererComponent') as object;
  const nativeOwner = Reflect.get(nativeCall, 'owner') as object;
  assert.ok(Reflect.get(nativeCall, 'component') || Reflect.get(nativeOwner, 'callInner'),
    'successful missing-path fallback remains genuinely native even at zero width');
});

test('zero-width predecessor spacing never materializes owned pending, error, or unfunded file renderers', async () => {
  const stockRender = ToolExecutionComponent.prototype.render;
  for (const kind of ['pending', 'error', 'unfunded'] as const) {
    const h = fixture(); await h.start();
    try {
      const previous = writeOwner(h, `zero-predecessor-${kind}`, writeSource(`predecessor_${kind}`));
      if (kind === 'error') previous.updateResult({ content: [{ type: 'text', text: 'failure' }], isError: true }, false);
      else if (kind === 'unfunded') {
        completeLiveWrite(h, previous);
        const geometryFunding = SourceController.prototype.geometryFunding;
        SourceController.prototype.geometryFunding = () => undefined;
        try { previous.render(80); } finally { SourceController.prototype.geometryFunding = geometryFunding; }
      }
      previous.setExpanded(true);
      const follower = new ToolExecutionComponent('probe', `zero-predecessor-${kind}-follower`, {}, undefined, undefined,
        h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
      h.root.addChild(follower); follower.setExpanded(true);
      follower.render(0);
      assertNativeRendererCold(previous, 'call', `zero-width sibling spacing after ${kind} file`);
      if (kind !== 'pending') assertNativeRendererCold(previous, 'result', `zero-width sibling spacing after ${kind} file`);
      const nativeControl = stockRender.call(previous, 80);
      if (kind === 'error') assert.ok(nativeControl.some(row => row.includes('failure')));
      else assert.ok(nativeControl.some(row => row.includes(`predecessor_${kind}_row_0`)));
    } finally { await h.stop(); }
  }
});

test('valid full file preparation refusal stays custom and retries without changing expansion', async () => {
  const h = fixture(); await h.start();
  const tool = writeOwner(h, 'full-preparation-refusal', writeSource('preparation_refusal'));
  tool.setExpanded(true);
  const geometryFunding = SourceController.prototype.geometryFunding; let refusals = 0;
  SourceController.prototype.geometryFunding = function () { refusals++; return undefined; };
  try {
    completeLiveWrite(h, tool);
    const rows = tool.render(80).join('\n');
    assertNativeRendererCold(tool, 'call', 'valid full preparation refusal');
    assertNativeRendererCold(tool, 'result', 'valid full preparation refusal');
    assert.match(rows.replace(/\x1b\[[0-9;]*m/gu, '').replace(/\s+/gu, ' '), /Full file view unavailable within the current preparation or geometry budget/u);
    assert.doesNotMatch(rows, /preparation_refusal_row_13/u);
    assert.equal(Reflect.get(tool, 'expanded'), true, 'a funding refusal preserves Pi’s requested full mode');
    assert.ok(refusals > 0, 'the full-card preparation encountered the controlled refusal');
  } finally { SourceController.prototype.geometryFunding = geometryFunding; }
  tool.render(80);
  await settled();
  const recovered = tool.render(80).join('\n');
  assert.match(recovered, /preparation_refusal_row_13/u, 'an eligible cold visit retries the same full card after funding returns');
  assertNativeRendererCold(tool, 'call', 'recovered full card remains custom');
  assertNativeRendererCold(tool, 'result', 'recovered full card remains custom');
});

test('valid retained full file retries refused geometry without re-preparing its source', async () => {
  const h = fixture();
  const originalFunding = SourceController.prototype.geometryFunding;
  const originalUpdate = CardSources.prototype.updateDisplay;
  let fileUpdates = 0, geometryAttempts = 0;
  try {
    await h.start();
    const tool = writeOwner(h, 'full-geometry-refusal', writeSource('geometry_refusal'));
    completeLiveWrite(h, tool); tool.setExpanded(true);
    assert.match(tool.render(80).join('\n'), /geometry_refusal_row_13/u, 'the full-card precondition is accepted and visible');
    assertNativeRendererCold(tool, 'call', 'full geometry precondition');
    assertNativeRendererCold(tool, 'result', 'full geometry precondition');

    CardSources.prototype.updateDisplay = function (...args) {
      if (args[1].kind === 'file') fileUpdates++;
      return Reflect.apply(originalUpdate, this, args);
    };
    SourceController.prototype.geometryFunding = function () { geometryAttempts++; return undefined; };
    let rows = tool.render(100).join('\n');
    assert.match(rows, /Full file view unavailable within the current preparation or geometry budget/u);
    assert.doesNotMatch(rows, /geometry_refusal_row_13/u);
    assert.equal(Reflect.get(tool, 'expanded'), true, 'geometry refusal preserves Pi’s requested full mode');
    assertNativeRendererCold(tool, 'call', 'valid full geometry refusal');
    assertNativeRendererCold(tool, 'result', 'valid full geometry refusal');
    const updatesAfterRefusal = fileUpdates, attemptsAfterRefusal = geometryAttempts;
    for (let frame = 0; frame < 4; frame++) tool.render(100);
    assert.ok(geometryAttempts > attemptsAfterRefusal, 'each repeated same-width frame actually retries geometry funding');
    assert.equal(fileUpdates, updatesAfterRefusal, 'repeated geometry refusal does not rebuild the accepted full source');

    SourceController.prototype.geometryFunding = originalFunding;
    rows = tool.render(100).join('\n');
    assert.match(rows, /geometry_refusal_row_13/u, 'the retained full source recovers when geometry funding returns');
    assert.equal(fileUpdates, updatesAfterRefusal, 'geometry recovery reuses the retained full source');
    assertNativeRendererCold(tool, 'call', 'recovered full layout remains custom');
    assertNativeRendererCold(tool, 'result', 'recovered full layout remains custom');

    SourceController.prototype.geometryFunding = function (...args) {
      geometryAttempts++;
      const funding = Reflect.apply(originalFunding, this, args);
      return funding && { budget: funding.budget, grant: () => undefined };
    };
    rows = tool.render(101).join('\n');
    assert.match(rows, /Full file view unavailable within the current preparation or geometry budget/u);
    assertNativeRendererCold(tool, 'call', 'valid full geometry-grant refusal');
    assertNativeRendererCold(tool, 'result', 'valid full geometry-grant refusal');
    const updatesAfterPaintRefusal = fileUpdates, attemptsAfterPaintRefusal = geometryAttempts;
    for (let frame = 0; frame < 4; frame++) tool.render(101);
    assert.ok(geometryAttempts > attemptsAfterPaintRefusal, 'each repeated same-width frame retries the denied layout geometry grant');
    assert.equal(fileUpdates, updatesAfterPaintRefusal, 'geometry-grant refusal does not discard or re-prepare the accepted full source');

    SourceController.prototype.geometryFunding = originalFunding;
    rows = tool.render(101).join('\n');
    assert.match(rows, /geometry_refusal_row_13/u, 'the same full source recovers after ordinary geometry funding returns');
    assert.equal(fileUpdates, updatesAfterPaintRefusal, 'layout recovery reuses the retained full source');
  } finally {
    SourceController.prototype.geometryFunding = originalFunding;
    CardSources.prototype.updateDisplay = originalUpdate;
    await h.stop();
  }
});

test('entry shutdown keeps prepared card presentation during cleanup and fully unhooks before return', async () => {
  const h = fixture();
  const tool = new ToolExecutionComponent('write', 'shutdown-write', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    writeToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  const native = ToolExecutionComponent.prototype.render;
  await h.start(); h.root.render(80); await settled(); const before = h.root.render(80);
  assert.notEqual(ToolExecutionComponent.prototype.render, native);
  const dispose = SyntaxRuntime.prototype.dispose;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  SyntaxRuntime.prototype.dispose = function () { const stopped = dispose.call(this); return Promise.all([stopped, gate]).then(() => {}); };
  const stopping = h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx) as Promise<void>;
  try {
    await settled();
    assert.notEqual(ToolExecutionComponent.prototype.render, native, 'only our own hooks remain until cleanup finishes');
    assert.deepEqual(h.root.render(80), before, 'unchanged prepared content does not switch to native while cleanup waits');
    const progress = { render: () => ['CLEANUP_PROGRESS'], invalidate() {} }; h.root.addChild(progress);
    assert.ok(h.root.render(80).some(row => row.includes('CLEANUP_PROGRESS')), 'normal host updates remain visible');
    tool.updateResult({ content: [{ type: 'text', text: 'CLEANUP_ERROR' }], isError: true }, false);
    assert.ok(h.root.render(80).some(row => row.includes('CLEANUP_ERROR')), 'changed content is never hidden by old rows');
  } finally { release(); await stopping; SyntaxRuntime.prototype.dispose = dispose; }
  assert.equal(ToolExecutionComponent.prototype.render, native, 'no visual hooks survive shutdown return');
});

test('entry shutdown restores hooks and closes the journal even if source cleanup fails', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'tidy-shutdown-error-')), h = fixture('tui', { root: directory });
  const native = ToolExecutionComponent.prototype.render, dispose = SyntaxRuntime.prototype.dispose;
  const tool = new ToolExecutionComponent('write', 'shutdown-error', { path: 'tiny.ts', content: 'const x=1;' }, undefined,
    writeToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
  tool.setArgsComplete(); tool.updateResult({ content: [{ type: 'text', text: 'written' }], isError: false }, false); h.root.addChild(tool);
  await h.start(); await settled(); const failure = Error('source cleanup failed');
  SyntaxRuntime.prototype.dispose = function () { return dispose.call(this).then(() => { throw failure; }); };
  try {
    await assert.rejects(h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx) as Promise<void>, error => error === failure);
    assert.equal(ToolExecutionComponent.prototype.render, native);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.closed.log')).length, 1);
  } finally { SyntaxRuntime.prototype.dispose = dispose; await h.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('entry preloads preferences before startup and attaches without another asynchronous gap', async () => {
  const h = fixture(); await settled();
  assert.equal(h.counts.load, 1); assert.equal(h.counts.constructed, 0);
  const starting = h.start();
  assert.equal(h.counts.constructed, 1, 'loaded factory preferences do not defer UI attachment until another turn');
  await starting; assert.equal(h.counts.load, 1);
});

test('notification prefix: an unavailable selected theme is attributed once through the real entry', async () => {
  const h = fixture('tui', false, undefined, undefined, undefined,
    { kind: 'theme', id: 'unavailable-notification-family', variant: 'dark' });
  await h.start(); await h.page('Code color theme'); await settled();
  const messages = () => h.notices.filter(message => message.includes('Syntax theme'));
  assert.deepEqual(messages(), ['[pi-tidy-ui] Syntax theme "unavailable-notification-family" is unavailable; using Pi palette temporarily.']);
  await h.page('Code color theme'); await settled();
  assert.equal(messages().length, 1, 'prefixing does not change the missing-theme episode suppression');
});

test('runtime health entry: settings errors are visible with recording unavailable, recover on valid read, and reset for a new session', async () => {
  let changed!: (value: SettingsLoadResult) => void;
  const h = fixture('tui', false, { async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: false }; },
    async update() { return { ok: true }; }, watch(callback) { changed = callback; return () => {}; } });
  await h.start(); await settled();
  const before = h.notices.length;
  const bad: SettingsLoadResult = { ok: false, themePreference: { kind: 'pi', variant: 'dark' }, issue: { code: 'invalid-json', message: 'PRIVATE_CONFIG_DETAIL' } };
  changed(bad); changed(bad); await settled();
  assert.equal(h.notices.length, before + 1); assert.doesNotMatch(h.notices.at(-1)!, /PRIVATE_CONFIG_DETAIL/);
  assert.match(h.notices.at(-1)!, /^\[pi-tidy-ui\] Settings encountered an unexpected error/u);
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  await h.page('Status & troubleshooting', 'Diagnostic logs'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  assert.match(h.view, /Diagnostic logging is unavailable/);
  changed({ ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: false }); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 0/); assert.match(h.view, /recovered/);
  await h.stop();
  const after = h.notices.length; changed(bad); await settled(); assert.equal(h.notices.length, after, 'old watcher cannot report after shutdown');
  await h.start({ type: 'session_start', reason: 'resume' }); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 0; active: 0/);
});

test('runtime health entry: explicit appearance Off and reinstallation retire the old failed owner without GC', async () => {
  const h = fixture('tui', false, { async load() { return { ok: true, themePreference: { kind: 'pi', variant: 'dark' }, terminalColorsEnabled: false }; }, async update() { return { ok: true }; } });
  const foreign = Object.assign(new Container(), { toolCallId: 'incompatible', toolName: 'bash' });
  h.root.addChild(foreign); await h.start(); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 1/);
  await h.appearance(false); await h.page('Status & troubleshooting');
  assert.match(h.view, /Runtime errors: 1; active: 0/); assert.match(h.view, /owner removed/);
  h.root.removeChild(foreign); await h.appearance(true); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 1; active: 0/);
  h.root.addChild(foreign); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 2; active: 1/);
  h.root.removeChild(foreign); await h.page('Status & troubleshooting', 'Reapply Tidy UI appearance'); await settled();
  await h.page('Status & troubleshooting'); assert.match(h.view, /Runtime errors: 2; active: 0/); assert.match(h.view, /owner removed/);
});


test('only the latest ten live successful file cards remain automatically full after each turn', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const restored = writeOwner(h, 'restored-history', writeSource('restored_history'));
    restored.updateResult({ content: [], isError: false }, false);
    assert.ok(!restored.render(80).join('\n').includes('restored_history_row_13'), 'restored history starts with the bounded preview');

    const retained: ToolExecutionComponent[] = [], successful: ToolExecutionComponent[] = [];
    let next = 0;
    const batch = (count: number) => {
      h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
      const current = Array.from({ length: count }, () => writeOwner(h, `live_${next}`, writeSource(`live_${next++}`)));
      for (const tool of [...current].reverse()) completeLiveWrite(h, tool);
      const previousWindow = new Set(successful.slice(-10));
      for (const tool of [...current, ...previousWindow]) {
        const full = tool.render(80).join('\n').includes(`live_${liveToolCallId(tool).slice('live_'.length)}_row_13`);
        assert.equal(full, previousWindow.has(tool) || current.includes(tool), 'prior window and current-turn successes stay full until turn_end');
      }
      h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
      retained.push(...current); successful.push(...current);
      const newest = new Set(successful.slice(-10));
      for (const tool of retained) {
        const marker = `live_${liveToolCallId(tool).slice('live_'.length)}_row_13`, full = tool.render(80).join('\n').includes(marker);
        assert.equal(full, newest.has(tool), `automatic full choice follows first-seen live component order across turns, not completion order: owner=${liveToolCallId(tool)}, expected=${newest.has(tool)}, retained=${retained.map(liveToolCallId).join(',')}, root=${(h.root.children as Component[]).filter((value): value is ToolExecutionComponent => value instanceof ToolExecutionComponent).map(liveToolCallId).join(',')}`);
      }
      assert.equal(retained.filter(tool => tool.render(80).join('\n').includes(`live_${liveToolCallId(tool).slice('live_'.length)}_row_13`)).length,
        Math.min(10, successful.length), `after ${count} current calls the rolling live window contains ${Math.min(10, successful.length)} successes`);
    };
    await batch(9); await batch(2); await batch(11);
  } finally { await h.stop(); }
});

test('a real wide mixed preview keeps unified rows, a visual cap and the common overflow hint', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const long = (tag: string) => `const ${tag} = "${tag.repeat(35)}";`;
    const patch = ['@@ -1,14 +1,14 @@', ' context_before', `-${long('removed')}`, `+${long('added')}`,
      ...Array.from({ length: 12 }, (_, index) => ` context_${index}`)].join('\n');
    const tool = new ToolExecutionComponent('edit', 'wide-mixed-preview', { path: 'wide-mixed.ts', oldText: '', newText: '' }, undefined,
      editToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(tool); tool.setArgsComplete();
    tool.updateResult({ content: [], isError: false, details: { patch } }, false);
    const rows = h.root.render(160), output = rows.join('\n');
    assert.ok(output.includes('removed') && output.includes('added'), 'the bounded raw prefix contains both change sides');
    assert.ok(!rows.some(row => row.includes('removed') && row.includes('added')), 'a real prepared preview does not split old/new columns');
    assert.ok(output.includes('Click to expand'), `the common overflow marker stays visible beside the preview note:\n${output}`);
    assertNativeRendererCold(tool, 'call', 'wide preview does not construct the stock edit/preflight renderer');
    assertNativeRendererCold(tool, 'result', 'wide preview does not construct the stock result renderer');
  } finally { await h.stop(); }
});

test('expanded failed file tools use a Bash-style error frame without proposed source', async () => {
  const h = fixture();
  try {
    await h.start();
    const owners = [readOwner(h, 'framed-read-error'), writeOwner(h, 'framed-write-error', 'PROPOSED_WRITE_SOURCE'),
      editOwner(h, 'framed-edit-error')];
    for (const owner of owners) {
      owner.setArgsComplete(); owner.markExecutionStarted();
      owner.updateResult({ content: [{ type: 'text', text: 'EACCES: permission denied\r  detail 界é' },
        { type: 'text', text: 'ERROR_TAIL' }], isError: true }, false);
      assert.doesNotMatch(plainRows(owner.render(80)), /┃|EACCES|ERROR_TAIL/u, 'a failed call starts compact');
      const args = Reflect.get(owner, 'args') as Record<string, unknown>;
      let proposalReads = 0;
      for (const key of ['content', 'edits', 'oldText', 'newText']) {
        const value = args[key];
        Object.defineProperty(args, key, { configurable: true, get() { proposalReads++; return value; } });
      }
      owner.setExpanded(true);
      const rows = owner.render(80), text = plainRows(rows);
      assert.match(text, /┃/u, 'explicit expansion uses the shared card frame');
      assert.ok(rows.every(row => !row || plainRows([row]).startsWith(' ┃')), 'the expanded frame replaces the compact summary, without an outside duplicate title');
      assert.match(text, /EACCES: permission denied/u);
      assert.ok(rows.some(row => plainRows([row]).includes('┃   detail 界é')), 'standalone CR becomes a newline and preserves error indentation');
      assert.match(text, /ERROR_TAIL/u, 'every saved text part is visible');
      assert.match(text, /\[error: tool call failed\]/u);
      assert.doesNotMatch(text, /PROPOSED_WRITE_SOURCE|Original file content|Requested replacement|Tool error:|Requested file content/u);
      assert.equal(await hasHostInk(rows, themes.theme, 'error', '┃'), true, 'the stripe uses the error foreground');
      assert.equal(await hasHostInk(rows, themes.theme, 'error', '[error:'), true, 'the separate status uses the error foreground');
      assert.equal(await hasHostInk(rows, themes.theme, 'toolOutput', 'EACCES'), true, 'error output remains readable, not entirely red');
      assert.equal(await hasHostInk(rows, themes.theme, 'muted', owner === owners[0] ? 'Read' : owner === owners[1] ? 'Write' : 'Edit'), true);
      for (const width of [1, 2, 5, 24, 80]) {
        const narrow = owner.render(width);
        assert.ok(narrow.every(row => visibleWidth(row) <= width), `error frame fits width ${width}`);
      }
      assertNativeRendererCold(owner, 'call', 'owned error cards never materialize stock call callbacks');
      assertNativeRendererCold(owner, 'result', 'owned error cards never materialize stock result callbacks');
      owner.setExpanded(false);
      assert.doesNotMatch(plainRows(owner.render(80)), /┃|EACCES|ERROR_TAIL/u, 'collapse returns to the compact failure');
      owner.setExpanded(true);
      assert.match(plainRows(owner.render(80)), /ERROR_TAIL/u, 're-expansion restores the complete error');
      assert.equal(proposalReads, 0, 'error preparation and drawing do not read proposed source fields');
    }
  } finally { await h.stop(); }
});

test('expanded error headings retain the compact path budget instead of preparing unbounded arguments', async () => {
  const h = fixture();
  try {
    await h.start();
    const path = `${'long-path/'.repeat(1500)}UNBOUNDED_PATH_TAIL`;
    const owner = writeOwner(h, 'bounded-error-heading', '');
    owner.updateArgs({ path, content: 'UNAPPLIED' });
    owner.updateResult({ content: [{ type: 'text', text: 'SAVED_ERROR' }], isError: true }, false);
    owner.setExpanded(true);
    const text = plainRows(owner.render(80));
    assert.match(text, /SAVED_ERROR/u);
    assert.match(text, /…/u, 'the bounded path remains visibly abbreviated');
    assert.doesNotMatch(text, /UNBOUNDED_PATH_TAIL/u, 'failed title formatting retains the existing compact argument budget');
    assert.equal((Reflect.get(owner, 'args') as { path: string }).path, path, 'the original path remains in tool data');
  } finally { await h.stop(); }
});

test('empty and pathless file failures retain one no-details message inside an error frame', async () => {
  const h = fixture();
  try {
    await h.start();
    const owners = [readOwner(h, 'empty-read-error', {}), writeOwner(h, 'empty-write-error', ''), editOwner(h, 'empty-edit-error')];
    for (const owner of owners) {
      owner.updateArgs({});
      owner.updateResult({ content: [], isError: true }, false);
      owner.setExpanded(true);
      const text = plainRows(owner.render(80));
      assert.match(text, /┃/u);
      assert.equal(text.split('The tool reported an error without text details.').length - 1, 1, 'the empty-error note is not duplicated');
      assert.match(text, /\[error: tool call failed\]/u, 'status does not infer an execution cause from absent live flags');
      assert.ok(!h.notices.length, 'a missing path cannot disable the adapter');
    }
  } finally { await h.stop(); }
});

test('pending edit details are bounded while final failures show complete errors without reading proposals', async () => {
  const h = fixture();
  try {
    await h.start();
    const pending = editOwner(h, 'pending-edit-array');
    pending.updateArgs({ path: 'pending-edit-array.ts', edits: [
      { oldText: 'BEFORE_EDIT_1', newText: 'AFTER_EDIT_1' },
      { oldText: 'BEFORE_EDIT_2', newText: 'AFTER_EDIT_2' },
    ] });
    pending.markExecutionStarted(); pending.setExpanded(true);
    const pendingRows = pending.render(100).join('\n');
    for (const text of ['Original file content (edit 1):', 'BEFORE_EDIT_1', 'Requested replacement (edit 1):', 'AFTER_EDIT_1',
      'Original file content (edit 2):', 'BEFORE_EDIT_2', 'Requested replacement (edit 2):', 'AFTER_EDIT_2']) assert.ok(pendingRows.includes(text), text);

    const partial = editOwner(h, 'pending-partial-edit-array');
    partial.updateArgs({ path: 'partial-edit.ts', edits: [{ oldText: 'KNOWN_PARTIAL_OLD' }] });
    partial.markExecutionStarted(); partial.setExpanded(true);
    const partialRows = partial.render(80).join('\n');
    assert.ok(partialRows.includes('KNOWN_PARTIAL_OLD'), 'an available field from a streaming edit entry is shown');
    assert.doesNotMatch(partialRows, /additional file content is omitted/, 'an unarrived field is not presented as truncated source');

    const many: unknown[] = [{ oldText: Array.from({ length: 12 }, (_, i) => `bounded_before_row_${i}`).join('\n'), newText: 'NOT_NEEDED_AFTER_ROW_LIMIT' },
      ...Array.from({ length: 20 }, () => ({ oldText: 'NOT_READ_LATER_EDIT', newText: 'NOT_READ_LATER_EDIT' }))];
    const indexed: number[] = [];
    const edits = new Proxy(many, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) indexed.push(Number(key));
      return Reflect.get(target, key, receiver);
    } });
    const oversized = editOwner(h, 'pending-oversized-edit-array');
    oversized.updateArgs({ path: 'oversized-edit.ts', edits }); oversized.markExecutionStarted(); oversized.setExpanded(true);
    const boundedRows = oversized.render(100).join('\n');
    assert.ok(boundedRows.includes('bounded_before_row_0') && !boundedRows.includes('NOT_NEEDED_AFTER_ROW_LIMIT'));
    assert.match(boundedRows, /additional file content is omitted/, 'actual row/entry truncation is still reported');
    assert.deepEqual(indexed, [0], 'the pending builder stops at the shared row bound without reading later edits');

    const mixed = editOwner(h, 'pending-edit-array-wins');
    mixed.updateArgs({ path: 'array-wins.ts', oldText: 'LEGACY_OLD', newText: 'LEGACY_NEW',
      edits: [{ oldText: 'ARRAY_OLD', newText: 'ARRAY_NEW' }] });
    mixed.markExecutionStarted(); mixed.setExpanded(true);
    const mixedRows = mixed.render(80).join('\n');
    assert.ok(mixedRows.includes('ARRAY_OLD') && mixedRows.includes('ARRAY_NEW'));
    assert.ok(!mixedRows.includes('LEGACY_OLD') && !mixedRows.includes('LEGACY_NEW'), 'an edits array takes precedence over legacy top-level fields');

    const failed = editOwner(h, 'failed-edit-array');
    failed.updateArgs({ path: 'failed-edit-array.ts', edits: [
      { oldText: 'FAILED_BEFORE_1', newText: 'FAILED_AFTER_1' },
      { oldText: 'FAILED_BEFORE_2', newText: 'FAILED_AFTER_2' },
    ] });
    failed.updateResult({ content: [{ type: 'text', text: 'EDIT_FAILED' }], isError: true }, false); failed.setExpanded(true);
    const failedRows = failed.render(100).join('\n');
    assert.match(failedRows, /EDIT_FAILED/u);
    assert.doesNotMatch(failedRows, /FAILED_BEFORE_|FAILED_AFTER_/u, 'failed edits show the error, not unapplied proposals');

    const finalEntries: unknown[] = Array.from({ length: 12 }, (_, index) => ({
      oldText: `FINAL_ERROR_OLD_${index}`, newText: `FINAL_ERROR_NEW_${index}`,
    }));
    const finalReads: number[] = [];
    const finalEdits = new Proxy(finalEntries, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) finalReads.push(Number(key));
      return Reflect.get(target, key, receiver);
    } });
    const finalErrorRows = Array.from({ length: 12 }, (_, index) => `FINAL_ERROR_ROW_${index}_${'x'.repeat(700)}`).join('\n');
    const finalErrorTail = 'FINAL_ERROR_TAIL';
    const fullFailure = editOwner(h, 'full-final-edit-array');
    fullFailure.updateArgs({ path: 'full-final-edit-array.ts', edits: finalEdits });
    fullFailure.updateResult({ content: [{ type: 'text', text: `${finalErrorRows}\n${finalErrorTail}` }], isError: true }, false);
    fullFailure.setExpanded(true);
    const fullFailureRows = fullFailure.render(100).join('\n');
    for (let index = 0; index < finalEntries.length; index++) {
      assert.ok(!fullFailureRows.includes(`FINAL_ERROR_OLD_${index}`) && !fullFailureRows.includes(`FINAL_ERROR_NEW_${index}`), 'failed edits do not display unapplied source');
      assert.ok(fullFailureRows.includes(`FINAL_ERROR_ROW_${index}_`), `all saved error rows remain available: ${index}`);
    }
    assert.ok(finalErrorRows.length > 8192 && finalErrorRows.split('\n').length > 10);
    assert.ok(fullFailureRows.includes(finalErrorTail), 'the error suffix beyond both pending-preview limits remains visible when funded');
    assert.deepEqual(finalReads, [], 'error preparation does not traverse the proposed edits');

    const requestTail = 'WRITE_REQUEST_TAIL', writeErrorTail = 'WRITE_ERROR_TAIL';
    const writeFailure = writeOwner(h, 'full-final-write-error', `${'r'.repeat(8300)}${requestTail}`);
    writeFailure.updateResult({ content: [{ type: 'text', text: `${'e'.repeat(8300)}${writeErrorTail}` }], isError: true }, false);
    writeFailure.setExpanded(true);
    const writeFailureRows = writeFailure.render(100).join('\n');
    assert.ok(!writeFailureRows.includes(requestTail), 'failed writes do not display submitted content');
    assert.ok(writeFailureRows.includes(writeErrorTail), 'funded final write errors retain all saved error text');
  } finally { await h.stop(); }
});

test('Ctrl+O and selection-safe clicks use owned file views; pending and failed details never invoke stock renderers', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const old = writeOwner(h, 'manual_old', writeSource('manual_old'));
    old.updateResult({ content: [], isError: false }, false);
    assert.ok(!old.render(80).join('\n').includes('manual_old_row_13'));
    old.setExpanded(true);
    assert.ok(old.render(80).join('\n').includes('manual_old_row_13'), 'global Ctrl+O selects our full view');
    h.root.selection = true;
    assert.equal(clickFile(old), undefined, 'mouse selection remains native and unchanged');
    assert.ok(old.render(80).join('\n').includes('manual_old_row_13'));
    h.root.selection = false;
    assert.equal(clickFile(old)?.handled, true);
    assert.ok(!old.render(80).join('\n').includes('manual_old_row_13'), 'a direct click overrides global expansion for this owner');
    old.setExpanded(false);
    assert.ok(!old.render(80).join('\n').includes('manual_old_row_13'), 'clearing Ctrl+O restores the stored per-card choice');
    assert.equal(clickFile(old)?.handled, true);
    assert.ok(old.render(80).join('\n').includes('manual_old_row_13'));

    const pendingSource = writeSource('pending_live');
    const pending = writeOwner(h, 'pending-live', pendingSource);
    pending.markExecutionStarted(); pending.setExpanded(true);
    const pendingSuccessor = writeOwner(h, 'pending-successor', writeSource('pending_successor'));
    completeLiveWrite(h, pendingSuccessor);
    h.root.render(80);
    assertNativeRendererCold(pending, 'call', 'spacing for a following tool keeps expanded pending details on the owned path');
    const pendingRows = pending.render(80).join('\n');
    assert.ok(pendingRows.includes('pending_live_row_0') && !pendingRows.includes('pending_live_row_13'), 'expanded streaming input stays bounded');
    pending.updateArgs({ path: 'pending-live.ts', content: `${pendingSource}const pending_hidden_suffix = 1;\n` });
    assert.ok(!pending.render(80).join('\n').includes('pending_hidden_suffix'), 'growing hidden input is not disclosed by expansion');
    assertNativeRendererCold(pending, 'call', 'custom pending details do not build a stock call component');
    assert.equal(Reflect.get(pending, 'resultRendererComponent'), undefined, 'Pi has not created a stock result callback while the tool is still pending');
    pending.setExpanded(false);

    const errorBody = 'const failed_detail_row_0 = true;\nconst failed_detail_row_1 = true;';
    const failed = writeOwner(h, 'failed-summary', '');
    const errorContent = [{ type: 'text' as const, text: errorBody }];
    const errorResult = { content: errorContent, isError: true };
    let rejectContentRead = false;
    Object.defineProperty(errorResult, 'content', { configurable: true, get() {
      if (rejectContentRead) throw new Error('error details were reread during render');
      return errorContent;
    } });
    failed.updateResult(errorResult, false);
    const failedSuccessor = writeOwner(h, 'failed-successor', writeSource('failed_successor'));
    completeLiveWrite(h, failedSuccessor);
    h.root.render(80);
    assertNativeRendererCold(failed, 'call', 'spacing for a following tool keeps failed details on the owned path');
    rejectContentRead = true;
    let collapsed: string[] = [];
    assert.doesNotThrow(() => { collapsed = failed.render(80); }, 'collapsed error preview does not traverse result text');
    assert.ok(!collapsed.join('\n').includes('failed_detail_row_0'), 'failed result begins as a compact summary');
    rejectContentRead = false;
    assert.equal(clickFile(failed, 1)?.handled, true, `clicking the failed summary opens owned error details: ${JSON.stringify(failed.render(80))}`);
    rejectContentRead = true;
    let expanded: string[] = [];
    assert.doesNotThrow(() => { expanded = failed.render(80); }, 'expanded rows render the detail measured at the cold click boundary');
    rejectContentRead = false;
    assert.ok(expanded.join('\n').includes('failed_detail_row_1'), 'expanded final error keeps its complete saved rows within the shared bound');
    assertNativeRendererCold(failed, 'call', 'custom failed details do not build a stock call component');
    assertNativeRendererCold(failed, 'result', 'custom failed details do not build a stock result component');
  } finally { await h.stop(); }
});


test('following-tool spacing never invokes native rows for owned pending, failed or refused-preview files', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const pending = writeOwner(h, 'neighbor-pending', writeSource('neighbor_pending'));
    pending.setExpanded(true);
    const afterPending = writeOwner(h, 'after-pending', writeSource('after_pending'));
    assert.doesNotThrow(() => afterPending.render(80));
    assertNativeRendererCold(pending, 'call', 'following-tool spacing treats expanded pending as an owned summary');

    const pathless = writeOwner(h, 'neighbor-pathless-pending', writeSource('pathless_pending'));
    pathless.updateArgs({ content: writeSource('pathless_pending'), path: undefined }); pathless.setExpanded(true);
    const afterPathless = writeOwner(h, 'after-pathless-pending', writeSource('after_pathless_pending'));
    assert.doesNotThrow(() => afterPathless.render(80));
    assertNativeRendererCold(pathless, 'call', 'an expanded pending file without a path remains on the owned renderer even for sibling spacing');

    const failed = writeOwner(h, 'neighbor-failed', writeSource('neighbor_failed'));
    failed.updateResult({ content: [{ type: 'text', text: 'bounded failure detail' }], isError: true }, false);
    failed.setExpanded(true);
    const afterFailed = writeOwner(h, 'after-failed', writeSource('after_failed'));
    assert.doesNotThrow(() => afterFailed.render(80));
    assertNativeRendererCold(failed, 'call', 'following-tool spacing treats expanded error as an owned summary');
    assertNativeRendererCold(failed, 'result', 'following-tool spacing does not construct the native error component');

    const refused = writeOwner(h, 'neighbor-refused-preview', writeSource('neighbor_refused'));
    refused.updateResult({ content: [], isError: false }, false);
    assert.ok(refused.render(80).length > 0, 'the owned preview is prepared at useful width');
    const afterRefused = writeOwner(h, 'after-refused', writeSource('after_refused'));
    const originalFunding = SourceController.prototype.geometryFunding; let refusals = 0;
    SourceController.prototype.geometryFunding = () => { refusals++; return undefined; };
    try {
      const refusedRows = refused.render(81);
      assert.ok(refusedRows.length > 0, 'a funded-preparation refusal still shows the bounded owned preview');
      assert.ok(refusals > 0, 'the current file layout actually encounters the funding refusal');
      assert.doesNotThrow(() => afterRefused.render(81), 'sibling spacing remains safe after a file layout refuses funding');
      assertNativeRendererCold(refused, 'call', 'following-tool spacing keeps refused preview data on the owned path');
      assertNativeRendererCold(refused, 'result', 'following-tool spacing does not build the refused preview result renderer');
    } finally { SourceController.prototype.geometryFunding = originalFunding; }
  } finally { await h.stop(); }
});

test('unsupported saved-file preview uses the owned fallback for sibling spacing', async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const unsupported = editOwner(h, 'neighbor-unsupported-preview');
    unsupported.updateResult({ content: [], isError: false, details: { patch: { invalid: true } } }, false);
    const ownRows = unsupported.render(80);
    assert.match(ownRows.join('\\n'), /No saved file change details are available/);
    assert.ok(ownRows.length > 1, 'the unavailable preview has more than the ordinary one-row summary');
    assertNativeRendererCold(unsupported, 'call', 'an unsupported preview remains custom-presented');
    assertNativeRendererCold(unsupported, 'result', 'presenting unsupported preview metadata does not materialize stock details');

    const after = writeOwner(h, 'after-unsupported-preview', writeSource('after_unsupported_preview'));
    const following = after.render(80);
    assert.equal(following[0], '', 'following-tool spacing uses the rendered unavailable fallback height');
    assertNativeRendererCold(unsupported, 'call', 'measuring an unsupported preview does not materialize stock edit output');
    assertNativeRendererCold(unsupported, 'result', 'sibling spacing does not materialize stock edit output');
  } finally { await h.stop(); }
});

test('valid full file cards stay owned across preparation and geometry refusal, then retry cold', async () => {
  const h = fixture(); const originalFunding = SourceController.prototype.geometryFunding;
  try {
    await h.start();
    const tool = writeOwner(h, 'funded-full-retry', writeSource('funded_full_retry'));
    completeLiveWrite(h, tool);

    SourceController.prototype.geometryFunding = () => undefined;
    tool.setExpanded(true);
    let rows = tool.render(80).join('\n');
    assert.match(rows, /Full file view unavailable/);
    assert.doesNotMatch(rows, /funded_full_retry_row_13/);
    assertNativeRendererCold(tool, 'call', 'valid full preparation refusal remains on the owned path');
    assertNativeRendererCold(tool, 'result', 'valid full preparation refusal never constructs stock result output');

    SourceController.prototype.geometryFunding = originalFunding;
    tool.render(80); await settled();
    rows = tool.render(80).join('\n');
    assert.match(rows, /funded_full_retry_row_13/, 'ordinary later render retries the same requested full mode');
    assertNativeRendererCold(tool, 'call', 'successful cold retry remains custom');

    SourceController.prototype.geometryFunding = function(...args) {
      const funding = originalFunding.apply(this, args);
      return funding && { budget: funding.budget, grant: () => undefined };
    };
    rows = tool.render(81).join('\n');
    assert.match(rows, /Full file view unavailable/);
    assert.doesNotMatch(rows, /funded_full_retry_row_13/);
    assertNativeRendererCold(tool, 'call', 'valid full layout refusal does not fall through to the stock renderer');
    assertNativeRendererCold(tool, 'result', 'valid full layout refusal does not construct native result rows');

    SourceController.prototype.geometryFunding = originalFunding;
    rows = tool.render(81).join('\n');
    assert.match(rows, /funded_full_retry_row_13/, 'later geometry admission restores the full owned view');
  } finally { SourceController.prototype.geometryFunding = originalFunding; await h.stop(); }
});

test('accepted unsupported full metadata retains native fallback when paint publication is unavailable', async () => {
  const h = fixture(); await h.start();
  const tool = writeOwner(h, 'unsupported-without-paint', writeSource('unsupported_without_paint'));
  tool.markExecutionStarted();
  const result = { content: [], isError: false, details: { patch: 'malformed full patch metadata' } };
  h.events.get('tool_execution_end')!({ type: 'tool_execution_end', toolCallId: liveToolCallId(tool), toolName: 'write', result, isError: false }, h.ctx);
  tool.updateResult(result, false); tool.setExpanded(true);
  const visit = CardSources.prototype.visit;
  CardSources.prototype.visit = function () { return false; };
  try {
    const rows = tool.render(80).join('\n');
    assert.match(rows, /unsupported_without_paint_row_0/u, 'accepted unsupported metadata delegates to the unchanged native full renderer without requiring palette paint');
    assert.doesNotMatch(rows, /Full file view unavailable/u, 'known unsupported data is not mistaken for a funding refusal');
  } finally { CardSources.prototype.visit = visit; await h.stop(); }
});

test('unsupported full file metadata reuses exact current native leaves across preview and fallback', { skip: !global.gc }, async () => {
  const h = fixture();
  try {
    await h.ready; await h.start();
    const tool = writeOwner(h, 'unsupported-full-native', writeSource('unsupported_full'));
    tool.updateResult({ content: [], isError: false, details: { patch: 'unsupported saved patch metadata' } }, false);
    const callWrapper = Reflect.get(tool, 'callRendererComponent') as Component;
    const resultWrapper = Reflect.get(tool, 'resultRendererComponent') as Component;
    const firstNativeCall = callWrapper.render(80);
    const firstNativeResult = resultWrapper.render(80);
    assert.ok(firstNativeCall.join('\n').includes('unsupported-full-native.ts'), 'direct native baseline uses the live file args');
    const oldCallInner = weakDeferredInner(callWrapper), oldResultInner = weakDeferredInner(resultWrapper);
    const nativeUpdateDisplay = Reflect.get(tool, 'updateDisplay') as (...args: unknown[]) => unknown;
    let displayUpdates = 0;
    Reflect.set(tool, 'updateDisplay', function (this: ToolExecutionComponent, ...args: unknown[]) {
      displayUpdates++; return nativeUpdateDisplay.apply(this, args);
    });

    const preview = tool.render(80).join('\n');
    assert.match(preview, /No saved file change details are available; expand for full validation/, 'unsupported bounded preview explains that the saved change is unavailable');
    assert.equal(Reflect.get(tool, 'callRendererComponent'), callWrapper, 'custom preview keeps the current native call leaf');
    assert.equal(Reflect.get(tool, 'resultRendererComponent'), resultWrapper, 'custom preview keeps the current native result leaf');
    for (let attempt = 0; attempt < 40 && (oldCallInner.deref() || oldResultInner.deref()); attempt++) { await turn(); global.gc!(); await turn(); }
    assert.equal(oldCallInner.deref(), undefined, 'custom ownership retires the exact previous native call materialization');
    assert.equal(oldResultInner.deref(), undefined, 'custom ownership retires the exact previous native result materialization');

    assert.equal(clickFile(tool, 1)?.handled, true, 'the owned refusal summary can enter the explicit full view');
    const full = tool.render(80).join('\n');
    assert.match(full, /unsupported-full-native\.ts/, 'unsupported full metadata delegates back to the stock heading rather than inventing unavailable content');
    assert.equal(displayUpdates, 0, 'returning to the permitted native fallback does not regenerate current callbacks');
    assert.equal(Reflect.get(tool, 'callRendererComponent'), callWrapper, 'the exact current native call leaf is reused for fallback');
    assert.equal(Reflect.get(tool, 'resultRendererComponent'), resultWrapper, 'the exact current native result leaf is reused for fallback');
    assert.ok(weakDeferredInner(callWrapper).deref(), 'stock call state rematerializes from the current lazy callback');
    assert.deepEqual(resultWrapper.render(80), firstNativeResult, 'native result fallback matches the direct stock baseline');
  } finally { await h.stop(); }
});

test('expanded final error details refuse unbudgeted untrusted text without retaining a copied body', async () => {
  const h = fixture();
  const originalFunding = SourceController.prototype.geometryFunding;
  let refusals = 0, budget: import('../../../src/occipital/data-budget.ts').DataBudget | undefined, retainedBefore: number | undefined;
  try {
    await h.start();
    const error = writeOwner(h, 'large-error-details', 'small request');
    error.markExecutionStarted();
    const marker = 'UNFUNDED_ERROR_TAIL';
    const body = `${'x'.repeat(2 * 1024 * 1024)}${marker}`;
    error.updateResult({ content: [{ type: 'text', text: body }], isError: true }, false);
    SourceController.prototype.geometryFunding = function(...args) {
      const funding = originalFunding.apply(this, args);
      if (!funding) return funding;
      budget = funding.budget; retainedBefore ??= budget.stats().retainedBytes;
      return { budget, grant: () => { refusals++; return undefined; } };
    };
    assert.equal(clickFile(error, 0)?.handled, true);
    const rows = error.render(80).join('\n');
    assert.ok(refusals > 0, 'expanded full details actually encounter a denied reservation');
    assert.match(rows, /File details are unavailable within the current geometry budget/);
    assert.match(rows, /┃/u, 'budget refusal retains the same owned error panel');
    assert.match(rows, /\[error: tool call failed\]/u, 'budget refusal does not remove the known error status');
    assert.doesNotMatch(rows, new RegExp(marker), 'an unfunded full error body never reaches the card');
    assert.equal(budget?.stats().retainedBytes, retainedBefore, 'a refused detail keeps neither copied text nor measurement charges');
    SourceController.prototype.geometryFunding = originalFunding;
    error.updateResult({ content: [{ type: 'text', text: 'recovered error detail' }], isError: true }, false);
    assert.match(error.render(80).join('\n'), /recovered error detail/, 'a later funded error update prepares the new current detail');
  } finally { SourceController.prototype.geometryFunding = originalFunding; await h.stop(); }
});


test('expanded error details use actual measurement funding without the pending-preview limits', async () => {
  const h = fixture();
  const originalFunding = SourceController.prototype.geometryFunding;
  const largestSingleGrant = 1024 * 1024;
  const grants: number[] = [];
  let budget: import('../../../src/occipital/data-budget.ts').DataBudget | undefined;
  SourceController.prototype.geometryFunding = function (...args) {
    const funding = originalFunding.apply(this, args);
    if (!funding) return funding;
    budget = funding.budget;
    return { budget: funding.budget, grant(bytes: number) {
      grants.push(bytes);
      return bytes > largestSingleGrant ? undefined : funding.grant(bytes);
    } };
  };
  try {
    await h.start();
    const error = writeOwner(h, 'repetitive-error-details', 'request');
    const longErrorText = Array.from({ length: 7 }, (_, index) => `${'x'.repeat(650)}${index === 6 ? 'LOW_GLYPH_DETAIL_TAIL' : `detail_${index}`}`).join('\n');
    error.updateResult({ content: [{ type: 'text', text: longErrorText }], isError: true }, false);
    assert.equal(clickFile(error, 0)?.handled, true);
    const rows = error.render(80).join('\n');
    assert.match(rows, /LOW_GLYPH_DETAIL_TAIL/, 'complete saved error rows remain available under ordinary geometry grants');
    assert.ok(grants.length > 1, 'construction scratch, retained text and measured glyph storage use ordinary independent grants');
    assert.ok(grants.every(bytes => bytes <= largestSingleGrant), `no single reservation exceeds the existing 1 MiB operation budget: ${JSON.stringify(grants)}`);
    const admittedTextUnits = longErrorText.length;
    assert.ok((budget?.stats().retainedBytes ?? 0) > admittedTextUnits * 2, 'the retained complete error text has a separate charged measurement while the owner is alive');
    assert.equal(budget?.stats().outstandingPeakBytes, 0, 'completed detail preparation leaves no outstanding synthetic grant');
    const lineError = writeOwner(h, 'newline-error-details', 'request');
    const newlineTail = 'LINE_BREAK_DETAIL_TAIL';
    lineError.updateResult({ content: [{ type: 'text', text: `${'\n'.repeat(1500)}${newlineTail}` }], isError: true }, false);
    assert.equal(clickFile(lineError, 1)?.handled, true, 'newline-dense error details enter the owned full view');
    const lineRows = lineError.render(80).join('\n');
    assert.ok(lineRows.includes(newlineTail), 'funded final error text is not cut at the pending-preview physical-row ceiling');
    assert.doesNotMatch(lineRows, /additional file content is omitted/u);
    assert.doesNotMatch(lineRows, /File details are unavailable within the current geometry budget/u, 'the full detail was funded rather than refused');
  } finally { SourceController.prototype.geometryFunding = originalFunding; await h.stop(); }
});

test('entry batches full live file previews and keeps only the latest ten in host component order', async () => {
  const h = fixture();
  try {
    await h.start();
    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const source = (tag: string) => Array.from({ length: 14 }, (_, index) => `const ${tag}_row_${index} = ${index};`).join('\n');
    const tools = Array.from({ length: 11 }, (_, index) => writeOwner(h, `window-${index}`, source(`window_${index}`)));
    for (const tool of tools) h.root.render(100);
    for (const tool of [...tools].reverse()) completeLiveWrite(h, tool);
    for (const [index, tool] of tools.entries()) assert.match(tool.render(100).join('\n'), new RegExp(`window_${index}_row_13`), 'successful owners stay full during the live turn');

    const beforeEnd = h.root.requests;
    h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
    assert.equal(h.root.requests, beforeEnd + 1, 'the one end-of-turn window change requests one repaint');
    assert.doesNotMatch(tools[0]!.render(100).join('\n'), /window_0_row_13/, 'the oldest completed owner returns to its bounded preview');
    assert.match(tools[0]!.render(100).join('\n'), /window_0_row_9/);
    for (let index = 1; index < tools.length; index++) assert.match(tools[index]!.render(100).join('\n'), new RegExp(`window_${index}_row_13`));

    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const nextTurn = writeOwner(h, 'window-next-turn', source('window_next_turn'));
    h.root.render(100); completeLiveWrite(h, nextTurn);
    const beforeNextEnd = h.root.requests;
    h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
    assert.equal(h.root.requests, beforeNextEnd + 1, 'the next turn boundary publishes one rolling-window change');
    for (const index of [0, 1]) assert.doesNotMatch(tools[index]!.render(100).join('\n'), new RegExp(`window_${index}_row_13`));
    for (const index of [2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.match(tools[index]!.render(100).join('\n'), new RegExp(`window_${index}_row_13`));
    assert.match(nextTurn.render(100).join('\n'), /window_next_turn_row_13/);
  } finally { await h.stop(); }
});

test('attached successful hidden and native file calls consume the automatic presentation window', async () => {
  const h = fixture(); h.setFlag('tidy-ui-card', 'edit');
  try {
    await h.start();
    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const earlier = Array.from({ length: 10 }, (_, index) => {
      const tool = writeOwner(h, `recency-before-${index}`, writeSource(`recency_before_${index}`));
      completeLiveWrite(h, tool); return tool;
    });
    h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
    for (const [index, tool] of earlier.entries()) assert.match(tool.render(100).join('\n'), new RegExp(`recency_before_${index}_row_13`));

    h.events.get('turn_start')!({ type: 'turn_start' }, h.ctx);
    const recent = Array.from({ length: 10 }, (_, index) => index % 2 === 0 ?
      { tool: editOwner(h, `recency-native-${index}`), hidden: false } :
      { tool: writeOwner(h, `recency-hidden-${index}`, writeSource(`recency_hidden_${index}`)), hidden: true });
    for (const { tool } of [...recent].reverse()) completeLiveFile(h, tool);
    for (const { tool, hidden } of recent) if (hidden) assert.equal(Reflect.set(tool, 'hideComponent', true), true);
    const native = recent.find(entry => !entry.hidden)!.tool;
    const nativeBefore = native.render(80);
    for (const { tool, hidden } of recent) {
      if (hidden) assert.deepEqual(tool.render(80), [], 'a hidden attached success remains hidden');
      else assert.ok(tool.render(80).length > 0, 'an explicit native edit remains in Pi’s renderer');
    }
    h.events.get('turn_end')!({ type: 'turn_end' }, h.ctx);
    assert.deepEqual(native.render(80), nativeBefore, 'counting a native success does not replace its native presentation');
    for (const [index, tool] of earlier.entries()) {
      const rows = tool.render(100).join('\n');
      assert.doesNotMatch(rows, new RegExp(`recency_before_${index}_row_13`), 'native and hidden successes both displace older automatic cards');
      assert.match(rows, new RegExp(`recency_before_${index}_row_9`), 'displaced cards retain their bounded source prefix');
    }
  } finally { await h.stop(); }
});

test('entry keeps pending and failed details bounded and lets explicit expansion reveal saved error text without stock renderers', async () => {
  const h = fixture();
  try {
    await h.start();
    const pending = writeOwner(h, 'pending-detail', Array.from({ length: 14 }, (_, index) => `pending_${index}`).join('\n'));
    let rows = pending.render(80).join('\n');
    assert.doesNotMatch(rows, /pending_0/, 'collapsed pending cards expose only the compact summary');
    h.root.selection = true; assert.equal(clickFile(pending, 1), undefined, 'selection-safe clicks do not change the stored view'); h.root.selection = false;
    assert.equal(clickFile(pending, 1), undefined, 'pending details are not mouse-expanded');
    pending.setExpanded(true);
    rows = pending.render(80).join('\n');
    assert.match(rows, /pending_8/); assert.doesNotMatch(rows, /pending_9/, 'labels count toward the explicit ten-row pending bound');

    const error = writeOwner(h, 'error-detail', 'const later = true;');
    error.markExecutionStarted();
    const details = Array.from({ length: 14 }, (_, index) => `failure_detail_${index}`).join('\n');
    error.updateResult({ content: [{ type: 'text', text: details }], isError: true }, false);
    rows = error.render(80).join('\n'); assert.doesNotMatch(rows, /const later = true|failure_detail_/, 'collapsed errors do not disclose requested or returned file text');
    assert.equal(clickFileSummary(error)?.handled, true, 'the compact error summary has an explicit expansion target');
    rows = error.render(80).join('\n'); assert.doesNotMatch(rows, /const later = true|Requested file content/);
    for (let index = 0; index < 14; index++) assert.ok(rows.includes(`failure_detail_${index}`), `funded final-error details preserve saved row ${index}`);
    assert.doesNotMatch(rows, /additional file content is omitted/, 'final errors use ordinary full-detail funding, not pending preview bounds');
    assert.equal(clickFileSummary(error)?.handled, true, 'the expanded error can be collapsed again');
    rows = error.render(80).join('\n'); assert.doesNotMatch(rows, /failure_detail_0/);

    const editError = new ToolExecutionComponent('edit', 'edit-error-details', { path: 'edit-error.ts', oldText: 'ORIGINAL_REQUEST', newText: 'REQUESTED_REPLACEMENT' }, undefined,
      editToolDefinition(h), h.root as unknown as ConstructorParameters<typeof ToolExecutionComponent>[5], '/tmp');
    h.root.addChild(editError); editError.setArgsComplete();
    editError.updateResult({ content: [{ type: 'text', text: 'EDIT_ERROR_TEXT' }], isError: true }, false);
    rows = editError.render(80).join('\n');
    assert.doesNotMatch(rows, /ORIGINAL_REQUEST|REQUESTED_REPLACEMENT|EDIT_ERROR_TEXT/, 'collapsed edit errors hide the complete old/new request and result text');
    assert.equal(clickFileSummary(editError)?.handled, true);
    rows = editError.render(80).join('\n');
    assert.doesNotMatch(rows, /ORIGINAL_REQUEST|REQUESTED_REPLACEMENT/); assert.match(rows, /EDIT_ERROR_TEXT/);

    error.updateResult({ content: [], isError: false }, false);
    rows = error.render(80).join('\n'); assert.match(rows, /later/); assert.doesNotMatch(rows, /failure_detail_0/, 'successful recovery replaces the error body on the same owner');
  } finally { await h.stop(); }
});



test('collected expanded error owners release their funded details without a turn-wide sweep', { skip: !global.gc }, async () => {
  const h = fixture();
  const originalFunding = SourceController.prototype.geometryFunding;
  let retainedBytes: (() => number) | undefined;
  SourceController.prototype.geometryFunding = function (...args) {
    const funding = originalFunding.apply(this, args);
    if (funding) retainedBytes = () => funding.budget.stats().retainedBytes;
    return funding;
  };
  let owner: ToolExecutionComponent | undefined;
  try {
    await h.ready; await h.start();
    owner = writeOwner(h, 'orphan-error-details', 'requested body');
    owner.updateResult({ content: [{ type: 'text', text: 'saved error detail row' }], isError: true }, false);
    owner.setExpanded(true);
    const bytes = retainedBytes?.();
    assert.ok(bytes && bytes > 0, 'the deliberate full error detail owns funded text and measurement storage');
    const weak = new WeakRef(owner);
    const index = h.root.children.indexOf(owner);
    assert.notEqual(index, -1);
    h.root.children.splice(index, 1);
    owner = undefined;
    for (let attempt = 0; attempt < 40 && (weak.deref() || (retainedBytes?.() ?? bytes) >= bytes); attempt++) {
      await turn(); global.gc!(); await turn();
    }
    assert.equal(weak.deref(), undefined, 'the host can abandon a whole transcript owner without retaining it');
    assert.ok((retainedBytes?.() ?? bytes) < bytes, 'the weak-owner cleanup releases the detached funded measurement without scanning all records at turn_end');
  } finally {
    SourceController.prototype.geometryFunding = originalFunding;
    await h.stop();
  }
});

test('pending full details reuse funded measurement when replacement input changes only beyond the bounded prefix', async () => {
  const h = fixture();
  try {
    await h.start();
    const source = Array.from({ length: 12 }, (_, index) => `pending_line_${index}`).join('\n');
    const pending = writeOwner(h, 'pending-measurement', source);
    assert.equal(clickFile(pending, 1), undefined, 'pending details require explicit host expansion');
    pending.setExpanded(true);
    assert.match(pending.render(80).join('\n'), /pending_line_8/);

    const geometryFunding = SourceController.prototype.geometryFunding; const grants: number[] = [];
    SourceController.prototype.geometryFunding = function(...args) {
      const funding = geometryFunding.apply(this, args);
      return funding && { budget: funding.budget, grant: (bytes: number) => { grants.push(bytes); return funding.grant(bytes); } };
    };
    try {
      const beforeArgs = grants.length;
      pending.updateArgs({ path: 'pending-measurement.ts', content: `${source.slice(0, source.lastIndexOf('\n'))}\nreplacement_hidden_line` });
      await settled();
      assert.equal(grants.length, beforeArgs, 'a hidden-only argument suffix keeps the existing bounded pending text and measurement');
      const beforeResult = grants.length;
      pending.updateResult({ content: [{ type: 'text', text: `unchanged result prefix\n${'hidden result suffix '.repeat(100)}` }], isError: false }, true);
      await settled();
      assert.equal(grants.length, beforeResult, 'a hidden-only partial-result suffix keeps the existing bounded pending text and measurement');
      const beforeWarm = grants.length;
      pending.render(79); pending.render(70);
      assert.ok(grants.slice(beforeWarm).every(bytes => bytes < 10_000), `width-only reflow uses geometry-sized grants, not source-sized remeasurement grants: ${JSON.stringify(grants.slice(beforeWarm))}`);
      assertNativeRendererCold(pending, 'call', 'pending details retain the owned path after hidden replacement');
    } finally { SourceController.prototype.geometryFunding = geometryFunding; }
  } finally { await h.stop(); }
});

test('unsupported saved edit preview spacing stays on the bounded owned fallback', async () => {
  const h = fixture();
  try {
    await h.start();
    const unsupported = editOwner(h, 'unsupported-spacing-edit');
    unsupported.updateArgs({ path: 'unsupported-spacing.ts', oldText: 'before', newText: 'after' });
    unsupported.updateResult({ content: [], isError: false, details: { patch: 3 } }, false);
    const successor = writeOwner(h, 'unsupported-spacing-successor', writeSource('unsupported_spacing_successor'));
    completeLiveWrite(h, successor);
    h.root.render(80);
    assertNativeRendererCold(unsupported, 'call', 'an accepted unsupported preview uses the same owned fallback for spacing as for display');
    assertNativeRendererCold(unsupported, 'result', 'spacing cannot materialize the unsupported edit result renderer');
    const unsupportedRows = unsupported.render(80).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''));
    assert.ok(unsupportedRows.join('\n').includes('No saved file change details are available') || unsupportedRows.join('\n').includes('File preview unavailable'), unsupportedRows.join('\n'));
    assert.ok(unsupportedRows.length > 1, 'the unavailable preview has more than its one-line title');
    const rootRows = h.root.render(80).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''));
    const successorIndex = rootRows.findIndex(row => row.includes('unsupported-spacing-successor.ts'));
    assert.ok(successorIndex >= 0, 'successor exposes its own path');
    const detailIndex = rootRows.findIndex(row => row.includes('Click to expand'));
    const separatorIndex = rootRows.findIndex((row, index) => index > detailIndex && index < successorIndex && row === '');
    assert.ok(detailIndex >= 0 && separatorIndex > detailIndex && separatorIndex < successorIndex,
      'spacing measures the same multi-row owned fallback that the unsupported predecessor renders');
    assert.ok(rootRows.join('\n').includes('unsupported_spacing_successor_row_0'));
  } finally { await h.stop(); }
});


test('expanded read image rows remain during reload cleanup until hooks are restored', async () => {
  const previousCapabilities = getCapabilities(); setCapabilities({ ...previousCapabilities, images: 'kitty' });
  const h = fixture();
  let release!: () => void, stopping: Promise<void> | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispose = SyntaxRuntime.prototype.dispose;
  try {
    await h.ready; await h.start();
    const owner = readOwner(h, 'read-image-reload', { path: 'reload.png' });
    owner.setShowImages(true); owner.setImageWidthCells(30);
    owner.updateResult({ content: [{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', mimeType: 'image/png' }], isError: false }, false);
    owner.setExpanded(true);
    const before = h.root.render(80);
    assert.equal(before.some(row => row.includes('\x1b_G') || row.includes('\x1b]1337;File=')), true,
      'the normal expanded read frame includes its saved Pi image protocol block');
    SyntaxRuntime.prototype.dispose = function () {
      const stopped = dispose.call(this);
      return Promise.all([stopped, gate]).then(() => {});
    };
    stopping = h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx) as Promise<void>;
    await settled();
    const cleanup = h.root.render(80);
    assert.deepEqual(cleanup, before, 'the temporary reload-cleanup frame retains the current saved image rows and surrounding card');
  } finally {
    release();
    if (stopping) await stopping;
    SyntaxRuntime.prototype.dispose = dispose;
    await h.stop(); setCapabilities(previousCapabilities);
  }
});


test('owned-palette mode drift schedules current refresh outside render without changing source identity', async () => {
  const h = fixture('tui', false, undefined, undefined, undefined, { kind: 'theme', id: 'gruvbox', variant: 'dark' });
  const theme = themes.getThemeByName('dark') as Theme & { getColorMode(): TerminalColorMode } | undefined;
  assert.ok(theme, 'the SDK returns a real public theme instance for this mode-change control');
  themes.setThemeInstance(theme);
  const descriptor = Object.getOwnPropertyDescriptor(theme, 'getColorMode');
  let mode = theme.getColorMode();
  Object.defineProperty(theme, 'getColorMode', { configurable: true, value: () => mode });
  const original = CardSources.prototype.updateDisplay;
  const inputs: CardDisplayInput[] = [];
  let inRender = false, updatesInRender = 0;
  CardSources.prototype.updateDisplay = function(node, input) {
    if (inRender) updatesInRender++;
    inputs.push(input);
    return original.call(this, node, input);
  };
  try {
    await h.ready; await h.start();
    const owner = writeOwner(h, 'owned-mode-deferred', 'const OWNED_MODE_REFRESH = true;');
    completeLiveWrite(h, owner); owner.setExpanded(true); owner.render(80); await settled();
    const first = inputs.at(-1);
    assert.equal(first?.kind, 'file'); if (first?.kind !== 'file') return;
    const sourceRevision = first.sourceRevision;
    mode = mode === 'truecolor' ? '256color' : 'truecolor';
    assert.equal(theme.getColorMode(), mode, 'the public Theme getter observes the changed mode before the render probe');
    inRender = true; owner.render(80); inRender = false;
    assert.equal(updatesInRender, 0, 'an already-applied owned palette never rebuilds rows or measurements on the render stack');
    await settled();
    const refreshed = inputs.at(-1);
    assert.equal(refreshed?.kind, 'file'); if (refreshed?.kind !== 'file') return;
    assert.equal(refreshed.mode, mode, 'the deferred drain re-reads current public color mode rather than a captured value');
    assert.equal(refreshed.sourceRevision, sourceRevision, 'mode-only refresh keeps the accepted source revision');
    const calls = inputs.length;
    owner.render(80); owner.render(100); await settled();
    assert.equal(inputs.length, calls, 'warm and width-only frames do not repeat display preparation');
  } finally {
    CardSources.prototype.updateDisplay = original;
    if (descriptor) Object.defineProperty(theme, 'getColorMode', descriptor);
    else Reflect.deleteProperty(theme, 'getColorMode');
    themes.initTheme('dark', false);
    await h.stop();
  }
});

test('cold expanded write and edit preparation leaves the render stack and recovers at the same expansion', async () => {
  const originalUpdate = CardSources.prototype.updateDisplay;
  for (const kind of ['write', 'edit'] as const) {
    const h = fixture(); let inRender = false, updatesInRender = 0, updatesOutsideRender = 0, siblingUpdates = 0, denyTarget = false;
    let sibling: ToolExecutionComponent | undefined, target: ToolExecutionComponent | undefined;
    CardSources.prototype.updateDisplay = function (owner, input) {
      if (inRender) updatesInRender++; else updatesOutsideRender++;
      if (owner === sibling) siblingUpdates++;
      if (owner === target && denyTarget) return false;
      return originalUpdate.call(this, owner, input);
    };
    try {
      await h.start();
      sibling = writeOwner(h, `warm-sibling-${kind}`, writeSource(`warm_sibling_${kind}`));
      completeLiveWrite(h, sibling); sibling.setExpanded(true); sibling.render(80); await settled();
      const siblingRows = sibling.render(80);
      assert.ok(siblingRows.join('\n').includes(`warm_sibling_${kind}_row_13`), `the unrelated sibling has an admitted full display before target refusal; rows:\n${siblingRows.join('\n')}`);
      updatesOutsideRender = 0; siblingUpdates = 0;
      const owner = kind === 'write' ? writeOwner(h, `deferred-${kind}`, writeSource(`deferred_${kind}`)) : editOwner(h, `deferred-${kind}`);
      h.root.removeChild(owner);
      owner.setExpanded(true);
      if (kind === 'edit') completeLiveEdit(h, owner); else completeLiveWrite(h, owner);
      Reflect.set(owner, 'hideComponent', true);
      h.root.addChild(owner);
      assert.equal(Reflect.get(owner, 'hideComponent'), true, `${kind} remains genuinely hidden after Pi updates its result`);
      assert.equal(updatesOutsideRender, 0, `${kind} has not attempted source admission while detached`);
      target = owner; denyTarget = true;
      const args = Reflect.get(owner, 'args'), result = Reflect.get(owner, 'result');
      owner.render(80);
      assert.equal(updatesOutsideRender, 0, `${kind} hidden detached-to-attached render still does not admit content`);
      Reflect.set(owner, 'hideComponent', false);

      inRender = true;
      try { owner.render(80); } finally { inRender = false; }
      const pendingRows = owner.render(80).join('\n');
      assert.match(pendingRows, /Preparing full file view/u, `${kind} distinguishes pending admission from a real funding refusal`);
      assert.doesNotMatch(pendingRows, /unavailable within the current .* budget/u);
      assert.equal(updatesInRender, 0, `${kind} cold source/display admission does not run inside its render call`);
      const framesBeforeDrain = h.root.requests;
      await settled();
      assert.ok(updatesOutsideRender > 0, `${kind} admission drains outside render`);
      assert.equal(siblingUpdates, 0, `${kind} refused outcome does not invalidate or re-admit a warm unrelated sibling`);
      const firstRequestedFrame = h.root.requests;
      assert.equal(firstRequestedFrame, framesBeforeDrain + 1, `${kind} first refusal requests exactly one ordinary status frame`);
      const attemptsBeforeRepeat = updatesOutsideRender, stableFrames = h.root.requests;
      for (let i = 0; i < 3; i++) { owner.render(80); await settled(); }
      assert.ok(updatesOutsideRender - attemptsBeforeRepeat <= 3, `${kind} repeated denied frames remain bounded to explicit attempts`);
      assert.equal(h.root.requests, stableFrames, `${kind} unchanged refusal does not create a self-sustaining frame loop`);
      assert.equal(siblingUpdates, 0, `${kind} target-only notification leaves the warm sibling cache untouched`);
      const siblingTail = sibling.render(80).join('\n');
      assert.ok(siblingTail.includes(`warm_sibling_${kind}_row_13`), `${kind} target refusal leaves the warm sibling's saved full rows available`);
      assert.equal(siblingUpdates, 0, `${kind} sibling-only render does not re-admit its source`);

      denyTarget = false;
      inRender = true;
      try { owner.render(80); } finally { inRender = false; }
      assert.equal(updatesInRender, 0, `${kind} funding recovery remains deferred`);
      await settled();
      const rows = owner.render(80).join('\n');
      assert.ok(rows.includes(kind === 'write' ? 'deferred_write_row_13' : 'after'), `${kind} saved full text recovers without changing expansion`);
      assert.equal(Reflect.get(owner, 'expanded'), true);
      assert.equal(Reflect.get(owner, 'args'), args); assert.equal(Reflect.get(owner, 'result'), result);
      const warmUpdates = updatesOutsideRender;
      inRender = true;
      try { owner.render(80); owner.render(100); } finally { inRender = false; }
      await settled();
      assert.equal(updatesOutsideRender, warmUpdates, `${kind} warm and width-only visits reuse current preparation`);
      assert.equal(updatesInRender, 0);
      assert.equal(siblingUpdates, 0);
    } finally {
      CardSources.prototype.updateDisplay = originalUpdate;
      await h.stop();
    }
  }
});

test('predecessor measurement defers cold full write and edit preparation', async () => {
  const originalUpdate = CardSources.prototype.updateDisplay;
  for (const kind of ['write', 'edit'] as const) {
    const h = fixture(); let inRender = false, updatesInRender = 0, updatesOutsideRender = 0;
    CardSources.prototype.updateDisplay = function (owner, input) {
      if (inRender) updatesInRender++; else updatesOutsideRender++;
      return originalUpdate.call(this, owner, input);
    };
    try {
      await h.start();
      const predecessor = kind === 'write' ? writeOwner(h, `measure-${kind}`, writeSource(`measure_${kind}`)) : editOwner(h, `measure-${kind}`);
      h.root.removeChild(predecessor);
      predecessor.setExpanded(true);
      if (kind === 'edit') completeLiveEdit(h, predecessor); else completeLiveWrite(h, predecessor);
      Reflect.set(predecessor, 'hideComponent', true);
      h.root.addChild(predecessor);
      assert.equal(Reflect.get(predecessor, 'hideComponent'), true);
      assert.equal(updatesOutsideRender, 0, `${kind} predecessor has not been admitted before sibling measurement`);
      const follower = readOwner(h, `measure-follower-${kind}`);
      completeLiveFile(h, follower);
      const originalArgs = Reflect.get(predecessor, 'args'), originalResult = Reflect.get(predecessor, 'result');
      Reflect.set(predecessor, 'hideComponent', false);

      inRender = true;
      let rows: string[];
      try { rows = follower.render(80); } finally { inRender = false; }
      assert.ok(rows.length > 0, 'the following compact read remains visible');
      assert.equal(updatesInRender, 0, `${kind} predecessor measurement does not construct source/display rows inside the follower render`);
      await settled();
      assert.ok(updatesOutsideRender > 0, `${kind} predecessor admission drains after render`);
      const rendered = predecessor.render(80).join('\n');
      assert.ok(rendered.includes(kind === 'write' ? 'measure_write_row_13' : 'after'), `${kind} predecessor becomes available after deferred preparation`);
      assert.equal(Reflect.get(predecessor, 'args'), originalArgs); assert.equal(Reflect.get(predecessor, 'result'), originalResult);
      const warmUpdates = updatesOutsideRender;
      follower.render(80); predecessor.render(80); await settled();
      assert.equal(updatesOutsideRender, warmUpdates, `${kind} warm predecessor measurement does not repeat source/display admission`);
      assert.equal(updatesInRender, 0);
    } finally {
      CardSources.prototype.updateDisplay = originalUpdate;
      await h.stop();
    }
  }
});


test('queued palette refresh rechecks lifecycle and preserves the current token', async () => {
  const h = fixture('tui', false, undefined, undefined, undefined, { kind: 'theme', id: 'gruvbox', variant: 'dark' });
  const theme = themes.getThemeByName('dark') as Theme & { getColorMode(): TerminalColorMode } | undefined;
  assert.ok(theme, 'the SDK returns a real public Theme instance for deferred-token checks');
  themes.setThemeInstance(theme);
  const descriptor = Object.getOwnPropertyDescriptor(theme, 'getColorMode');
  let mode = theme.getColorMode();
  Object.defineProperty(theme, 'getColorMode', { configurable: true, value: () => mode });
  const original = CardSources.prototype.updateDisplay;
  const inputs: CardDisplayInput[] = [];
  let owner: ToolExecutionComponent | undefined;
  CardSources.prototype.updateDisplay = function(node, input) {
    if (node === owner) inputs.push(input);
    return original.call(this, node, input);
  };
  let stopped = false;
  try {
    await h.ready; await h.start();
    owner = writeOwner(h, 'queued-refresh-lifecycle', 'const QUEUED_REFRESH_LIFECYCLE = true;');
    completeLiveWrite(h, owner); owner.setExpanded(true); owner.render(80); await settled();
    assert.ok(inputs.some(input => input.kind === 'file' && input.mode === mode), 'initial full display is prepared before lifecycle probes');

    for (const transition of ['hide', 'detach', 'zero-width', 'collapse'] as const) {
      mode = '256color';
      const beforeSchedule = inputs.length;
      owner.render(80);
      assert.equal(inputs.length, beforeSchedule, `${transition}: mode drift is not prepared in render`);
      if (transition === 'hide') Reflect.set(owner, 'hideComponent', true);
      else if (transition === 'detach') h.root.removeChild(owner);
      else if (transition === 'zero-width') owner.render(0);
      else owner.setExpanded(false);
      const afterLifecycle = inputs.length;
      await settled();
      assert.equal(inputs.length, afterLifecycle, `${transition}: queued obsolete refresh adds no preparation after lifecycle change`);
      if (transition === 'collapse') {
        assert.ok(inputs.slice(beforeSchedule).every(input => input.kind === 'file' && input.viewMode === 'preview'),
          'a real collapse may prepare only its current preview, never stale full rows');
        owner.setExpanded(true);
      } else if (transition === 'hide') Reflect.set(owner, 'hideComponent', false);
      else if (transition === 'detach') h.root.addChild(owner);

      mode = inputs.at(-1)?.mode === '256color' ? 'truecolor' : '256color';
      const beforeCurrent = inputs.length;
      owner.render(80);
      await settled();
      assert.ok(inputs.slice(beforeCurrent).some(input => input.kind === 'file' && input.mode === mode),
        `${transition}: a later valid current token still refreshes the changed mode; observed=${JSON.stringify(inputs.map(input => input.kind === 'file' ? { mode: input.mode, viewMode: input.viewMode, revision: input.revision } : input.kind))}; expected=${mode}`);
    }

    mode = '256color'; owner.render(80);
    const beforeStop = inputs.length;
    await h.stop(); stopped = true;
    await settled();
    assert.equal(inputs.length, beforeStop, 'quiescing invalidates a queued refresh before it can prepare');
  } finally {
    CardSources.prototype.updateDisplay = original;
    if (descriptor) Object.defineProperty(theme, 'getColorMode', descriptor);
    else Reflect.deleteProperty(theme, 'getColorMode');
    themes.initTheme('dark', false);
    if (!stopped) await h.stop();
  }
});
