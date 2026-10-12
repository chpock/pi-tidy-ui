import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runNpmPreparation, summarizeNpmLog } from './fixtures/npm-preparation.ts';

const secret = 'PRIVATE_AUTH_MARKER';
const log = `0 verbose cli /private/${secret}/node /private/npm
1 silly config load:/private/${secret}/.npmrc
2 silly fetch manifest @private/${secret}@1.0.0
3 http fetch GET 200 https://user:${secret}@registry.example/pkg?token=${secret} 40ms (cache miss)
4 timing idealTree:${secret} Completed in 42ms
5 silly tarball no local data for ${secret}. Extracting by manifest.
6 silly placeDep ROOT ${secret}
7 silly reify mark retired [ '/private/${secret}' ]
8 error code ETIMEDOUT
9 error ${secret}
10 verbose stack Error: ${secret}
11 timing ${secret} Completed in 99ms
`;

test('npm diagnostics project only known stages and numeric progress, never opaque log data', () => {
  assert.deepEqual(summarizeNpmLog(log), [
    { line: 1, event: 'configuration' }, { line: 2, event: 'fetchManifest' },
    { line: 3, event: 'http', status: 200, elapsedMs: 40 },
    { line: 4, event: 'idealTree', elapsedMs: 42 }, { line: 5, event: 'tarball' },
    { line: 6, event: 'placeDependency' }, { line: 7, event: 'reify' }, { line: 8, event: 'ETIMEDOUT' },
  ]);
  assert.doesNotMatch(JSON.stringify(summarizeNpmLog(log)), /PRIVATE_AUTH_MARKER|private|https|registry|npmrc/);
  assert.deepEqual(summarizeNpmLog('partial row\nunknown\n99999999999999999999 silly fetch manifest secret\n12 http fetch GET 999 secret 1ms'), []);
});

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, failure: boolean, logsPresent = true) {
  const root = await mkdtemp(join(tmpdir(), 'tidy-npm-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporary = join(root, 'temporary'), reportsRoot = join(root, 'reports');
  await mkdir(temporary);
  const npmPath = join(root, 'npm-fixture.mjs');
  await writeFile(npmPath, `import { writeFile } from 'node:fs/promises';
const logs = process.argv.find(arg => arg.startsWith('--logs-dir=')).slice('--logs-dir='.length);
if (${logsPresent}) await writeFile(logs + '/fixture-debug-0.log', ${JSON.stringify(log)});
console.log(${JSON.stringify(failure ? secret : '[{"filename":"fixture.tgz"}]')});
console.error(${JSON.stringify(secret)});
process.exitCode = ${failure ? 17 : 0};
`);
  return { temporary, reportsRoot, options: { cwd: root, npmPath, logsRoot: join(temporary, 'npm-logs'), reportsRoot } };
}

test('failed real preparation child preserves original failure and safe diagnostic after consumer cleanup', async t => {
  const f = await fixture(t, true);
  await assert.rejects(runNpmPreparation(['install', 'private-package'], f.options), { code: 17 });
  await rm(f.temporary, { recursive: true, force: true });
  const [directory] = await readdir(f.reportsRoot);
  const bytes = await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8');
  assert.doesNotMatch(bytes, /PRIVATE_AUTH_MARKER|private|https|registry|npmrc|stdout|stderr|cmd|environment/);
  const packet = JSON.parse(bytes);
  assert.equal(packet.node, process.version); assert.equal(packet.operation, 'install');
  assert.equal(packet.exitCode, 17); assert.equal(packet.killed, false);
  assert.equal(packet.signal, null); assert.deepEqual(packet.debugLogs, [summarizeNpmLog(log)]);
});

test('successful preparation preserves exact pack stdout/stderr and writes no failure artifact', async t => {
  const f = await fixture(t, false);
  const result = await runNpmPreparation(['pack'], f.options);
  assert.equal(result.stdout, '[{"filename":"fixture.tgz"}]\n');
  assert.equal(result.stderr, secret + '\n');
  await assert.rejects(readdir(f.reportsRoot), { code: 'ENOENT' });
});

test('missing npm log stays explicit and capture I/O failure preserves both errors', async t => {
  const f = await fixture(t, true, false);
  await assert.rejects(runNpmPreparation(['install'], f.options), { code: 17 });
  const [directory] = await readdir(f.reportsRoot);
  assert.deepEqual(JSON.parse(await readFile(join(f.reportsRoot, directory!, 'npm.json'), 'utf8')).debugLogs, []);
  const file = join(f.temporary, 'not-a-directory'); await writeFile(file, 'occupied');
  await assert.rejects(runNpmPreparation(['install'], { ...f.options, reportsRoot: file }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, 17); return true;
  });
});
