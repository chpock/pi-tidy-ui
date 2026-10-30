import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { sharedSyntaxHost } from '../../../fixtures/shared-syntax-host.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { paintProof, followPiMarkers } from '../../../fixtures/follow-pi-physical.mjs';
import { prepareSyntaxNative, requiredSharedHost, settledStats, captureThenRenderDiagnostics, work, traffic, persisted, body, finish, syntaxReady, peerSource } from '../../../fixtures/syntax-cli-support.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();
const publications = terminal => new Map(terminal.events().filter(e => e.type === 'syntax_card_publication').map(e => [e.id, e]));
const workDelta = (before, after) => ({
  sourceRequests: after.counts.sourceRequests - before.counts.sourceRequests,
  styleRequests: after.counts.styleRequests - before.counts.styleRequests,
  piCaptures: after.counts.piCaptures - before.counts.piCaptures,
  piBridges: after.counts.piBridges - before.counts.piBridges,
});

for (const mode of ['fullscreen', 'regular']) test(`Follow Pi shared CLI: ${mode} real Markdown, palette rebind and saved replay`, { timeout: 180000 }, async () => {
  const host = await sharedSyntaxHost(requiredSharedHost(), binary), terminals = [];
  const create = (name, options = {}) => {
    const { extraEnv = {}, ...rest } = options;
    const terminal = new PiTerminal(`follow-pi-shared-${mode}-${name}`, { mode, tidyUi: false, extensions: [fixture],
      extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1', TIDY_UI_TEST_CARD_OBSERVE: '1',
        TIDY_UI_TEST_PALETTE_OBSERVE: '1', TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }), ...extraEnv }, ...rest });
    terminals.push(terminal); return terminal;
  };
  try {
    const terminal = create('live');
    await terminal.ready(); await syntaxReady(terminal); terminal.send('run follow-pi-palette\r'); await terminal.event('agent_end');
    const original = await captureThenRenderDiagnostics(terminal, 'shared-pi-strike'); paintProof(original);
    const before = original.sample, priorPaints = publications(terminal);
    assert.ok(await semanticPhaseReady(() => before, () => terminal.events(), followPiMarkers, 'pi'), 'actual shared generic SOURCE/STYLE acceptance');
    assert.equal(priorPaints.size, 3); assert.equal(before.client.provider.kind, 'shared'); assert.equal(before.counts.acquisitions, 0);
    const originalTraffic = traffic(terminal), originalData = persisted(original), originalBody = body(original);
    const session = original.session, workspace = terminal.work, originalWork = work(before);
    assert.ok(before.counts.styleRequests > 0); assert.equal(before.counts.piCaptures, 0); assert.equal(before.counts.piBridges, 0);

    let latestPaint = original, expectedPaletteSamples = originalWork.localWork.paletteSamples;
    for (const theme of ['light', 'dark']) {
      const previous = terminal.events().filter(event => event.type === 'theme').length;
      await terminal.command(`/tidy-ui-theme ${theme}`); await terminal.event('theme', previous + 1);
      const transition = terminal.events().filter(event => event.type === 'theme')[previous];
      assert.equal(transition.name, theme); assert.equal(transition.result.success, true);
      const painted = await captureThenRenderDiagnostics(terminal, `shared-pi-${theme}`); paintProof(painted); latestPaint = painted;
      const current = publications(terminal), stats = painted.sample;
      assert.ok([...current].every(([id, event]) => event.origin === 'pi' && event.paintStamp !== priorPaints.get(id)?.paintStamp),
        'Pi colors update all three cards through their current palette input');
      expectedPaletteSamples++;
      assert.deepEqual(work(stats), { ...originalWork, localWork: { ...originalWork.localWork, paletteSamples: expectedPaletteSamples } },
        'Pi palette repaint samples exactly the selected public palette and reuses generic SOURCE/STYLE results');
      assert.equal(stats.counts.sourceRequests, before.counts.sourceRequests); assert.equal(stats.counts.styleRequests, before.counts.styleRequests);
      assert.equal(stats.counts.piCaptures, 0); assert.equal(stats.counts.piBridges, 0);
    }
    const warm = await settledStats(terminal, 'shared-pi-warm');
    assert.deepEqual(work(warm), { ...originalWork, localWork: { ...originalWork.localWork, paletteSamples: expectedPaletteSamples } });
    assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(persisted(latestPaint), originalData); assert.deepEqual(body(latestPaint), originalBody);
    const liveToolModelCallDelta = traffic(terminal).length - originalTraffic.length;
    const paletteWorkDelta = workDelta(before, latestPaint.sample);
    const liveWarmDelta = workDelta(before, warm);
    await finish(terminal);

    const replay = create('replay', { session, workspace }); await replay.ready(); await replay.event('syntax_card_publication', 3);
    const restored = await captureThenRenderDiagnostics(replay, 'shared-pi-replay'), replayCold = restored.sample;
    assert.ok(await semanticPhaseReady(() => replayCold, () => replay.events(), followPiMarkers, 'pi'), 'saved shared replay publishes actual source and style replies');
    assert.equal(replayCold.client.provider.kind, 'shared'); assert.equal(replayCold.counts.acquisitions, 0);
    assert.ok(replayCold.counts.sourceRequests > 0); assert.ok(replayCold.counts.styleRequests > 0);
    assert.equal(replayCold.counts.piCaptures, 3, 'one finite Pi source capture per restored file fragment');
    assert.equal(replayCold.counts.piBridges, 3, 'each restored file fragment adopts its bounded Pi projection once');
    const captures = replay.events().filter(event => event.type === 'follow_pi_capture' && event.accepted);
    assert.equal(captures.length, 3);
    const sources = replay.events().filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
      .flatMap(event => event.payload.sources);
    assert.deepEqual(sources.filter(source => source.hint?.path === 'follow-pi.md').map(source => source.text).sort(),
      captures.map(capture => capture.text).sort(), 'each finite restore capture receives shared SOURCE parsing');
    assert.equal(publications(replay).size, 3); assert.ok([...publications(replay).values()].every(event => event.origin === 'pi'));
    paintProof(restored); assert.deepEqual(persisted(restored), originalData); assert.deepEqual(body(restored), originalBody);
    const replayToolModelCalls = traffic(replay).length;
    assert.equal(replayToolModelCalls, 0, 'saved-session rendering makes no model or tool calls');
    await replay.observeAnimation();
    const replayWarm = await settledStats(replay, 'shared-pi-replay-warm');
    assert.deepEqual(work(replayWarm), work(replayCold), 'shared saved replay warm frames add no SOURCE, STYLE or palette work');
    assert.equal(replayWarm.counts.piCaptures, replayCold.counts.piCaptures, 'warm replay adds no Pi source capture');
    assert.equal(replayWarm.counts.piBridges, replayCold.counts.piBridges, 'warm replay adds no Pi projection');
    assert.deepEqual(traffic(replay), []);
    const replayWarmToolModelCalls = traffic(replay).length;
    const replayWarmDelta = workDelta(replayCold, replayWarm);
    await finish(replay);

    const peer = host.initialPeer; await peerSource(peer);
    assert.equal(peer.snapshot().provider.kind, 'shared'); assert.equal(peer.snapshot().provider.availability, 'ready');
    console.log(JSON.stringify({ followPiShared: { mode,
      live: { paletteWorkDelta: paletteWorkDelta, warmDelta: liveWarmDelta, toolModelCallDelta: liveToolModelCallDelta },
      replay: { provider: replayCold.client.provider.kind, acquisitions: replayCold.counts.acquisitions,
        sourceRequests: replayCold.counts.sourceRequests, styleRequests: replayCold.counts.styleRequests,
        piCaptures: replayCold.counts.piCaptures, piBridges: replayCold.counts.piBridges, toolModelCalls: replayToolModelCalls,
        warmDelta: replayWarmDelta, warmToolModelCallDelta: replayWarmToolModelCalls - replayToolModelCalls } } }));
  } finally { await runCleanupSteps(() => closeTerminals(terminals), () => host.close()); }
});
