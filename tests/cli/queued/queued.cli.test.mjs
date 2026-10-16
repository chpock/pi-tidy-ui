import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import test from 'node:test';
import { PiTerminal, fixtures, plain, assertFits } from '../../fixtures/terminal-harness.mjs';
import { runCleanupSteps } from '../../fixtures/terminal-cleanup.mjs';
import { Terminal } from '../../fixtures/main-cli-support.mjs';

for (const mode of ['regular', 'fullscreen']) test(`real CLI: queued cards adaptive height, native dequeue/delivery and replay (${mode})`,
  { timeout: 180000 }, async () => {
    const terminals = [];
    const messages = [Array.from({ length: 8 }, (_, i) => `QUEUE_FIRST_${i + 1}`).join('\n'),
      Array.from({ length: 8 }, (_, i) => `QUEUE_SECOND_${i + 1}`).join('\n'), 'QUEUE_FOLLOW_1\nQUEUE_FOLLOW_2'];
    const observe = async (terminal, name, action = 'snapshot') => {
      writeFileSync(join(terminal.output, 'queued-request.json'), JSON.stringify({ name, action }));
      terminal.send('\x1b[121;7u');
      if (!terminal.queuedNative) {
        if (action === 'on' || action === 'off') await terminal.appearance(action === 'on', { alreadyOpen: true, leaveOpen: true });
        await terminal.cacheSnapshot(action === 'cache clear', { alreadyOpen: true, refreshAfterClear: true,
          beforeClose: stats => writeFileSync(join(terminal.output, `${name}-menu-stats.json`), JSON.stringify(stats)) });
      }
      const dump = await terminal.waitForProgress(() => {
        terminal.health(); const file = join(terminal.output, `${name}.json`);
        if (!existsSync(file)) return false;
        try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
      }, `queued ${name}`);
      await terminal.settle(); terminal.session = dump.session;
      return terminal.captureScreen(name, dump);
    };
    const start = async (name, native = false, options = {}) => {
      const terminal = new PiTerminal(`queued-${name}-${mode}`, { mode, ...options,
        agentSettings: { steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
        extraEnv: { TIDY_UI_TEST_QUEUED_CARDS: '1', ...(native ? { TIDY_UI_TEST_QUEUE_NATIVE: '1' } : {}) },
        extensions: [join(fixtures, 'queued-driver.ts')] });
      terminal.queuedNative = native;
      terminals.push(terminal); await terminal.ready(); await terminal.resize(100, 120); return terminal;
    };
    const enqueue = async terminal => {
      for (let i = 0; i < messages.length; i++) {
        terminal.send('\x1b[200~' + messages[i] + '\x1b[201~' + (i === 2 ? '\x1b\r' : '\r'));
        await terminal.settle();
      }
    };
    // Only cross-run wall-clock metadata is variable. Keep all content, mode,
    // usage and other message fields exact; captures retain the original values.
    const withoutTiming = message => {
      if (message.role === 'assistant' && Object.hasOwn(message, 'durationMs')) {
        assert.ok(Number.isFinite(message.durationMs) && message.durationMs >= 0);
        return { ...message, timestamp: 0, durationMs: 0 };
      }
      return { ...message, timestamp: 0 };
    };
    const saved = terminal => readFileSync(terminal.session, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(entry => entry.type === 'message').map(entry => withoutTiming(entry.message));
    const contexts = terminal => {
      const events = terminal.events();
      assert.equal(events.filter(event => event.type === 'call').length, 0);
      assert.equal(events.filter(event => event.type === 'result').length, 0);
      assert.equal(events.filter(event => event.type === 'provider_error').length, 0);
      const values = events.filter(event => event.type === 'queued_context'); assert.equal(values.length, 4);
      return values;
    };
    const text = value => typeof value.content === 'string' ? value.content : value.content.filter(part => part.type === 'text').map(part => part.text).join('');
    const visibleBodies = dump => {
      const bodies = []; let current = [];
      for (const row of dump.rows.map(plain)) {
        if (!row.includes('┃')) continue;
        const value = row.slice(3);
        if (value.startsWith(' QUEUED · ')) { bodies.push(current.filter(Boolean)); current = []; }
        else current.push(value);
      }
      return bodies;
    };
    const physical = async dump => {
      // xterm retains painted trailing spaces. Compare exact full-width physical
      // rows instead of comparing them with trimEnd()'d component strings.
      const expected = dump.rows.map(row => stripVTControlCharacters(row).padEnd(dump.width));
      const first = dump.screen.findIndex((_, y) => expected.every((row, i) => dump.screen[y + i]?.padEnd(dump.width) === row));
      assert.ok(first >= 0, 'actual terminal displays the complete bounded pending block');
      await assertFits(dump.rows, dump.width);
      for (let y = 0; y < expected.length; y++) {
        const row = expected[y], x = row.indexOf('QUEUED · '); if (x < 0) continue;
        const stripe = dump.cells[first + y][1], badge = dump.cells[first + y][x], panel = dump.cells[first + y][2];
        assert.equal(badge.bg, stripe.fg); assert.equal(badge.bgMode, stripe.fgMode);
        const label = row.includes('QUEUED · Steering') ? 'QUEUED · Steering' : 'QUEUED · Follow-up';
        for (const column of [x - 1, x + label.length]) {
          const padding = dump.cells[first + y][column];
          assert.equal(padding.text, ' ');
          assert.equal(padding.bg, badge.bg); assert.equal(padding.bgMode, badge.bgMode);
        }
        assert.equal(badge.fg, panel.bg); assert.equal(badge.fgMode, panel.bgMode);
        for (const column of [0, dump.width - 1]) assert.equal(dump.cells[first + y][column].bgMode, 0);
      }
      const suffix = expected.findIndex(row => row.includes('(Alt+Up to edit all queued messages)'));
      assert.ok(suffix >= 0); const row = expected[suffix], opening = row.indexOf('('), closing = row.lastIndexOf(')');
      const reference = new Terminal({ cols: 4, rows: 1, allowProposedApi: true });
      try {
        for (const [role, columns] of [['dim', [opening, closing]], ['muted', [opening + 1]]]) {
          reference.reset(); await new Promise(done => reference.write(dump.styles[role], done));
          const color = reference.buffer.active.getLine(0).getCell(0);
          for (const column of columns) {
            const cell = dump.cells[first + suffix][column];
            assert.equal(cell.fg, color.getFgColor()); assert.equal(cell.fgMode, color.getFgColorMode());
          }
        }
      } finally { reference.dispose(); }
    };
    try {
      const terminal = await start('tidy-ui'); terminal.send('run queued-cards\r'); await terminal.event('queued_gate');
      await enqueue(terminal);
      let dump = await observe(terminal, 'full');
      assert.equal(dump.pending, true); assert.equal(dump.stats.byKind.queued.entries, 3);
      assert.deepEqual(visibleBodies(dump), messages.map(value => value.split('\n'))); await physical(dump);
      assert.equal(dump.rows.length, 33);
      assert.equal(dump.rows.filter(row => row.includes('edit all queued messages')).length, 1);
      assert.ok(!dump.rows.join('').includes('↳')); assert.deepEqual(dump.before, dump.after);
      assert.deepEqual(saved(terminal).filter(message => message.role === 'user').map(text), ['run queued-cards'], 'unsent cards are not history');
      const waitingBytes = readFileSync(terminal.session, 'utf8');
      const cold = dump.stats.builds;
      await terminal.observeAnimation();
      dump = await observe(terminal, 'warm'); assert.equal(dump.stats.builds, cold, 'Working frames do not rebuild queued layouts');
      await terminal.resize(100, 90); dump = await observe(terminal, 'budget-thirty');
      assert.equal(dump.rows.length, 30); assert.deepEqual(visibleBodies(dump).map(body => body.length), [5, 8, 2]);
      assert.equal(visibleBodies(dump)[0].at(-1), 'QUEUE_FIRST_5…'); await physical(dump);
      assert.equal(dump.stats.builds, cold, 'height-only change does not rebuild card text');
      await terminal.resize(100, 60); dump = await observe(terminal, 'budget-twenty');
      assert.equal(dump.rows.length, 20); assert.deepEqual(visibleBodies(dump).map(body => body.length), [1, 2, 2]); await physical(dump);
      await terminal.resize(100, 30); dump = await observe(terminal, 'minimum-overflow');
      assert.equal(dump.rows.length, 18); assert.deepEqual(visibleBodies(dump).map(body => body.length), [1, 1, 1]); await physical(dump);
      await terminal.resize(100, 12); dump = await observe(terminal, 'host-clipping');
      assert.equal(dump.rows.length, 18); assert.equal(visibleBodies(dump).length, 3, 'all cards returned despite host height clipping');
      await terminal.resize(100, 120); dump = await observe(terminal, 'light', 'light'); await physical(dump);
      dump = await observe(terminal, 'dark', 'dark'); await physical(dump);
      await terminal.resize(30, 120); dump = await observe(terminal, 'narrow'); await assertFits(dump.rows, 30);
      assert.equal(dump.raw.length, 4); assert.equal(dump.stats.byKind.queued.entries, 3);
      await terminal.resize(100, 120);
      terminal.send('UNCHANGED_DRAFT'); await terminal.settle();
      dump = await observe(terminal, 'off', 'off'); assert.deepEqual(dump.rows, dump.nativeRows); assert.equal(dump.before.expanded, 'UNCHANGED_DRAFT'); assert.deepEqual(dump.before, dump.after);
      dump = await observe(terminal, 'on', 'on'); assert.deepEqual(dump.before, dump.after); await physical(dump);
      await terminal.clearDraft();
      terminal.send('\x1b[1;3A'); await terminal.settle();
      dump = await observe(terminal, 'dequeued'); assert.equal(dump.pending, false); assert.deepEqual(dump.rows, []);
      assert.equal(dump.after.expanded, messages.join('\n\n')); assert.equal(dump.stats.byKind.queued.entries, 0);
      await terminal.clearDraft(); await enqueue(terminal);
      dump = await observe(terminal, 'requeued'); assert.deepEqual(visibleBodies(dump), messages.map(value => value.split('\n')));
      assert.equal(readFileSync(terminal.session, 'utf8'), waitingBytes, 'unsent presentation and edit-all never write history');
      writeFileSync(join(terminal.output, 'queued-release'), 'go'); await terminal.event('agent_end');
      dump = await observe(terminal, 'delivered', 'snapshot'); assert.equal(dump.pending, false); assert.deepEqual(dump.rows, []);
      assert.equal(dump.stats.byKind.queued.entries, 0);
      assert.deepEqual(saved(terminal).filter(message => message.role === 'user').map(text), ['run queued-cards', ...messages]);
      const traffic = contexts(terminal), stored = saved(terminal);
      await terminal.command('/reload'); await terminal.event('start', 2);
      dump = await observe(terminal, 'reload', 'snapshot'); assert.deepEqual(dump.rows, []); assert.deepEqual(contexts(terminal), traffic);
      const native = await start('native', true, { workspace: terminal.work });
      native.send('run queued-cards\r'); await native.event('queued_gate'); await enqueue(native);
      const stock = await observe(native, 'queued-native'); assert.deepEqual(stock.rows, stock.nativeRows); assert.equal(stock.raw.length, 4);
      writeFileSync(join(native.output, 'queued-release'), 'go'); await native.event('agent_end');
      await observe(native, 'delivered-native', 'snapshot');
      const timed = values => values.map(event => ({ ...event, messages: event.messages.map(withoutTiming) }));
      assert.deepEqual(timed(contexts(native)), timed(traffic), 'exact provider input messages match native delivery apart from wall-clock metadata');
      assert.deepEqual(saved(native), stored, 'saved message data equal apart from timestamps and assistant durationMs');
      const replay = await start('replay', false, { session: terminal.session, workspace: terminal.work });
      const replayDump = await observe(replay, 'replay', 'snapshot'); assert.deepEqual(replayDump.rows, []); assert.equal(replayDump.pending, false);
      assert.equal(replay.events().filter(event => event.type === 'queued_context').length, 0);
      assert.deepEqual(saved(replay), stored, 'replay adds neither queue rows nor model requests');
    } finally { await runCleanupSteps(...terminals.map(terminal => () => terminal.close()), ...terminals.map(terminal => () => terminal.dispose())); }
  });
