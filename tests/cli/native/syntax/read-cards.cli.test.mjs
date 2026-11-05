import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { Terminal } from '../../../fixtures/main-cli-support.mjs';
import { prepareSyntaxNative, captureThenRenderDiagnostics, finish, syntaxReady, traffic, work } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const file = 'read-saved.ts', missing = 'read-missing.txt';
const marker = 'STABLE_text_READ';
const original = ['const HIDDEN_BEFORE = 1;', `export const ${marker} = 73;`,
  'console.log("READ_SAVED_BODY");', 'const HIDDEN_AFTER = 4;', ''].join('\n');
const changed = 'const CHANGED_ON_DISK = 999;\n';
const calls = [{ name: 'read', arguments: { path: file, offset: 2, limit: 2 } },
  { name: 'read', arguments: { path: missing } }];

function readProbeEpochs(terminal) {
  const probes = terminal.events().filter(event => event.type === 'deferred_native_probe');
  assert.ok(probes.length > 0, 'the actual loaded renderer prototype has a preparation observer');
  return probes.map(event => event.epoch);
}

function readMaterializations(terminal) {
  const epochs = new Set(readProbeEpochs(terminal));
  const materializations = terminal.events().filter(event => event.type === 'deferred_native_materialize' && event.tool === 'read');
  assert.ok(materializations.every(event => epochs.has(event.epoch) && event.prototypeMatches === true));
  return materializations;
}

function roleRgb(dump, role) {
  const match = dump.summaryStyles[role].match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/u);
  assert.ok(match, `the configured truecolor theme supplies ${role}`);
  return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]);
}

function compact(dump) {
  const text = dump.screen.join('\n');
  assert.ok(text.includes(file), 'the compact read path is physically visible');
  assert.ok(text.includes(missing), 'the compact failed read remains visible');
  assert.ok(!text.includes(`→ Read ${file}`), 'the read header remains collapsed');
  assert.ok(!text.includes(marker), 'the compact frame does not expose the saved body');
}

async function neutralPaint(dump) {
  const reference = new Terminal({ cols: 1, rows: 1, allowProposedApi: true });
  try {
    await new Promise(done => reference.write(dump.backgroundStyles.toolPendingBg, done));
    const cell = reference.buffer.active.getLine(0).getCell(0);
    return { bg: cell.getBgColor(), bgMode: cell.getBgColorMode() };
  } finally { reference.dispose(); }
}

function cellDifference(expected, actual) {
  const rows = Math.max(expected.cells.length, actual.cells.length);
  for (let y = 0; y < rows; y++) {
    const left = expected.cells[y] ?? [], right = actual.cells[y] ?? [];
    const cols = Math.max(left.length, right.length);
    for (let x = 0; x < cols; x++) if (!isDeepStrictEqual(left[x], right[x])) return {
      y, x, expected: expected.screen[y], actual: actual.screen[y],
      expectedCell: left[x] ?? null, actualCell: right[x] ?? null,
    };
  }
  return { expectedRows: expected.cells.length, actualRows: actual.cells.length };
}

async function full(dump, returned, palette = dump, failedExpanded = true) {
  const { notice, noticeLine } = returned, text = dump.screen.join('\n');
  assert.ok(text.includes(`→ Read ${file}`), 'expansion paints our read card, not the stock read view');
  const y = dump.screen.findIndex(row => row.includes(`export const ${marker} = 73;`));
  assert.ok(y >= 0, 'the returned source is physically painted');
  const row = dump.screen[y], x = row.indexOf('export');
  assert.match(row, /┃\s+2\s+export const/u, 'saved offset supplies line numbering without a diff sign column');
  assert.equal(dump.cells[y][x].fg, roleRgb(palette, 'syntaxKeyword'));
  assert.equal(dump.cells[y][row.indexOf('73')].fg, roleRgb(palette, 'syntaxNumber'));
  const actual = dump.cells[y][x];
  assert.deepEqual({ bg: actual.bg, bgMode: actual.bgMode }, await neutralPaint(palette), 'read code uses the neutral panel, not a write-added surface');
  assert.ok(text.includes('READ_SAVED_BODY'));
  const noticeRow = dump.screen.find(row => row.includes(notice));
  assert.ok(noticeRow, 'the actual tool continuation notice remains verbatim');
  assert.match(noticeRow, new RegExp(`┃\\s+${noticeLine}\\s+\\[`, 'u'), 'the gutter advances over opaque saved rows, not inferred original file positions');
  assert.equal(/ENOENT|no such file/u.test(text), failedExpanded, 'only the deliberately expanded failed read exposes saved error text');
  for (const hidden of ['HIDDEN_BEFORE', 'HIDDEN_AFTER', 'CHANGED_ON_DISK']) assert.ok(!text.includes(hidden), `read does not reconstruct ${hidden}`);
}

function readSourceTexts(terminal) {
  return terminal.events().filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
    .flatMap(event => event.payload.sources ?? []).filter(source => source.hint?.path === file).map(source => source.text);
}

function sourceWork(sample, phase) {
  assert.ok(sample.source && typeof sample.source === 'object', `${phase} reports authoritative source-work counters`);
  return work(sample);
}

async function nativeControl(terminal, name, epochs = new Set(readProbeEpochs(terminal))) {
  await terminal.appearance(false); terminal.send('\x0f');
  await terminal.settle();
  const shown = await terminal.captureCompleteScreen(name, {}), text = shown.screen.join('\n');
  assert.ok(text.includes(marker), 'the actual stock read body is physically visible');
  assert.ok(!text.includes(`→ Read ${file}`), 'Appearance Off does not leave our card on screen');
  const materialized = readMaterializations(terminal).filter(event => epochs.has(event.epoch));
  assert.deepEqual([...new Set(materialized.map(event => event.slot))].sort(), ['call', 'result'], 'both actual stock read slots are observed in the current renderer epoch');
  terminal.send('\x0f'); await terminal.appearance(true);
  return materialized;
}

for (const mode of ['fullscreen', 'regular']) test(`owned read CLI: ${mode} saved text, lazy native control, collapse and exact replay`,
  { timeout: 180000 }, async () => {
    const terminals = [];
    const create = (name, options = {}) => {
      const terminal = new PiTerminal(`read-cards-${mode}-${name}`, { mode, ...options,
        agentSettings: { outputPad: 1, ...options.agentSettings }, extensions: [fixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_CARD_OBSERVE: '1', TIDY_UI_TEST_PALETTE_OBSERVE: '1',
          TIDY_UI_TEST_NATIVE_PREPARATION: '1',
          TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }) } });
      terminals.push(terminal); return terminal;
    };
    try {
      const live = create('live');
      writeFileSync(join(live.work, file), original);
      writeFileSync(join(live.output, 'highlighting-limits.json'), JSON.stringify({ calls }));
      await live.ready(); await syntaxReady(live);
      await live.run('highlighting-limits-read');
      const cold = await captureThenRenderDiagnostics(live, 'read-compact'); compact(cold);
      assert.equal(cold.sample.counts.sourceRequests, 0);
      assert.equal(cold.sample.counts.piCaptures, 0);
      assert.equal(cold.sample.localWork.sourceSegments, 0, 'collapsed reads do not measure their saved text');
      const results = live.events().filter(event => event.type === 'result');
      assert.equal(results.length, 2); assert.equal(results[0].isError, false); assert.equal(results[1].isError, true);
      const savedText = results[0].content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      assert.ok(savedText.includes(marker));
      const notice = savedText.split('\n\n').at(-1);
      assert.ok(notice && notice !== savedText && notice.length < 80, 'the actual limited read returned a visible continuation notice');
      const returned = { notice, noticeLine: calls[0].arguments.offset + savedText.split('\n').indexOf(notice) };
      const session = cold.session, bytes = readFileSync(session), originalTraffic = traffic(live);
      assert.deepEqual(originalTraffic.filter(event => event.type === 'call').map(event => ({ name: event.name, arguments: event.input })), calls);
      writeFileSync(join(live.work, file), changed);

      live.send('\x0f');
      const expanded = await captureThenRenderDiagnostics(live, 'read-expanded'); await full(expanded, returned);
      assert.equal(readMaterializations(live).length, 0, 'our full and compact views never materialize stock read callbacks');
      const sources = readSourceTexts(live);
      assert.ok(sources.length > 0, 'the actual native helper received the expanded read source');
      assert.ok(sources.every(text => text === savedText), 'SOURCE contains only the saved returned text, including its notice');
      assert.ok(expanded.sample.localWork.sourceSegments > 0, 'the read-specific source marker makes measurement counters meaningful');
      const baseline = sourceWork(expanded.sample, 'natural expanded capture');
      const afterDiagnostics = await live.captureSettled('read-after-diagnostics');
      assert.deepEqual(sourceWork(afterDiagnostics.sample, 'post-diagnostic passive capture'), baseline, 'the explicit diagnostic probe adds no source or measurement work');
      const warm = await live.captureSettled('read-warm');
      assert.deepEqual(sourceWork(warm.sample, 'adjacent warm capture'), baseline, 'warm rendering performs no new preparation work');
      assert.ok(isDeepStrictEqual(afterDiagnostics.cells, warm.cells),
        `adjacent natural warm frames keep every screen cell unchanged: ${JSON.stringify(cellDifference(afterDiagnostics, warm))}`);
      await full({ ...expanded, ...warm }, returned, expanded);
      for (const width of [24, 100]) {
        await live.resize(width);
        const resized = await live.captureSettled(`read-width-${width}`);
        assert.deepEqual(sourceWork(resized.sample, `width ${width}`), baseline, 'width-only changes reuse source/style and measured glyphs');
      }
      const wideAgain = await captureThenRenderDiagnostics(live, 'read-wide-again');
      await full(wideAgain, returned);
      assert.deepEqual(sourceWork(wideAgain.sample, 'return to original width'), baseline, 'returning to the original width reuses the prepared source and measured rows');
      await live.command('/tidy-ui-theme light');
      const light = await captureThenRenderDiagnostics(live, 'read-light'); await full(light, returned);
      assert.equal(light.sample.counts.sourceRequests, wideAgain.sample.counts.sourceRequests);
      assert.equal(light.sample.localWork.sourceSegments, wideAgain.sample.localWork.sourceSegments,
        'theme-only palette change must not remeasure source');
      await live.command('/tidy-ui-theme dark');
      await full(await captureThenRenderDiagnostics(live, 'read-dark-again'), returned);

      live.send('\x0f');
      const collapsed = await captureThenRenderDiagnostics(live, 'read-collapsed'); compact(collapsed);
      assert.equal(collapsed.outputPad, 1, 'the margin click is issued only after the public Pi setting is observed');
      const collapseWarm = await live.captureSettled('read-collapsed-warm');
      assert.deepEqual(sourceWork(collapseWarm.sample, 'collapsed warm capture'), sourceWork(collapsed.sample, 'collapsed capture'));
      assert.equal(readMaterializations(live).length, 0);
      if (mode === 'fullscreen') {
        const y = collapsed.screen.findIndex(row => row.includes(file));
        live.send(`\x1b[<0;1;${y + 1}M\x1b[<0;1;${y + 1}m`);
        const margin = await captureThenRenderDiagnostics(live, 'read-margin-click'); compact(margin);
        assert.deepEqual(sourceWork(margin.sample, 'margin click'), sourceWork(collapsed.sample, 'collapsed capture'), 'a rejected margin click admits no body work');
        live.send(`\x1b[<0;8;${y + 1}M\x1b[<0;8;${y + 1}m`);
        const clicked = await captureThenRenderDiagnostics(live, 'read-click-expanded');
        await full(clicked, returned, clicked, false);
        assert.doesNotMatch(clicked.screen.join('\n'), /ENOENT|no such file/u, 'the neighboring failed read stays compact');
        const title = clicked.screen.findIndex(row => row.includes(`→ Read ${file}`));
        live.send(`\x1b[<0;8;${title + 1}M\x1b[<0;8;${title + 1}m`);
        const unclicked = await captureThenRenderDiagnostics(live, 'read-click-collapsed'); compact(unclicked);
        assert.doesNotMatch(unclicked.screen.join('\n'), /ENOENT|no such file/u);
        assert.equal(readMaterializations(live).length, 0);
      }
      for (const pass of [2, 3]) {
        live.send('\x0f');
        const reopened = await captureThenRenderDiagnostics(live, `read-reopened-${pass}`);
        await full(reopened, returned);
        assert.equal(readMaterializations(live).length, 0, 'reopening the complete saved body keeps both stock callbacks cold');
        live.send('\x0f');
        compact(await captureThenRenderDiagnostics(live, `read-recollapsed-${pass}`));
      }
      const native = await nativeControl(live, 'read-native-positive');
      compact(await captureThenRenderDiagnostics(live, 'read-owned-again'));
      const materialized = readMaterializations(live).length, epochsBeforeReload = new Set(readProbeEpochs(live));
      const starts = live.events().filter(event => event.type === 'start').length;
      await live.command('/reload'); await live.event('start', starts + 1);
      const reloaded = await captureThenRenderDiagnostics(live, 'read-reloaded'); compact(reloaded);
      assert.equal(reloaded.sample.counts.sourceRequests, 0);
      assert.equal(reloaded.sample.localWork.sourceSegments, 0);
      const reloadedEpochs = new Set(readProbeEpochs(live).filter(epoch => !epochsBeforeReload.has(epoch)));
      assert.ok(reloadedEpochs.size > 0, 'the reloaded extension installs a new observer epoch');
      const afterReload = readMaterializations(live);
      const reloadEvents = afterReload.slice(materialized).map(event => ({ epoch: event.epoch, tool: event.tool, slot: event.slot, callId: event.callId, phase: event.phase, prototypeMatches: event.prototypeMatches }));
      const reloadRows = reloaded.screen.map((row, index) => ({ index, text: row })).filter(({ text }) => /→ Read|read-saved\\.ts|READ_SAVED_BODY|STABLE_text_READ|ENOENT|no such file/iu.test(text));
      const reloadLifecycle = live.events().filter(event => event.type === 'start' || event.type === 'deferred_native_probe' || event.type === 'deferred_native_materialize');
      assert.equal(afterReload.length, materialized,
        `reload does not materialize restored stock read views; new=${JSON.stringify(reloadEvents)} rows=${JSON.stringify(reloadRows)} lifecycle=${JSON.stringify(reloadLifecycle.slice(-12).map(event => ({ type: event.type, epoch: event.epoch, tool: event.tool, slot: event.slot })))} calls=${JSON.stringify(traffic(live).filter(event => event.type === 'call').map(event => ({ toolCallId: event.toolCallId ?? event.id, name: event.name })))}`);
      await nativeControl(live, 'read-reload-native-positive', reloadedEpochs);
      compact(await captureThenRenderDiagnostics(live, 'read-reload-owned-again'));
      assert.deepEqual(traffic(live), originalTraffic);
      assert.deepEqual(readFileSync(session), bytes, 'UI operations leave the saved session byte-for-byte unchanged');
      assert.equal(readFileSync(join(live.work, file), 'utf8'), changed);
      await finish(live);

      const replay = create('replay', { session, workspace: live.work });
      await replay.ready();
      const replayCold = await captureThenRenderDiagnostics(replay, 'read-replay-compact'); compact(replayCold);
      assert.equal(replayCold.sample.counts.sourceRequests, 0);
      assert.equal(replayCold.sample.localWork.sourceSegments, 0);
      replay.send('\x0f');
      const replayFull = await captureThenRenderDiagnostics(replay, 'read-replay-full'); await full(replayFull, returned);
      assert.ok(readSourceTexts(replay).every(text => text === savedText));
      assert.ok(readSourceTexts(replay).length > 0);
      assert.equal(readMaterializations(replay).length, 0);
      assert.deepEqual(sourceWork((await replay.captureSettled('read-replay-warm')).sample, 'replay warm capture'), sourceWork(replayFull.sample, 'replay expanded capture'));
      replay.send('\x0f');
      compact(await captureThenRenderDiagnostics(replay, 'read-replay-collapsed'));
      await nativeControl(replay, 'read-replay-native-positive');
      compact(await captureThenRenderDiagnostics(replay, 'read-replay-owned-again'));
      assert.equal(traffic(replay).length, 0, 'replay and expansion execute no tools or model requests');
      assert.deepEqual(readFileSync(session), bytes);
      assert.equal(readFileSync(join(replay.work, file), 'utf8'), changed);
      console.log(JSON.stringify({ readCards: { mode, live: live.output, replay: replay.output,
        calls: originalTraffic.filter(event => event.type === 'call').length, nativePositive: native.length,
        expanded: expanded.sample.counts, replayExpanded: replayFull.sample.counts, work: baseline } }));
      await finish(replay);
    } finally { await closeTerminals(terminals); }
  });


test('read first-column hit remains valid with Output padding disabled', { timeout: 120000 }, async () => {
  const terminal = new PiTerminal('read-cards-padding-zero', { mode: 'fullscreen', agentSettings: { outputPad: 0 },
    extensions: [fixture], extraEnv: { ...descriptor, TIDY_UI_TEST_CARD_OBSERVE: '1',
      TIDY_UI_TEST_PALETTE_OBSERVE: '1', TIDY_UI_TEST_NATIVE_PREPARATION: '1',
      TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }) } });
  try {
    writeFileSync(join(terminal.work, file), original);
    writeFileSync(join(terminal.output, 'highlighting-limits.json'), JSON.stringify({ calls }));
    await terminal.ready(); await syntaxReady(terminal); await terminal.run('highlighting-limits-read');
    const collapsed = await captureThenRenderDiagnostics(terminal, 'read-padding-zero-compact'); compact(collapsed);
    assert.equal(collapsed.outputPad, 0, 'the public Pi setting is observed before clicking the first content column');
    const y = collapsed.screen.findIndex(row => row.includes(file));
    terminal.send(`\x1b[<0;1;${y + 1}M\x1b[<0;1;${y + 1}m`);
    const expanded = await captureThenRenderDiagnostics(terminal, 'read-padding-zero-expanded');
    assert.ok(expanded.screen.some(row => row.includes(`→ Read ${file}`)), 'column one belongs to the card when there is no outer padding');
    await finish(terminal);
  } finally { await closeTerminals([terminal]); }
});
