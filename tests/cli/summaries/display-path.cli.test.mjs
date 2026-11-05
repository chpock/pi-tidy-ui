import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PiTerminal, byName, lines, toolLines, assertFits } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';
import { persisted } from '../../fixtures/main-cli-support.mjs';

for (const mode of ['fullscreen', 'regular']) test(`display paths CLI: ${mode} root-reaching read/write/edit, compact parameters and replay`,
  { timeout: 120000 }, async () => {
    const terminals = [];
    const create = (name, options = {}) => {
      const terminal = new PiTerminal(`display-path-${mode}-${name}`, {
        mode, dimensions: { columns: 240, rows: 100 }, ...options,
      });
      terminals.push(terminal);
      return terminal;
    };
    try {
      const live = create('live', { tidyUi: true });
      const source = join(live.work, 'path-source.txt'), written = join(live.work, 'path-written.txt');
      const nearby = join(live.work, '../nearby.txt');
      writeFileSync(source, 'PATH_READ_SAVED\n');
      writeFileSync(nearby, 'PATH_NEARBY_SAVED\n');
      const rooted = path => '../'.repeat(live.work.split('/').filter(Boolean).length + 2) + path.slice(1);
      const calls = [
        { name: 'read', arguments: { path: rooted(source) } },
        { name: 'write', arguments: { path: rooted(written), content: 'PATH_WRITE_OLD\n' } },
        { name: 'edit', arguments: { path: rooted(written), edits: [{ oldText: 'PATH_WRITE_OLD', newText: 'PATH_WRITE_NEW' }] } },
        { name: 'read', arguments: { path: '../nearby.txt' } },
        { name: 'tidy_ui_summary', arguments: { target: rooted(source), files: [rooted(written)] } },
      ];
      writeFileSync(join(live.output, 'highlighting-limits.json'), JSON.stringify({ calls }));
      await live.ready(); await live.run('highlighting-limits-read');
      const compact = await live.capture('compact');
      assert.ok(compact.screen.some(row => row.includes(`read ${source}`)), 'physical compact read displays the resolved name');
      assert.ok(compact.screen.some(row => row.includes('read ../nearby.txt')), 'ordinary parent-relative path remains relative');
      const generic = lines(byName(compact, 'tidy_ui_summary')[0]).join('');
      assert.ok(generic.includes(source) && generic.includes(`files=["${written}"]`), generic);
      const traffic = live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
      assert.deepEqual(traffic.filter(event => event.type === 'call').map(({ name, input }) => ({ name, arguments: input })), calls);
      const results = traffic.filter(event => event.type === 'result');
      assert.equal(results.length, calls.length);
      assert.ok(results.every(result => result.isError === false), 'all real filesystem tools execute successfully with unchanged input');
      assert.equal(readFileSync(written, 'utf8'), 'PATH_WRITE_NEW\n');
      const sessionBytes = readFileSync(compact.session);
      live.send('\x0f'); await live.settle();
      const expanded = await live.capture('expanded');
      for (const heading of [`→ Read ${source}`, `← Wrote ${written}`, `← Edited ${written}`, '→ Read ../nearby.txt'])
        assert.ok(expanded.screen.some(row => row.includes(heading)), `physical expanded heading: ${heading}`);
      assert.ok(expanded.screen.some(row => row.includes('PATH_READ_SAVED')));
      assert.deepEqual(persisted(expanded), persisted(compact));
      await live.resize(80, 100);
      const narrow = await live.capture('narrow');
      for (const tool of narrow.tools) await assertFits(tool.lines, 80);
      assert.deepEqual(readFileSync(compact.session), sessionBytes, 'UI normalization, expansion and resize do not change saved session bytes');
      assert.deepEqual(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)), traffic);
      await live.close();

      const native = create('native-replay', { session: compact.session, workspace: live.work });
      await native.ready(); native.send('\x0f'); await native.settle();
      const nativeExpanded = await native.capture('expanded'); await native.close();
      const replay = create('replay', { tidyUi: true, session: compact.session, workspace: live.work });
      await replay.ready(); replay.send('\x0f'); await replay.settle();
      const restored = await replay.capture('expanded');
      assert.ok(restored.screen.some(row => row.includes(`→ Read ${source}`)), 'saved arguments normalize again without new execution');
      assert.ok(restored.screen.some(row => row.includes(`← Edited ${written}`)));
      assert.deepEqual(persisted(restored), persisted(compact));
      await replay.appearance(false);
      const off = await replay.capture('off');
      assert.deepEqual(toolLines(off), toolLines(nativeExpanded), 'Appearance Off restores the exact native replay of the same saved data');
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      assert.equal(readFileSync(written, 'utf8'), 'PATH_WRITE_NEW\n');
      assert.equal(readFileSync(source, 'utf8'), 'PATH_READ_SAVED\n');
      assert.deepEqual(readFileSync(compact.session), sessionBytes);
    } finally { await closeTerminals(terminals); }
  });
