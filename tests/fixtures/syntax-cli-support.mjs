// Shared syntax-CLI preparation/assertions. Importing this module registers no tests.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from './terminal-harness.mjs';
import { closeTerminals } from './terminal-cleanup.mjs';
import { createSyntaxStockReferences } from './syntax-stock-reference.mjs';
import { readPendingJson, nativeReady, themePhaseReady, semanticStyle, semanticPhaseReady } from './syntax-observation.mjs';
import { PI_RULE_BINDINGS } from '../../src/syntax/pi-rules.ts';
import { childEnv, readInputs, validateNative } from '../../scripts/test/context.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after } from 'node:test';
import { stageExtensionPackage } from '../../scripts/release/extension-release.mjs';

const inputs = readInputs();
function requiredSharedHost() {
  if (!inputs.sharedHost?.path) throw new Error('Shared syntax terminal profile requires a prepared shared host');
  return inputs.sharedHost.path;
}
async function prepareSyntaxPackage() {
  let fixture = resolve('tests/fixtures/syntax-driver.ts'), loggingFixture = resolve('tests/fixtures/logging-driver.ts');
  await mkdir(resolve('.test-artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-artifacts/syntax-package-')), source = join(directory, 'extension');
  after(() => rm(directory, { recursive: true, force: true }));
  // A real-version copy exercises published bootstrap without weakening source 0.0.0's local-only rule.
  const release = JSON.parse(await readFile(resolve('tests/fixtures/occipital-release-0.1.4.json'), 'utf8'));
  await stageExtensionPackage({ root: resolve('.'), output: source, version: '0.0.0-cli', release });
  await mkdir(join(source, 'tests/fixtures'), { recursive: true });
  fixture = join(source, 'tests/fixtures/syntax-driver.ts');
  await cp(resolve('tests/fixtures/syntax-driver.ts'), fixture);
  await cp(resolve('tests/fixtures/syntax-local-work.ts'), join(source, 'tests/fixtures/syntax-local-work.ts'));
  loggingFixture = join(source, 'tests/fixtures/logging-driver.ts');
  for (const name of ['logging-driver.ts', 'presentation-driver.ts', 'terminal-output.ts']) await cp(resolve('tests/fixtures', name), join(source, 'tests/fixtures', name));
  return { fixture, loggingFixture };
}
async function prepareSyntaxNative() {
  const binary = validateNative(inputs).path;
  const { fixture, loggingFixture } = await prepareSyntaxPackage();
  const helperVersion = binary ? execFileSync(resolve(binary), ['--version'], { encoding: 'utf8', timeout: 30000, env: childEnv(resolve('.test-artifacts/syntax-version')) }).trim().match(/^occipital (\S+)$/)?.[1] : undefined;
  if (!helperVersion) throw new Error('Unexpected local artifact version output');
  assert.equal(helperVersion, inputs.native.version, 'actual helper matches the prepared native identity');
  const descriptor = binary ? { TIDY_UI_TEST_OCCIPITAL_BIN: resolve(binary), TIDY_UI_TEST_OCCIPITAL_VERSION: helperVersion,
    TIDY_UI_TEST_OCCIPITAL_SHA: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    TIDY_UI_TEST_OCCIPITAL_BYTES: String(statSync(binary).size), TIDY_UI_TEST_SYNTAX_CARDS: '1' } : undefined;

  return { binary, fixture, loggingFixture, descriptor };
}

const pause = ms => new Promise(done => setTimeout(done, ms));

async function until(check, label) {
  for (let end = Date.now() + 12000; Date.now() < end;) { const result = await check(); if (result) return result; await pause(30); }
  throw new Error('Timed out: ' + label);
}

async function stats(terminal, name) {
  terminal.send(`/tidy-ui-syntax-stats ${name}\r`);
  return until(() => {
    terminal.health();
    return readPendingJson(`${terminal.output}/syntax-stats-${name}.json`);
  }, 'actual syntax counters ' + name);
}

async function previewStats(terminal, name) {
  writeFileSync(join(terminal.output, 'syntax-preview-request'), name); terminal.send('\x1b\x10');
  return until(() => { terminal.health(); return readPendingJson(join(terminal.output, `syntax-preview-${name}.json`)); }, `draft-safe syntax counters ${name}`);
}

const work = snapshot => { const s = snapshot.source; return s && { dispatches: s.dispatches,
  sourceRequests: snapshot.counts.sourceRequests, styleRequests: snapshot.counts.styleRequests, closeRequests: snapshot.counts.closeRequests,
  localWork: snapshot.localWork,
  committedLineCalls: s.committedLineCalls, committedLineBytes: s.committedLineBytes, tailCalls: s.tailCalls, preparedBytes: s.preparedBytes }; };

function sourceColors(dump) {
  const rgb = role => { const match = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(match); return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]); };
  const y = dump.screen.findIndex(row => row.includes('const x=2;')); assert.ok(y >= 0);
  const x = dump.screen[y].indexOf('const x=2;');
  assert.equal(dump.cells[y][x].fg, rgb('syntaxKeyword')); assert.equal(dump.cells[y][x + 8].fg, rgb('syntaxNumber'));
}

const body = dump => dump.tools.map(({ name, lines }) => ({ name, lines: lines.map(stripVTControlCharacters)
  .map(row => row.replace(/Took \d+(?:\.\d+)?s/g, 'Took <runtime>s')) }));

const traffic = terminal => terminal.events().filter(e => ['call', 'result', 'model_context'].includes(e.type));

const persisted = dump => dump.branch.filter(e => e.type === 'message').flatMap(({ message }) => {
  if (message.role === 'toolResult') return [{ role: message.role, toolName: message.toolName, content: message.content,
    details: message.details, isError: message.isError }];
  if (message.role === 'assistant') return message.content.filter(c => c.type === 'toolCall')
    .map(({ name, arguments: args }) => ({ name, arguments: args }));
  return [];
});

async function finish(terminal) {
  await terminal.close();
  const snapshot = JSON.parse(readFileSync(`${terminal.output}/syntax-shutdown.json`, 'utf8'));
  for (const transport of snapshot.transports) {
    assert.equal(transport.childState, 'exited'); assert.equal(transport.retainedBytes, 0); assert.equal(transport.liveTimers, 0);
    assert.throws(() => process.kill(transport.pid, 0), { code: 'ESRCH' });
  }
  assert.equal(snapshot.source?.globalUnsettledJobs ?? 0, 0);
}

async function settledStats(terminal, name, condition) {
  let observation = 0;
  return until(async () => {
    const current = await stats(terminal, `${name}-${observation++}`);
    return condition(current) ? current : false;
  }, name);
}

async function syntaxReady(terminal) {
  const ready = await settledStats(terminal, 'startup', nativeReady);
  assert.equal(ready.node, inputs.node.version);
  assert.equal(ready.counts.describeReplies, 1); assert.equal(ready.counts.downloads, 0);
  return ready;
}

async function scenario(terminal, native, awaitClassification = true) {
  await terminal.ready();
  if (native) await syntaxReady(terminal);
  terminal.send('run syntax-cards\r');
  const prefixes = [];
  for (let phase = 0; phase < 5; phase++) {
    await terminal.event('syntax_prefix', phase + 1);
    const offered = terminal.events().find(e => e.type === 'syntax_prefix' && e.phase === phase);
    const display = await terminal.capture(`syntax-prefix-${phase}`);
    assert.equal(display.tools.find(t => t.name === 'bash').argsComplete, false);
    if (native) {
      const snapshot = await stats(terminal, `prefix-${phase}`); assert.equal(snapshot.source.globalUnsettledJobs, 0);
      assert.equal(snapshot.counts.piBridges, 0);
      assert.equal(snapshot.source.preparedBytes, offered.bytes + (phase === 4 ? prefixes[3].preparedBytes : 0),
        'wire source bytes are append-only except the explicitly counted nonappend resynchronization');
      prefixes.push(work(snapshot));
    }
    writeFileSync(`${terminal.output}/syntax-prefix-go-${phase}`, 'go');
  }
  if (native) {
    assert.equal(prefixes[1].committedLineCalls, 1); assert.equal(prefixes[2].committedLineCalls, prefixes[1].committedLineCalls);
    assert.equal(prefixes[2].committedLineBytes, prefixes[1].committedLineBytes, 'one-byte append reparses no completed prefix');
    assert.equal(prefixes[3].committedLineCalls, 2, 'append commits only the new completed line');
    assert.equal(prefixes[4].committedLineCalls, 4, 'named nonappend correction performs one source resynchronization');
    console.log(JSON.stringify({ gradual: terminal.output, prefixes }));
  }
  await terminal.event('provider_gate');
  const pending = await terminal.capture('syntax-pending');
  const bash = pending.tools.find(t => t.name === 'bash'); assert.ok(bash); assert.equal(bash.argsComplete, false); assert.equal(bash.executionStarted, false);
  if (native) { const s = await stats(terminal, 'pending'); assert.equal(s.counts.piBridges, 0); assert.ok(s.source.dispatches >= 1); }
  writeFileSync(`${terminal.output}/provider-go`, 'go');
  await until(() => existsSync(`${terminal.output}/syntax-shell-ready`), 'real Bash is running');
  const running = await terminal.capture('syntax-running');
  const active = running.tools.find(t => t.name === 'bash'); assert.equal(active.argsComplete, true); assert.equal(active.executionStarted, true);
  if (native) { const s = await stats(terminal, 'running'); assert.equal(s.source.globalUnsettledJobs, 0); assert.equal(s.counts.piBridges, 0); }
  writeFileSync(`${terminal.output}/syntax-shell-final`, 'go'); await terminal.event('agent_end'); await terminal.settle();
  const calls = terminal.events().filter(e => e.type === 'call'), results = terminal.events().filter(e => e.type === 'result');
  assert.deepEqual(calls.map(e => e.name), ['bash', 'write', 'edit']); assert.equal(results.length, 3);
  assert.equal(terminal.events().filter(e => e.type === 'model_context').length, 4);
  if (native && awaitClassification) await settledStats(terminal, 'final-settled', nativeReady);
  return terminal.capture('syntax-final');
}

const stockReference = createSyntaxStockReferences(async mode => {
  const terminal = new PiTerminal(`syntax-stock-reference-${mode}`, { mode, tidyUi: false,
    extraEnv: { TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
  try {
    const shown = await scenario(terminal, false);
    const evidence = { traffic: traffic(terminal), persisted: persisted(shown), output: terminal.output };
    await terminal.close();
    console.log(JSON.stringify({ stockReference: terminal.output, mode }));
    return evidence;
  } finally { await closeTerminals([terminal]); }
});

let menuSequence = 0;

async function menuAction(terminal, action) {
  await terminal.openTidyMenu();
  if (action === 'status') { await terminal.selectTidyItem('Status & troubleshooting'); await terminal.selectTidyItem('Highlighting service details'); }
  else if (action === 'refresh') { await terminal.selectTidyItem('Code color theme'); await terminal.selectTidyItem('Refresh theme list'); }
  else throw Error('Unknown test menu action');
}

async function chooseTheme(terminal, index) {
  const snapshot = await stats(terminal, `theme-choice-${++menuSequence}`);
  const profiles = snapshot.client.provider.description.profiles.filter(profile => profile.id !== 'pi');
  const label = index === 0 ? 'Follow Pi theme' : profiles[index - 1].label;
  await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
  assert.ok(terminal.tidyRows().some(row => row.includes('Search:')), 'public searchable theme picker installed');
  // One complete search avoids exercising every intervening preview in controls
  // whose counters are specifically about a single selected profile change.
  terminal.send(label);
  await terminal.waitForScreen(() => terminal.tidyRows().some(row => row.startsWith('→ ') && row.includes(label)), 'searched theme selected');
  await terminal.selectTidyItem(label); await terminal.closeTidyMenu();
}

async function peerSource(client) {
  const profile = client.snapshot().effective;
  assert.ok(profile);
  assert.equal(client.sources.observe({ key: 'peer', version: 1, text: 'echo peer\n', language: 'bash', complete: true,
    profile: profile.id, fingerprint: profile.fingerprint }), true);
  await client.sources.flush();
  await until(() => client.sources.status('peer')?.exact, 'actual peer classification');
}

async function keywordColor(terminal, color, name) {
  let observation = 0;
  return until(async () => {
    const dump = await terminal.capture(`${name}-${observation++}`);
    const y = dump.screen.findIndex(row => row.includes('const x=2;'));
    const x = y < 0 ? -1 : dump.screen[y].indexOf('const x=2;');
    return x >= 0 && dump.cells[y][x].fg === color ? dump : false;
  }, 'actual source foreground ' + color.toString(16));
}

async function loggingFrame(terminal) {
  const count = terminal.events().filter(event => event.type === 'logging_frame').length;
  terminal.send('\x1b\x0c');
  await terminal.event('logging_frame', count + 1);
  const status = terminal.events().filter(event => event.type === 'logging_frame').at(-1).logging;
  assert.ok(status); assert.equal(status.state, 'active'); return status;
}

async function loggingIdle(terminal) {
  await terminal.tidyPage(['Status & troubleshooting', 'Diagnostic logs', 'Write state snapshot']);
  return until(async () => {
    const status = await loggingFrame(terminal);
    return status.pendingBytes === 0 && status.inFlightBytes === 0 && !status.timer ? status : false;
  }, 'actual active journal drained');
}

const loggerWork = status => ({ records: status.records, writes: status.writes, rotations: status.rotations, scans: status.scans, writeErrors: status.writeErrors });

function loggingPrivacy(text, events) {
  for (const event of events.filter(event => event.type === 'call')) {
    for (const value of [event.input.command, event.input.content, ...(event.input.edits ?? []).flatMap(edit => [edit.oldText, edit.newText])]) {
      if (typeof value === 'string' && value.length >= 8) {
        assert.equal(text.includes(value), false, 'journal contains no full command/source');
        assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false, 'journal contains no escaped full command/source');
      }
    }
  }
}

const themeMarkers = ['THEME_BASH_0', 'THEME_BASH_1', 'const THEME_OLD', 'const THEME_NEW', 'const THEME_WRITE'];

async function initialThemeStats(terminal, name) {
  let observation = 0;
  return until(() => themePhaseReady(() => stats(terminal, `${name}-${observation++}`), () => {
    terminal.health(); return terminal.events();
  }, 'initial', themeMarkers.filter(marker => marker.startsWith('THEME_BASH_'))), 'initial native scene sources');
}

async function retainedNativeThemeStats(terminal, name, observe) {
  const initial = await stats(terminal, `${name}-before`);
  const profile = initial.client.provider.description.profiles.find(profile => profile.label === 'Catppuccin Mocha'); assert.ok(profile);
  // Restored FILEs can initially own only Pi ANSI. Preview once to establish
  // their FIRST native semantics before asserting no SOURCE on later themes.
  writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'native-prerequisite');
  await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme'); terminal.send(profile.label);
  let observation = 0;
  const ready = id => until(() => semanticPhaseReady(() => observe(`${name}-${observation++}`), () => terminal.events(), themeMarkers, id), 'retained native semantics for every theme marker');
  await ready(profile.id);
  terminal.send('\x1b'); await until(() => terminal.tidyHeading('Tidy UI'), 'prerequisite preview cancelled'); await terminal.closeTidyMenu();
  writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'initial');
  const baseline = await ready('pi');
  assert.equal(baseline.counts.themeSaves, 0, 'prerequisite preview never persists settings');
  return baseline;
}

function themeForegrounds(dump) {
  return themeMarkers.map(marker => {
    const y = dump.screen.findIndex(row => row.includes(marker)); assert.ok(y >= 0, `physically visible ${marker}`);
    return dump.cells[y][dump.screen[y].indexOf(marker)].fg;
  });
}

function expressionForeground(expression, dump, inherited = 'toolOutput') {
  const ink = expression.foreground;
  if (ink.kind === 'rgb') return ink.r * 65536 + ink.g * 256 + ink.b;
  const role = ink.kind === 'binding' ? PI_RULE_BINDINGS[ink.slot] : inherited;
  assert.ok(ink.kind === 'binding' || ink.kind === 'inherit', `explicit expected foreground ${ink.kind}`);
  const rgb = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(rgb, `actual Pi role ${role}`);
  return Number(rgb[1]) * 65536 + Number(rgb[2]) * 256 + Number(rgb[3]);
}
function expectedThemeColors(terminal, phase, dump, profileId) {
  assert.ok(profileId, 'explicit v3 profile identity is required');
  return themeMarkers.map(marker => {
    const style = semanticStyle(terminal.events(), marker, profileId); assert.ok(style, `actual v3 source/style for ${phase} ${marker}`);
    return expressionForeground(style.expression, dump, marker.startsWith('THEME_BASH') ? 'toolTitle' : 'toolOutput');
  });
}

async function savedThemeSession() {
    const directory = await mkdtemp(resolve('.test-artifacts/theme-session-'));
    const manager = SessionManager.create(directory, join(directory, 'sessions'));
    manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const cards = [
      { name: 'bash', arguments: { command: "printf 'THEME_BASH_0\\n'" }, details: { exit_code: 0 } },
      { name: 'bash', arguments: { command: "printf 'THEME_BASH_1\\n'" }, details: { exit_code: 0 } },
      { name: 'edit', arguments: { path: 'theme-edit.ts', oldText: 'const THEME_OLD=1;', newText: 'const THEME_NEW=2;' }, details: { diff: '-1 const THEME_OLD=1;\n+1 const THEME_NEW=2;' } },
      { name: 'write', arguments: { path: 'theme-write.ts', content: 'const THEME_WRITE=3;' }, details: {} },
    ];
    for (const [i, card] of cards.entries()) {
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `saved theme card ${i}` }], timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `theme-${i}`, name: card.name, arguments: card.arguments }],
        api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: 'toolUse', timestamp: Date.now() });
      manager.appendMessage({ role: 'toolResult', toolCallId: `theme-${i}`, toolName: card.name, content: [{ type: 'text', text: `saved result ${i}` }],
        details: card.details, isError: false, timestamp: Date.now() });
    }
    const session = manager.getSessionFile();
    return { directory, cards, session, bytes: readFileSync(session) };
}

export { inputs, requiredSharedHost, prepareSyntaxPackage, prepareSyntaxNative, pause, until, stats, work, sourceColors, body, traffic, persisted, finish, settledStats, syntaxReady, scenario, stockReference, previewStats, menuSequence, menuAction, chooseTheme, peerSource, keywordColor, loggingFrame, loggingIdle, loggerWork, loggingPrivacy, themeMarkers, initialThemeStats, retainedNativeThemeStats, themeForegrounds, expectedThemeColors, expressionForeground, savedThemeSession };
