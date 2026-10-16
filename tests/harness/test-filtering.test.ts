import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native test skip patterns prevent excluded top-level and nested bodies from executing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tidy-ui-test-filter-'));
  try {
    const fixture = join(directory, 'filter.test.mjs');
    writeFileSync(fixture, `import assert from 'node:assert/strict';
import test from 'node:test';
const forbidden = () => assert.fail('excluded body executed');
test('excluded source case', forbidden);
test('permitted source case', () => console.log('FILTER_BODY:top'));
test('permitted group', async t => {
  await t.test('excluded source case', forbidden);
  await t.test('permitted source case', () => console.log('FILTER_BODY:nested'));
});
`);
    const env = { ...process.env };
    // This child is a standalone runner, not a member of the parent's binary report channel.
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-skip-pattern=excluded source case', fixture],
      { encoding: 'utf8', timeout: 10000, env });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(child.stdout.split('\n').filter(line => line.startsWith('# FILTER_BODY:')),
      ['# FILTER_BODY:top', '# FILTER_BODY:nested']);
    assert.equal(child.signal, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
