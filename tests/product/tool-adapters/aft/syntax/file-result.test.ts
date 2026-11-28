import '../../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureToolCall, createToolReader } from '../../../../../src/tool-adapters/registry.ts';
import { FILE_PREVIEW_MAX_UNITS } from '../../../../../src/cards/file-input.ts';
import { Tool, plain, setup } from '../../../../fixtures/sdk-contract-support.ts';

for (const hiddenHeader of [false, true]) test(`AFT diff preview bounds format detection before a hidden suffix (header=${hiddenHeader})`, t => {
  const diff = Array.from({ length: 1200 }, (_, index) => `+${index + 1} VISIBLE_${index + 1}`).join('\n')
    + (hiddenHeader ? '\n@@ -1 +1 @@\n-OLD_HIDDEN\n+NEW_HIDDEN' : '');
  const reader = createToolReader(captureToolCall({ name: 'edit', id: 'prefix-format', args: { path: 'a.ts' },
    result: { content: [], details: { diff } }, partial: false, expanded: false, executionStarted: true, argsComplete: true }));
  assert.ok(reader?.kind === 'edit');
  const original = RegExp.prototype.test;
  let visits = 0, maximum = 0;
  t.mock.method(RegExp.prototype, 'test', function(this: RegExp, value: string) {
    if (typeof value === 'string' && value.startsWith('+1 VISIBLE_1\n')) { visits++; maximum = Math.max(maximum, value.length); }
    return original.call(this, value);
  });
  const prepared = reader.prepareFile('preview');
  assert.ok(visits > 0, 'the real format detector is observed');
  assert.ok(maximum <= FILE_PREVIEW_MAX_UNITS, `format detection inspected ${maximum} units`);
  assert.ok(prepared, 'a valid numbered prefix remains displayable regardless of its hidden suffix');
  assert.equal(prepared.view.preview, true);
  assert.equal(prepared.view.omitted, true);
  assert.ok(prepared.view.lines.some(line => line.kind !== 'gap' && line.text === 'VISIBLE_1'));
  assert.ok(prepared.sources.every(source => !source.text.includes('HIDDEN')));
});

test('AFT exact preview title detects the saved diff format in the validation pass', t => {
  const prefix = Array.from({ length: 1200 }, (_, index) => `+${index + 1} VISIBLE_${index + 1}`).join('\n');
  const diff = `${prefix}\n@@ -1 +1 @@\n-OLD_HIDDEN\n+NEW_HIDDEN\n`;
  const reader = createToolReader(captureToolCall({ name: 'write', id: 'exact-format', args: { path: 'a.ts' },
    result: { content: [], details: { diff } }, partial: false, expanded: false, executionStarted: true, argsComplete: true }));
  assert.ok(reader?.kind === 'write');
  const exec = RegExp.prototype.exec;
  let rowStarts = 0, fullFormatScans = 0;
  t.mock.method(RegExp.prototype, 'exec', function(this: RegExp, value: string) {
    if (value === diff) {
      if (this.source === '[\\r\\n]') { if (this.lastIndex === 0) rowStarts++; }
      else fullFormatScans++;
    }
    return exec.call(this, value);
  });
  assert.equal(reader.classifyChange?.(), 'Replaced', 'a hunk after the prefix decides the saved result type');
  assert.deepEqual({ rowStarts, fullFormatScans }, { rowStarts: 1, fullFormatScans: 0 }, 'format recognition does not traverse the full input separately');
  const preview = reader.prepareFile('preview');
  assert.ok(preview?.view.lines.some(line => line.kind !== 'gap' && line.text === 'VISIBLE_1'));
  assert.ok(preview?.sources.every(source => !source.text.includes('HIDDEN')));
});

for (const ending of ['\n', '\r', '\r\n']) test(`AFT preserves distinct numbered and unified final-newline rules (${JSON.stringify(ending)})`, () => {
  const read = (diff: string) => {
    const reader = createToolReader(captureToolCall({ name: 'write', id: 'diff-ending', args: { path: 'a.ts' },
      result: { content: [], details: { diff } }, partial: false, expanded: false, executionStarted: true, argsComplete: true }));
    assert.ok(reader?.kind === 'write'); return reader;
  };
  const numbered = read(`+1 CONTENT${ending}`);
  assert.equal(numbered.classifyChange?.(), null);
  assert.equal(numbered.prepareFile('full'), undefined);
  const unified = read(['-1 NUMBERED_LIKE_PREAMBLE', '@@ -0,0 +1 @@', '+UNIFIED_CONTENT', ''].join(ending));
  assert.equal(unified.classifyChange?.(), 'Created', 'only hunk rows determine a unified title');
  assert.equal(unified.prepareFile('full')?.view.label, 'Created');
});

for (const kind of ['write', 'edit'] as const) test(`AFT ${kind} preview observes diagnostics consistently across no-op expansion and invalidation`, t => {
  const diagnostics: { severity: string; message: string }[] = [];
  const tool = new Tool(kind, { path: 'a.ts', content: 'const stableSource=1;' });
  tool.result = { content: [], details: { diagnostics, ...(kind === 'edit' ? { diff: '+1 const stableSource=1;' } : {}) } };
  const fixture = setup([tool]);
  t.after(() => fixture.controller.restore());
  const rows = () => tool.render(80).map(plain).join('\n');
  assert.doesNotMatch(rows(), /Diagnostics available/);
  diagnostics.push({ severity: 'error', message: 'CHANGED_DIAGNOSTIC' });
  tool.setExpanded(false);
  tool.invalidate();
  assert.match(rows(), /Diagnostics available in the full file view/);
  diagnostics.length = 0;
  tool.setExpanded(false);
  tool.invalidate();
  assert.doesNotMatch(rows(), /Diagnostics available/);
});
