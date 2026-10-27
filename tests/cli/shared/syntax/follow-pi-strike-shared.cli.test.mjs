import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { sharedSyntaxHost } from '../../../fixtures/shared-syntax-host.mjs';
import { semanticPhaseReady } from '../../../fixtures/syntax-observation.mjs';
import { paintProof, followPiMarkers, spans } from '../../../fixtures/follow-pi-physical.mjs';
import { prepareSyntaxNative, requiredSharedHost, settledStats, captureThenRenderDiagnostics, work, traffic, persisted, finish, chooseTheme, syntaxReady } from '../../../fixtures/syntax-cli-support.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();
const publications = terminal => new Map(terminal.events().filter(e => e.type === 'syntax_card_publication').map(e => [e.id, e]));

test('Follow Pi shared CLI: actual five-bit styles, native clear and cached Pi restoration over the real host', { timeout: 120000 }, async () => {
  const host = await sharedSyntaxHost(requiredSharedHost(), binary);
  const terminal = new PiTerminal('follow-pi-shared-strike', { mode: 'fullscreen', tidyUi: false, extensions: [fixture],
    extraEnv: { ...descriptor, SUBC_CONNECTION_FILE: host.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1', TIDY_UI_TEST_CARD_OBSERVE: '1',
      TIDY_UI_TEST_PALETTE_OBSERVE: '1', TIDY_UI_TEST_SYNTAX_CONFIG: JSON.stringify({ syntaxTheme: { kind: 'pi' } }) } });
  try {
    await terminal.ready(); await syntaxReady(terminal); terminal.send('run follow-pi-palette\r'); await terminal.event('agent_end');
    const original = await captureThenRenderDiagnostics(terminal, 'shared-pi-strike'); paintProof(original);
    const before = original.sample, old = publications(terminal);
    assert.ok(await semanticPhaseReady(() => before, () => terminal.events(), followPiMarkers, 'pi'), 'actual shared SOURCE/STYLE acceptance');
    assert.equal(old.size, 3); assert.equal(before.client.provider.kind, 'shared'); assert.equal(before.counts.acquisitions, 0);
    const originalTraffic = traffic(terminal), originalData = persisted(original);
    const custom = before.client.provider.description.profiles.find(profile => profile.label === 'cli-shared'); assert.ok(custom);
    const index = before.client.provider.description.profiles.filter(profile => profile.id !== 'pi').findIndex(profile => profile.id === custom.id) + 1;
    writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'native'); await chooseTheme(terminal, index);
    const native = await captureThenRenderDiagnostics(terminal, 'shared-native-full-clear');
    assert.ok(await semanticPhaseReady(() => native.sample, () => terminal.events(), followPiMarkers, custom.id), 'actual native replacement style tables');
    const currentNative = publications(terminal);
    assert.ok([...old].every(([id, prior]) => currentNative.get(id)?.origin === 'native' && currentNative.get(id)?.phase === 'native'
      && currentNative.get(id).paintStamp !== prior.paintStamp), 'atomic native publication in all three cards');
    assert.equal(native.cells.flat().filter(cell => cell?.strike).length, 0, 'native full masks clear unsupported strike everywhere');
    for (const text of ['BOLD_STAR', 'BOLD_UNDER']) for (const found of spans(native, text))
      assert.ok(found.cells.every(cell => cell.fg === 0x223344 && !cell.bold), 'native authored ink/fonts replace Follow Pi accent and bold');
    const nativeStats = native.sample, nativePublications = publications(terminal);
    assert.equal(nativeStats.counts.sourceRequests, before.counts.sourceRequests);
    writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'pi-return'); await chooseTheme(terminal, 0);
    const back = await captureThenRenderDiagnostics(terminal, 'shared-pi-strike-return'); paintProof(back);
    const currentPi = publications(terminal);
    assert.ok([...nativePublications].every(([id, prior]) => currentPi.get(id)?.origin === 'pi' && currentPi.get(id)?.phase === 'pi-return'
      && currentPi.get(id).paintStamp !== prior.paintStamp), 'cached full Pi restoration');
    const restored = back.sample;
    assert.equal(restored.counts.sourceRequests, before.counts.sourceRequests); assert.equal(restored.counts.styleRequests, nativeStats.counts.styleRequests);
    assert.equal(restored.counts.piCaptures, 0); assert.equal(restored.counts.piBridges, 0);
    await terminal.observeAnimation(); assert.deepEqual(work(await settledStats(terminal, 'shared-warm')), work(restored));
    assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(persisted(back), originalData);
    await finish(terminal);
    const peer = host.initialPeer; assert.equal((await peer.refreshThemes()).ok, true, 'the independent real shared peer remains alive after UI unload');
    console.log(JSON.stringify({ followPiShared: { path: terminal.output, provider: restored.client.provider.kind,
      acquisitions: restored.counts.acquisitions, sourceDelta: 0, returnStyleDelta: 0, warmDelta: 0, nativeStrikeCells: 0 } }));
  } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => host.close()); }
});
