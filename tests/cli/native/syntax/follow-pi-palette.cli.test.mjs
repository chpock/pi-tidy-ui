import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { createSyntaxStockReferences, assertSyntaxStockReference } from '../../../fixtures/syntax-stock-reference.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { paintProof, publications } from '../../../fixtures/follow-pi-physical.mjs';
import { prepareSyntaxNative, stats, work, traffic, persisted, body, finish, until, syntaxReady } from '../../../fixtures/syntax-cli-support.mjs';

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
    await until(() => semanticPhaseReady(() => stats(terminal, 'initial'), () => terminal.events(), markers, 'pi'), 'all actual Pi semantic source/style replies');
    const dark = await terminal.capture('follow-pi-dark'); paintProof(dark);
    const cold = await stats(terminal, 'cold');
    assert.ok(cold.localWork.paletteSamples > 0); assert.ok(cold.localWork.sourceSegments > 0);
    assert.equal(cold.counts.piCaptures, 0); assert.equal(cold.counts.piBridges, 0);
    for (const width of [60, 24, 140, 100]) { await terminal.resize(width); await terminal.capture(`follow-pi-width-${width}`); }
    await terminal.observeAnimation(); const warm = await stats(terminal, 'warm');
    assert.deepEqual(work(warm), work(cold), 'warm frames/reflow do not sample/derive, parse, resolve, measure or reread source scalars');
    const before = publications(terminal); assert.equal(before.size, 4);
    writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'light');
    await terminal.command('/tidy-ui-theme light');
    await until(() => {
      const current = publications(terminal);
      return [...before].every(([id, prior]) => current.get(id)?.phase === 'light' && current.get(id).paintStamp !== prior.paintStamp);
    }, 'all four owned cards publish current light palette');
    const light = await terminal.capture('follow-pi-light'); paintProof(light);
    assert.notEqual(rgb(light, 'mdHeading'), rgb(dark, 'mdHeading'));
    const recolored = await stats(terminal, 'recolored');
    assert.equal(recolored.counts.sourceRequests, cold.counts.sourceRequests); assert.equal(recolored.counts.styleRequests, cold.counts.styleRequests);
    assert.equal(recolored.localWork.sourceSegments, cold.localWork.sourceSegments); assert.equal(recolored.localWork.prefixScalarReads, cold.localWork.prefixScalarReads);
    assert.ok(recolored.localWork.paletteSamples > cold.localWork.paletteSamples);
    await terminal.observeAnimation(); assert.deepEqual(work(await stats(terminal, 'light-warm')), work(recolored));
    await terminal.command('/tidy-ui-theme dark');
    await until(async () => {
      const current = await terminal.capture('follow-pi-back-dark');
      const row = current.screen.findIndex(line => line.includes('FOLLOW_PI_HEADING'));
      return row >= 0 && current.cells[row][current.screen[row].indexOf('FOLLOW_PI_HEADING')].fg === rgb(dark, 'mdHeading') ? current : false;
    }, 'real public dark rollback');
    const back = await terminal.capture('follow-pi-rollback'); paintProof(back);
    assert.deepEqual(body(back), body(dark));
    const liveTraffic = traffic(terminal), saved = persisted(dark), session = dark.session, workspace = terminal.work;
    const final = await stats(terminal, 'final');
    assert.equal(final.counts.sourceRequests, cold.counts.sourceRequests); assert.equal(final.counts.styleRequests, cold.counts.styleRequests);
    await finish(terminal);
    const replay = create('replay', { session, workspace, extraEnv: { TIDY_UI_TEST_SYNTAX_ACQUIRE_GATE: '1' } }); await replay.ready();
    await replay.event('syntax_acquire_gate');
    await until(async () => (await stats(replay, 'replay-before-provider')).counts.piCaptures === 3, 'three finite file fallback captures before helper admission');
    await replay.capture('follow-pi-replay-initial-fallback');
    writeFileSync(join(replay.output, 'syntax-acquire-go'), 'go');
    await until(() => semanticPhaseReady(() => stats(replay, 'replay-ready'), () => replay.events(), markers, 'pi'), 'replay actual source/style publication');
    const restored = await replay.capture('follow-pi-replay');
    const writeRow = restored.screen.findIndex(row => row.includes('Wrote follow-pi.md'));
    const editRow = restored.screen.findIndex(row => row.includes('Edited follow-pi.md'));
    assert.ok(writeRow >= 0 && editRow > writeRow);
    assert.equal(restored.tools.at(-1).name, 'bash', 'the newest registry entry is not a file');
    paintProof(restored);
    const captures = replay.events().filter(event => event.type === 'follow_pi_capture' && event.accepted);
    assert.equal(captures.length, 3, 'the write and both edit fragments each have one finite fallback capture');
    const sources = replay.events().filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
      .flatMap(event => event.payload.sources);
    // Protocol SOURCE keys are opaque, not the adapter's Pi-capture keys.
    assert.deepEqual(sources.filter(source => source.hint?.path === 'follow-pi.md').map(source => source.text).sort(),
      captures.map(capture => capture.text).sort(), 'every captured file fragment gets its first native SOURCE without clicks');
    assert.deepEqual(persisted(restored), saved);
    assert.deepEqual(body(restored), body(dark));
    assert.equal(traffic(replay).length, 0);
    const replayCold = await stats(replay, 'replay-cold'); await replay.observeAnimation();
    assert.equal(replayCold.counts.sourceRequests, 5, 'two Bash commands plus three file fragments are each parsed once');
    assert.deepEqual(work(await stats(replay, 'replay-warm')), work(replayCold));
    if (mode === 'fullscreen') {
      const click = async dump => {
        const y = dump.screen.findIndex(row => row.includes('~~**_fixed_**~~')); assert.ok(y >= 0, 'edit body remains visible in custom and native-expanded views');
        replay.send(`\x1b[<0;10;${y + 1}M\x1b[<0;10;${y + 1}m`); await replay.settle();
      };
      await click(restored); const expanded = await replay.capture('follow-pi-expanded');
      assert.equal(expanded.tools.find(tool => tool.name === 'edit').expanded, true);
      await click(expanded); const collapsed = await replay.capture('follow-pi-collapsed');
      assert.equal(collapsed.tools.find(tool => tool.name === 'edit').expanded, false);
      paintProof(collapsed);
      assert.equal((await stats(replay, 'replay-clicked')).counts.sourceRequests, replayCold.counts.sourceRequests, 'clicks reuse the already parsed edit, not fix missing highlighting');
    }
    const reloadBoundary = replay.events().length;
    unlinkSync(join(replay.output, 'syntax-acquire-go'));
    await replay.command('/reload'); await replay.event('syntax_acquire_gate', 2);
    await until(async () => (await stats(replay, 'reload-before-provider')).counts.piCaptures === 3, 'reload establishes finite fallback before helper admission');
    writeFileSync(join(replay.output, 'syntax-acquire-go'), 'go');
    await until(() => semanticPhaseReady(() => stats(replay, 'reload-ready'), () => replay.events().slice(reloadBoundary), markers, 'pi'), 'new reload SOURCE and STYLE replies, not prior-run evidence');
    const reloaded = await replay.capture('follow-pi-reloaded'); paintProof(reloaded);
    assert.deepEqual(body(reloaded), body(restored)); assert.deepEqual(persisted(reloaded), saved); assert.equal(traffic(replay).length, 0);
    const reloadCold = await stats(replay, 'reload-cold'); assert.equal(reloadCold.counts.sourceRequests, 5);
    await replay.observeAnimation(); assert.deepEqual(work(await stats(replay, 'reload-warm')), work(reloadCold));
    console.log(JSON.stringify({ followPiPhysical: { mode, live: terminal.output, replay: replay.output,
      cold: work(cold), warm: work(warm), recolored: work(recolored), final: work(final), replayCold: work(replayCold),
      piCaptures: [cold.counts.piCaptures, final.counts.piCaptures, replayCold.counts.piCaptures], warmDelta: 0, recolorSourceDelta: 0, recolorStyleDelta: 0 } }));
    await finish(replay);
    assertSyntaxStockReference(await stock(mode), { traffic: liveTraffic, persisted: saved });
  } finally { await closeTerminals(terminals); }
});
