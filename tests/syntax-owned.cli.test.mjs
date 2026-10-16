import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from './fixtures/terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from './fixtures/terminal-cleanup.mjs';
import { assertSyntaxStockReference } from './fixtures/syntax-stock-reference.mjs';
import { nativeReady } from './fixtures/syntax-observation.mjs';
import { prepareSyntaxNative, inputs, scenario, traffic, persisted, stats, sourceColors, body, work, until, finish, settledStats, stockReference, syntaxReady, savedThemeSession, themeForegrounds, expectedThemeColors, initialThemeStats, chooseTheme } from './fixtures/syntax-cli-support.mjs';

const { binary, fixture, descriptor } = await prepareSyntaxNative();

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: actual ${mode} startup, args completion, warm/resize/off and exact traffic replay`,
  { timeout: 120000 }, async () => {
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
      await native.selectTidyItem('Use Occipital highlighting');
      // Configuration can be written before the synchronized terminal frame ends.
      const disabledRows = await until(async () => {
        const rows = await native.completeTidyRows();
        return rows.some(row => /Use Occipital highlighting\s+Off/u.test(row)) ? rows : false;
      }, 'complete same overlay after native disable');
      native.captureScreen('syntax-menu-off', {});
      assert.ok(disabledRows.some(row => /Use Occipital highlighting\s+Off/u.test(row)), 'same real overlay survives native disable: ' + native.output);
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
      assertSyntaxStockReference(await stockReference(mode), { traffic: nativeTraffic, persisted: nativeData });
    } finally { await closeTerminals(terminals); }
  });

test('occipital CLI: provider readiness waits for the actual acquired/publication state, not terminal silence',
  { timeout: 30000 }, async () => {
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
    } finally { await closeTerminals([terminal]); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} input and tool progress with held real file replies and no duplicate Pi classification`,
  { timeout: 120000 }, async () => {
    const terminal = new PiTerminal(`syntax-held-${mode}`, { mode, tidyUi: false, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_SYNTAX_REPLY_GATE: '1' } });
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
      assert.equal(before.node, inputs.node.version);
      assert.equal(before.pendingHeldReplies, 1); assert.equal(before.counts.heldReplies, 1);
      assert.equal(before.counts.deliveredReplies, 0); assert.equal(before.source.globalUnsettledJobs, 1);
      assert.equal(before.counts.piCaptures, 0); assert.equal(before.counts.piBridges, 0);
      assert.deepEqual(terminal.events().filter(e => e.type === 'result').map(e => e.name), ['bash', 'write']);
      terminal.send('HELD_REPLY_DRAFT');
      await until(() => terminal.screen().some(row => row.includes('HELD_REPLY_DRAFT')), 'physical editable input while the native reply is unsettled');
      terminal.captureScreen('held-input', {});
      terminal.send('\x15'); await terminal.settle();
      for (const width of [60, 100]) {
        await terminal.resize(width, 80);
        const resized = await terminal.capture(`held-before-width-${width}`);
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
      const reference = await stockReference(mode);
      assertSyntaxStockReference(reference, { traffic: traffic(terminal), persisted: persisted(held) });
      console.log(JSON.stringify({ heldReplies: terminal.output, stock: reference.output,
        observations: [before, after, done].map(snapshot => ({ node: snapshot.node, counts: snapshot.counts,
          pendingHeldReplies: snapshot.pendingHeldReplies, work: work(snapshot), unsettledJobs: snapshot.source.globalUnsettledJobs,
          pid: snapshot.transports[0].pid })) }));
      await finish(terminal);
    } finally {
      await runCleanupSteps(
        () => writeFileSync(`${terminal.output}/syntax-reply-tool-go`, 'go'),
        () => writeFileSync(`${terminal.output}/syntax-reply-go`, 'go'),
        () => run,
        () => closeTerminals([terminal]),
      );
    }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} gradual argument abort preserves prefix, stock traffic and warm work`,
  { timeout: 60000 }, async () => {
    const live = new PiTerminal(`syntax-abort-${mode}`, { mode, extensions: [fixture], extraEnv: descriptor });
    const stock = new PiTerminal(`syntax-abort-stock-${mode}`, { mode, tidyUi: false, extraEnv: descriptor });
    const fallback = new PiTerminal(`syntax-abort-fallback-${mode}`, { mode, tidyUi: true, extraEnv: descriptor });
    try {
      for (const terminal of [live, stock, fallback]) {
        await terminal.ready(); if (terminal === live) await syntaxReady(terminal);
        terminal.send('run syntax-cards\r');
        await terminal.event('syntax_prefix');
        await terminal.capture('abort-first-prefix');
        writeFileSync(`${terminal.output}/syntax-prefix-go-0`, 'go');
        await terminal.event('syntax_prefix', 2);
        const pending = await terminal.capture('abort-completed-line');
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
    } finally { await closeTerminals([live, stock, fallback]); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} historical Bash tail stays colored across held append, new grapheme and abort`,
  { timeout: 90000 }, async () => {
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
        await terminal.capture('pointer-prefix-initial');
        if (terminal === live) {
          const ready = await settledStats(live, 'prefix-native', s => nativeReady(s) && s.source.tailCalls === 1);
          assert.equal(ready.source.committedLineCalls, 0); assert.equal(ready.source.committedLineBytes, 0);
          const shown = await live.capture('pointer-prefix-colored');
          assert.equal(cells(shown).prefix.fg, fg(shown, 'syntaxString'));
        }
        writeFileSync(join(terminal.output, 'bash-contract-go-0'), 'go'); await terminal.event('bash_contract_prefix', 2);
        if (terminal === live) await live.event('bash_contract_reply_held');
        const appended = await terminal.capture('pointer-prefix-held');
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
            const hot = await live.capture(`pointer-prefix-held-warm-${i}`);
            assert.equal(cells(hot).prefix.fg, fg(hot, 'syntaxString'));
          }
          const after = await stats(live, 'prefix-held-after'); assert.deepEqual(work(after), work(before)); assert.equal(after.counts.piBridges, 0);
        }
        writeFileSync(join(terminal.output, 'bash-contract-go-1'), 'go'); await terminal.event('bash_contract_prefix', 3);
        await terminal.capture('pointer-prefix-coalesced');
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
    } finally { await runCleanupSteps(() => live.close(), () => stock.close(), () => replay?.close(),
        () => live.dispose(), () => stock.dispose(), () => replay?.dispose()); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} online wait resumes both restored and connection-loss Bash demands`,
  { timeout: 120000 }, async () => {
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
    } finally { await runCleanupSteps(() => terminal.close(), () => stock.close(), () => terminal.dispose(), () => stock.dispose(),
        () => rm(directory, { recursive: true, force: true })); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} restored Bash backlog colors newest cards before older cards`,
  { timeout: 120000 }, async () => {
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
      await terminal.quit('\x04');
      await finish(terminal);
      console.log(JSON.stringify({ backlogOrder: terminal.output, stock: stock.output, node: final.node, mode, cards: commands.length,
        order: dispatches.map(e => e.payload.sources[0].text), warmNativeDelta: 0, calls: 0, results: 0 }));
    } finally { await runCleanupSteps(() => terminal.close(), () => stock.close(), () => terminal.dispose(), () => stock.dispose(),
        () => rm(directory, { recursive: true, force: true })); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} theme switch recolors every Bash/write/edit card without zero-width capture`,
  { skip: !binary, timeout: 120000 }, async () => {
    const { directory, cards, session, bytes } = await savedThemeSession();
    const terminal = new PiTerminal(`theme-all-cards-${mode}`, { mode, session, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_THEME_OBSERVE: '1' } });
    const raw = dump => dump.tools.map(({ name, args, content, details, isError, argsComplete, executionStarted, partial }) =>
      ({ name, args, content, details, isError, argsComplete, executionStarted, partial }));
    const foregrounds = themeForegrounds, expected = (phase, dump) => expectedThemeColors(terminal, phase, dump);
    try {
      await terminal.ready(); await terminal.resize(100, 160);
      await initialThemeStats(terminal, 'all-theme-initial');
      const baseline = await terminal.capture('physical-theme-baseline');
      assert.equal(baseline.tools.length, cards.length); assert.ok(baseline.tools.every(tool => !('tinyLines' in tool)));
      foregrounds(baseline);
      for (const [phase, label] of [['mocha', 'Catppuccin Mocha'], ['latte', 'Catppuccin Latte'], ['pi', null]]) {
        const before = await stats(terminal, `all-theme-before-${phase}`);
        const profiles = before.client.provider.description.profiles.filter(profile => profile.id !== 'pi');
        const index = label === null ? 0 : profiles.findIndex(profile => profile.label === label) + 1;
        assert.ok(label === null || index > 0, `bundled theme ${label} exists`);
        writeFileSync(join(terminal.output, 'syntax-theme-phase'), phase);
        await chooseTheme(terminal, index);
        const after = await settledStats(terminal, `all-theme-${phase}`, s => nativeReady(s) && s.source.dispatches >= before.source.dispatches + 5);
        assert.equal(after.node, process.env.PI_TEST_EXPECT_NODE ?? process.version);
        const dispatches = terminal.events().filter(event => event.type === 'syntax_theme_dispatch' && event.phase === phase);
        assert.equal(dispatches.length, 5, 'one finite native request per saved logical source, including both diff sides');
        assert.ok(dispatches.every(event => event.jobs <= 2), 'theme refresh uses the existing physical-credit limit');
        let painted;
        await until(async () => {
          painted = await terminal.capture(`physical-theme-${phase}`);
          return foregrounds(painted).every((color, i) => color === expected(phase, painted)[i]);
        }, `all mixed-card physical colors for ${phase}`);
        assert.deepEqual(raw(painted), raw(baseline)); assert.deepEqual(body(painted), body(baseline));
        assert.deepEqual(readFileSync(session), bytes); assert.equal(traffic(terminal).length, 0);
        for (const width of [100, 90, 100]) {
          await terminal.resize(width, 160); await terminal.capture(`physical-theme-warm-${phase}-${width}`);
        }
        const warm = await stats(terminal, `all-theme-warm-${phase}`);
        assert.deepEqual(work(warm), work(after)); assert.equal(warm.counts.piBridges, before.counts.piBridges);
        assert.equal(terminal.events().filter(event => event.type === 'syntax_theme_dispatch' && event.phase === phase).length, 5);
        console.log(JSON.stringify({ allCardTheme: terminal.output, mode, phase, node: after.node,
          sources: dispatches.map(event => event.payload.sources[0].text), colors: foregrounds(painted), warmDelta: 0 }));
      }
      await terminal.quit('\x04');
      await finish(terminal);
    } finally { await runCleanupSteps(() => closeTerminals([terminal]), () => rm(directory, { recursive: true, force: true })); }
  });

for (const mode of ['fullscreen', 'regular']) test(`occipital CLI: ${mode} live history theme backlog starts with the latest edit card`,
  { timeout: 120000 }, async () => {
    const terminal = new PiTerminal(`lifo-live-theme-${mode}`, { mode, extensions: [fixture],
      extraEnv: { ...descriptor, TIDY_UI_TEST_THEME_OBSERVE: '1', TIDY_UI_TEST_THEME_PREVIEW: '1' } });
    try {
      const shown = await scenario(terminal, true);
      await terminal.resize(100, 160);
      const before = await stats(terminal, 'lifo-before'), sessionBytes = readFileSync(shown.session), originalTraffic = traffic(terminal);
      const mocha = before.client.provider.description.profiles.find(p => p.label === 'Catppuccin Mocha'); assert.ok(mocha);
      await terminal.openTidyMenu(); await terminal.selectTidyItem('Code color theme');
      writeFileSync(join(terminal.output, 'syntax-theme-phase'), 'held-preview'); terminal.send(mocha.label);
      await terminal.event('syntax_preview_reply_held', 2);
      const first = terminal.events().filter(e => e.type === 'syntax_theme_dispatch' && e.phase === 'held-preview');
      assert.deepEqual(first.map(e => e.payload.sources[0].text.trim()).toSorted(), ['const x=1;', 'const x=2;'],
        'both slots serve the latest edit, not the older write/Bash sources admitted first during live execution');
      writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go');
      await terminal.selectTidyItem(mocha.label); await terminal.closeTidyMenu();
      const accepted = await settledStats(terminal, 'lifo-accepted', s => nativeReady(s) && s.client.effective.id === mocha.id);
      assert.equal(accepted.source.dispatches, before.source.dispatches + 4);
      const reply = terminal.events().find(e => e.type === 'syntax_theme_reply' && e.phase === 'held-preview' && e.payload.sources[0].text.includes('const x=2;')).reply.body.sources[0];
      const rgb = reply.styles[reply.runs[1]].rgb; assert.ok(rgb);
      const expected = rgb[0] * 65536 + rgb[1] * 256 + rgb[2];
      await until(async () => {
        const dump = await terminal.captureCompleteScreen('physical-lifo-visible', shown);
        const y = dump.screen.findIndex(row => row.includes('const x=2;'));
        return y >= 0 && dump.cells[y][dump.screen[y].indexOf('const x=2;')].fg === expected;
      }, 'latest edit has its actual native preview color');
      const settled = await stats(terminal, 'lifo-confirmed'); assert.deepEqual(work(settled), work(accepted));
      for (const width of [90, 100]) { await terminal.resize(width, 160); await terminal.capture(`physical-lifo-warm-${width}`); }
      const warm = await stats(terminal, 'lifo-warm'); assert.deepEqual(work(warm), work(settled));
      assert.deepEqual(traffic(terminal), originalTraffic); assert.deepEqual(readFileSync(shown.session), sessionBytes);
      const final = await terminal.capture('physical-lifo-final'); assert.deepEqual(persisted(final), persisted(shown));
      assertSyntaxStockReference(await stockReference(mode), { traffic: originalTraffic, persisted: persisted(shown) });
      console.log(JSON.stringify({ unifiedLifo: terminal.output, mode, node: warm.node, firstSources: first.map(e => e.payload.sources[0].text), warmDelta: 0 }));
      await terminal.quit('\x04'); await finish(terminal);
    } finally {
      writeFileSync(join(terminal.output, 'syntax-preview-go'), 'go'); await closeTerminals([terminal]);
    }
  });
