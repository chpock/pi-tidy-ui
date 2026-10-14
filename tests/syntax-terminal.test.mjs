// Physical CLI checks with small real built-in calls and a controlled local artifact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test, { after } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { stageExtensionPackage } from '../scripts/release/extension-release.mjs';
import { PiTerminal } from './terminal.test.mjs';
import { sharedSyntaxHost, themeDefinition, reaped } from './fixtures/shared-syntax-host.mjs';

const binary = process.env.OCCIPITAL_TEST_BIN;
let fixture = resolve('tests/fixtures/syntax-driver.ts'), loggingFixture = resolve('tests/fixtures/logging-driver.ts');
if (binary) {
  await mkdir(resolve('.test-artifacts'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-artifacts/syntax-package-')), source = join(directory, 'extension');
  after(() => rm(directory, { recursive: true, force: true }));
  // A real-version copy exercises published bootstrap without weakening source 0.0.0's local-only rule.
  const release = JSON.parse(await readFile(resolve('tests/fixtures/occipital-release-0.1.4.json'), 'utf8'));
  await stageExtensionPackage({ root: resolve('.'), output: source, version: '0.0.0-cli', release });
  await mkdir(join(source, 'tests/fixtures'), { recursive: true });
  fixture = join(source, 'tests/fixtures/syntax-driver.ts');
  await cp(resolve('tests/fixtures/syntax-driver.ts'), fixture);
  loggingFixture = join(source, 'tests/fixtures/logging-driver.ts');
  for (const name of ['logging-driver.ts', 'presentation-driver.ts']) await cp(resolve('tests/fixtures', name), join(source, 'tests/fixtures', name));
}
const helperVersion = binary ? execFileSync(resolve(binary), ['--version'], { encoding: 'utf8', timeout: 30000 }).trim().match(/^occipital (\S+)$/)?.[1] : undefined;
if (binary && !helperVersion) throw new Error('Unexpected local artifact version output');
const descriptor = binary ? { TIDY_UI_TEST_OCCIPITAL_BIN: resolve(binary), TIDY_UI_TEST_OCCIPITAL_VERSION: helperVersion,
  TIDY_UI_TEST_OCCIPITAL_SHA: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  TIDY_UI_TEST_OCCIPITAL_BYTES: String(statSync(binary).size), TIDY_UI_TEST_SYNTAX_CARDS: '1' } : undefined;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label) {
  for (let end = Date.now() + 12000; Date.now() < end;) { const result = await check(); if (result) return result; await pause(30); }
  throw new Error('Timed out: ' + label);
}
async function stats(terminal, name) {
  terminal.send(`/tidy-ui-syntax-stats ${name}\r`);
  return until(() => {
    terminal.health();
    try { return JSON.parse(readFileSync(`${terminal.output}/syntax-stats-${name}.json`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, 'actual syntax counters ' + name);
}
const work = snapshot => { const s = snapshot.source; return s && { dispatches: s.dispatches,
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
const nativeReady = snapshot => snapshot.client?.provider.availability === 'ready' && snapshot.client.effective
  && snapshot.source?.globalUnsettledJobs === 0;
async function syntaxReady(terminal) {
  const ready = await settledStats(terminal, 'startup', nativeReady);
  assert.equal(ready.node, process.env.PI_TEST_EXPECT_NODE ?? process.version);
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
    const display = await terminal.capture(`syntax-prefix-${phase}`, { animated: true });
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
  const pending = await terminal.capture('syntax-pending', { animated: true });
  const bash = pending.tools.find(t => t.name === 'bash'); assert.ok(bash); assert.equal(bash.argsComplete, false); assert.equal(bash.executionStarted, false);
  if (native) { const s = await stats(terminal, 'pending'); assert.equal(s.counts.piBridges, 0); assert.ok(s.source.dispatches >= 1); }
  writeFileSync(`${terminal.output}/provider-go`, 'go');
  await until(() => existsSync(`${terminal.output}/syntax-shell-ready`), 'real Bash is running');
  const running = await terminal.capture('syntax-running', { animated: true });
  const active = running.tools.find(t => t.name === 'bash'); assert.equal(active.argsComplete, true); assert.equal(active.executionStarted, true);
  if (native) { const s = await stats(terminal, 'running'); assert.equal(s.source.globalUnsettledJobs, 0); assert.equal(s.counts.piBridges, 0); }
  writeFileSync(`${terminal.output}/syntax-shell-final`, 'go'); await terminal.event('agent_end'); await terminal.settle();
  const calls = terminal.events().filter(e => e.type === 'call'), results = terminal.events().filter(e => e.type === 'result');
  assert.deepEqual(calls.map(e => e.name), ['bash', 'write', 'edit']); assert.equal(results.length, 3);
  assert.equal(terminal.events().filter(e => e.type === 'model_context').length, 4);
  if (native && awaitClassification) await settledStats(terminal, 'final-settled', nativeReady);
  return terminal.capture('syntax-final');
}
for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: actual ${mode} startup, args completion, warm/resize/off and exact traffic replay`,
  { skip: !binary, timeout: 120000 }, async () => {
    const terminals = [], create = (name, options) => { const t = new PiTerminal(`syntax-${mode}-${name}`, { mode, ...options }); terminals.push(t); return t; };
    try {
      const native = create('native', { tidyUi: false, extraEnv: descriptor, extensions: [fixture] });
      const shown = await scenario(native, true), nativeTraffic = traffic(native), nativeData = persisted(shown), baseline = await stats(native, 'warm-before');
      sourceColors(shown);
      assert.equal(baseline.counts.acquisitions, 1); assert.equal(baseline.counts.piBridges, 0); assert.equal(baseline.source.globalUnsettledJobs, 0);
      assert.ok(baseline.source.dispatches >= 4); assert.match(body(shown).map(t => t.lines.join('\n')).join('\n'), /const x=2;/);
      for (const width of [60, 100]) { await native.resize(width); await native.capture(`syntax-width-${width}`); }
      const warmed = await stats(native, 'warm-after'); assert.deepEqual(work(warmed), work(baseline)); assert.equal(warmed.counts.piBridges, 0);
      assert.deepEqual(body(await native.capture('syntax-back-wide')), body(shown));
      await native.openTidyMenu(); await native.selectTidyItem('Code color theme'); await native.closeTidyMenu();
      const menu = await stats(native, 'menu-cancel'); assert.deepEqual(work(menu), work(baseline)); assert.equal(menu.counts.acquisitions, 1);
      const pid = baseline.transports[0].pid;
      await native.openTidyMenu(); await native.selectTidyItem('Status & troubleshooting');
      await native.selectTidyItem('Use Occipital highlighting'); native.captureScreen('syntax-menu-off', {});
      assert.ok(native.tidyRows().some(row => /Use Occipital highlighting\s+Off/u.test(row)), 'same real overlay survives native disable: ' + native.output);
      await native.closeTidyMenu();
      const disabled = await stats(native, 'native-off'); assert.ok(disabled.transports.every(t => t.childState === 'exited'));
      await native.appearance(false); const off = await stats(native, 'master-off');
      assert.ok(off.transports.every(t => t.childState === 'exited' && t.retainedBytes === 0 && t.liveTimers === 0));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await native.appearance(true); const reenabled = await native.capture('syntax-reenabled');
      assert.deepEqual(body(reenabled), body(shown));
      const afterOn = await stats(native, 'master-on'); assert.equal(afterOn.counts.acquisitions, 1, 'session-native-off survives full adapter reinstall');
      assert.ok(afterOn.source.piSourceRecords > 0, 'post-reinstall diagnostics describe the current fallback owner, not the disposed native controller');
      assert.ok(afterOn.controller > baseline.controller, 'a genuinely new attached owner is measured');
      assert.equal(afterOn.client.enabled, false);
      const session = shown.session, workspace = native.work; await finish(native);
      const replay = create('replay', { session, workspace, extraEnv: descriptor, extensions: [fixture] });
      await replay.ready(); await settledStats(replay, 'replay-settled', s => nativeReady(s) && s.source.dispatches > 0);
      const replayed = await replay.capture('syntax-replay');
      assert.deepEqual(persisted(replayed), nativeData); assert.deepEqual(body(replayed), body(shown));
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      const replayStats = await stats(replay, 'replay'); assert.equal(replayStats.source.globalUnsettledJobs, 0);
      assert.ok(replayStats.source.dispatches > 0, 'native source work accepted after asynchronous replay startup');
      // Completed replay files may use exact Pi fallback before the helper is ready.
      await replay.capture('syntax-replay-warm'); const replayWarm = await stats(replay, 'replay-warm');
      assert.deepEqual(work(replayWarm), work(replayStats)); assert.equal(replayWarm.counts.piBridges, replayStats.counts.piBridges);
      console.log(JSON.stringify({ mode, native: native.output, replay: replay.output, nativeWork: work(baseline), replayWork: work(replayStats),
        coldReplayPiBridges: replayStats.counts.piBridges, warmNativeDelta: 0, warmReplayDelta: 0 }));
      await finish(replay);
      const control = create('control', { extraEnv: { TIDY_UI_TEST_SYNTAX_CARDS: '1' } }); const plain = await scenario(control, false);
      assert.deepEqual(traffic(control), nativeTraffic); assert.deepEqual(persisted(plain), nativeData); await control.close();
    } finally { for (const terminal of terminals) { await terminal.close(); terminal.dispose(); } }
  });

test('occipital CLI: real theme picker, explicit RGB, persisted selection and fresh default enablement',
  { skip: !binary, timeout: 90000 }, async () => {
    const native = new PiTerminal('syntax-theme-native', { mode: 'fullscreen', extraEnv: descriptor, extensions: [fixture] });
    let replay;
    try {
      const initial = await scenario(native, true);
      await chooseTheme(native, 1);
      const prefs = readFileSync(`${native.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'), saved = JSON.parse(prefs);
      assert.deepEqual(Object.keys(saved), ['syntaxTheme']); assert.equal(saved.syntaxTheme.kind, 'occipital'); assert.equal(typeof saved.syntaxTheme.id, 'string');
      await settledStats(native, 'theme-settled', s => nativeReady(s) && s.client.effective.id === saved.syntaxTheme.id);
      const themed = await native.capture('syntax-explicit-theme'); assert.deepEqual(body(themed), body(initial));
      const y = themed.screen.findIndex(row => row.includes('const x=2;')), x = themed.screen[y].indexOf('const x=2;');
      assert.notEqual(themed.cells[y][x].fg, initial.cells[initial.screen.findIndex(row => row.includes('const x=2;'))][x].fg,
        'explicit daemon theme RGB reaches physical source cells, not Pi keyword color');
      const before = await stats(native, 'theme-before'); await native.capture('syntax-theme-warm');
      const after = await stats(native, 'theme-after'); assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, before.counts.piBridges);
      const session = initial.session, workspace = native.work; await finish(native);
      replay = new PiTerminal('syntax-theme-restored', { mode: 'fullscreen', session, workspace, extensions: [fixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_CONFIG: prefs } });
      await replay.ready(); await settledStats(replay, 'theme-restored-settled', s => nativeReady(s)
        && s.source.dispatches > 0 && s.client.effective.id === saved.syntaxTheme.id);
      const restored = await replay.capture('syntax-theme-restored');
      assert.deepEqual(body(restored), body(themed)); assert.deepEqual(persisted(restored), persisted(initial));
      const ry = restored.screen.findIndex(row => row.includes('const x=2;')), rx = restored.screen[ry].indexOf('const x=2;');
      assert.equal(restored.cells[ry][rx].fg, themed.cells[y][x].fg, 'fresh client restores saved explicit theme');
      const restoredStats = await stats(replay, 'theme-restored'); assert.equal(restoredStats.counts.acquisitions, 1); assert.equal(restoredStats.counts.downloads, 0);
      assert.equal(replay.events().filter(e => ['call', 'result', 'model_context'].includes(e.type)).length, 0);
      await finish(replay);
      console.log(JSON.stringify({ theme: saved.syntaxTheme, actual: native.output, restored: replay.output, warmDelta: 0 }));
    } finally { await native.close(); await replay?.close(); replay?.dispose(); native.dispose(); }
  });


test('occipital CLI: provider readiness waits for the actual acquired/publication state, not terminal silence',
  { skip: !binary, timeout: 30000 }, async () => {
    const terminal = new PiTerminal('syntax-acquisition-gated', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE: '1' } });
    try {
      await terminal.ready(); await terminal.event('syntax_acquire_gate');
      const early = await stats(terminal, 'gated-early'); assert.equal(early.counts.describeReplies, 0);
      const waiting = syntaxReady(terminal).then(() => undefined, error => error);
      await until(() => existsSync(`${terminal.output}/syntax-stats-startup-0.json`), 'fresh early provider observation');
      writeFileSync(`${terminal.output}/syntax-acquire-go`, 'go');
      const failure = await waiting; if (failure) throw failure;
      await finish(terminal);
    } finally { await terminal.close(); terminal.dispose(); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} input and tool progress with held real file replies and no duplicate Pi classification`,
  { skip: !binary, timeout: 120000 }, async () => {
    const terminal = new PiTerminal(`syntax-held-${mode}`, { mode, tidyUi: false, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_REPLY_GATE: '1' } });
    const stock = new PiTerminal(`syntax-held-${mode}-stock`, { mode, tidyUi: false,
      extraEnv: { TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
    let run;
    try {
      run = scenario(terminal, true, false).then(value => ({ value }), error => ({ error }));
      await terminal.event('syntax_reply_tool_gate'); await terminal.event('syntax_reply_held');
      const actualReply = terminal.events().find(e => e.type === 'syntax_reply_held');
      assert.equal(actualReply.payload.op, 'highlight'); assert.equal(actualReply.payload.sources.length, 1);
      assert.equal(actualReply.payload.sources[0].text, 'const x=1;\n');
      assert.equal(Buffer.byteLength(actualReply.payload.sources[0].text), 11);
      assert.equal(actualReply.reply.status, 'ok');
      const before = await stats(terminal, 'held-before');
      assert.equal(before.node, process.env.PI_TEST_EXPECT_NODE ?? process.version);
      assert.equal(before.pendingHeldReplies, 1); assert.equal(before.counts.heldReplies, 1);
      assert.equal(before.counts.deliveredReplies, 0); assert.equal(before.source.globalUnsettledJobs, 1);
      assert.equal(before.counts.piCaptures, 0); assert.equal(before.counts.piBridges, 0);
      assert.deepEqual(terminal.events().filter(e => e.type === 'result').map(e => e.name), ['bash', 'write']);
      terminal.send('HELD_REPLY_DRAFT');
      await until(() => terminal.screen().some(row => row.includes('HELD_REPLY_DRAFT')), 'physical editable input while the native reply is unsettled');
      terminal.captureScreen('held-input', {});
      terminal.send('\x15'); await terminal.settle(true);
      for (const width of [60, 100]) {
        await terminal.resize(width, 80, true);
        const resized = await terminal.capture(`held-before-width-${width}`, { animated: true });
        assert.equal(resized.editor.text, '');
      }
      const warm = await stats(terminal, 'held-warm');
      assert.deepEqual(work(warm), work(before)); assert.equal(warm.counts.piCaptures, 0); assert.equal(warm.counts.piBridges, 0);
      assert.equal(warm.pendingHeldReplies, 1); assert.equal(warm.counts.deliveredReplies, 0);
      writeFileSync(`${terminal.output}/syntax-reply-tool-go`, 'go');
      const result = await run; run = undefined;
      if (result.error) throw result.error;
      const held = result.value;
      const after = await stats(terminal, 'held-after-tool');
      assert.deepEqual(terminal.events().filter(e => e.type === 'call').map(e => e.name), ['bash', 'write', 'edit']);
      assert.deepEqual(terminal.events().filter(e => e.type === 'result').map(e => e.name), ['bash', 'write', 'edit']);
      assert.ok(after.pendingHeldReplies >= 1); assert.ok(after.source.globalUnsettledJobs >= 1);
      assert.equal(after.counts.deliveredReplies, 0); assert.equal(after.counts.piCaptures, 0); assert.equal(after.counts.piBridges, 0);
      assert.match(body(held).map(t => t.lines.join('\n')).join('\n'), /const x=2;/, 'full source is visible before delivery');
      for (const width of [60, 100]) { await terminal.resize(width); await terminal.capture(`held-after-width-${width}`); }
      const stillHeld = await stats(terminal, 'held-after-warm');
      assert.deepEqual(work(stillHeld), work(after)); assert.equal(stillHeld.counts.piCaptures, 0); assert.equal(stillHeld.counts.piBridges, 0);
      assert.equal(stillHeld.counts.deliveredReplies, 0);
      writeFileSync(`${terminal.output}/syntax-reply-go`, 'go');
      const done = await settledStats(terminal, 'delivered', nativeReady);
      assert.equal(done.pendingHeldReplies, 0); assert.equal(done.counts.deliveredReplies, done.counts.heldReplies);
      assert.equal(done.counts.piCaptures, 0); assert.equal(done.counts.piBridges, 0);
      const colored = await terminal.capture('delivered-colors'); sourceColors(colored);
      assert.deepEqual(colored.branch, held.branch, 'classification delivery changes no saved session data');
      const control = await scenario(stock, false);
      assert.deepEqual(traffic(terminal), traffic(stock)); assert.deepEqual(persisted(held), persisted(control));
      console.log(JSON.stringify({ heldReplies: terminal.output, stock: stock.output,
        observations: [before, after, done].map(snapshot => ({ node: snapshot.node, counts: snapshot.counts,
          pendingHeldReplies: snapshot.pendingHeldReplies, work: work(snapshot), unsettledJobs: snapshot.source.globalUnsettledJobs,
          pid: snapshot.transports[0].pid })) }));
      await finish(terminal);
    } finally {
      writeFileSync(`${terminal.output}/syntax-reply-tool-go`, 'go'); writeFileSync(`${terminal.output}/syntax-reply-go`, 'go');
      if (run) await run;
      await terminal.close(); await stock.close(); terminal.dispose(); stock.dispose();
    }
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
  assert.ok(terminal.tidyRows().some(row => row.includes('Follow Pi')), 'public searchable theme picker installed');
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

test('occipital CLI: shared discovery, public refresh/status/Pi menu, actual loss and owned-to-shared return preserve peer and traffic',
  { skip: !binary || !process.env.OCCIPITAL_TEST_SHARED_HOST, timeout: 120000 }, async () => {
    const host = await sharedSyntaxHost(process.env.OCCIPITAL_TEST_SHARED_HOST, binary);
    const terminal = new PiTerminal('syntax-shared-transitions', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } });
    let returnedPeer;
    try {
      const initial = await scenario(terminal, true), original = await stats(terminal, 'shared-initial');
      assert.equal(original.client.provider.kind, 'shared'); assert.equal(original.counts.acquisitions, 0);
      const oldPid = original.client.provider.description.runtime.pid;
      assert.equal(oldPid, host.initialPeer.snapshot().provider.description.runtime.pid);
      const initialTraffic = traffic(terminal), initialData = persisted(initial), initialBranch = initial.branch;
      await menuAction(terminal, 'status');
      assert.ok(terminal.screen().some(row => row.includes('Provider: shared')), 'public status reports the actual provider');
      await terminal.closeTidyMenu();
      const custom = original.client.provider.description.profiles.find(profile => profile.label === 'cli-shared'); assert.ok(custom);
      const index = original.client.provider.description.profiles.filter(profile => profile.id !== 'pi').findIndex(profile => profile.id === custom.id) + 1;
      await terminal.resize(42, 12);
      await chooseTheme(terminal, index);
      await terminal.resize(100, 80);
      await settledStats(terminal, 'shared-custom-ready', s => nativeReady(s) && s.client.effective.id === custom.id);
      await keywordColor(terminal, 0x223344, 'shared-custom');
      const selected = JSON.parse(readFileSync(`${terminal.agent}/extensions/pi-tidy-ui/config.json`, 'utf8'));
      assert.deepEqual(selected, { syntaxTheme: { kind: 'occipital', id: custom.id } });
      rmSync(host.themeFile);
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      const missing = await settledStats(terminal, 'shared-missing', s => nativeReady(s) && s.client.effective.id === 'pi');
      assert.equal(missing.client.selected.id, custom.id); assert.equal(missing.counts.refreshReplies, 1);
      const errors = terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error');
      assert.equal(errors.length, 1, 'one bounded UI issue for the unavailable selected theme');
      assert.deepEqual(JSON.parse(readFileSync(`${terminal.agent}/extensions/pi-tidy-ui/config.json`, 'utf8')), selected);
      sourceColors(await terminal.capture('shared-missing-pi'));
      const absentWarm = await stats(terminal, 'missing-before'); await terminal.capture('missing-warm');
      assert.deepEqual(work(await stats(terminal, 'missing-after')), work(absentWarm));
      assert.equal(terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error').length, 1);
      writeFileSync(host.themeFile, themeDefinition('#667788'));
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      await settledStats(terminal, 'shared-restored', s => nativeReady(s) && s.client.effective.id === custom.id);
      await keywordColor(terminal, 0x667788, 'shared-restored');
      rmSync(host.alias); process.kill(oldPid, 'SIGKILL');
      const owned = await settledStats(terminal, 'owned-after-loss', s => nativeReady(s) && s.client.provider.kind === 'owned');
      assert.equal(owned.broker.reconnectAttempts, 2); assert.equal(owned.counts.acquisitions, 1);
      assert.equal(owned.client.provider.initialShared, true); assert.equal(owned.broker.recoveryTimers, 1);
      assert.equal(owned.client.selected.id, custom.id); assert.equal(owned.client.effective.id, 'pi');
      const missingNotices = () => terminal.events().filter(event => event.type === 'syntax_notify' && event.level === 'error'
        && event.message === `Syntax theme ${JSON.stringify(custom.id)} is unavailable; using Pi palette temporarily.`);
      assert.equal(missingNotices().length, 2, 'restoration resets suppression for the next unavailable episode');
      await reaped(oldPid); await host.initialPeer.dispose();
      returnedPeer = await host.peer(); await peerSource(returnedPeer);
      const newPid = returnedPeer.snapshot().provider.description.runtime.pid, peerBefore = returnedPeer.sources.stats();
      assert.notEqual(newPid, oldPid); assert.notEqual(newPid, owned.transports[0].pid);
      writeFileSync(host.alias, readFileSync(host.connection), { mode: 0o600 });
      await terminal.command('/tidy-ui-syntax-clock 60000');
      const returned = await settledStats(terminal, 'shared-returned', s => nativeReady(s) && s.client.provider.kind === 'shared');
      assert.equal(returned.client.provider.description.runtime.pid, newPid);
      assert.equal(returned.broker.probesStarted, 1); assert.equal(returned.broker.handoffsSucceeded, 1);
      assert.equal(returned.broker.recoveryTimers, 0); assert.equal(returned.counts.acquisitions, 1);
      await reaped(owned.transports[0].pid); await keywordColor(terminal, 0x667788, 'shared-returned');
      await chooseTheme(terminal, 0);
      const pi = await settledStats(terminal, 'shared-pi-selected', s => nativeReady(s) && s.client.effective.id === 'pi');
      assert.equal(pi.client.selected.kind, 'pi'); sourceColors(await terminal.capture('shared-pi-selected'));
      const before = await stats(terminal, 'shared-warm-before');
      for (const width of [40, 100]) { await terminal.resize(width); await terminal.capture(`shared-width-${width}`); }
      const after = await stats(terminal, 'shared-warm-after'); assert.deepEqual(work(after), work(before));
      assert.equal((await returnedPeer.refreshThemes()).ok, true, 'live peer receives an actual control reply after handoff');
      await peerSource(returnedPeer); assert.equal(returnedPeer.sources.stats().dispatches, peerBefore.dispatches);
      assert.equal(missingNotices().length, 2, 'return and warm frames do not repeat an unavailable-theme issue');
      const final = await terminal.capture('shared-final');
      assert.deepEqual(traffic(terminal), initialTraffic); assert.deepEqual(persisted(final), initialData);
      assert.deepEqual(final.branch, initialBranch, 'UI status/errors never become model or session records');
      await finish(terminal); process.kill(newPid, 0);
      assert.equal((await returnedPeer.refreshThemes()).ok, true, 'live peer receives an actual control reply after Pi shutdown');
      await peerSource(returnedPeer); assert.equal(returnedPeer.sources.stats().dispatches, peerBefore.dispatches);
      console.log(JSON.stringify({ sharedCli: terminal.output, node: after.node, calls: 3, results: 3, contexts: 4,
        ownedStarts: 1, reconnectAttempts: returned.broker.reconnectAttempts, returnProbes: 1, handoffs: 1, peerWarmDelta: 0 }));
    } finally { await terminal.close(); terminal.dispose(); await host.close(); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} gradual argument abort preserves prefix, stock traffic and warm work`,
  { skip: !binary, timeout: 60000 }, async () => {
    const live = new PiTerminal(`syntax-abort-${mode}`, { mode, extensions: [fixture], extraEnv: descriptor });
    const stock = new PiTerminal(`syntax-abort-stock-${mode}`, { mode, tidyUi: false, extraEnv: descriptor });
    const fallback = new PiTerminal(`syntax-abort-fallback-${mode}`, { mode, tidyUi: true, extraEnv: descriptor });
    try {
      for (const terminal of [live, stock, fallback]) {
        await terminal.ready(); if (terminal === live) await syntaxReady(terminal);
        terminal.send('run syntax-cards\r');
        await terminal.event('syntax_prefix');
        await terminal.capture('abort-first-prefix', { animated: true });
        writeFileSync(`${terminal.output}/syntax-prefix-go-0`, 'go');
        await terminal.event('syntax_prefix', 2);
        const pending = await terminal.capture('abort-completed-line', { animated: true });
        assert.equal(pending.tools[0].argsComplete, false); assert.equal(pending.tools[0].executionStarted, false);
        if (terminal === live) {
          const s = await settledStats(terminal, 'abort-prefix-ready', nativeReady);
          assert.equal(s.source.committedLineCalls, 1); assert.equal(s.source.committedLineBytes, 25);
          assert.equal(s.counts.piBridges, 0);
        }
        terminal.send('\x1b'); await terminal.event('agent_end'); await terminal.settle();
        assert.equal(terminal.events().filter(e => e.type === 'provider_error').length, 1);
      }
      const aborted = await live.capture('aborted'), baseline = await stock.capture('aborted'), neutral = await fallback.capture('aborted');
      assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(traffic(fallback), traffic(stock));
      assert.equal(traffic(live).filter(e => e.type === 'call').length, 0);
      assert.equal(traffic(live).filter(e => e.type === 'result').length, 0);
      assert.equal(traffic(live).filter(e => e.type === 'model_context').length, 1);
      assert.deepEqual(persisted(aborted), persisted(baseline)); assert.deepEqual(persisted(neutral), persisted(baseline));
      // Wall-clock timestamp and Pi's recorded elapsed duration vary across independent runs.
      const assistant = dump => dump.branch.filter(e => e.type === 'message' && e.message.role === 'assistant')
        .map(({ message: { timestamp, durationMs, ...message } }) => message);
      const raw = dump => dump.tools.map(({ name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial }) =>
        ({ name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial }));
      assert.equal(assistant(aborted).length, 1); assert.equal(assistant(aborted)[0].stopReason, 'aborted');
      assert.deepEqual(assistant(aborted), assistant(baseline)); assert.deepEqual(assistant(neutral), assistant(baseline));
      assert.deepEqual(raw(aborted), raw(baseline)); assert.deepEqual(raw(neutral), raw(baseline));
      assert.equal(raw(aborted)[0].args.command, "printf 'SYNTAX_OUTPUT\\n'\n");
      assert.ok(body(neutral)[0].lines.some(row => /^ ┃/.test(row)), 'neutral control really installs the existing pi-tidy-ui card');
      assert.deepEqual(body(aborted), body(neutral), 'native syntax preserves the existing pi-tidy-ui frame and abort presentation');
      assert.ok(body(aborted)[0].lines.some(row => row.includes("printf 'SYNTAX_OUTPUT\\n'")));
      assert.ok(body(aborted)[0].lines.some(row => row.includes('[error: incomplete tool call]')));
       const before = await stats(live, 'abort-warm-before');
      assert.equal(before.source.sourceRecords, 1, 'terminal argument abort retains one display-only source record');
       assert.ok(before.source.retention.retainedBytes > 0, 'retained colors remain budgeted until owner removal/off');
      assert.equal(before.source.remoteLeases, 0); assert.equal(before.source.pendingCloses, 0);
      assert.equal(before.source.dispatches, 3, 'two native prefix requests plus one best-effort close');
      for (const width of [40, 100]) { await live.resize(width); await live.capture(`abort-width-${width}`); }
      const after = await stats(live, 'abort-warm-after');
      assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, 0);
      assert.equal(after.source.globalUnsettledJobs, 0);
      await finish(live);
      console.log(JSON.stringify({ abortCli: live.output, node: after.node, mode, bytes: 25, calls: 0, results: 0, contexts: 1,
        committedLineCalls: after.source.committedLineCalls, warmDelta: 0 }));
    } finally { for (const terminal of [live, stock, fallback]) { await terminal.close(); terminal.dispose(); } }
  });


test('occipital CLI: structured RGB and font attributes preserve both file diff sides, frames and warm work',
  { skip: !binary || !process.env.OCCIPITAL_TEST_SHARED_HOST, timeout: 120000 }, async () => {
    const host = await sharedSyntaxHost(process.env.OCCIPITAL_TEST_SHARED_HOST, binary);
    const terminal = new PiTerminal('syntax-physical-styles', { mode: 'fullscreen', extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } });
    const vectors = dump => {
      const found = [];
      for (const [y, row] of dump.screen.entries()) {
        const matches = [...row.matchAll(/const x=[12];/g)];
        for (const [index, match] of matches.entries()) {
          const x = match.index, start = index === 0 ? 0 : matches[index - 1].index + 10;
          const end = index + 1 === matches.length ? dump.cells[y].length : matches[index + 1].index;
          found.push({ value: match[0], keyword: dump.cells[y].slice(x, x + 5), variable: dump.cells[y][x + 6],
            number: dump.cells[y][x + 8], prefix: dump.cells[y].slice(start, x), suffix: dump.cells[y].slice(x + 10, end) });
        }
      }
      assert.equal(found.length, 3, 'write source plus both old/new edit sides are physically visible');
      assert.equal(found.filter(row => row.value === 'const x=1;').length, 2);
      assert.equal(found.filter(row => row.value === 'const x=2;').length, 1);
      return found;
    };
    try {
      const baseline = await scenario(terminal, true), baselineCells = vectors(baseline);
      await terminal.resize(140); const wideBaseline = await terminal.capture('styles-wide-baseline');
      const wideBaselineCells = vectors(wideBaseline); await terminal.resize(100);
      const initial = await stats(terminal, 'styles-initial');
      assert.equal(initial.node, process.version, 'actual Pi child uses the same asserted parent runtime');
      assert.equal(initial.client.provider.kind, 'shared'); assert.equal(initial.counts.acquisitions, 0);
      const originalTraffic = traffic(terminal), originalData = persisted(baseline), originalBranch = baseline.branch;
      writeFileSync(host.themeFile, `<plist><dict><key>settings</key><array>
        <dict><key>settings</key><dict><key>foreground</key><string>#112233</string></dict></dict>
        <dict><key>scope</key><string>storage, keyword</string><key>settings</key><dict>
          <key>foreground</key><string>#a1b2c3</string><key>fontStyle</key><string>bold italic underline</string></dict></dict>
        <dict><key>scope</key><string>constant.numeric</string><key>settings</key><dict>
          <key>foreground</key><string>#22aa44</string><key>fontStyle</key><string>italic</string></dict></dict>
        </array></dict></plist>`);
      await menuAction(terminal, 'refresh'); await terminal.closeTidyMenu();
      const refreshed = await stats(terminal, 'styles-refreshed');
      assert.equal(refreshed.counts.refreshReplies, 1);
      const custom = refreshed.client.provider.description.profiles.find(profile => profile.label === 'cli-shared'); assert.ok(custom);
      const index = refreshed.client.provider.description.profiles.filter(profile => profile.id !== 'pi').findIndex(profile => profile.id === custom.id) + 1;
      await chooseTheme(terminal, index);
      await settledStats(terminal, 'styles-selected', s => nativeReady(s) && s.client.effective.id === custom.id);
      let painted, observation = 0;
      await until(async () => {
        painted = await terminal.capture(`styles-colored-${observation++}`);
        return vectors(painted).every(row => row.keyword.every(cell => cell.fg === 0xa1b2c3));
      }, 'all three actual source foregrounds');
      const styledCells = vectors(painted);
      assert.deepEqual(body(painted), body(baseline), 'theme changes source styles, never tool glyphs or geometry');
      const assertVectors = dump => {
        for (const row of vectors(dump)) {
          for (const cell of row.keyword) assert.deepEqual({ fg: cell.fg, rgb: cell.fgMode, bold: !!cell.bold, italic: !!cell.italic, underline: !!cell.underline },
            { fg: 0xa1b2c3, rgb: 50331648, bold: true, italic: true, underline: true });
          assert.deepEqual({ fg: row.number.fg, rgb: row.number.fgMode, bold: !!row.number.bold, italic: !!row.number.italic, underline: !!row.number.underline },
            { fg: 0x22aa44, rgb: 50331648, bold: false, italic: true, underline: false });
          assert.deepEqual({ fg: row.variable.fg, rgb: row.variable.fgMode, bold: !!row.variable.bold, italic: !!row.variable.italic, underline: !!row.variable.underline },
            { fg: 0x112233, rgb: 50331648, bold: false, italic: false, underline: false }, 'keyword attributes cannot leak into the next plain token');
        }
      };
      assertVectors(painted);
      const assertFrame = (current, previousRows) => {
        for (const [index, row] of current.entries()) {
          const previous = previousRows[index];
          assert.deepEqual(row.prefix, previous.prefix, 'line-number/diff/frame prefix keeps every original cell style');
          assert.deepEqual(row.suffix, previous.suffix, 'source attributes cannot leak into row suffix/frame');
          for (const [cell, old] of [...row.keyword.map((cell, i) => [cell, previous.keyword[i]]), [row.variable, previous.variable], [row.number, previous.number]])
            assert.deepEqual({ bg: cell.bg, bgMode: cell.bgMode }, { bg: old.bg, bgMode: old.bgMode }, 'syntax theme never replaces semantic diff background');
        }
      };
      assertFrame(styledCells, baselineCells);
      const before = await settledStats(terminal, 'styles-warm-before', s => nativeReady(s) && s.source.globalUnsettledJobs === 0);
      for (const width of [24, 60, 100, 140]) {
        await terminal.resize(width); const dump = await terminal.capture(`styles-width-${width}`); assertVectors(dump);
        if (width === 140) { assertFrame(vectors(dump), wideBaselineCells); assert.deepEqual(body(dump), body(wideBaseline)); }
      }
      for (const theme of ['light', 'dark']) {
        const previousEvents = terminal.events().filter(event => event.type === 'theme').length;
        await terminal.command(`/tidy-ui-theme ${theme}`); await terminal.event('theme', previousEvents + 1);
        const transition = terminal.events().filter(event => event.type === 'theme')[previousEvents];
        assert.equal(transition.name, theme); assert.equal(transition.result.success, true, 'fresh requested Pi theme transition succeeds');
        const dump = await terminal.capture(`styles-${theme}`);
        assertVectors(dump); assert.deepEqual(body(dump), body(wideBaseline), 'Pi theme changes no source glyphs/geometry');
        const themed = await stats(terminal, `styles-${theme}-stats`);
        assert.equal(themed.client.effective.id, custom.id);
        assert.deepEqual(work(themed), work(before), 'fixed native theme remains classified across Pi palette changes');
      }
      const final = await terminal.capture('styles-warm'); const after = await stats(terminal, 'styles-warm-after');
      assert.equal(after.node, process.version);
      assert.deepEqual(work(after), work(before), 'width changes and warm frames do no new source work');
      assert.equal(before.counts.piBridges, 0); assert.equal(after.counts.piBridges, 0);
      assert.equal(after.counts.acquisitions, 0); assert.equal(after.client.provider.description.runtime.pid, initial.client.provider.description.runtime.pid);
      assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(persisted(final), originalData);
      assert.deepEqual(final.branch, originalBranch);
      await finish(terminal); assert.deepEqual(await host.initialPeer.refreshThemes(), { ok: true });
      console.log(JSON.stringify({ physicalStyles: terminal.output, node: after.node, visibleSources: 3,
        structuredRgb: true, bold: true, italic: true, underline: true, semanticBackgrounds: true, widths: [24, 60, 100, 140], piThemes: ['dark', 'light'], warmWorkDelta: 0 }));
    } finally { await terminal.close(); terminal.dispose(); await host.close(); }
  });


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
for (const mode of ['regular', 'fullscreen']) for (const native of [false, true])
  test(`occipital CLI: logging ${mode} ${native ? 'native' : 'fallback'} truthful decisions, unchanged frames, reload and replay`,
    { skip: native && !binary, timeout: 120000 }, async () => {
      const terminal = new PiTerminal(`logging-${mode}-${native ? 'native' : 'fallback'}`, { mode, extensions: [loggingFixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_LOGGING_NATIVE: native ? '1' : '0', TIDY_UI_TEST_LOGGING_CANCEL: '1', TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
      const stock = new PiTerminal(`logging-${mode}-stock-${native}`, { mode, extraEnv: { TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
      let replay;
      try {
        const shown = await scenario(terminal, native), control = await scenario(stock, false);
        assert.deepEqual(traffic(terminal), traffic(stock)); assert.deepEqual(persisted(shown), persisted(control));
        if (native) sourceColors(shown);
        const counters = native ? await stats(terminal, 'logging-before') : undefined, baseline = await loggingIdle(terminal);
        assert.ok(baseline.records > 0); assert.ok(baseline.writes > 0); assert.equal(baseline.capture, true);
        assert.equal(baseline.dropped, 0); assert.equal(baseline.writeErrors, 0);
        const originalEvents = terminal.events(), text = readFileSync(baseline.path, 'utf8'); loggingPrivacy(text, originalEvents);
        writeFileSync(join(terminal.output, 'logging-live.log'), text);
        assert.match(text, /Session started:.*session=.*run=/); assert.match(text, /\[cache\].*Tool layout built/);
        const bashId = shown.tools.find(tool => tool.name === 'bash').id;
        assert.ok(text.split('\n').some(row => row.includes('[syntax]') && row.includes(`call=${bashId}`) && row.includes('source=')), 'final decision correlates the actual Bash call and source');
        assert.match(text, native ? /Occipital classification applied/ : /Whole Bash command uses toolTitle/);
        if (!native) assert.match(text, /Cached Pi fallback applied/);
        for (let i = 0; i < 5; i++) assert.deepEqual(loggerWork(await loggingFrame(terminal)), loggerWork(baseline));
        await terminal.resize(100);
        assert.deepEqual(loggerWork(await loggingFrame(terminal)), loggerWork(baseline), 'same-size observation adds no records or I/O');
        if (native) { const after = await stats(terminal, 'logging-after'); assert.deepEqual(work(after), work(counters)); assert.equal(after.counts.piBridges, counters.counts.piBridges); }
        await terminal.command('/new'); await terminal.event('logging_cancelled_switch');
        const cancelled = await loggingFrame(terminal); assert.equal(cancelled.run, baseline.run); assert.equal(cancelled.session, baseline.session);
        await terminal.appearance(false);
        const logRows = await terminal.tidyPage(['Status & troubleshooting', 'Diagnostic logs']);
        assert.ok(logRows.some(line => line === 'Recording: On'), 'capture survives master presentation off');
        await terminal.appearance(true);
        if (native) await settledStats(terminal, 'logging-on-ready', nativeReady);
        const on = await terminal.capture('logging-after-on'); assert.deepEqual(body(on), body(shown)); assert.deepEqual(persisted(on), persisted(shown));
        const beforeReload = await loggingIdle(terminal); await terminal.command('/reload');
        if (native) await syntaxReady(terminal);
        const afterReload = await loggingIdle(terminal);
        assert.equal(afterReload.session, beforeReload.session); assert.notEqual(afterReload.run, beforeReload.run);
        assert.ok(existsSync(beforeReload.path.replace(/\.log$/u, '.closed.log')));
        writeFileSync(join(terminal.output, 'logging-reload.log'), readFileSync(beforeReload.path.replace(/\.log$/u, '.closed.log')));
        const reloaded = await terminal.capture('logging-after-reload'); assert.deepEqual(body(reloaded), body(shown)); assert.deepEqual(persisted(reloaded), persisted(shown));
        if (native) await finish(terminal); else await terminal.close();
        replay = new PiTerminal(`logging-${mode}-replay-${native}`, { mode, session: shown.session, workspace: terminal.work, extensions: [loggingFixture],
          extraEnv: { ...descriptor, TIDY_UI_TEST_LOGGING_NATIVE: native ? '1' : '0' } });
        await replay.ready(); if (native) await settledStats(replay, 'logging-replay-ready', s => nativeReady(s) && s.source.dispatches > 0);
        const restored = await replay.capture('logging-replay'); const replayStatus = await loggingIdle(replay);
        assert.equal(replayStatus.session, baseline.session); assert.notEqual(replayStatus.run, baseline.run);
        assert.deepEqual(body(restored), body(shown)); assert.deepEqual(persisted(restored), persisted(shown));
        assert.equal(traffic(replay).length, 0); const replayText = readFileSync(replayStatus.path, 'utf8'); loggingPrivacy(replayText, originalEvents);
        writeFileSync(join(replay.output, 'logging-replay.log'), replayText);
        const replayBaseline = loggerWork(replayStatus);
        for (let i = 0; i < 3; i++) assert.deepEqual(loggerWork(await loggingFrame(replay)), replayBaseline);
        if (native) await finish(replay); else await replay.close();
        const closed = readFileSync(replayStatus.path.replace(/\.log$/u, '.closed.log'), 'utf8'); assert.match(closed, /Session run ended/);
        console.log(JSON.stringify({ logging: terminal.output, replay: replay.output, mode, native, session: baseline.session,
          run: baseline.run, reloadRun: afterReload.run, replayRun: replayStatus.run, warmRecordDelta: 0, warmWriteDelta: 0,
          nativeWork: native ? work(counters) : undefined }));
      } finally {
        await terminal.close(); await stock.close(); await replay?.close(); replay?.dispose(); terminal.dispose(); stock.dispose();
      }
    });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} historical Bash tail stays colored across held append, new grapheme and abort`,
  { skip: !binary, timeout: 90000 }, async () => {
    const live = new PiTerminal(`bash-prefix-${mode}`, { mode, extensions: [fixture], extraEnv: { ...descriptor, TIDY_UI_TEST_BASH_REPLY_GATE: '1' } });
    const stock = new PiTerminal(`bash-prefix-stock-${mode}`, { mode, tidyUi: false, extraEnv: descriptor });
    let replay;
    const fg = (dump, role) => { const match = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(match); return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]); };
    const cells = dump => {
      const y = dump.screen.findLastIndex(row => row.includes('STABLE_text e')); assert.ok(y >= 0, 'latest Bash text is physically visible');
      const x = dump.screen[y].indexOf('STABLE_text e');
      return { prefix: dump.cells[y][x], last: dump.cells[y][x + 'STABLE_text '.length], next: dump.cells[y][x + 'STABLE_text '.length + 1] };
    };
    try {
      for (const terminal of [live, stock]) {
        await terminal.ready(); if (terminal === live) await syntaxReady(terminal);
        terminal.send('run bash-prefix-contract\r'); await terminal.event('bash_contract_prefix');
        await terminal.capture('pointer-prefix-initial', { animated: true });
        if (terminal === live) {
          const ready = await settledStats(live, 'prefix-native', s => nativeReady(s) && s.source.tailCalls === 1);
          assert.equal(ready.source.committedLineCalls, 0); assert.equal(ready.source.committedLineBytes, 0);
          const shown = await live.capture('pointer-prefix-colored', { animated: true });
          assert.equal(cells(shown).prefix.fg, fg(shown, 'syntaxString'));
        }
        writeFileSync(join(terminal.output, 'bash-contract-go-0'), 'go'); await terminal.event('bash_contract_prefix', 2);
        if (terminal === live) await live.event('bash_contract_reply_held');
        const appended = await terminal.capture('pointer-prefix-held', { animated: true });
        assert.equal(appended.tools[0].args.command, ": 'STABLE_text é界");
        assert.equal(appended.tools[0].argsComplete, false); assert.equal(appended.tools[0].executionStarted, false);
        if (terminal === live) {
          const vector = cells(appended);
          assert.equal(vector.prefix.fg, fg(appended, 'syntaxString')); assert.equal(vector.last.text, 'é');
          assert.equal(vector.last.fg, fg(appended, 'syntaxString'), 'new combining mark inherits the matching first scalar');
          assert.equal(vector.next.text, '界'); assert.equal(vector.next.fg, fg(appended, 'toolTitle'), 'entire new wide glyph is neutral');
          const before = await stats(live, 'prefix-held-before');
          assert.equal(before.pendingHeldReplies, 1); assert.equal(before.source.dispatches, 2); assert.equal(before.source.tailCalls, 1);
          for (let i = 0; i < 3; i++) {
            const hot = await live.capture(`pointer-prefix-held-warm-${i}`, { animated: true });
            assert.equal(cells(hot).prefix.fg, fg(hot, 'syntaxString'));
          }
          const after = await stats(live, 'prefix-held-after'); assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, 0);
        }
        writeFileSync(join(terminal.output, 'bash-contract-go-1'), 'go'); await terminal.event('bash_contract_prefix', 3);
        await terminal.capture('pointer-prefix-coalesced', { animated: true });
        terminal.send('\x1b'); await terminal.event('agent_end'); await terminal.settle();
      }
      await settledStats(live, 'prefix-aborted-settled', s => s.source.globalUnsettledJobs === 0 && s.source.remoteLeases === 0 && s.pendingHeldReplies === 0);
      const aborted = await live.capture('pointer-prefix-aborted'), baseline = await stock.capture('pointer-prefix-aborted');
      assert.equal(cells(aborted).prefix.fg, fg(aborted, 'syntaxString'));
      assert.ok(body(aborted)[0].lines.some(row => row.includes('[error: incomplete tool call]')));
      assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(persisted(aborted), persisted(baseline));
      const raw = dump => dump.tools.map(({ name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial }) =>
        ({ name, args, content, details, structuredContent, isError, argsComplete, executionStarted, partial }));
      assert.deepEqual(raw(aborted), raw(baseline)); assert.equal(traffic(live).filter(e => e.type === 'call' || e.type === 'result').length, 0);
      const before = await stats(live, 'prefix-frozen-before');
      assert.equal(before.source.sourceRecords, 1); assert.equal(before.source.dispatches, 3); assert.equal(before.counts.heldBashReplies, 1);
      for (const width of [60, 100]) {
        await live.resize(width); const resized = await live.capture(`pointer-prefix-frozen-${width}`);
        assert.equal(cells(resized).prefix.fg, fg(resized, 'syntaxString'));
      }
      const after = await stats(live, 'prefix-frozen-after'); assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, 0);
      await finish(live);
      const sessionBytes = readFileSync(aborted.session);
      replay = new PiTerminal(`bash-prefix-replay-${mode}`, { mode, session: aborted.session, extensions: [fixture], extraEnv: descriptor });
      await replay.ready(); await syntaxReady(replay);
       const replayStats = await settledStats(replay, 'prefix-replay-colored', s => nativeReady(s) && s.source.dispatches === 1 && s.source.decodedBytes > 0);
       const replayed = await replay.capture('pointer-prefix-replayed');
       assert.equal(cells(replayed).prefix.fg, fg(replayed, 'syntaxString'), 'restored incomplete call is freshly colored as static saved text');
      assert.deepEqual(body(replayed), body(aborted), 'replay changes no latest command glyphs or incomplete-call geometry');
      assert.deepEqual(raw(replayed), raw(aborted));
      assert.equal(traffic(replay).length, 0, 'replay performs no model or tool work');
      assert.deepEqual(readFileSync(aborted.session), sessionBytes);
       assert.equal(replayStats.source.dispatches, 1, 'one finite new-owner classification, not a continuing abandoned stream');
       assert.equal(replayStats.source.remoteLeases, 0); assert.equal(replayStats.counts.piBridges, 0);
       for (const width of [60, 100]) {
         await replay.resize(width);
         const warmReplay = await replay.capture(`pointer-prefix-replayed-warm-${width}`);
         assert.equal(cells(warmReplay).prefix.fg, fg(warmReplay, 'syntaxString'));
       }
       const replayAfter = await stats(replay, 'prefix-replay-warm'); assert.deepEqual(work(replayAfter), work(replayStats));
       assert.equal(traffic(replay).length, 0); assert.deepEqual(readFileSync(aborted.session), sessionBytes);
      await finish(replay);
      console.log(JSON.stringify({ historicalBash: live.output, stock: stock.output, replay: replay.output, node: after.node, mode, heldReplies: 1,
        committedLineCalls: 0, tailCalls: after.source.tailCalls, warmNativeDelta: 0, calls: 0, results: 0, coloredAfterAbort: true, restoredDispatches: replayAfter.source.dispatches, coloredAfterReopen: true }));
    } finally { await live.close(); await stock.close(); await replay?.close(); live.dispose(); stock.dispose(); replay?.dispose(); }
  });


for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} online wait resumes both restored and connection-loss Bash demands`,
  { skip: !binary, timeout: 120000 }, async () => {
    const directory = await mkdtemp(resolve('.test-artifacts/online-wait-session-'));
    const manager = SessionManager.create(directory, join(directory, 'sessions'));
    manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const savedFirst = ": 'ONLINE_WAIT_FIRST", savedSecond = "printf 'ONLINE_WAIT_SECOND\\n'";
    const assistant = (id, command, stopReason) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
      api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason, timestamp: Date.now(),
      ...(stopReason === 'error' ? { errorMessage: 'WebSocket closed 1000' } : {}) });
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'saved interrupted call' }], timestamp: Date.now() });
    manager.appendMessage(assistant('saved-first', savedFirst, 'error'));
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'saved successful call' }], timestamp: Date.now() });
    manager.appendMessage(assistant('saved-second', savedSecond, 'toolUse'));
    manager.appendMessage({ role: 'toolResult', toolCallId: 'saved-second', toolName: 'bash', content: [{ type: 'text', text: 'saved second result' }], details: { exit_code: 0 }, isError: false, timestamp: Date.now() });
    const session = manager.getSessionFile(), original = readFileSync(session);
    const terminal = new PiTerminal(`online-wait-${mode}`, { mode, session, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE: '1' } });
    const stock = new PiTerminal(`online-wait-stock-${mode}`, { mode, session, extraEnv: descriptor });
    const raw = dump => dump.tools.map(({ name, args, content, details, isError, argsComplete, executionStarted, partial }) =>
      ({ name, args, content, details, isError, argsComplete, executionStarted, partial }));
    const rgb = (dump, role) => { const match = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(match); return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]); };
    const color = (dump, marker, role) => {
      const y = dump.screen.findIndex(row => row.includes(marker)); assert.ok(y >= 0, `physically visible ${marker}`);
      assert.equal(dump.cells[y][dump.screen[y].indexOf(marker)].fg, rgb(dump, role), marker);
    };
    try {
      await terminal.ready(); await terminal.event('syntax_acquire_gate'); await stock.ready();
      const early = await terminal.capture('online-wait-before-start'), baseline = await stock.capture('online-wait-stock-restored');
      assert.deepEqual(raw(early), raw(baseline)); assert.equal(early.tools.length, 2);
      assert.equal(early.tools[0].argsComplete, false); assert.equal(early.tools[0].executionStarted, false);
      color(early, 'ONLINE_WAIT_FIRST', 'toolTitle'); color(early, 'ONLINE_WAIT_SECOND', 'toolTitle');
      const before = await stats(terminal, 'online-wait-start-deferred');
      assert.notEqual(before.client.provider.availability, 'ready'); assert.equal(before.counts.describeReplies, 0); assert.equal(before.source.dispatches, 0);
      writeFileSync(join(terminal.output, 'syntax-acquire-go'), 'go');
      const started = await settledStats(terminal, 'online-wait-start-colored', s => nativeReady(s) && s.source.dispatches === 2 && s.source.decodedBytes > 0);
      const colored = await terminal.capture('online-wait-start-colored');
      color(colored, 'ONLINE_WAIT_FIRST', 'syntaxString'); color(colored, 'ONLINE_WAIT_SECOND', 'syntaxString');
      assert.deepEqual(raw(colored), raw(early)); assert.deepEqual(readFileSync(session), original); assert.equal(traffic(terminal).length, 0);
      assert.equal(started.source.preparedBytes, Buffer.byteLength(savedFirst) + Buffer.byteLength(savedSecond));
      assert.equal(started.counts.piBridges, 0); assert.equal(started.source.remoteLeases, 0);
      rmSync(join(terminal.output, 'syntax-acquire-go')); process.kill(started.transports[0].pid, 'SIGKILL');
      await terminal.event('syntax_acquire_gate', 2);
      const lost = await stats(terminal, 'online-wait-recovery-deferred');
      assert.notEqual(lost.client.provider.availability, 'ready'); assert.equal(lost.counts.acquisitions, 2);
      assert.deepEqual(work(lost), work(started));
      // Two real short Bash calls while the same client waits for its owned replacement.
      for (let round = 0; round < 2; round++) for (const current of [terminal, stock]) {
        current.send('run user-card\r'); await current.event('agent_end', round + 1); await current.settle();
      }
      const pending = await terminal.capture('online-wait-recovery-pending'), stockAfter = await stock.capture('online-wait-stock-after');
      assert.deepEqual(raw(pending), raw(stockAfter)); assert.deepEqual(traffic(terminal), traffic(stock));
      assert.deepEqual(persisted(pending), persisted(stockAfter));
      const demanded = pending.tools.filter(tool => tool.name === 'bash').slice(2); assert.equal(demanded.length, 2);
      const paused = await stats(terminal, 'online-wait-recovery-demanded'); assert.deepEqual(work(paused), work(started));
      writeFileSync(join(terminal.output, 'syntax-acquire-go'), 'go');
      const recovered = await settledStats(terminal, 'online-wait-recovered', s => nativeReady(s) && s.source.dispatches === 4 && s.source.sourceRecords === 4);
      const restored = await terminal.capture('online-wait-recovered');
      color(restored, 'ONLINE_WAIT_FIRST', 'syntaxString'); color(restored, 'ONLINE_WAIT_SECOND', 'syntaxString');
      const rows = restored.screen.flatMap((row, y) => row.includes('printf') && row.includes('USER_BASH_OUTPUT') ? [y] : []);
      assert.equal(rows.length, 2, 'both recovery-deferred command strings, not their output rows, are visible');
      for (const y of rows) assert.equal(restored.cells[y][restored.screen[y].indexOf('USER_BASH_OUTPUT')].fg, rgb(restored, 'syntaxString'));
      assert.equal(recovered.source.preparedBytes, started.source.preparedBytes + demanded.reduce((sum, tool) => sum + Buffer.byteLength(tool.args.command), 0), 'no already-colored saved command is classified again');
      assert.equal(recovered.counts.piBridges, 0); assert.equal(recovered.counts.acquisitions, 2); assert.equal(recovered.source.remoteLeases, 0);
      const persistedBytes = readFileSync(session);
      for (const width of [60, 100, 100]) { await terminal.resize(width); await terminal.capture(`online-wait-warm-${width}-${Date.now()}`); }
      assert.deepEqual(work(await stats(terminal, 'online-wait-warm-final')), work(recovered));
      assert.deepEqual(readFileSync(session), persistedBytes); assert.deepEqual(raw(restored), raw(pending)); assert.deepEqual(traffic(terminal), traffic(stock));
      await finish(terminal);
      console.log(JSON.stringify({ onlineWait: terminal.output, stock: stock.output, node: recovered.node, mode, restoredDispatches: 2,
        recoveryDispatches: recovered.source.dispatches - started.source.dispatches, redundantPreparedBytes: 0, warmNativeDelta: 0, piBridges: 0 }));
    } finally { await terminal.close(); await stock.close(); terminal.dispose(); stock.dispose(); await rm(directory, { recursive: true, force: true }); }
  });


for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} restored Bash backlog colors newest cards before older cards`,
  { skip: !binary, timeout: 120000 }, async () => {
    const directory = await mkdtemp(resolve('.test-artifacts/order-session-'));
    const manager = SessionManager.create(directory, join(directory, 'sessions'));
    manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const commands = Array.from({ length: 8 }, (_, i) => `printf 'ORDER_CARD_${i}\\n'`);
    for (let i = 0; i < commands.length; i++) {
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `saved card ${i}` }], timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `saved-order-${i}`, name: 'bash', arguments: { command: commands[i] } }],
        api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: i === 0 ? 'error' : 'toolUse', timestamp: Date.now(),
        ...(i === 0 ? { errorMessage: 'WebSocket closed 1000' } : {}) });
      if (i) manager.appendMessage({ role: 'toolResult', toolCallId: `saved-order-${i}`, toolName: 'bash', content: [{ type: 'text', text: `saved result ${i}` }],
        details: { exit_code: 0 }, isError: false, timestamp: Date.now() });
    }
    const session = manager.getSessionFile(), bytes = readFileSync(session);
    const terminal = new PiTerminal(`backlog-order-${mode}`, { mode, session, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE: '1', TIDY_UI_TEST_SYNTAX_ORDER_GATE: '1' } });
    const stock = new PiTerminal(`backlog-order-stock-${mode}`, { mode, session, extraEnv: descriptor });
    const raw = dump => dump.tools.map(({ name, args, content, details, isError, argsComplete, executionStarted, partial }) =>
      ({ name, args, content, details, isError, argsComplete, executionStarted, partial }));
    const color = (dump, i, role) => {
      const marker = `ORDER_CARD_${i}`, y = dump.screen.findIndex(row => row.includes(marker));
      assert.ok(y >= 0, `physically visible ${marker}`);
      const match = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(match);
      assert.equal(dump.cells[y][dump.screen[y].indexOf(marker)].fg, Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]), marker);
    };
    try {
      await terminal.ready(); await terminal.event('syntax_acquire_gate'); await stock.ready();
      await terminal.resize(100, 160); await stock.resize(100, 160);
      const early = await terminal.capture('backlog-order-pending'), baseline = await stock.capture('backlog-order-stock');
      assert.equal(early.tools.length, commands.length); assert.deepEqual(raw(early), raw(baseline));
      writeFileSync(join(terminal.output, 'syntax-acquire-go'), 'go');
      await terminal.event('syntax_order_reply_held', 2);
      assert.deepEqual(terminal.events().filter(e => e.type === 'syntax_order_dispatch').map(e => e.payload.sources[0].text), commands.slice(-2).reverse());
      for (let batch = 0; batch < commands.length / 2; batch++) {
        const from = batch * 2;
        await terminal.event('syntax_order_reply_held', from + 2);
        const held = await stats(terminal, `backlog-order-held-${batch}`);
        assert.equal(held.source.globalUnsettledJobs, 2); assert.equal(held.counts.orderDispatches, from + 2);
        for (const ordinal of [from + 1, from + 2]) writeFileSync(join(terminal.output, `syntax-order-go-${ordinal}`), 'go');
        const accepted = await settledStats(terminal, `backlog-order-accepted-${batch}`, s => s.source.decodedBytes ===
          commands.slice(commands.length - from - 2).reduce((sum, text) => sum + Buffer.byteLength(text), 0));
        if (!batch) {
          const first = await terminal.capture('backlog-order-newest-first');
          color(first, 7, 'syntaxString'); color(first, 6, 'syntaxString');
          for (let i = 0; i < 6; i++) color(first, i, 'toolTitle');
          assert.deepEqual(raw(first), raw(early)); assert.deepEqual(readFileSync(session), bytes);
        }
        if (batch === commands.length / 2 - 1) assert.equal(accepted.source.globalUnsettledJobs, 0);
      }
      const colored = await terminal.capture('backlog-order-complete'), final = await stats(terminal, 'backlog-order-final');
      const dispatches = terminal.events().filter(e => e.type === 'syntax_order_dispatch');
      assert.deepEqual(dispatches.map(e => e.payload.sources[0].text), commands.toReversed());
      for (let i = 0; i < commands.length; i++) color(colored, i, 'syntaxString');
      assert.equal(final.source.dispatches, commands.length); assert.equal(final.counts.piBridges, 0); assert.equal(final.source.remoteLeases, 0);
      assert.equal(final.source.preparedBytes, commands.reduce((sum, text) => sum + Buffer.byteLength(text), 0));
      for (const width of [60, 100]) { await terminal.resize(width); await terminal.capture(`backlog-order-warm-${width}`); }
      assert.deepEqual(work(await stats(terminal, 'backlog-order-warm-final')), work(final));
      assert.deepEqual(raw(colored), raw(baseline)); assert.deepEqual(readFileSync(session), bytes); assert.equal(traffic(terminal).length, 0);
      terminal.send('\x04');
      await until(() => terminal.exited, 'backlog-order graceful Pi exit');
      assert.equal(terminal.exited.code, 0);
      await finish(terminal);
      console.log(JSON.stringify({ backlogOrder: terminal.output, stock: stock.output, node: final.node, mode, cards: commands.length,
        order: dispatches.map(e => e.payload.sources[0].text), warmNativeDelta: 0, calls: 0, results: 0 }));
    } finally { await terminal.close(); await stock.close(); terminal.dispose(); stock.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
