import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal } from './fixtures/terminal-harness.mjs';
import { runCleanupSteps } from './fixtures/terminal-cleanup.mjs';
import { assertSyntaxStockReference } from './fixtures/syntax-stock-reference.mjs';
import { nativeReady } from './fixtures/syntax-observation.mjs';
import { prepareSyntaxPackage, scenario, stockReference, traffic, persisted, sourceColors, stats, loggingIdle, loggingPrivacy, loggerWork, loggingFrame, work, settledStats, body, syntaxReady, finish } from './fixtures/syntax-cli-support.mjs';

const { loggingFixture } = await prepareSyntaxPackage();
const descriptor = { TIDY_UI_TEST_SYNTAX_CARDS: '1' };

for (const mode of ['regular', 'fullscreen']) for (const native of [false])
  test(`occipital CLI: logging ${mode} ${native ? 'native' : 'fallback'} truthful decisions, unchanged frames, reload and replay`,
    { timeout: 120000 }, async () => {
      const terminal = new PiTerminal(`logging-${mode}-${native ? 'native' : 'fallback'}`, { mode, extensions: [loggingFixture],
        extraEnv: { ...descriptor, TIDY_UI_TEST_LOGGING_NATIVE: native ? '1' : '0', TIDY_UI_TEST_LOGGING_CANCEL: '1', TIDY_UI_TEST_SYNTAX_CARDS: '1' } });
      let replay;
      try {
        const shown = await scenario(terminal, native), reference = await stockReference(mode);
        assertSyntaxStockReference(reference, { traffic: traffic(terminal), persisted: persisted(shown) });
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
        console.log(JSON.stringify({ logging: terminal.output, stock: reference.output, replay: replay.output, mode, native, session: baseline.session,
          run: baseline.run, reloadRun: afterReload.run, replayRun: replayStatus.run, warmRecordDelta: 0, warmWriteDelta: 0,
          nativeWork: native ? work(counters) : undefined }));
      } finally {
        await runCleanupSteps(() => terminal.close(), () => replay?.close(), () => replay?.dispose(), () => terminal.dispose());
      }
    });
