import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { ExtensionSelectorComponent, initTheme, Theme, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, stripTerminalSequences, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import type { SyntaxTheme } from '../src/settings.ts';
import type { ProfileDescription } from '../src/occipital/protocol.ts';
import { openSyntaxMenu, type SyntaxMenuOwner, type SyntaxMenuSnapshot, type SyntaxMenuOutcome } from '../src/occipital/menu.ts';

initTheme('dark', false);
const foregroundTokens = 'accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode'.split(' ');
const backgroundTokens = 'selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg'.split(' ');
const inputs = JSON.parse(await readFile(process.env.TIDY_TEST_INPUTS!, 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent')), 'utf8'));
assert.equal(manifest.version, inputs.pi.version);
const dialogTheme = new Theme(Object.fromEntries(foregroundTokens.map(key => [key, '#66aaff'])) as ConstructorParameters<typeof Theme>[0],
  Object.fromEntries(backgroundTokens.map(key => [key, '#333333'])) as ConstructorParameters<typeof Theme>[1], 'truecolor');
type DialogComponent = Component & { dispose?(): void };
type CustomFactory<T> = (tui: TUI, theme: Theme, keybindings: Parameters<Parameters<ExtensionContext['ui']['custom']>[0]>[2], done: (result: T) => void) => DialogComponent | Promise<DialogComponent>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const profile = (id: string, label = id): ProfileDescription => ({ id, label, fingerprint: 'a'.repeat(64) });
function cached(): SyntaxMenuSnapshot {
  const profiles = [profile('pi', 'Pi palette'), profile('opaque:/one', 'One'), profile('opaque:/two', 'Two')];
  return {
    enabled: true,
    provider: { availability: 'ready', reason: 'ready', generation: 1, kind: 'shared', initialShared: true,
      description: { backend_version: 'shared-9.0', profiles, instance: 'CONNECTION_SECRET', assets: 'ASSET_SECRET',
        catalogue_revision: 1, diagnostic: 'RAW_DIAGNOSTIC_SECRET',
        runtime: { pid: 1, routes: 1, leases: 0, data_bytes: 0, data_jobs: 0, queued: 0, control_bytes: 0, control_jobs: 0 },
        limits: { request_bytes: 2097152, reply_bytes: 2097152, control_request_bytes: 4096, control_reply_bytes: 32768,
          source_bytes: 1048576, line_bytes: 8192, batch_sources: 8, queue_wait_ms: 1000, state_pool_bytes: 2097152,
          leases: 32, leases_per_route: 4, runs: 131072, styles: 512, idle_ms: 60000, age_ms: 300000,
          quantum_ms: 2, data_per_route: 2, control_per_route: 1, routes: 8, workers: 2 } } },
    standaloneVersion: 'owned-1.0', selected: { kind: 'occipital', id: 'missing:/saved' },
    effective: profiles[0], lastIssue: 'Selected theme is unavailable; temporarily using Pi palette.',
  };
}
class Owner implements SyntaxMenuOwner {
  state = cached();
  alive = true;
  generation = 1;
  counts = { snapshots: 0, selections: 0, refreshes: 0, toggles: 0, writes: 0, starts: 0, describes: 0 };
  choices: SyntaxTheme[] = [];
  enabledChoices: boolean[] = [];
  outcome: SyntaxMenuOutcome = { ok: true };
  thrown?: Error;
  pending?: ReturnType<typeof deferred<void>>;
  snapshot() { this.counts.snapshots++; return this.state; }
  async selectTheme(choice: SyntaxTheme): Promise<SyntaxMenuOutcome> {
    this.counts.selections++;
    const generation = this.generation;
    if (this.pending) await this.pending.promise;
    if (!this.alive || generation !== this.generation) return { ok: false, message: 'Retired owner.' };
    if (this.thrown) throw this.thrown;
    this.choices.push(choice); this.state.selected = choice;
    this.counts.writes++;
    return this.outcome;
  }
  async refreshThemes(): Promise<SyntaxMenuOutcome> {
    this.counts.refreshes++;
    const generation = this.generation;
    if (this.pending) await this.pending.promise;
    if (!this.alive || generation !== this.generation) return { ok: false, message: 'Retired owner.' };
    if (this.thrown) throw this.thrown;
    return this.outcome;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.counts.toggles++; this.enabledChoices.push(enabled);
    const generation = this.generation;
    if (this.pending) await this.pending.promise;
    if (!this.alive || generation !== this.generation) return;
    if (this.thrown) throw this.thrown;
    this.state.enabled = enabled;
    if (enabled) this.counts.starts++;
  }
}
class PublicUI implements Pick<ExtensionContext['ui'], 'select' | 'notify' | 'custom'> {
  terminal = { columns: 80, rows: 24 };
  renderRequests = 0;
  factoryGate?: ReturnType<typeof deferred<void>>;
  customOptions?: Parameters<ExtensionContext['ui']['custom']>[1];
  dialogs: { title: string; options: string[]; reply: ReturnType<typeof deferred<string | undefined>>; component: DialogComponent; custom?: boolean; completions?: number }[] = [];
  notifications: { message: string; type?: string }[] = [];
  select(title: string, options: string[]) {
    const reply = deferred<string | undefined>();
    const component = new ExtensionSelectorComponent(title, options, value => reply.resolve(value), () => reply.resolve(undefined));
    this.dialogs.push({ title, options: [...options], reply, component });
    return reply.promise;
  }
  async custom<T>(factory: CustomFactory<T>, options?: Parameters<ExtensionContext['ui']['custom']>[1]): Promise<T> {
    this.customOptions = options;
    const reply = deferred<T>();
    if (this.factoryGate) await this.factoryGate.promise;
    let component: DialogComponent | undefined;
    let completions = 0;
    const done = (value: T) => { completions++; reply.resolve(value); component?.dispose?.(); };
    component = await factory({ terminal: this.terminal, requestRender: () => { this.renderRequests++; } } as unknown as TUI,
      dialogTheme, getKeybindings() as unknown as Parameters<CustomFactory<T>>[2], done);
    const title = component.render(this.terminal.columns).map(stripTerminalSequences).join('\n');
    // Discover choices through rendered selected rows and public key input, not
    // production test hooks or private SelectList fields. One wrap restores index.
    const labels: string[] = [];
    for (let i = 0; i < 51; i++) {
      const line = component.render(this.terminal.columns).map(stripTerminalSequences).find(row => row.startsWith('→ '));
      const label = line?.slice(2);
      if (label === undefined || labels.includes(label)) break;
      labels.push(label); component.handleInput?.('\x1b[B');
    }
    const dialog = { title, options: labels, reply: reply as unknown as ReturnType<typeof deferred<string | undefined>>,
      component, custom: true, get completions() { return completions; } };
    this.dialogs.push(dialog);
    try { return await reply.promise; } finally { component.dispose?.(); }
  }
  notify(message: string, type?: string) { this.notifications.push({ message, type }); }
}
function setup(mode: ExtensionContext['mode'] = 'tui', hasUI = true) {
  const owner = new Owner(), ui = new PublicUI();
  const generation = owner.generation;
  const current = () => owner.alive && owner.generation === generation;
  const ctx = { mode, hasUI, ui: ui as unknown as ExtensionContext['ui'] };
  return { owner, ui, current, open: () => openSyntaxMenu(ctx, owner, current) };
}
async function answer(s: ReturnType<typeof setup>, index: number, choice?: string) {
  // Assertions stay outside the UI/owner promises caught by the menu.
  assert.ok(s.ui.dialogs[index], `expected dialog ${index}`);
  const dialog = s.ui.dialogs[index];
  if (dialog.custom) {
    if (choice === undefined) dialog.component.handleInput?.('\x1b');
    else {
      const target = dialog.options.indexOf(choice);
      assert.ok(target >= 0, `unknown rendered choice ${choice}`);
      for (let i = 0; i < target; i++) dialog.component.handleInput?.('\x1b[B');
      dialog.component.handleInput?.('\r');
    }
  } else dialog.reply.resolve(choice);
  await turn();
}
function noWork(owner: Owner) {
  const { snapshots: _snapshots, ...work } = owner.counts;
  assert.deepEqual(work, { selections: 0, refreshes: 0, toggles: 0, writes: 0, starts: 0, describes: 0 });
}
async function close(s: ReturnType<typeof setup>, job: Promise<void>) {
  await answer(s, s.ui.dialogs.length - 1, 'Close');
  await job;
}

for (const choice of [undefined, 'Close']) test(`openSyntaxMenu main cancellation ${choice} has exact zero work`, async () => {
  const s = setup(), job = s.open();
  assert.deepEqual(s.ui.dialogs[0].options, ['Theme', 'Reload themes', 'Service status', 'Disable for this session', 'Close']);
  await answer(s, 0, choice); await job;
  noWork(s.owner); assert.equal(s.owner.counts.snapshots, 1);
  assert.equal(s.ui.dialogs.length, 1); assert.deepEqual(s.ui.notifications, []);
});
for (const choice of [undefined, 'Back']) test(`openSyntaxMenu theme cancellation ${choice} never writes or reloads`, async () => {
  const s = setup(), job = s.open();
  await answer(s, 0, 'Theme');
  assert.equal(s.ui.dialogs[1].options.length, 4);
  assert.match(s.ui.dialogs[1].title, /Selected:.*missing:\/saved/);
  assert.match(s.ui.dialogs[1].title, /Effective: Pi palette/);
  await answer(s, 1, choice); await close(s, job);
  noWork(s.owner); assert.equal(s.owner.counts.snapshots, 3);
  assert.deepEqual(s.ui.notifications, []);
});
test('openSyntaxMenu service status reads only cached bounded public fields', async () => {
  const s = setup(), job = s.open();
  await answer(s, 0, 'Service status'); await close(s, job);
  noWork(s.owner); assert.equal(s.owner.counts.snapshots, 3);
  assert.equal(s.ui.notifications.length, 1);
  const { message, type } = s.ui.notifications[0];
  assert.equal(type, 'info');
  for (const text of ['ready', 'shared', 'shared-9.0', 'owned-1.0', 'Protocol: 2', 'Selected:', 'missing:/saved', 'Effective: Pi palette', s.owner.state.lastIssue!]) assert.ok(message.includes(text), text);
  assert.doesNotMatch(message, /SECRET|fingerprint|runtime|pid|limits/);
});
for (const availability of ['disabled', 'initializing', 'transitioning', 'unavailable'] as const) {
  test(`openSyntaxMenu ${availability}: Pi palette remains selectable; stale catalogue is not listed`, async () => {
    const s = setup(); s.owner.state.provider.availability = availability; s.owner.state.enabled = availability !== 'disabled';
    const job = s.open(); await answer(s, 0, 'Theme');
    assert.deepEqual(s.ui.dialogs[1].options, ['1. Pi palette', 'Back']);
    assert.match(s.ui.dialogs[1].title, new RegExp(availability));
    await answer(s, 1, s.ui.dialogs[1].options[0]); await close(s, job);
    assert.deepEqual(s.owner.choices, [{ kind: 'pi' }]);
    assert.equal(s.owner.counts.writes, 1); assert.equal(s.owner.counts.starts, 0); assert.equal(s.owner.counts.describes, 0); assert.equal(s.owner.counts.refreshes, 0);
  });
  test(`openSyntaxMenu ${availability}: refresh reports why without owner action`, async () => {
    const s = setup(); s.owner.state.provider.availability = availability; s.owner.state.enabled = availability !== 'disabled';
    const job = s.open(); await answer(s, 0, 'Reload themes'); await close(s, job);
    noWork(s.owner); assert.equal(s.ui.notifications.length, 1);
    assert.equal(s.ui.notifications[0].type, 'error'); assert.match(s.ui.notifications[0].message, new RegExp(availability));
  });
}
test('openSyntaxMenu disabled wins over a cached ready provider', async () => {
  const s = setup(); s.owner.state.enabled = false;
  const job = s.open(); await answer(s, 0, 'Reload themes'); await answer(s, 1, 'Theme');
  assert.deepEqual(s.ui.dialogs[2].options, ['1. Pi palette', 'Back']);
  await answer(s, 2, 'Back'); await close(s, job); noWork(s.owner);
  assert.match(s.ui.notifications[0].message, /disabled/);
});
test('openSyntaxMenu theme choices preserve opaque IDs despite duplicate and control-label collisions', async () => {
  const s = setup();
  const profiles = [profile('pi', 'Pi palette'), profile('custom:/α[2]', 'Pi palette'), profile('two', 'Pi palette'), profile('three', 'Back'), profile('four', '2. Pi palette [custom:/α[2]]')];
  s.owner.state.provider.description!.profiles = profiles;
  const job = s.open(); await answer(s, 0, 'Theme');
  const options = s.ui.dialogs[1].options;
  assert.equal(new Set(options).size, options.length); assert.equal(options.length, profiles.length + 1);
  await answer(s, 1, options[1]); await answer(s, 2, 'Theme');
  assert.match(s.ui.dialogs[3].title, /Selected:.*custom:\/α\[2\]/);
  await answer(s, 3, s.ui.dialogs[3].options[2]); await close(s, job);
  assert.deepEqual(s.owner.choices, [{ kind: 'occipital', id: 'custom:/α[2]' }, { kind: 'occipital', id: 'two' }]);
  assert.equal(s.owner.counts.writes, 2); assert.equal(s.owner.counts.refreshes, 0); assert.equal(s.owner.counts.describes, 0);
});
test('openSyntaxMenu explicit refresh delegates exactly once and reports success', async () => {
  const s = setup(), job = s.open(); await answer(s, 0, 'Reload themes'); await close(s, job);
  assert.equal(s.owner.counts.refreshes, 1); assert.equal(s.owner.counts.writes, 0); assert.equal(s.owner.counts.starts, 0);
  assert.equal(s.ui.notifications.length, 1); assert.equal(s.ui.notifications[0].type, 'info');
});
for (const enabled of [true, false]) test(`openSyntaxMenu session toggle from ${enabled} delegates once without persistence`, async () => {
  const s = setup(); s.owner.state.enabled = enabled;
  const job = s.open(); await answer(s, 0, enabled ? 'Disable for this session' : 'Enable for this session');
  assert.ok(s.ui.dialogs[1].options.includes(enabled ? 'Enable for this session' : 'Disable for this session'));
  await close(s, job);
  assert.deepEqual(s.owner.enabledChoices, [!enabled]); assert.equal(s.owner.counts.toggles, 1);
  assert.equal(s.owner.counts.writes, 0); assert.equal(s.owner.counts.selections, 0); assert.equal(s.owner.counts.refreshes, 0);
});
for (const action of ['selection', 'refresh'] as const) test(`openSyntaxMenu ${action} reports safe owner outcome failure`, async () => {
  const s = setup(); s.owner.outcome = { ok: false, message: action === 'selection' ? 'Selection is active but could not be saved.' : 'Themes could not be reloaded; previous catalogue retained.' };
  const job = s.open(); await answer(s, 0, action === 'selection' ? 'Theme' : 'Reload themes');
  if (action === 'selection') await answer(s, 1, s.ui.dialogs[1].options[1]);
  await close(s, job);
  assert.deepEqual(s.ui.notifications, [{ message: s.owner.outcome.message, type: 'error' }]);
  if (action === 'selection') assert.deepEqual(s.owner.state.selected, { kind: 'occipital', id: 'opaque:/one' });
});
for (const action of ['selection', 'refresh', 'toggle'] as const) test(`openSyntaxMenu ${action} thrown failure is bounded, not a raw error`, async () => {
  const s = setup(); s.owner.thrown = new Error('RAW_SECRET /connection /source');
  const job = s.open(); await answer(s, 0, action === 'selection' ? 'Theme' : action === 'refresh' ? 'Reload themes' : 'Disable for this session');
  if (action === 'selection') await answer(s, 1, s.ui.dialogs[1].options[1]);
  await close(s, job);
  assert.equal(s.ui.notifications.length, 1); assert.equal(s.ui.notifications[0].type, 'error');
  assert.doesNotMatch(s.ui.notifications[0].message, /RAW_SECRET|connection|source/);
});
for (const mode of ['rpc', 'json', 'print'] as const) for (const hasUI of [true, false]) test(`openSyntaxMenu unsupported ${mode}/${hasUI} uses notify only`, async () => {
  const s = setup(mode, hasUI); await s.open(); noWork(s.owner);
  assert.equal(s.owner.counts.snapshots, 0); assert.equal(s.ui.dialogs.length, 0); assert.equal(s.ui.notifications.length, 1);
});
test('openSyntaxMenu TUI without UI uses notify only', async () => {
  const s = setup('tui', false); await s.open(); noWork(s.owner);
  assert.equal(s.owner.counts.snapshots, 0); assert.equal(s.ui.dialogs.length, 0); assert.equal(s.ui.notifications.length, 1);
});
test('openSyntaxMenu already stale does nothing even in an unsupported mode', async () => {
  const s = setup('rpc'); s.owner.alive = false; await s.open(); noWork(s.owner);
  assert.equal(s.owner.counts.snapshots, 0); assert.deepEqual(s.ui.notifications, []); assert.deepEqual(s.ui.dialogs, []);
});
for (const action of ['Theme', 'Reload themes', 'Service status', 'Disable for this session']) test(`openSyntaxMenu stale main reply ${action} never delegates/notifies/reopens`, async () => {
  const s = setup(), job = s.open(); s.owner.generation++;
  await answer(s, 0, action); await job; noWork(s.owner);
  assert.equal(s.owner.counts.snapshots, 1); assert.equal(s.ui.dialogs.length, 1); assert.deepEqual(s.ui.notifications, []);
});
for (const disposed of [false, true]) test(`openSyntaxMenu delayed theme reply after ${disposed ? 'disposal' : 'generation retirement'} never saves`, async () => {
  const s = setup(), job = s.open(); await answer(s, 0, 'Theme');
  if (disposed) s.owner.alive = false; else s.owner.generation++;
  await answer(s, 1, s.ui.dialogs[1].options[1]); await job; noWork(s.owner);
  assert.equal(s.ui.dialogs.length, 2); assert.deepEqual(s.ui.notifications, []);
});
for (const action of ['selection', 'refresh', 'toggle'] as const) for (const reject of [false, true]) test(`openSyntaxMenu stale pending ${action} ${reject ? 'reject' : 'resolve'} cannot notify or reopen`, async () => {
  const s = setup(); s.owner.pending = deferred<void>();
  const job = s.open(); await answer(s, 0, action === 'selection' ? 'Theme' : action === 'refresh' ? 'Reload themes' : 'Disable for this session');
  if (action === 'selection') await answer(s, 1, s.ui.dialogs[1].options[1]);
  assert.equal(s.owner.counts[action === 'selection' ? 'selections' : action === 'refresh' ? 'refreshes' : 'toggles'], 1);
  const dialogs = s.ui.dialogs.length; s.owner.alive = false;
  if (reject) s.owner.pending.reject(new Error('RAW_SECRET')); else s.owner.pending.resolve();
  await job;
  assert.equal(s.owner.counts.writes, 0); assert.equal(s.owner.counts.starts, 0); assert.equal(s.owner.state.enabled, true);
  assert.equal(s.ui.dialogs.length, dialogs); assert.deepEqual(s.ui.notifications, []);
});
for (const submenu of [false, true]) test(`openSyntaxMenu ${submenu ? 'theme' : 'main'} public selector rejection reports only bounded feedback`, async () => {
  const s = setup(), job = s.open(); if (submenu) await answer(s, 0, 'Theme');
  s.ui.dialogs[submenu ? 1 : 0].reply.reject(new Error('RAW_SECRET'));
  await turn(); if (submenu) await close(s, job); else await job;
  noWork(s.owner); assert.equal(s.ui.notifications.length, 1); assert.equal(s.ui.notifications[0].type, 'error');
  assert.doesNotMatch(s.ui.notifications[0].message, /RAW_SECRET/);
});
test('openSyntaxMenu stale public selector rejection is silent', async () => {
  const s = setup(), job = s.open(); s.owner.alive = false;
  s.ui.dialogs[0].reply.reject(new Error('RAW_SECRET')); await job;
  noWork(s.owner); assert.deepEqual(s.ui.notifications, []); assert.equal(s.ui.dialogs.length, 1);
});

test('openSyntaxMenu missing cached descriptor/effective profile never fabricates readiness or protocol', async () => {
  const s = setup(); delete s.owner.state.provider.description; delete s.owner.state.effective;
  const job = s.open(); await answer(s, 0, 'Theme');
  assert.deepEqual(s.ui.dialogs[1].options, ['1. Pi palette', 'Back']);
  assert.match(s.ui.dialogs[1].title, /no cached catalogue/);
  await answer(s, 1, 'Back'); await answer(s, 2, 'Reload themes');
  await answer(s, 3, 'Service status'); await close(s, job); noWork(s.owner);
  assert.match(s.ui.notifications[0].message, /no cached catalogue/);
  assert.match(s.ui.notifications[1].message, /Daemon version: unavailable\nProtocol: unavailable/);
  assert.match(s.ui.notifications[1].message, /Effective: Unavailable/);
});
for (const action of ['selection', 'refresh', 'toggle'] as const) test(`openSyntaxMenu delayed current ${action} waits without reopening and completes once`, async () => {
  const s = setup(); s.owner.pending = deferred<void>();
  const job = s.open(); await answer(s, 0, action === 'selection' ? 'Theme' : action === 'refresh' ? 'Reload themes' : 'Disable for this session');
  if (action === 'selection') await answer(s, 1, s.ui.dialogs[1].options[1]);
  assert.equal(s.ui.dialogs.length, action === 'selection' ? 2 : 1); assert.equal(s.ui.notifications.length, 0);
  assert.equal(s.owner.counts[action === 'selection' ? 'selections' : action === 'refresh' ? 'refreshes' : 'toggles'], 1);
  s.owner.pending.resolve(); await turn(); await close(s, job);
  assert.equal(s.ui.notifications.length, 1); assert.equal(s.ui.notifications[0].type, 'info');
  if (action === 'toggle') assert.equal(s.ui.notifications[0].message, 'Syntax highlighting disabled for this session.');
});
for (const action of ['Theme', 'Reload themes', 'Service status']) test(`openSyntaxMenu checks current again after cached ${action} snapshot before UI/action`, async () => {
  const s = setup(); const snapshot = s.owner.snapshot.bind(s.owner);
  s.owner.snapshot = () => { const value = snapshot(); if (s.owner.counts.snapshots === 2) s.owner.alive = false; return value; };
  const job = s.open(); await answer(s, 0, action); await job;
  noWork(s.owner); assert.equal(s.ui.dialogs.length, 1); assert.deepEqual(s.ui.notifications, []);
});
test('openSyntaxMenu checks current after the first snapshot before acquiring a dialog', async () => {
  const s = setup(); const snapshot = s.owner.snapshot.bind(s.owner);
  s.owner.snapshot = () => { s.owner.alive = false; return snapshot(); };
  await s.open(); noWork(s.owner); assert.deepEqual(s.ui.dialogs, []); assert.deepEqual(s.ui.notifications, []);
});

function fullCatalogue(s: ReturnType<typeof setup>) {
  const profiles = [profile('pi', 'Pi palette'), ...Array.from({ length: 48 }, (_, i) => profile(`opaque:/${i}:α[]`, `${i < 2 ? 'Pi palette' : i === 2 ? 'Back' : 'Native'} ${'wide界🙂'.repeat(8)}`))];
  for (const item of profiles) {
    assert.ok(Buffer.byteLength(item.label) <= 128);
    assert.ok(Buffer.byteLength(item.id) <= 64);
  }
  s.owner.state.provider.description!.profiles = profiles;
  return profiles;
}
test('openSyntaxMenu theme picker paints the first and every navigated choice within 80x24 for all 49 profiles', async () => {
  const s = setup(); const profiles = fullCatalogue(s);
  const job = s.open(); await answer(s, 0, 'Theme');
  const picker = s.ui.dialogs[1].component;
  let maximumRows = 0;
  for (let i = 0; i < 50; i++) {
    const rows = picker.render(80);
    maximumRows = Math.max(maximumRows, rows.length);
    assert.ok(rows.length <= 24, `choice ${i}: ${rows.length} rows exceed terminal`);
    assert.ok(rows.every(row => visibleWidth(row) <= 80), `choice ${i}: overlong row`);
    assert.equal(rows.map(stripTerminalSequences).filter(row => row.startsWith('→ ')).length, 1);
    const selected = rows.map(stripTerminalSequences).find(row => row.startsWith('→ '))!;
    assert.ok(selected.startsWith(i === 49 ? '→ Back' : `→ ${i + 1}. `), `invisible/wrong selected row ${i}: ${selected}`);
    picker.handleInput?.('\x1b[B');
  }
  assert.equal(s.ui.dialogs[1].custom, true);
  assert.equal(s.ui.dialogs[1].options.length, profiles.length + 1);
  console.log(JSON.stringify({ viewport: '80x24', profiles: profiles.length, choices: 50, paintedSelections: 50, maximumRows }));
  picker.handleInput?.('\x1b'); await turn(); await close(s, job); noWork(s.owner);
});

function painted(s: ReturnType<typeof setup>, picker: DialogComponent, index: number) {
  const { columns, rows: height } = s.ui.terminal;
  const rows = picker.render(columns);
  assert.ok(rows.length <= height, `${columns}x${height}: ${rows.length} rows`);
  assert.ok(rows.every(row => visibleWidth(row) <= columns), 'width must be truncated, not wrapped');
  const selected = rows.map(stripTerminalSequences).filter(row => row.startsWith('→'));
  assert.equal(selected.length, 1, 'exactly one selected row is painted');
  assert.ok(selected[0].startsWith(index === 49 ? '→ Back' : `→ ${index + 1}. `), `wrong/invisible row ${index}: ${selected[0]}`);
  return rows.map(stripTerminalSequences);
}
for (const [columns, height] of [[24, 24], [24, 5], [24, 2], [24, 1], [80, 1]]) test(`openSyntaxMenu scrolling paints every choice at ${columns}x${height}`, async () => {
  const s = setup(); fullCatalogue(s);
  const job = s.open(); await answer(s, 0, 'Theme');
  const picker = s.ui.dialogs[1].component;
  s.ui.terminal.columns = columns; s.ui.terminal.rows = height;
  picker.invalidate();
  let maximumRows = 0;
  for (let i = 0; i < 50; i++) { maximumRows = Math.max(maximumRows, painted(s, picker, i).length); picker.handleInput?.('\x1b[B'); }
  console.log(JSON.stringify({ viewport: `${columns}x${height}`, choices: 50, paintedSelections: 50, maximumRows }));
  picker.handleInput?.('\x1b'); await turn(); await close(s, job); noWork(s.owner);
});
test('openSyntaxMenu every full-catalogue entry returns its exact opaque ID through actual Enter input', async () => {
  const s = setup(); const profiles = fullCatalogue(s); const job = s.open();
  for (let i = 0; i < profiles.length; i++) {
    await answer(s, s.ui.dialogs.length - 1, 'Theme');
    const picker = s.ui.dialogs[s.ui.dialogs.length - 1].component;
    for (let step = 0; step < i; step++) picker.handleInput?.('\x1b[B');
    painted(s, picker, i); picker.handleInput?.('\r'); await turn();
    assert.deepEqual(s.owner.choices[i], i === 0 ? { kind: 'pi' } : { kind: 'occipital', id: profiles[i].id });
    assert.equal(s.owner.counts.writes, i + 1);
  }
  await close(s, job); assert.equal(s.owner.counts.selections, 49);
  console.log(JSON.stringify({ exactThemeSelections: 49, writes: s.owner.counts.writes, starts: s.owner.counts.starts, describes: s.owner.counts.describes, refreshes: s.owner.counts.refreshes }));
  assert.equal(s.owner.counts.refreshes, 0); assert.equal(s.owner.counts.starts, 0); assert.equal(s.owner.counts.describes, 0);
});
test('openSyntaxMenu resize reconstruction retains selected identity before render and during navigation', async () => {
  const s = setup(); const profiles = fullCatalogue(s); const job = s.open(); await answer(s, 0, 'Theme');
  const picker = s.ui.dialogs[1].component;
  for (let i = 0; i < 20; i++) picker.handleInput?.('\x1b[B');
  painted(s, picker, 20);
  for (const [columns, rows] of [[24, 1], [24, 2], [80, 24], [24, 5], [80, 2]]) {
    s.ui.terminal.columns = columns; s.ui.terminal.rows = rows; picker.invalidate(); painted(s, picker, 20);
  }
  s.ui.terminal.rows = 1;
  // Input may arrive after resize, before the next render.
  picker.handleInput?.('\x1b[B'); painted(s, picker, 21);
  s.ui.terminal.rows = 24; s.ui.terminal.columns = 80;
  picker.handleInput?.('\r'); await turn(); await close(s, job);
  assert.deepEqual(s.owner.choices, [{ kind: 'occipital', id: profiles[21].id }]);
});
test('openSyntaxMenu public overlay geometry occupies only the available viewport and preserves normal headers', async () => {
  const s = setup(), job = s.open(); await answer(s, 0, 'Theme');
  assert.deepEqual(s.ui.customOptions, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, anchor: 'top-left' } });
  const rows = s.ui.dialogs[1].component.render(80).map(stripTerminalSequences);
  assert.match(rows.join('\n'), /Selected:.*missing:\/saved/); assert.match(rows.join('\n'), /Effective: Pi palette/);
  s.ui.dialogs[1].component.handleInput?.('\x1b'); await turn(); await close(s, job); noWork(s.owner);
});
for (const key of ['\x1b', '\x03']) test(`openSyntaxMenu real custom cancellation ${JSON.stringify(key)} completes once and ignores input after disposal`, async () => {
  const s = setup(); fullCatalogue(s); const job = s.open(); await answer(s, 0, 'Theme');
  const dialog = s.ui.dialogs[1]; dialog.component.handleInput?.(key); await turn();
  const requests = s.ui.renderRequests;
  dialog.component.handleInput?.('\r'); dialog.component.handleInput?.('\x1b[B'); dialog.component.invalidate(); dialog.component.dispose?.();
  assert.deepEqual(dialog.component.render(80), []); assert.equal(dialog.completions, 1); assert.equal(s.ui.renderRequests, requests);
  await close(s, job); noWork(s.owner);
});
test('openSyntaxMenu full-catalogue Back wraps into view and cancels without writes', async () => {
  const s = setup(); fullCatalogue(s); const job = s.open(); await answer(s, 0, 'Theme');
  const picker = s.ui.dialogs[1].component; picker.handleInput?.('\x1b[A'); painted(s, picker, 49);
  picker.handleInput?.('\r'); await turn(); await close(s, job); noWork(s.owner);
});
test('openSyntaxMenu owner retirement before a delayed custom factory closes without mounting/listing/delegation', async () => {
  const s = setup(); s.ui.factoryGate = deferred<void>();
  const job = s.open(); await answer(s, 0, 'Theme');
  assert.equal(s.ui.dialogs.length, 1); s.owner.alive = false;
  s.ui.factoryGate.resolve(); await job;
  assert.equal(s.ui.dialogs.length, 2); assert.deepEqual(s.ui.dialogs[1].component.render(80), []);
  assert.equal(s.ui.dialogs[1].completions, 1); noWork(s.owner); assert.deepEqual(s.ui.notifications, []);
});
