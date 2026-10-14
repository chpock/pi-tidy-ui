import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);

test('shared optional-import fixture owns its transport across real SDK load and GC', { skip: !global.gc }, async () => {
  const preload = fileURLToPath(new URL('./fixtures/shared-import-gc.ts', import.meta.url));
  const target = fileURLToPath(new URL('./occipital-shared.test.ts', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(process.execPath, [
    '--expose-gc', '--import', preload, '--test', '--test-reporter=tap',
    '--test-timeout=3000',
    '--test-name-pattern=^optional import rejection is handled and diagnostics never echo raw errors$',
    target,
  ], { timeout: 6000, maxBuffer: 1024 * 1024, env });
  const collections = stdout.match(/^# \{"sharedImportCollections":(\d+)\}$/m);
  assert.ok(collections, stdout);
  assert.ok(Number(collections[1]) > 0, stdout);
  assert.match(stdout, /^ok \d+ - optional import rejection is handled and diagnostics never echo raw errors$/m);
  assert.match(stdout, /^# pass 1$/m);
  assert.match(stdout, /^# fail 0$/m);
  assert.match(stdout, /^# cancelled 0$/m);
});
