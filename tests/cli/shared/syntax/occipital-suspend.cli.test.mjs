import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from '../../../fixtures/terminal-cleanup.mjs';
import { sharedSyntaxHost } from '../../../fixtures/shared-syntax-host.mjs';
import { prepareSyntaxNative, requiredSharedHost, stats, until, syntaxReady, settledStats, traffic, persisted, work } from '../../../fixtures/syntax-cli-support.mjs';
import { semanticPhaseReady, nativeReady } from '../../../fixtures/syntax-observation.mjs';
import { followPiMarkers, paintProof } from '../../../fixtures/follow-pi-physical.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();
const deadlineMs = 4000;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function bashProof(dump) {
  const y = dump.screen.findLastIndex(row => row.includes('STABLE_text e')); assert.ok(y >= 0);
  const x = dump.screen[y].indexOf('STABLE_text e'), ink = dump.summaryStyles.syntaxString.match(/38;2;(\d+);(\d+);(\d+)m/);
  assert.ok(ink); assert.equal(dump.cells[y][x].fg, Number(ink[1]) * 65536 + Number(ink[2]) * 256 + Number(ink[3]));
}
async function suspend(t) {
  const boundary = t.raw.length, stopped = join(t.output, 'stopped');
  t.send('\x1a');
  await until(() => Buffer.concat(t.raw.slice(boundary)).includes('JOB_CONTROL> '), 'actual shell prompt after Ctrl+Z');
  t.send(`jobs -s -p > ${quote(stopped)}\r`);
  await until(() => existsSync(stopped) && /^[1-9]\d*\s*$/.test(readFileSync(stopped, 'utf8')), 'shell reports stopped Pi job');
}
test('Occipital deliberate suspend recovery (Linux stopped-helper evidence)', { timeout: 180000, skip: process.platform !== 'linux' }, async suite => {
for (const kind of ['owned', 'shared']) for (const mode of ['fullscreen', 'regular']) for (const operation of ['SOURCE', 'STYLE', 'APPEND']) {
  await suite.test(`Occipital pending ${operation}: ${kind}, ${mode} past deadline during Ctrl+Z`, { timeout: 45000 }, async () => {
    const host = kind === 'shared' ? await sharedSyntaxHost(requiredSharedHost(), binary) : undefined;
    let t, helperPid, helperStopped = false;
    try {
      t = new PiTerminal(`pending-${kind}-${mode}-${operation}`, { mode, jobControl: true, tidyUi: false, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SUSPEND_PROBE: '1', TIDY_UI_TEST_SUSPEND_DEADLINE_MS: String(deadlineMs),
         ...(operation !== 'SOURCE' ? { TIDY_UI_TEST_SUSPEND_OP: operation === 'STYLE' ? 'styles.resolve' : 'stream.append' } : {}),
        TIDY_UI_TEST_CARD_OBSERVE: '1', TIDY_UI_TEST_PALETTE_OBSERVE: '1',
        ...(host ? { TIDY_UI_TEST_SYNTAX_SHARED: '1', SUBC_CONNECTION_FILE: host.alias } : {}) } });
      await t.ready(); const startup = await syntaxReady(t); assert.equal(startup.client.provider.kind, kind);
      helperPid = startup.client.provider.description.runtime.pid;
      assert.ok(Number.isSafeInteger(helperPid) && helperPid > 1 && helperPid !== process.pid);
       const stopHelper = async () => {
         process.kill(helperPid, 'SIGSTOP'); helperStopped = true;
         await until(() => /^State:\s+T/m.test(readFileSync(`/proc/${helperPid}/status`, 'utf8')), 'fixture helper is kernel-stopped before dispatch');
       };
       if (operation === 'SOURCE') await stopHelper();
       writeFileSync(join(t.output, 'suspend-arm'), 'go');
        if (operation === 'APPEND') {
          t.send('run bash-prefix-contract\r'); await t.event('bash_contract_prefix');
          await settledStats(t, 'first-tail', nativeReady); bashProof(await t.capture('first-tail'));
          writeFileSync(join(t.output, 'bash-contract-go-0'), 'go'); await t.event('bash_contract_prefix', 2);
        } else t.send('run follow-pi-palette\r');
        if (operation !== 'SOURCE') {
         await t.event('suspend_transport_selected'); await stopHelper();
         writeFileSync(join(t.output, 'suspend-dispatch'), 'go');
       }
       await t.event('suspend_transport_pending');
      const pending = await settledStats(t, 'actual-pending', s => s.suspend?.outcome === 'pending' && s.source.globalUnsettledJobs > 0);
       assert.ok(pending.source.globalUnsettledJobs > 0);
       if (operation === 'STYLE') assert.ok(pending.source.styleCaptures > 0);
      const transport = kind === 'owned' ? pending.transports.at(-1) : pending.sharedTransports.at(-1);
      assert.ok(transport.unsettledData > 0); assert.ok(transport.liveTimers > 0);
       {
        await suspend(t);
        if (host) {
          process.kill(helperPid, 'SIGCONT'); helperStopped = false;
          assert.equal((await host.initialPeer.refreshThemes()).ok, true, 'real shared helper and independent peer progress while Pi remains stopped');
        }
        await delay(deadlineMs + 500);
        t.send('fg\r'); await t.settle(); helperStopped = false;
       }
       if (operation === 'APPEND') {
         await settledStats(t, 'resumed-tail', s => nativeReady(s) && s.counts.sourceRequests >= 3);
         bashProof(await t.capture('resumed-tail'));
         const opens = t.events().filter(e => e.type === 'syntax_native_dispatch' && e.payload.op === 'stream.open');
         assert.equal(opens.length, 2, 'interrupted incremental work reopens exactly once');
         assert.equal(opens[1].payload.sources[0].text, ": 'STABLE_text é界");
         assert.notEqual(opens[0].payload.sources[0].key, opens[1].payload.sources[0].key);
         writeFileSync(join(t.output, 'bash-contract-go-1'), 'go'); await t.event('bash_contract_prefix', 3);
         writeFileSync(join(t.output, 'bash-contract-go-2'), 'go');
       }
       await t.event('agent_end'); await t.observeAnimation();
        const after = operation === 'APPEND' ? await settledStats(t, 'recovered', nativeReady)
          : await until(() => semanticPhaseReady(() => stats(t, 'recovered'), () => t.events(), followPiMarkers, 'pi'), 'current cards recover SOURCE/STYLE automatically');
       assert.equal(after.suspend.outcome, 'rejected'); assert.equal(after.suspend.expirations, 0, 'deliberate close clears the old request timer');
       assert.equal(after.client.provider.availability, 'ready');
       assert.notEqual(after.client.provider.generation, startup.client.provider.generation);
       if (kind === 'owned') assert.notEqual(after.client.provider.description.runtime.pid, helperPid);
       else assert.equal(after.client.provider.description.runtime.pid, helperPid);
        const restored = await t.capture('restored-colors');
        if (operation === 'APPEND') bashProof(restored); else paintProof(restored);
      const first = await t.capture('first-cards'), sourceBefore = after.counts.sourceRequests;
      const ends = t.events().filter(e => e.type === 'agent_end').length;
      t.send('run follow-pi-palette\r'); await t.event('agent_end', ends + 1); await t.observeAnimation();
       const next = await until(() => semanticPhaseReady(() => stats(t, 'new-cards'), () => t.events(), followPiMarkers, 'pi'), 'new cards use restored provider');
       const nextCards = await t.capture('new-cards'); paintProof(nextCards);
       assert.ok(next.counts.sourceRequests > sourceBefore);
       await t.resize(90); await t.resize(100); await t.observeAnimation();
       assert.deepEqual(work(await stats(t, 'warm')), work(next), 'warm frames and reflow do not replay or recompute');
       await suspend(t); t.send('fg\r'); await t.settle();
       const idle = await stats(t, 'idle-resume');
       assert.equal(idle.client.provider.generation, next.client.provider.generation, 'idle provider is retained');
       assert.deepEqual(work(idle), work(next), 'ready cards reuse sources, styles, palettes and geometry after idle suspend');
       paintProof(await t.capture('idle-resume'));
      const report = { kind, mode, operation, configuredDeadlineMs: deadlineMs, pending, after, next,
        newSourceRequests: next.counts.sourceRequests - sourceBefore,
        firstStrikeCells: first.cells.flat().filter(c => c.strike).length, nextStrikeCells: nextCards.cells.flat().filter(c => c.strike).length,
        traffic: traffic(t), persisted: persisted(nextCards), events: t.events().filter(e => e.type.startsWith('suspend_transport_')) };
      writeFileSync(join(t.output, 'suspend-evidence.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ evidence: t.output, kind, mode, operation, outcome: after.suspend,
         availability: after.client.provider.availability, newSourceRequests: report.newSourceRequests,
         firstStrikeCells: report.firstStrikeCells, nextStrikeCells: report.nextStrikeCells }));
    } finally { await runCleanupSteps(() => {
      if (helperStopped) { try { process.kill(helperPid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }, () => closeTerminals(t ? [t] : []), async () => { if (host) await host.close(); }); }
  });
}
});
