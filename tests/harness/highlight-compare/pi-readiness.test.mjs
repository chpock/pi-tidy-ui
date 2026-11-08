import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../../scripts/highlight-compare/model.mjs';
import { validatePiReadiness } from '../../../scripts/highlight-compare/adapters/pi-tidy-ui.mjs';

const fixture = { kind: 'source', filename: 'example.py', content: 'def f():\n    return "界"\n' };
fixture.sha256 = digest(fixture.content);
const bytes = Buffer.byteLength(fixture.content), call = 'comparison-call';
const current = () => ({
  client: { enabled: true, provider: { availability: 'ready' }, selected: { kind: 'theme', id: 'github', variant: 'dark' },
    effective: { kind: 'theme', id: 'github-dark', fingerprint: 'test-palette' } },
  preparations: [{ call, phase: 'updated' }, { call, phase: 'prepared', sourceEligible: true, applied: true, outcomes: ['waiting'] }, { call, phase: 'updated' }],
  views: [{ kind: 'file', path: fixture.filename, accepted: true, preview: false, error: false, origin: 'owned', mode: 'truecolor',
    sources: [{ key: 'source-key', version: 7, complete: true, basisAccepted: true, rangesAccepted: true, textSha256: fixture.sha256,
      source: { version: 7, complete: true, sha256: fixture.sha256, bytes },
      status: { exact: true, complete: true, availability: 'ready', protective: false, execution: 'acknowledged' },
      work: { fallbackEligible: true }, display: { version: 7, complete: true, palette: 'theme:github-dark:test-palette:truecolor' }, ranges: [[0, bytes]] }] }],
});
const check = sample => validatePiReadiness(sample, fixture, 'github', 'dark', call);

test('Pi capture readiness uses current compiled whole-source paint rather than historical preparation outcomes', () => {
  for (const outcome of ['waiting', 'neutral', 'native']) {
    const sample = current(); sample.preparations[1].outcomes = [outcome];
    assert.equal(check(sample).status, 'ready');
  }
  const neutralGaps = current(); neutralGaps.views[0].sources[0].ranges = [[1, 3], [4, bytes]];
  assert.equal(check(neutralGaps).status, 'ready', 'native byte-range gaps are neutral by the FlatRangeReader contract');
});

test('Pi capture rejects stale, partial, foreign-palette or unpainted source even with native historical receipt and idle counters', () => {
  const violations = {
    'missing paint': sample => { sample.views = []; },
    'preview only': sample => { sample.views[0].preview = true; },
    'fallback paint': sample => { sample.views[0].origin = 'pi'; },
    'rejected outer borrow': sample => { sample.views[0].accepted = false; },
    'missing compiled group': sample => { sample.views[0].sources[0].basisAccepted = false; },
    'invalidated range reader': sample => { sample.views[0].sources[0].rangesAccepted = false; },
    'old text painted': sample => { sample.views[0].sources[0].textSha256 = digest('old'); },
    'prefix only': sample => { sample.views[0].sources[0].source.bytes--; },
    'incomplete classification': sample => { sample.views[0].sources[0].status.exact = false; },
    'source not complete': sample => { sample.views[0].sources[0].source.complete = false; },
    'unsettled native source': sample => { sample.views[0].sources[0].status.execution = 'unsettled'; },
    'older palette': sample => { sample.views[0].sources[0].display.palette = 'theme:github-light:test-palette:truecolor'; },
    'older source version': sample => { sample.views[0].sources[0].display.version--; },
    'wrong effective theme': sample => { sample.client.effective.id = 'github-light'; },
    'unavailable helper': sample => { sample.client.provider.availability = 'unavailable'; },
    'out-of-bounds native range': sample => { sample.views[0].sources[0].ranges = [[0, bytes + 1]]; },
  };
  for (const [label, violate] of Object.entries(violations)) {
    const sample = current(); sample.preparations[1].outcomes = ['native'];
    sample.source = { unsettledJobs: 0, stylePublications: 10 }; violate(sample);
    assert.throws(() => check(sample), Error, label);
  }
});

test('Pi saved edit metadata preserves original context coordinates after a net line removal', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { savedPiSession } = await import('../../../scripts/highlight-compare/adapters/pi-tidy-ui.mjs');
  const { prepareFileCard } = await import('../../../src/file-card.ts');
  const directory = mkdtempSync(join(tmpdir(), 'hc-pi-diff-'));
  const input = { kind: 'diff', id: 'net-removal', filename: 'example.txt', before: 'first\nold\n\nshared\n', after: 'first\nnew\nshared\n',
    logicalRows: [
      { role: 'context', oldLine: 1, newLine: 1, text: 'first' }, { role: 'removed', oldLine: 2, text: 'old' },
      { role: 'removed', oldLine: 3, text: '' }, { role: 'added', newLine: 2, text: 'new' },
      { role: 'context', oldLine: 4, newLine: 3, text: 'shared' },
    ] };
  try {
    const saved = savedPiSession(directory, input);
    const card = prepareFileCard({ kind: 'edit', path: input.filename, complete: true, failed: false, viewMode: 'full',
      saved: { format: 'numbered', value: saved.details.diff } });
    assert.deepEqual(card?.view.lines.map(row => [row.kind, row.old, row.next, row.text]), [
      [' ', 1, 1, 'first'], ['-', 2, undefined, 'old'], ['-', 3, undefined, ''], ['+', undefined, 2, 'new'], [' ', 4, 3, 'shared'],
    ]);
    assert.equal(saved.args.oldText, input.before);
    assert.equal(saved.args.newText, input.after);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
