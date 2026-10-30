import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { Theme } from '@earendil-works/pi-coding-agent';
import { colorToHex, visibleWidth } from '@earendil-works/pi-tui';
import xterm from '@xterm/headless';
import { readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { sharedPiIsolationHost, sharedPiProgress } from '../../../fixtures/shared-pi-isolation.mjs';
import { createSemanticRuleDefinition } from '../../../../src/syntax/semantic-rules.ts';
import { samplePiBindings } from '../../../../src/syntax/pi-bindings.ts';
import { samplePiCardPalette } from '../../../../src/syntax/pi-palette.ts';
import { fingerprintRules } from '../../../../src/occipital/style-rules.ts';
import { measure, reflow } from '../../../../src/syntax/measured-rows.ts';
import { compileStyleAnsi } from '../../../../src/syntax/style-ansi.ts';
import { paintFlat } from '../../../../src/syntax/flat-paint.ts';

const inputs = readInputs(), binary = validateNative(inputs);
const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { getThemeByName } = await import(pathToFileURL(resolve(dist, 'modes/interactive/theme/theme.js')).href);
const text = '//consumer\nlet value = 42;\n', key = 'shared-source';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Complete public Themes, not theme-like objects or simplified ANSI formatters.
// Built-in dark/light colors plus a declared public faint token exercise local
// typography independently as well as different foregrounds and panel surfaces.
function publicTheme(name, faint) {
  const original = getThemeByName(name); assert.ok(original);
  const backgrounds = new Set(['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']);
  const fg = {}, bg = {};
  for (const [role, color] of Object.entries(original.colors)) (backgrounds.has(role) ? bg : fg)[role] = colorToHex(color);
  return new Theme(fg, bg, 'truecolor', { name: `shared-${name}`, dim: faint ? ['syntaxComment'] : [] });
}
function bind(client, theme, revision) {
  assert.equal(client.sources.setStyleSelection({ definition: createSemanticRuleDefinition(),
    bindings: samplePiBindings(theme), roles: samplePiCardPalette(theme), bindingRevision: revision, palette: `pi:${revision}` }), true);
}
function observe(client) {
  const effective = client.snapshot().effective; assert.equal(effective.id, 'pi');
  client.sources.observe({ key, version: 1, language: 'rust', text, complete: false });
  client.sources.flush();
}
async function ready(client) {
  assert.equal(await client.whenSettled(), true, 'existing producers settle through the public completion boundary');
  const stats = client.sources.stats();
  assert.ok(client.sources.displayBasis(key));
  assert.equal(stats.unsettledJobs, 0); assert.equal(stats.pendingCloses, 0);
}
function traffic(client) {
  const broker = client.broker.stats(), source = client.sources.stats();
  return { source: broker.sourceDispatches, style: broker.styleDispatches, accepted: broker.successfulClassifications,
    committedLineCalls: source.committedLineCalls, committedLineBytes: source.committedLineBytes,
    tailCalls: source.tailCalls, tailBytes: source.tailBytes };
}
function spy(t, client) {
  const request = client.broker.request, records = [];
  t.mock.method(client.broker, 'request', async function(...args) {
    const record = { request: structuredClone(args[1]) }; records.push(record);
    const reply = await request.apply(this, args); record.reply = structuredClone(reply); return reply;
  });
  return records;
}
function geometry(client) {
  const funding = client.sources.geometryFunding(); assert.ok(funding);
  const measured = measure(text, funding.budget, funding.grant); assert.ok(measured);
  return { measured, funding };
}
function paint(client, geometry, width) {
  const basis = client.sources.displayBasis(key); assert.ok(basis);
  const { funding, measured } = geometry, layout = reflow(measured, { mode: 'file', width }, funding.grant); assert.ok(layout);
  let painted;
  try {
    assert.equal(basis.visit((source, ranges) => {
      assert.equal(source, text);
      painted = paintFlat(source, measured, layout, consume => ranges((start, end, style) => consume(start, end, compileStyleAnsi(style, 'truecolor'))),
        compileStyleAnsi(basis.role('code'), 'truecolor'), compileStyleAnsi(basis.role('prompt'), 'truecolor'), Buffer.byteLength(source), funding.budget, funding.grant);
    }), true);
    assert.ok(painted); const rows = []; assert.equal(painted.visitRows((_index, row) => rows.push(row)), true); return rows;
  } finally { painted?.dispose(); layout.dispose(); }
}
// Whitespace filtering is only for selected-token color comparisons.
async function tokenCells(rows) {
  const terminal = new xterm.Terminal({ cols: Math.max(2, ...rows.map(visibleWidth)) + 1, rows: rows.length + 2, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(rows.join('\r\n'), resolve));
    return rows.flatMap((_row, y) => Array.from({ length: terminal.cols }, (_, x) => {
      const cell = terminal.buffer.active.getLine(y).getCell(x);
      return { text: cell.getChars(), fg: cell.getFgColor(), bg: cell.getBgColor(), rgbFg: cell.isFgRGB(), rgbBg: cell.isBgRGB(),
        bold: !!cell.isBold(), dim: !!cell.isDim(), italic: !!cell.isItalic(), underline: !!cell.isUnderline() };
    })).filter(cell => cell.text.trim());
  } finally { terminal.dispose(); }
}
function token(cells, value) {
  const start = cells.map(cell => cell.text).join('').indexOf(value); assert.ok(start >= 0, `missing ${value}`); return cells.slice(start, start + value.length);
}
async function exactUnwrappedText(rows, source) {
  const expected = source.split('\n');
  assert.ok(expected.every(row => /^[\x20-\x7e]*$/.test(row)), 'this independent oracle uses the ASCII fixture, one cell per character');
  assert.deepEqual(rows.map(stripVTControlCharacters), expected, 'exact unwrapped source rows, including spaces and final empty row');
  // Terminal dimensions and source boundaries come only from the independent
  // fixture, never the painter's measurements or output width. No source trim.
  const terminal = new xterm.Terminal({ cols: Math.max(2, ...expected.map(row => row.length)) + 1, rows: expected.length + 1, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(rows.join('\r\n'), resolve));
    const positioned = expected.map((row, y) => Array.from({ length: row.length }, (_unused, x) => terminal.buffer.active.getLine(y).getCell(x).getChars()).join(''));
    assert.deepEqual(positioned, expected, 'source characters occupy their exact rendered row and column');
    assert.equal(terminal.buffer.active.cursorY, expected.length - 1);
    assert.equal(terminal.buffer.active.cursorX, expected.at(-1).length);
    return positioned;
  } finally { terminal.dispose(); }
}
async function checkPaint(rows, theme, width = 80) {
  const actual = await tokenCells(rows), receipt = {};
  if (width >= Math.max(...text.split('\n').map(row => row.length))) receipt.unwrappedText = await exactUnwrappedText(rows, text);
  for (const [value, role] of [['//consumer', 'syntaxComment'], ['42', 'syntaxNumber']]) {
    // Oracle is Pi's public Theme transfer parsed independently by xterm, not
    // samplePiBindings/materializeStyle or the expressions under test.
    const expected = await tokenCells([theme.bg('toolPendingBg', theme.fg(role, value))]);
    const selected = token(actual, value); assert.deepEqual(selected, expected);
    receipt[role] = { ...selected[0], token: value, cellsChecked: selected.length };
  }
  return receipt;
}
function generic(records) {
  const styles = records.filter(record => record.request.op === 'styles.resolve'); assert.equal(styles.length, 1);
  const { request, reply } = styles[0]; assert.equal(reply.status, 'ok'); assert.equal(Object.hasOwn(reply.body, 'palette'), false);
  assert.deepEqual(request.rules, createSemanticRuleDefinition());
  assert.equal(reply.body.rules, fingerprintRules(createSemanticRuleDefinition()));
  assert.ok(request.contexts.length > 0); assert.ok(reply.body.styles.length > 0);
  for (const style of reply.body.styles) for (const ink of [style.foreground, style.background]) assert.ok(['binding', 'inherit'].includes(ink.kind), 'shared result contains only symbolic Pi colors');
  assert.ok(reply.body.styles.some(style => style.foreground.kind === 'binding' && style.foreground.slot === 0));
  assert.ok(reply.body.styles.some(style => style.foreground.kind === 'binding' && style.foreground.slot === 3));
  return { vocabulary: request.vocabulary, contexts: request.contexts, rules: reply.body.rules,
    indices: reply.body.indices, styles: reply.body.styles, declaration: request.rules };
}
function released(peer, funding) {
  const stats = peer.client.sources.stats(), transport = peer.transport().stats();
  assert.equal(stats.retention.retainedBytes, 0); assert.equal(stats.unsettledJobs, 0); assert.equal(stats.pendingCloses, 0);
  assert.equal(stats.transientBytes, 0); assert.equal(stats.remoteLeases, 0); assert.equal(stats.bookkeepingBytes, 0);
  assert.equal(funding.budget.stats().retainedBytes, 0); assert.equal(funding.budget.stats().outstandingPeakBytes, 0);
  assert.equal(transport.state, 'closed');
  for (const name of ['unsettledData', 'unsettledControl', 'dataReservedBytes', 'controlReservedBytes', 'encodedRequestBytes', 'liveTimers', 'abortListeners']) assert.equal(transport[name], 0, name);
  return { source: stats, budget: funding.budget.stats(), transport };
}

test('shared Follow Pi text oracle: exact source spaces and logical rows reject omissions', async () => {
  const rows = text.split('\n');
  assert.deepEqual(await exactUnwrappedText(rows, text), ['//consumer', 'let value = 42;', '']);
  await assert.rejects(exactUnwrappedText([rows[0], 'letvalue = 42;', rows[2]], text), { code: 'ERR_ASSERTION' });
  await assert.rejects(exactUnwrappedText([rows[0] + rows[1], rows[2]], text), { code: 'ERR_ASSERTION' });
  console.log('Exact text oracle sensitivity: missing source space and merged logical lines both rejected.');
});

test('shared Follow Pi: two actual consumers isolate public palettes and typography over identical symbolic rules', { timeout: 60000 }, async t => {
  const host = await sharedPiIsolationHost(inputs, binary.path);
  let a, b, ga, gb, evidence;
  try {
    a = await host.peer();
    const singleRouteBaseline = await a.describe();
    assert.equal(singleRouteBaseline.runtime.leases, 0); assert.equal(singleRouteBaseline.runtime.data_jobs, 0);
    b = await host.peer();
    assert.notEqual(a.transport(), b.transport()); assert.equal(host.pids.size, 1);
    const baseline = await b.describe();
    assert.equal(baseline.runtime.leases, 0); assert.equal(baseline.runtime.data_jobs, 0);
    const dark = publicTheme('dark', true), light = publicTheme('light', false);
    const ra = spy(t, a.client), rb = spy(t, b.client);
    bind(a.client, dark, 1); bind(b.client, light, 1);
    observe(a.client); observe(b.client); await Promise.all([ready(a.client), ready(b.client)]);
    const cold = [traffic(a.client), traffic(b.client)];
    for (const progress of cold) {
      assert.equal(progress.source, 1); assert.equal(progress.style, 1); assert.equal(progress.accepted, 1);
      assert.equal(progress.committedLineCalls, 2); assert.equal(progress.committedLineBytes, Buffer.byteLength(text));
    }
    const genericA = generic(ra), genericB = generic(rb); assert.deepEqual(genericA, genericB);
    ga = geometry(a.client); gb = geometry(b.client);
    const firstA = paint(a.client, ga, 80), firstB = paint(b.client, gb, 80);
    const colors = [await checkPaint(firstA, dark), await checkPaint(firstB, light)];
    assert.notEqual(colors[0].syntaxComment.fg, colors[1].syntaxComment.fg);
    assert.notEqual(colors[0].syntaxComment.bg, colors[1].syntaxComment.bg);
    assert.equal(colors[0].syntaxComment.dim, true); assert.equal(colors[1].syntaxComment.dim, false);
    const live = await b.describe();
    assert.equal(live.runtime.leases, 2); assert.equal(live.runtime.data_jobs, 0);
    for (let frame = 0; frame < 10; frame++) {
      observe(a.client); observe(b.client);
      assert.deepEqual(paint(a.client, ga, 80), firstA); assert.deepEqual(paint(b.client, gb, 80), firstB);
    }
    await Promise.all([ready(a.client), ready(b.client)]); assert.deepEqual([traffic(a.client), traffic(b.client)], cold);
    // Each client's same palette revision number is deliberately independent.
    // Rebinding A cannot change B's already-ready display or generic definition.
    bind(a.client, light, 2); await ready(a.client);
    await checkPaint(paint(a.client, ga, 80), light); assert.deepEqual(paint(b.client, gb, 80), firstB);
    bind(b.client, dark, 2); await ready(b.client);
    const rebound = [await checkPaint(paint(a.client, ga, 80), light), await checkPaint(paint(b.client, gb, 80), dark)];
    for (const width of [12, 24, 80]) {
      await checkPaint(paint(a.client, ga, width), light, width); await checkPaint(paint(b.client, gb, width), dark, width);
    }
    await Promise.all([ready(a.client), ready(b.client)]);
    assert.deepEqual([traffic(a.client), traffic(b.client)], cold); assert.deepEqual(generic(ra), genericA); assert.deepEqual(generic(rb), genericB);
    const warmRebindWidthDelta = cold.map((before, i) => Object.fromEntries(Object.keys(before).map(name => [name, traffic([a, b][i].client)[name] - before[name]])));
    for (const delta of warmRebindWidthDelta) assert.ok(Object.values(delta).every(value => value === 0));
    const survivorBasis = b.client.sources.displayBasis(key), survivorRows = paint(b.client, gb, 80), survivorBytes = gb.funding.budget.stats().retainedBytes;
    assert.ok(ga.funding.budget.stats().retainedBytes > 0); assert.ok(survivorBytes > 0);
    ga.measured.dispose(); await a.client.dispose();
    await sharedPiProgress(() => !a.client.sources.stats().unsettledJobs && !a.client.sources.stats().pendingCloses);
    const departed = released(a, ga.funding);
    const afterDeparture = await sharedPiProgress(async () => {
      const description = await b.describe();
      return description.runtime.leases === 1 && description.runtime.data_jobs === 0 && description;
    });
    assert.equal(afterDeparture.runtime.pid, live.runtime.pid);
    assert.equal(survivorBasis.visit(() => {}), true, 'departing route cannot invalidate survivor ready reader');
    assert.equal(gb.measured.isValid, true); assert.equal(gb.funding.budget.stats().retainedBytes, survivorBytes);
    assert.deepEqual(paint(b.client, gb, 80), survivorRows); await checkPaint(survivorRows, dark);
    observe(b.client); await ready(b.client); assert.deepEqual(traffic(b.client), cold[1]);
    b.client.sources.remove(key); await sharedPiProgress(() => { b.client.sources.flush(); return !b.client.sources.stats().pendingCloses && !b.client.sources.stats().unsettledJobs; });
    const empty = await b.describe();
    assert.equal(empty.runtime.leases, 0); assert.equal(empty.runtime.data_jobs, 0);
    assert.equal(empty.runtime.data_bytes, singleRouteBaseline.runtime.data_bytes, 'native source charges return to the measured no-source baseline');
    gb.measured.dispose(); await b.client.dispose();
    await sharedPiProgress(() => !b.client.sources.stats().unsettledJobs && !b.client.sources.stats().pendingCloses);
    const survivorReleased = released(b, gb.funding);
    assert.equal(b.client.sources.stats().globalTransientBytes, 0); assert.equal(b.client.sources.stats().globalUnsettledJobs, 0);
    evidence = { sharedPiIsolation: true, node: process.version, source: inputs.source, helper: binary, sharedHost: inputs.sharedHost,
      managedPid: live.runtime.pid, cold, generic: genericA, genericSha256: hash(genericA), colors, rebound,
      warmRebindWidthDelta, operations: [ra, rb].map(records => records.map(record => record.request.op)),
      native: { singleRouteBaseline: singleRouteBaseline.runtime, baseline: baseline.runtime, both: live.runtime, afterDeparture: afterDeparture.runtime, empty: empty.runtime },
      survivorRetainedBytes: survivorBytes, departed, survivorReleased };
  } finally {
    ga?.measured.dispose(); gb?.measured.dispose(); await host.close();
  }
  console.log(JSON.stringify({ ...evidence, cleanup: { hostReaped: true, helperReaped: true, privateRootRemoved: true } }));
});
