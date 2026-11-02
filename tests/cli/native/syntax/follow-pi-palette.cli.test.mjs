import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { createSyntaxStockReferences, assertSyntaxStockReference } from '../../../fixtures/syntax-stock-reference.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { paintPreviewProof, paintProof, publications } from '../../../fixtures/follow-pi-physical.mjs';
import { prepareSyntaxNative, stats, settledStats, captureThenRenderDiagnostics, work, traffic, persisted, body, finish, until, syntaxReady } from '../../../fixtures/syntax-cli-support.mjs';

const { fixture, descriptor } = await prepareSyntaxNative();
const markers = ['FOLLOW_PI_BASH', 'FOLLOW_PI_HEADING', 'gone', 'fixed', 'FOLLOW_PI_TAIL'];
async function trailingBash(terminal) {
  // Reuse the existing explicit built-in call feed without a streaming gate.
  writeFileSync(join(terminal.output, 'highlighting-limits.json'), JSON.stringify({ calls: [{ name: 'bash', arguments: { command: "printf '%s\\n' FOLLOW_PI_TAIL" } }] }));
  terminal.send('run highlighting-limits-bash\r'); await terminal.event('agent_end', 2);
}
const rgb = (dump, role) => {
  const match = dump.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/);
  assert.ok(match, `public truecolor ${role}`);
  return +match[1] * 65536 + +match[2] * 256 + +match[3];
};
function assertFollowPiPreview(dump) {
  const text = body(dump).filter(({ name }) => name === 'write' || name === 'edit').flatMap(({ lines }) => lines).join('\n');
  assert.match(text, /← Write follow-pi\.md/u);
  assert.match(text, /← Edit follow-pi\.md/u);
  assert.doesNotMatch(text, /← Wrote follow-pi\.md|← Edited follow-pi\.md/u);
  assert.match(text, /Preview is limited to a bounded source prefix/u);
  assert.match(text, /Click to expand/u);
  assert.doesNotMatch(text, /LIST_HEADING/u, 'rows beyond the restored prefix are not shown yet');
}
function savedDiffSources(patch) {
  assert.ok(patch.startsWith('--- ') && patch.includes('\n@@ '), 'the expected file fragments come from the saved unified diff');
  const oldRows = [], newRows = [];
  for (const row of patch.split(/\r?\n/u)) {
    if (row.startsWith('--- ') || row.startsWith('+++ ') || row.startsWith('@@ ')) continue;
    if (row.startsWith(' ')) { oldRows.push(row.slice(1)); newRows.push(row.slice(1)); }
    else if (row.startsWith('-')) oldRows.push(row.slice(1));
    else if (row.startsWith('+')) newRows.push(row.slice(1));
  }
  return [oldRows.join('\n'), newRows.join('\n')];
}
function fileSourceEvents(events) {
  return events.filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
    .flatMap(event => event.payload.sources).filter(source => source.hint?.path === 'follow-pi.md');
}

const stock = createSyntaxStockReferences(async mode => {
  const terminal = new PiTerminal(`follow-pi-stock-${mode}`, { mode, tidyUi: false, extraEnv: { TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
  try {
    await terminal.ready(); terminal.send('run follow-pi-palette\r'); await terminal.event('agent_end');
    await trailingBash(terminal);
    const shown = await terminal.capture('follow-pi-stock');
    const result = { traffic: traffic(terminal), persisted: persisted(shown), output: terminal.output };
    await terminal.close(); return result;
  } finally { await closeTerminals([terminal]); }
});

for (const mode of ['fullscreen', 'regular']) test(`Follow Pi CLI: ${mode} real nested strike/colors, atomic theme rebind, warm counters and exact replay`, { timeout: 120000 }, async () => {
  const terminals = [], create = (name, options = {}) => {
    const { extraEnv = {}, ...rest } = options;
    const terminal = new PiTerminal(`follow-pi-${mode}-${name}`, { mode, tidyUi: false, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_CARD_OBSERVE: '1', TIDY_UI_TEST_PALETTE_OBSERVE: '1',
        TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }), ...extraEnv }, ...rest });
    terminals.push(terminal); return terminal;
  };
  try {
    const terminal = create('live'); await terminal.ready(); await syntaxReady(terminal);
    terminal.send('run follow-pi-palette\r'); await terminal.event('agent_end');
    await trailingBash(terminal);
    const dark = await captureThenRenderDiagnostics(terminal, 'follow-pi-dark'), cold = dark.sample;
    assert.ok(await semanticPhaseReady(() => cold, () => terminal.events(), markers, 'pi'), 'all actual Pi semantic source/style replies');
    paintProof(dark);
    assert.ok(cold.localWork.paletteSamples > 0); assert.ok(cold.localWork.sourceSegments > 0);
    assert.equal(cold.counts.piCaptures, 0); assert.equal(cold.counts.piBridges, 0);
    for (const width of [60, 24, 140, 100]) { await terminal.resize(width); await terminal.capture(`follow-pi-width-${width}`); }
    await terminal.observeAnimation(); const warm = await settledStats(terminal, 'warm');
    assert.deepEqual(work(warm), work(cold), 'warm frames/reflow do not sample/derive, parse, resolve, measure or reread source scalars');
    const before = publications(terminal); assert.equal(before.size, 4);
    writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'light');
    await terminal.command('/tidy-ui-theme light');
    const light = await captureThenRenderDiagnostics(terminal, 'follow-pi-light'); paintProof(light);
    const current = publications(terminal);
    assert.ok([...before].every(([id, prior]) => current.get(id)?.phase === 'light' && current.get(id).paintStamp !== prior.paintStamp),
      'all four owned cards publish current light palette');
    assert.notEqual(rgb(light, 'mdHeading'), rgb(dark, 'mdHeading'));
    const recolored = light.sample;
    assert.equal(recolored.counts.sourceRequests, cold.counts.sourceRequests); assert.equal(recolored.counts.styleRequests, cold.counts.styleRequests);
    assert.equal(recolored.localWork.sourceSegments, cold.localWork.sourceSegments); assert.equal(recolored.localWork.prefixScalarReads, cold.localWork.prefixScalarReads);
    assert.ok(recolored.localWork.paletteSamples > cold.localWork.paletteSamples);
    await terminal.observeAnimation(); assert.deepEqual(work(await settledStats(terminal, 'light-warm')), work(recolored));
    await terminal.command('/tidy-ui-theme dark');
    const back = await captureThenRenderDiagnostics(terminal, 'follow-pi-rollback'); paintProof(back);
    const row = back.screen.findIndex(line => line.includes('FOLLOW_PI_HEADING'));
    assert.ok(row >= 0, 'real public dark rollback');
    assert.equal(back.cells[row][back.screen[row].indexOf('FOLLOW_PI_HEADING')].fg, rgb(dark, 'mdHeading'));
    assert.deepEqual(body(back), body(dark));
    const liveTraffic = traffic(terminal), saved = persisted(dark), session = dark.session, workspace = terminal.work;
    const final = await settledStats(terminal, 'final');
    assert.equal(final.counts.sourceRequests, cold.counts.sourceRequests); assert.equal(final.counts.styleRequests, cold.counts.styleRequests);
    await finish(terminal);
    const replay = create('replay', { session, workspace, extraEnv: { TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE: '1' } }); await replay.ready();
    await replay.event('syntax_acquire_gate');
    await until(async () => (await stats(replay, 'replay-before-provider')).counts.piCaptures === 3, 'three finite file fallback captures before helper admission');
    await replay.capture('follow-pi-replay-initial-fallback');
    writeFileSync(join(replay.output, 'syntax-acquire-go'), 'go');
    const restored = await captureThenRenderDiagnostics(replay, 'follow-pi-replay'), replayCold = restored.sample;
    assert.ok(await semanticPhaseReady(() => replayCold, () => replay.events(), markers, 'pi'), 'replay actual source/style publication');
    assert.equal(restored.tools.at(-1).name, 'bash', 'the newest registry entry is not a file');
    assertFollowPiPreview(restored); paintPreviewProof(restored);
    const captures = replay.events().filter(event => event.type === 'follow_pi_capture' && event.accepted);
    assert.equal(captures.length, 3, 'the write and both edit fragments each have one finite fallback capture before expansion');
    const sources = replay.events().filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
      .flatMap(event => event.payload.sources);
    // Protocol SOURCE keys are opaque, not the adapter's Pi-capture keys.
    assert.deepEqual(sources.filter(source => source.hint?.path === 'follow-pi.md').map(source => source.text).sort(),
      captures.map(capture => capture.text).sort(), 'every initial captured fragment gets its first native SOURCE before expansion');
    assert.deepEqual(persisted(restored), saved);
    assert.equal(traffic(replay).length, 0);
    await replay.observeAnimation();
    assert.equal(replayCold.counts.sourceRequests, 5, 'two Bash commands plus three bounded file fragments are each parsed once');
    assert.deepEqual(work(await settledStats(replay, 'replay-preview-warm')), work(replayCold));

    const beforeExpand = replay.events().length;
    replay.send('\x0f'); await replay.settle();
    const expanded = await captureThenRenderDiagnostics(replay, 'follow-pi-expanded'), expandedCold = expanded.sample;
    const expandedFileSources = fileSourceEvents(replay.events().slice(beforeExpand));
    const expandedToolInputs = expanded.tools.filter(tool => tool.name === 'write' || tool.name === 'edit');
    const expectedFullSources = [expandedToolInputs.find(tool => tool.name === 'write')?.args.content,
      ...savedDiffSources(expandedToolInputs.find(tool => tool.name === 'edit')?.details?.patch ?? '')];
    assert.equal(expandedFileSources.length, expectedFullSources.length, 'expansion dispatches one source per full write/diff-side fragment and no Bash source');
    assert.deepEqual(expandedFileSources.map(source => source.text).sort(), expectedFullSources.sort(), 'full SOURCE texts are derived from the complete write content and saved edit patch');
    assert.equal(expandedCold.counts.sourceRequests - replayCold.counts.sourceRequests, expectedFullSources.length, 'the cold expansion delta is exactly the newly exposed full fragments');
    assert.ok(await semanticPhaseReady(() => expandedCold, () => replay.events(), markers, 'pi'), 'explicit full view has current semantic source/style');
    paintProof(expanded);
    assert.deepEqual(body(expanded), body(dark), 'deliberate full view restores the complete live file rows and physical palette');
    assert.deepEqual(persisted(expanded), saved); assert.equal(traffic(replay).length, 0);
    await replay.observeAnimation();
    const expandedWarm = await settledStats(replay, 'replay-full-warm');
    assert.deepEqual(work(expandedWarm), work(expandedCold), 'full-view work settles once; warm frames add none');

    const beforeCollapse = replay.events().length;
    replay.send('\x0f'); await replay.settle();
    const collapsed = await captureThenRenderDiagnostics(replay, 'follow-pi-collapsed');
    const collapsedFileSources = fileSourceEvents(replay.events().slice(beforeCollapse));
    assert.equal(collapsedFileSources.length, captures.length, 'returning to the prefix reclassifies only the three previously captured file fragments');
    assert.deepEqual(collapsedFileSources.map(source => source.text).sort(), captures.map(capture => capture.text).sort(), 'collapse SOURCE texts match the exact initial bounded prefixes');
    assertFollowPiPreview(collapsed); paintPreviewProof(collapsed);
    assert.deepEqual(persisted(collapsed), saved); assert.equal(traffic(replay).length, 0);
    const collapsedCold = await settledStats(replay, 'replay-collapsed');
    assert.equal(collapsedCold.counts.sourceRequests - expandedCold.counts.sourceRequests, captures.length, 'collapse work matches exactly the previously captured bounded fragments');
    await replay.observeAnimation();
    const collapsedWarm = await settledStats(replay, 'replay-collapsed-warm');
    assert.deepEqual(work(collapsedWarm), work(collapsedCold), 'once the returned bounded source view settles, warm frames add no work');

    const reloadBoundary = replay.events().length;
    unlinkSync(join(replay.output, 'syntax-acquire-go'));
    await replay.command('/reload'); await replay.event('syntax_acquire_gate', 2);
    await until(async () => (await stats(replay, 'reload-before-provider')).counts.piCaptures === 3, 'reload establishes finite fallback before helper admission');
    writeFileSync(join(replay.output, 'syntax-acquire-go'), 'go');
    const reloaded = await captureThenRenderDiagnostics(replay, 'follow-pi-reloaded');
    const reloadCold = reloaded.sample;
    assert.ok(await semanticPhaseReady(() => reloadCold, () => replay.events().slice(reloadBoundary), markers, 'pi'), 'new reload SOURCE and STYLE replies, not prior-run evidence');
    assertFollowPiPreview(reloaded); paintPreviewProof(reloaded);
    assert.deepEqual(body(reloaded), body(collapsed)); assert.deepEqual(persisted(reloaded), saved); assert.equal(traffic(replay).length, 0);
    assert.equal(reloadCold.counts.sourceRequests, 5);
    await replay.observeAnimation(); assert.deepEqual(work(await settledStats(replay, 'reload-warm')), work(reloadCold));
    console.log(JSON.stringify({ followPiPhysical: { mode, live: terminal.output, replay: replay.output,
      cold: work(cold), warm: work(warm), recolored: work(recolored), final: work(final), replayCold: work(replayCold),
      expandedCold: work(expandedCold), expandedWarm: work(expandedWarm), collapsedCold: work(collapsedCold), collapsedWarm: work(collapsedWarm),
      piCaptures: [cold.counts.piCaptures, final.counts.piCaptures, replayCold.counts.piCaptures], warmDelta: 0, recolorSourceDelta: 0, recolorStyleDelta: 0 } }));
    await finish(replay);
    assertSyntaxStockReference(await stock(mode), { traffic: liveTraffic, persisted: saved });
  } finally { await closeTerminals(terminals); }
});
