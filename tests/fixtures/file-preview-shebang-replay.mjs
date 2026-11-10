import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from './terminal-harness.mjs';
import { closeTerminals, runCleanupSteps } from './terminal-cleanup.mjs';
import { semanticStyle } from './syntax-observation.mjs';
import { body, captureThenRenderDiagnostics, expressionForeground, finish, settledStats, syntaxReady, traffic, work } from './syntax-cli-support.mjs';

export async function assertPreviewShebangReplay({ mode, fixture, descriptor, shared }) {
  const directory = await mkdtemp(resolve('.test-artifacts/preview-shebang-')), terminals = [];
  try {
    const marker = 'SHEBANG_FILE_ONLY_MEASURE_7F3A';
    const rows = ['#!/usr/bin/python3', `print("${marker}")`, ...Array.from({ length: 12 }, (_, i) => `pass # row ${i}`), '# HIDDEN_PREVIEW_TAIL'];
    const content = rows.join('\n'), prefix = rows.slice(0, 10).join('\n');
    const manager = SessionManager.create(directory, join(directory, 'sessions'));
    manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const residue = 'OSC_PHYSICAL_SOURCE_ROW_71C';
    // One physical hunk header leaves nine source rows in the ten-row window.
    const topology = ['#!/usr/bin/python3', residue, 'print("TOPOLOGY_SOURCE")', ...Array.from({ length: 6 }, (_, i) => `pass # topology ${i}`)];
    const savedRows = [`${topology[0]}\u001b]8;;hidden`, `${residue}\u0007`, ...topology.slice(2), 'HIDDEN_TOPOLOGY_SOURCE_ROW', 'pass # tail 1', 'pass # tail 2'];
    const cases = [
      { id: 'valid', content }, { id: 'invalid', content: `\u001b[31m${content}` },
      { id: 'topology', content: 'UNUSED_TOPOLOGY_ARGUMENT', details: { diff: `@@ -1,12 +1,12 @@\n${savedRows.map(row => ` ${row}`).join('\n')}` } },
      { id: 'envelope', content: 'UNUSED_ENVELOPE_ARGUMENT', details: { diff: '\u001b[31m@@ -1,1 +1,1 @@\n-before\n+ENVELOPE_MUST_NOT_BECOME_SOURCE' } },
    ];
    for (const entry of cases) {
      const { id } = entry, path = `preview-${id}.unknown`;
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `saved preview ${id}` }], timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'write',
        arguments: { path, content: entry.content } }], api: 'openai-completions',
        provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: 'toolUse', timestamp: Date.now() });
      manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'write', content: [{ type: 'text', text: 'Saved write' }],
        details: entry.details ?? {}, isError: false, timestamp: Date.now() });
    }
    const session = manager.getSessionFile(), original = readFileSync(session);
    const terminal = new PiTerminal(`preview-shebang-${shared ? 'shared' : 'owned'}-${mode}`, {
      mode, session, workspace: directory, dimensions: { columns: 120, rows: 120 }, extensions: [fixture], extraEnv: {
        ...descriptor, TIDY_UI_TEST_PALETTE_OBSERVE: '1',
        ...(shared ? { SUBC_CONNECTION_FILE: shared.alias, TIDY_UI_TEST_SYNTAX_SHARED: '1' } : {}),
      },
    });
    terminals.push(terminal);
    await terminal.ready(); await syntaxReady(terminal);
    const shown = await captureThenRenderDiagnostics(terminal, 'raw-preview');
    const visible = body(shown).flatMap(tool => tool.lines).join('\n');
    assert.match(visible, /← Write preview-valid\.unknown/);
    assert.match(visible, /← Write preview-invalid\.unknown/);
    assert.doesNotMatch(visible, /HIDDEN_PREVIEW_TAIL/);
    const physical = shown.screen.join('\n');
    assert.match(physical, new RegExp(residue), 'later physical source rows survive multiline terminal-sequence cleanup');
    assert.match(physical, /No saved file change details are available/, 'a decorated envelope remains an owned unsupported preview');
    assert.doesNotMatch(physical, /HIDDEN_TOPOLOGY_SOURCE_ROW|ENVELOPE_MUST_NOT_BECOME_SOURCE|UNUSED_(?:TOPOLOGY|ENVELOPE)_ARGUMENT/);
    const events = terminal.events();
    const offered = events.filter(event => event.type === 'syntax_native_dispatch' && event.kind === 'source')
      .flatMap(event => event.payload.sources ?? []);
    for (const valid of [true, false]) {
      const path = `preview-${valid ? 'valid' : 'invalid'}.unknown`, sources = offered.filter(source => source.hint?.path === path);
      assert.ok(sources.length > 0, `${path}: actual SOURCE submission is observable`);
      for (const source of sources) {
        assert.equal(source.text, prefix, 'the parser receives only the cleaned ten-row preview');
        assert.equal(source.hint.language, valid ? 'python' : undefined, 'only an original control-free row selects Python');
      }
    }
    const topologySources = offered.filter(source => source.hint?.path === 'preview-topology.unknown');
    assert.ok(topologySources.length > 0, 'AFT-shaped saved diff reaches the actual SOURCE boundary');
    // Row-local cleaning preserves this incomplete OSC's visible tail, as in full views.
    const expectedTopology = ['#!/usr/bin/python3idden', ...topology.slice(1)].join('\n');
    for (const source of topologySources) {
      assert.equal(source.text, expectedTopology, 'one original header and nine source rows exhaust the physical prefix');
      assert.equal(source.hint.language, undefined, 'per-row cleaning cannot repair the original control-bearing hint');
    }
    assert.equal(offered.some(source => source.hint?.path === 'preview-envelope.unknown'), false, 'an unsupported raw envelope starts no SOURCE work');
    assert.ok(events.some(event => event.type === 'syntax_native_reply' && event.kind === 'source'
      && event.reply.status === 'error' && event.reply.error?.code === 'unknown_syntax' && event.reply.error?.execution === 'not_started'
      && event.payload.sources?.some(source => source.hint?.path === 'preview-invalid.unknown')),
    'a manufactured selector cannot bypass the genuine no-syntax control');
    const style = semanticStyle(events, marker, 'pi', 'python'); assert.ok(style, 'the valid source has actual SOURCE/STYLE results');
    const rgb = role => {
      const match = shown.summaryStyles[role].match(/38;2;(\d+);(\d+);(\d+)m/); assert.ok(match);
      return Number(match[1]) * 65536 + Number(match[2]) * 256 + Number(match[3]);
    };
    const colors = shown.screen.flatMap((row, y) => row.includes(marker) ? [shown.cells[y][row.indexOf(marker)].fg] : []);
    assert.deepEqual(colors, [expressionForeground(style.expression, shown, 'pi'), rgb('mdCodeBlock')]);
    assert.equal(colors[0], rgb('syntaxString'), 'the valid Python string uses the public Pi string ink');
    assert.notEqual(colors[0], colors[1], 'the same cleaned source keeps Pi\'s uniform unknown-language ink without an original hint');
    assert.ok(shown.sample.localWork.shebangFileSegments > 0, 'the observed measurement marker belongs to these two cards');
    assert.equal(shown.sample.client.provider.kind, shared ? 'shared' : 'owned');
    const before = await settledStats(terminal, 'raw-preview-before'); assert.deepEqual(work(before), work(shown.sample));
    await terminal.captureSettled('raw-preview-warm'); await terminal.resize(96, 120);
    await terminal.captureSettled('raw-preview-resized');
    const after = await settledStats(terminal, 'raw-preview-after'); assert.deepEqual(work(after), work(before));
    assert.equal(after.counts.piCaptures, before.counts.piCaptures, 'warm/resize starts no fallback classification');
    assert.equal(after.source.globalUnsettledJobs, 0); assert.equal(traffic(terminal).length, 0);
    assert.deepEqual(readFileSync(session), original, 'replay and UI-only resize preserve original saved bytes');
    console.log(JSON.stringify({ mode, provider: shared ? 'shared' : 'owned', previewShebang: { colors, cold: work(before), warmDelta: 0 }, output: terminal.output }));
    await finish(terminal); assert.deepEqual(readFileSync(session), original);
  } finally { await runCleanupSteps(() => closeTerminals(terminals), () => rm(directory, { recursive: true, force: true })); }
}
