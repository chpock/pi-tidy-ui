import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { CARD_ROLES } from '../../../../src/occipital/semantic-codec.ts';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { syntaxToolData as raw } from '../../../fixtures/syntax-tool-data.mjs';
import { nativeReady, semanticStyle } from '../../../fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, inputs, syntaxReady, stats, settledStats, traffic, persisted, finish, chooseTheme, expressionForeground, work } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const nativeBytes = 65536, piBytes = 8192;
const pad = (text, bytes) => text + '#' + 'x'.repeat(bytes - Buffer.byteLength(text) - 2) + '\n';
const fileSource = pad(pad('def VOLUME_PREFIX():\n    return 1\n', piBytes)
  + 'def VOLUME_PI_SUFFIX():\n    return 2\n', nativeBytes)
  + pad('def VOLUME_NATIVE_SUFFIX():\n    return 3\n', 5 * 1024);
const initial = "printf 'VOLUME_OK\\n'\n";
const saturated = pad(initial + '# VOLUME_PREFIX\n', nativeBytes) + '# VOLUME_NATIVE_SUFFIX\n';
const grown = saturated + pad('# VOLUME_GROWTH\n', 5 * 1024);
const corrected = grown.replace('VOLUME_PREFIX', 'VOLUME_CORRECT');
const assistants = dump => dump.branch.filter(e => e.type === 'message' && e.message.role === 'assistant')
  .map(({ message: { timestamp, durationMs, ...message } }) => message);
const cell = (dump, marker) => {
  const y = dump.screen.findLastIndex(row => row.includes(marker)); assert.ok(y >= 0, `physical marker ${marker}`);
  return dump.cells[y][dump.screen[y].indexOf(marker)];
};
const vector = c => ({ fg: c.fg, bg: c.bg, bold: !!c.bold, italic: !!c.italic, underline: !!c.underline, dim: !!c.dim, inverse: c.inverse });
const rgb = ink => { assert.equal(ink.kind, 'rgb'); return ink.r * 65536 + ink.g * 256 + ink.b; };
const ansiRgb = (ansi, channel = 38) => { const match = ansi.match(new RegExp(`${channel};2;(\\d+);(\\d+);(\\d+)m`)); assert.ok(match); return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]); };
function nativeCells(terminal, dump, marker, suffix, role = 'code') {
  const resolved = semanticStyle(terminal.events(), marker, terminal.profile);
  assert.ok(resolved, `validated SOURCE/STYLE for ${marker}`);
  const palette = resolved.styleEvent.reply.body, base = palette.styles[palette.palette.slots[CARD_ROLES.indexOf(role)] - 1];
  assert.ok(base, 'selected native role');
  const expression = resolved.expression, attributes = base.attributes & ~expression.attribute_mask | expression.attributes & expression.attribute_mask;
  const prefix = cell(dump, marker), neutral = cell(dump, suffix);
  assert.equal(prefix.fg, expressionForeground(expression, dump, 'toolTitle'));
  assert.equal(prefix.bg, rgb(role === 'addedCode' || role === 'removedCode' || expression.background.kind === 'inherit' ? base.background : expression.background));
  assert.deepEqual([!!prefix.bold, !!prefix.italic, !!prefix.underline, !!prefix.dim, prefix.inverse],
    [!!(attributes & 1), !!(attributes & 2), !!(attributes & 4), !!(attributes & 8), false]);
  assert.deepEqual(vector(neutral), { fg: rgb(base.foreground), bg: rgb(base.background), bold: !!(base.attributes & 1),
    italic: !!(base.attributes & 2), underline: !!(base.attributes & 4), dim: !!(base.attributes & 8), inverse: false });
  assert.notDeepEqual(vector(prefix), vector(neutral), 'known classified token contrasts with neutral remainder');
}
function exactFile(dump, text, kind) {
  assert.equal(dump.tools.length, 1); const tool = dump.tools[0];
  assert.equal(kind === 'write' ? tool.args.content : tool.args.newText, text);
  const rows = tool.lines.map(plain), sourceRows = text.split('\n');
  // Remove only independently known frame/gutter and right padding, never source spaces.
  const start = rows.findIndex(row => row.includes(sourceRows[0])); assert.ok(start >= 0);
  const column = rows[start].indexOf(sourceRows[0]);
  let cursor = start;
  for (const source of sourceRows) {
    if (!source.length) continue;
    let offset = 0;
    while (offset < source.length) {
      const row = rows[cursor++]; assert.ok(row !== undefined, 'complete full source row');
      const width = dump.width - column - 2; // One right panel pad and one exterior cell.
      const fragment = source.slice(offset, offset + width);
      assert.equal(row.slice(column, column + fragment.length), fragment);
      assert.equal(row.slice(column + fragment.length, dump.width - 2), ' '.repeat(width - fragment.length));
      offset += fragment.length;
    }
  }
  const y = dump.screen.findIndex(row => row === rows[start]); assert.ok(y >= 0);
  assert.deepEqual(dump.screen.slice(y, y + cursor - start), rows.slice(start, cursor), 'every complete source row is physically painted');
}
function exactBash(dump, text) {
  const rows = dump.tools[0].lines.map(plain), start = rows.findIndex(row => row.includes('$ printf'));
  assert.ok(start >= 0); const first = rows[start].indexOf('printf'), continuation = first - 2;
  let cursor = start;
  for (const [index, source] of text.split('\n').entries()) {
    if (!source.length) continue;
    let offset = 0;
    while (offset < source.length) {
      const column = index === 0 && offset === 0 ? first : continuation, width = dump.width - column - 2;
      const fragment = source.slice(offset, offset + width), row = rows[cursor++];
      assert.equal(row.slice(column, column + fragment.length), fragment);
      assert.equal(row.slice(column + fragment.length, dump.width - 2), ' '.repeat(width - fragment.length));
      offset += fragment.length;
    }
  }
  const y = dump.screen.findIndex(row => row === rows[start]); assert.ok(y >= 0);
  assert.deepEqual(dump.screen.slice(y, y + cursor - start), rows.slice(start, cursor), 'complete Bash source is physically painted');
}
async function start(name, native, plan, terminals) {
  const terminal = new PiTerminal(name, { mode: 'fullscreen', extensions: native ? [fixture] : [], extraEnv: { ...descriptor,
    TIDY_UI_TEST_HIGHLIGHTING_LIMITS: '1', TIDY_UI_TEST_THEME_PREVIEW: '1', TIDY_UI_TEST_CARD_OBSERVE: '1' } });
  terminals.push(terminal);
  writeFileSync(join(terminal.output, 'highlighting-limits.json'), JSON.stringify(plan));
  await terminal.ready(); await terminal.resize(1000, 200);
  if (native) await syntaxReady(terminal);
  return terminal;
}
async function selectNative(terminal) {
  const s = await stats(terminal, 'profiles');
  const profiles = s.client.provider.description.profiles.filter(p => p.id !== 'pi');
  const index = profiles.findIndex(p => p.label === 'Catppuccin Mocha'); assert.ok(index >= 0);
  terminal.profile = profiles[index].id; await chooseTheme(terminal, index + 1);
}
function exactTraffic(live, stock, actual, reference) {
  assert.deepEqual(traffic(live), traffic(stock)); assert.deepEqual(persisted(actual), persisted(reference));
  assert.deepEqual(raw(actual), raw(reference)); assert.deepEqual(assistants(actual), assistants(reference));
}
function boundedRequests(terminal) {
  const events = terminal.events().filter(e => e.type === 'syntax_native_dispatch' && e.kind === 'source');
  assert.ok(events.length > 0);
  for (const { payload } of events) {
    if (payload.op === 'stream.append') {
      assert.equal(typeof payload.append, 'string');
      assert.ok(Number.isSafeInteger(payload.base_bytes) && payload.base_bytes >= 0);
      assert.ok(payload.base_bytes + Buffer.byteLength(payload.append) <= nativeBytes);
    } else {
      assert.ok(Array.isArray(payload.sources));
      assert.ok(payload.sources.every(source => typeof source.text === 'string'));
      assert.ok(payload.sources.reduce((n, source) => n + Buffer.byteLength(source.text), 0) <= nativeBytes);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 512 * 1024);
  }
}

test('highlighting volume CLI: saturated live Bash finalizes its real lease before args complete, skips suffix work and replaces corrected prefix', { timeout: 120000 }, async () => {
  const plan = { calls: [{ name: 'bash', arguments: { command: corrected } }], prefixes: [initial, saturated, grown, corrected] };
  const terminals = [];
  try {
    const live = await start('volume-bash', true, plan, terminals); await selectNative(live);
    const stock = await start('volume-bash-stock', false, plan, terminals);
    let saturatedWork, saturatedCounts;
    for (let phase = 0; phase < 4; phase++) {
      for (const terminal of [live, stock]) {
        if (phase === 0) terminal.send('run highlighting-limits-bash\r');
        await terminal.event('highlighting_limits_prefix', phase + 1); await terminal.settle();
      }
      const s = await settledStats(live, `bash-phase-${phase}`, s => nativeReady(s) && s.counts.sourceRequests >= (phase === 0 ? 1 : 2)
        && (phase === 0 ? s.source.remoteLeases === 1 : s.source.remoteLeases === 0));
      const shown = await live.capture(`bash-phase-${phase}`), reference = await stock.capture(`bash-stock-phase-${phase}`);
      assert.equal(shown.tools[0].args.command, plan.prefixes[phase]); assert.equal(shown.tools[0].argsComplete, false);
      assert.equal(shown.tools[0].executionStarted, false); assert.deepEqual(raw(shown), raw(reference)); exactBash(shown, plan.prefixes[phase]);
      assert.equal(traffic(live).filter(e => e.type === 'call' || e.type === 'result').length, 0);
      if (phase === 1) {
        saturatedWork = work(s); saturatedCounts = s.counts; assert.ok(s.counts.styleRequests > 0);
        assert.equal(s.source.preparedBytes, nativeBytes);
        const finalized = live.events().findLast(e => e.type === 'syntax_native_reply' && e.kind === 'source');
        assert.equal(finalized.payload.op, 'stream.append'); assert.equal(finalized.payload.final, true);
        assert.equal(finalized.reply.body.sources[0].source_bytes, nativeBytes); assert.equal(finalized.reply.body.sources[0].complete, true);
      }
      if (phase === 2) {
        assert.equal(s.counts.sourceRequests, saturatedCounts.sourceRequests); assert.equal(s.counts.styleRequests, saturatedCounts.styleRequests);
        assert.equal(s.source.preparedBytes, saturatedWork.preparedBytes);
      }
      if (phase === 3) {
        assert.ok(s.counts.sourceRequests > saturatedCounts.sourceRequests);
        assert.equal(s.source.preparedBytes - saturatedWork.preparedBytes, nativeBytes, 'only the actual corrected prefix is newly encoded');
        nativeCells(live, shown, '# VOLUME_CORRECT', '# VOLUME_NATIVE_SUFFIX', 'title');
      }
      for (const terminal of [live, stock]) writeFileSync(join(terminal.output, `highlighting-limits-go-${phase}`), 'go');
    }
    for (const terminal of [live, stock]) { await terminal.event('agent_end'); await terminal.settle(); }
    const final = await live.capture('bash-final'), reference = await stock.capture('bash-stock-final'); exactTraffic(live, stock, final, reference);
    assert.equal(final.tools[0].content[0].text, 'VOLUME_OK\n'); boundedRequests(live);
    const before = await stats(live, 'bash-final-before'); await live.observeAnimation();
    assert.deepEqual(work(await stats(live, 'bash-final-after')), work(before));
    assert.equal(before.counts.piCaptures, 0); assert.equal(before.source.remoteLeases, 0);
    console.log(JSON.stringify({ volume: 'bash', output: live.output, stock: stock.output, node: before.node, prefixBytes: nativeBytes,
      fullBytes: Buffer.byteLength(corrected), counts: before.counts, source: before.source }));
    await finish(live);
  } finally { await closeTerminals(terminals); }
});

for (const kind of ['write', 'edit']) for (const policy of ['native', 'pi']) test(`highlighting volume CLI: actual ${kind} keeps exact full text with ${policy} prefix and neutral remainder`, { timeout: 120000 }, async () => {
  const args = kind === 'write' ? { path: 'limits.py', content: fileSource } : { path: 'limits.py', oldText: 'before', newText: fileSource };
  const plan = { calls: [{ name: kind, arguments: args }] }, terminals = [];
  try {
    const live = await start(`volume-${kind}-${policy}`, true, plan, terminals);
    if (policy === 'native') await selectNative(live);
    else {
      await live.openTidyMenu(); await live.selectTidyItem('Status & troubleshooting'); await live.selectTidyItem('Use Occipital highlighting'); await live.closeTidyMenu();
      const off = await stats(live, 'genuine-native-off'); assert.equal(off.client.enabled, false);
      assert.ok(off.transports.every(t => t.childState === 'exited' && t.retainedBytes === 0 && t.liveTimers === 0));
    }
    const stock = await start(`volume-${kind}-${policy}-stock`, false, plan, terminals);
    for (const terminal of [live, stock]) {
      if (kind === 'edit') writeFileSync(join(terminal.work, 'limits.py'), 'before');
      await terminal.run(`highlighting-limits-${kind}`);
    }
    const state = await settledStats(live, 'file-ready', s => policy === 'native' ? nativeReady(s)
      && !!semanticStyle(live.events(), 'def VOLUME_PREFIX', live.profile) : s.counts.piBridges > 0 && s.source.globalUnsettledJobs === 0);
    const shown = await live.capture('file-full'), reference = await stock.capture('file-stock'); exactTraffic(live, stock, shown, reference);
    assert.equal(readFileSync(join(live.work, 'limits.py'), 'utf8'), fileSource);
    assert.equal(readFileSync(join(stock.work, 'limits.py'), 'utf8'), fileSource);
    exactFile(shown, fileSource, kind);
    if (policy === 'native') {
      nativeCells(live, shown, 'def VOLUME_PREFIX', 'def VOLUME_NATIVE_SUFFIX', kind === 'edit' ? 'addedCode' : 'code');
      boundedRequests(live); assert.equal(state.counts.piCaptures, 0);
      const source = live.events().filter(e => e.type === 'syntax_native_dispatch' && e.kind === 'source').flatMap(e => e.payload.sources ?? []);
      assert.ok(source.some(s => s.text === fileSource.slice(0, nativeBytes)), 'wire carries the exact native prefix');
    } else {
      const captured = live.events().filter(e => e.type === 'highlighting_limits_pi_capture' && e.accepted);
      assert.ok(captured.some(e => e.text === fileSource.slice(0, piBytes) && e.language === 'python'));
      assert.ok(captured.every(e => Buffer.byteLength(e.text) <= piBytes)); assert.equal(state.counts.sourceRequests, 0);
      assert.equal(cell(shown, 'def VOLUME_PREFIX').fg, ansiRgb(shown.summaryStyles.syntaxKeyword));
      const neutral = cell(shown, 'def VOLUME_PI_SUFFIX');
      assert.equal(neutral.fg, ansiRgb(shown.summaryStyles.toolOutput));
      assert.deepEqual([!!neutral.bold, !!neutral.italic, !!neutral.underline, !!neutral.dim, neutral.inverse], [false, false, false, false, false]);
      assert.equal(cell(shown, 'def VOLUME_NATIVE_SUFFIX').fg, neutral.fg);
      assert.equal(neutral.bg, cell(shown, '    return 1').bg, 'neutral remainder keeps the same plain-code semantic surface');
      const prefix = cell(shown, 'def VOLUME_PREFIX');
      assert.deepEqual([!!prefix.bold, !!prefix.italic, !!prefix.underline, !!prefix.dim, prefix.inverse], [false, false, false, false, false]);
      assert.notEqual(prefix.fg, neutral.fg);
    }
    const saved = readFileSync(shown.session), originalTraffic = traffic(live), before = await stats(live, 'file-warm-before');
    await live.observeAnimation(); let after = await stats(live, 'file-warm-after'); assert.deepEqual(work(after), work(before));
    if (kind === 'write' && policy === 'native') {
      const pid = after.transports.at(-1).pid; process.kill(pid, 'SIGKILL');
      after = await settledStats(live, 'bounded-owned-recovery', s => nativeReady(s) && s.counts.acquisitions === 2 && s.counts.describeReplies === 2);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.notEqual(after.transports.at(-1).pid, pid);
      assert.deepEqual(work(after), work(before), 'actual helper recovery reuses the already validated bounded source/styles');
      assert.equal(after.counts.piCaptures, 0);
      const recovered = await live.capture('bounded-recovered'); exactFile(recovered, fileSource, kind);
      nativeCells(live, recovered, 'def VOLUME_PREFIX', 'def VOLUME_NATIVE_SUFFIX'); assert.deepEqual(raw(recovered), raw(shown));
    }
    assert.deepEqual(readFileSync(shown.session), saved); assert.deepEqual(traffic(live), originalTraffic);
    assert.equal(after.source.remoteLeases, 0); assert.equal(after.source.globalUnsettledJobs, 0); assert.equal(after.node, inputs.node.version);
    console.log(JSON.stringify({ volume: kind, policy, output: live.output, stock: stock.output, node: after.node,
      fullBytes: Buffer.byteLength(fileSource), prefixBytes: policy === 'native' ? nativeBytes : piBytes, counts: after.counts, source: after.source }));
    await finish(live);
  } finally { await closeTerminals(terminals); }
});

test('highlighting volume CLI: genuinely native-disabled Bash never invokes Pi and retains the complete command', { timeout: 120000 }, async () => {
  const plan = { calls: [{ name: 'bash', arguments: { command: corrected } }] }, terminals = [];
  try {
    const live = await start('volume-bash-off', true, plan, terminals);
    await live.openTidyMenu(); await live.selectTidyItem('Status & troubleshooting'); await live.selectTidyItem('Use Occipital highlighting'); await live.closeTidyMenu();
    const before = await stats(live, 'bash-disabled'); assert.equal(before.client.enabled, false);
    const stock = await start('volume-bash-off-stock', false, plan, terminals);
    for (const terminal of [live, stock]) await terminal.run('highlighting-limits-bash');
    const shown = await live.capture('bash-disabled-full'), reference = await stock.capture('bash-disabled-stock'); exactTraffic(live, stock, shown, reference);
    assert.equal(shown.tools[0].args.command, corrected); assert.equal(shown.tools[0].content[0].text, 'VOLUME_OK\n'); exactBash(shown, corrected);
    const prefix = cell(shown, '# VOLUME_CORRECT'), suffix = cell(shown, '# VOLUME_NATIVE_SUFFIX');
    assert.deepEqual(vector(prefix), vector(suffix)); assert.equal(prefix.fg, ansiRgb(shown.summaryStyles.toolTitle));
    const after = await stats(live, 'bash-disabled-final'); assert.equal(after.counts.piCaptures, 0); assert.equal(after.counts.piBridges, 0);
    assert.equal(after.counts.sourceRequests, 0); assert.equal(after.counts.styleRequests, before.counts.styleRequests);
    assert.equal(after.source.preparedBytes, 0); assert.equal(after.source.remoteLeases, 0);
    console.log(JSON.stringify({ volume: 'bash-disabled', output: live.output, stock: stock.output, node: after.node, counts: after.counts, source: after.source }));
    await finish(live);
  } finally { await closeTerminals(terminals); }
});

test('highlighting volume assertions: exact finite, batch, cumulative append and complete message boundaries', () => {
  const check = payload => boundedRequests({ events: () => [{ type: 'syntax_native_dispatch', kind: 'source', payload }] });
  const finite = text => ({ op: 'highlight', sources: [{ text }] });
  const append = (base_bytes, text) => ({ op: 'stream.append', base_bytes, append: text });
  check(finite('é'.repeat(nativeBytes / 2)));
  check({ op: 'stream.open', sources: [{ text: 'a'.repeat(nativeBytes / 2) }, { text: 'b'.repeat(nativeBytes / 2) }] });
  check(append(nativeBytes / 2, 'é'.repeat(nativeBytes / 4)));
  for (const payload of [finite('a'.repeat(nativeBytes + 1)),
    { op: 'highlight', sources: [{ text: 'a'.repeat(nativeBytes / 2) }, { text: 'b'.repeat(nativeBytes / 2 + 1) }] },
    append(0, 'a'.repeat(nativeBytes + 1)), append(nativeBytes / 2, 'a'.repeat(nativeBytes / 2 + 1)),
    { op: 'stream.append', base_bytes: 1 }, append(-1, ''), append(1.5, '')]) {
    assert.throws(() => check(payload), assert.AssertionError);
  }
  const envelope = { ...finite(''), note: '' }, messageBytes = 512 * 1024;
  envelope.note = 'x'.repeat(messageBytes - Buffer.byteLength(JSON.stringify(envelope)));
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), messageBytes); check(envelope);
  assert.throws(() => check({ ...envelope, note: envelope.note + 'x' }), assert.AssertionError);
});

function registeredTerminal(terminals, terminal) {
  // Never format a live terminal graph in a failing assertion.
  assert.equal(terminals.length, 1, 'one terminal must be registered for cleanup');
  assert.equal(terminals[0] === terminal, true, 'the created terminal must be registered');
}

test('highlighting volume startup diagnostics: registration failures inspect only primitives', () => {
  let reads = 0;
  const terminal = { get graph() { reads++; return {}; } };
  for (const owners of [[], [{}]]) {
    assert.throws(() => registeredTerminal(owners, terminal), error => {
      assert.ok(error instanceof assert.AssertionError);
      assert.ok(['number', 'boolean'].includes(typeof error.actual));
      assert.ok(['number', 'boolean'].includes(typeof error.expected));
      assert.ok(error.message.length < 2000);
      return true;
    });
  }
  registeredTerminal([terminal], terminal);
  assert.equal(reads, 0, 'even expected failures must not traverse the terminal graph');
});

test('highlighting volume startup: fallible ready preserves its error and disposes the already-created terminal', { timeout: 30000 }, async () => {
  const terminals = [], failure = new Error('controlled volume startup failure'), ready = PiTerminal.prototype.ready;
  let created;
  PiTerminal.prototype.ready = async function () { created = this; await ready.call(this); throw failure; };
  try {
    await assert.rejects(start('volume-startup-failure', false, { calls: [] }, terminals), error => error === failure);
    assert.equal(!!created, true, 'actual PiTerminal was constructed before startup rejection');
    registeredTerminal(terminals, created);
  } finally {
    PiTerminal.prototype.ready = ready;
    await closeTerminals([...new Set([...terminals, ...(created ? [created] : [])])]);
  }
  assert.equal(created.closed, true); assert.equal(existsSync(created.temp), false);
  assert.throws(() => process.kill(created.child.pid, 0), { code: 'ESRCH' });
});

test('highlighting volume traffic: only valid real Bash duration metadata is excluded from cross-run equality', () => {
  const value = { name: 'bash', args: { command: 'printf ok' }, content: [{ type: 'text', text: 'ok' }],
    structuredContent: { output: 'ok', exit_code: 0, truncated: false, wall_time_seconds: 0 },
    isError: false, argsComplete: true, executionStarted: true, partial: false };
  const view = tool => raw({ tools: [tool] });
  assert.deepEqual(view(value), view({ ...value, structuredContent: { ...value.structuredContent, wall_time_seconds: 0.1 } }));
  assert.equal(value.structuredContent.wall_time_seconds, 0, 'original result is unchanged');
  for (const [field, changed] of [['output', 'different'], ['exit_code', 1], ['truncated', true]]) {
    assert.notDeepEqual(view(value), view({ ...value, structuredContent: { ...value.structuredContent, [field]: changed } }));
  }
  assert.notDeepEqual(view(value), view({ ...value, args: { command: 'different' } }));
  assert.notDeepEqual(view(value), view({ ...value, content: [{ type: 'text', text: 'different' }] }));
  assert.notDeepEqual(view(value), view({ ...value, argsComplete: false }));
  for (const invalid of [-1, NaN, Infinity, '0.1']) {
    assert.throws(() => view({ ...value, structuredContent: { ...value.structuredContent, wall_time_seconds: invalid } }), assert.AssertionError);
  }
  assert.notDeepEqual(view({ ...value, name: 'write' }),
    view({ ...value, name: 'write', structuredContent: { ...value.structuredContent, wall_time_seconds: 0.1 } }));
});
