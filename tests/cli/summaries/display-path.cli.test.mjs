import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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


const sharedHeadingPath = [
  'heading-wrap-contract-root',
  'first-segment-0123456789',
  'middle-segment-0123456789',
  'final-segment-0123456789',
  'long-shared-heading-filename-0123456789.txt',
].join('/');

for (const mode of ['fullscreen', 'regular']) test(`shared file-heading wrap CLI: ${mode} keeps oversized paths beside labels with preferred separator cuts`,
  { timeout: 120000 }, async () => {
    const terminals = [];
    const live = new PiTerminal(`shared-heading-wrap-${mode}`, {
      mode, dimensions: { columns: 96, rows: 100 }, tidyUi: true,
    });
    terminals.push(live);
    const before = 'const HEADER_BODY_SENTINEL_BEFORE = 1;';
    const written = 'const HEADER_BODY_SENTINEL_WRITE = 2;';
    const after = 'const HEADER_BODY_SENTINEL_AFTER = 3;';
    const bodyMarker = 'HEADER_BODY_SENTINEL';
    const headings = [
      { name: 'read', label: '→ Read', bodyParts: [`${bodyMarker}_BEFORE`] },
      { name: 'write', label: '← Wrote', bodyParts: [`${bodyMarker}_WRITE`] },
      { name: 'edit', label: '← Edited', bodyParts: [`${bodyMarker}_WRITE`, `${bodyMarker}_AFTER`] },
    ];
    const inspectHeading = async (dump, tool, label, bodyParts) => {
      const rows = lines(tool);
      const title = `${label} `;
      const titleRow = rows.findIndex(row => row.includes(label));
      assert.ok(titleRow >= 0, `${tool.name} title is visible: ${label}`);
      const titleColumn = rows[titleRow].indexOf(label);
      const expectedTitle = `${title}${sharedHeadingPath}`;
      const fragments = [rows[titleRow].slice(titleColumn)];
      let reconstructed = fragments[0], bodyRow = titleRow + 1;
      while (reconstructed.length < expectedTitle.length && bodyRow < rows.length) {
        const continuation = rows[bodyRow++].replace(/^[\s┃]+/u, '');
        if (continuation) { fragments.push(continuation); reconstructed += continuation; }
      }
      const firstPathPart = fragments[0].slice(title.length);
      assert.ok(firstPathPart.length > 0 && firstPathPart.length < sharedHeadingPath.length,
        `${tool.name} shares a path prefix with its title before wrapping`);
      assert.equal(fragments.join(''), `${title}${sharedHeadingPath}`,
        `${tool.name} header reconstructs exactly across displayed rows`);
      const firstThree = sharedHeadingPath.split('/').slice(0, 3).join('/') + '/';
      const expectedFirst = dump.width === 96 ? firstThree + (label === '→ Read' ? 'final-' : '')
        : dump.width === 60 ? 'heading-wrap-contract-root/first-segment-'
        : label === '← Edited' ? 'heading-wrap-contract-' : 'heading-wrap-contract-root/';
      assert.equal(firstPathPart, expectedFirst, `${tool.name} uses the nearest eligible separator at width ${dump.width}`);
      for (const part of bodyParts) assert.ok(rows.slice(bodyRow).join('\n').includes(part), `${tool.name} body retains ${part} after the complete title`);
      await assertFits(tool.lines, dump.width);

      const physicalHeading = dump.screen.find(row => {
        const column = row.indexOf(title);
        return column >= 0 && row.slice(column).startsWith(fragments[0]);
      });
      assert.ok(physicalHeading, `${tool.name} physical heading shares its first row with the path`);
    };
    try {
      const directories = sharedHeadingPath.split('/').slice(0, -1).join('/');
      mkdirSync(join(live.work, directories), { recursive: true });
      const file = join(live.work, sharedHeadingPath);
      writeFileSync(file, `${before}\n`);
      const calls = [
        { name: 'read', arguments: { path: sharedHeadingPath } },
        { name: 'write', arguments: { path: sharedHeadingPath, content: `${written}\n` } },
        { name: 'edit', arguments: { path: sharedHeadingPath, edits: [{ oldText: written, newText: after }] } },
      ];
      writeFileSync(join(live.output, 'highlighting-limits.json'), JSON.stringify({ calls }));
      await live.ready(); await live.run('highlighting-limits-read');
      const compact = await live.capture('compact');
      const traffic = live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type));
      assert.deepEqual(traffic.filter(event => event.type === 'call').map(({ name, input }) => ({ name, arguments: input })), calls);
      assert.equal(traffic.filter(event => event.type === 'result').length, calls.length);
      assert.ok(traffic.filter(event => event.type === 'result').every(event => event.isError === false));
      assert.equal(traffic.filter(event => event.type === 'model_context').length, calls.length + 1);
      assert.equal(readFileSync(file, 'utf8'), `${after}\n`);
      const sessionBytes = readFileSync(compact.session);
      const saved = persisted(compact);

      live.send('\x0f'); await live.settle();
      const expanded = await live.capture('expanded-wrapped-headings');
      for (const { name, label, bodyParts } of headings) {
        const tool = byName(expanded, name)[0];
        assert.ok(tool, `${name} tool result exists`);
        await inspectHeading(expanded, tool, label, bodyParts);
      }
      for (const width of [60, 40, 96]) {
        await live.resize(width, 100);
        const resized = await live.capture(`headings-${width}`);
        for (const { name, label, bodyParts } of headings)
          await inspectHeading(resized, byName(resized, name)[0], label, bodyParts);
        assert.deepEqual(persisted(resized), saved);
      }
      assert.deepEqual(persisted(expanded), saved, 'expansion preserves the exact saved arguments and results');
      assert.deepEqual(live.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)), traffic,
        'expansion does not repeat the real tool calls');
      assert.deepEqual(readFileSync(compact.session), sessionBytes, 'display wrapping leaves saved session bytes unchanged');
      await live.close();
      const replay = new PiTerminal(`shared-heading-replay-${mode}`, {
        mode, dimensions: { columns: 96, rows: 100 }, tidyUi: true, session: compact.session, workspace: live.work,
      });
      terminals.push(replay);
      await replay.ready(); replay.send('\x0f'); await replay.settle();
      const restored = await replay.capture('restored-wrapped-headings');
      for (const { name, label, bodyParts } of headings)
        await inspectHeading(restored, byName(restored, name)[0], label, bodyParts);
      assert.deepEqual(persisted(restored), saved);
      assert.equal(replay.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
      assert.deepEqual(readFileSync(compact.session), sessionBytes);
    } finally { await closeTerminals(terminals); }
  });
