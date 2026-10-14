import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs } from '../scripts/test/context.mjs';
import { prepareConsumerClosure, rewriteConsumerLock, seedConsumerLock } from './fixtures/consumer-preparation.mjs';

const run = promisify(execFile);

test('consumer lock rewriting changes only validated fixture URL origins', () => {
  const source = 'http://127.0.0.1:1234', destination = 'http://127.0.0.1:4321';
  const lock = { lockfileVersion: 3, packages: { '': { private: true }, 'node_modules/fixture': {
    version: '1.0.0', integrity: 'unchanged', resolved: `${source}/archives/${'a'.repeat(64)}`, optional: true } } };
  const rewritten = rewriteConsumerLock(lock, source, destination);
  assert.equal(rewritten.packages['node_modules/fixture'].resolved, `${destination}/archives/${'a'.repeat(64)}`);
  rewritten.packages['node_modules/fixture'].resolved = lock.packages['node_modules/fixture'].resolved;
  assert.deepEqual(rewritten, lock);
  for (const resolved of ['https://registry.npmjs.org/fixture', `${source}/unknown`, `${source}/archives/${'a'.repeat(64)}?query=1`]) {
    assert.throws(() => rewriteConsumerLock({ packages: { 'node_modules/fixture': { resolved } } }, source, destination));
  }
  assert.throws(() => rewriteConsumerLock(lock, 'https://registry.npmjs.org', destination));
  assert.throws(() => rewriteConsumerLock(lock, source, 'http://user:secret@127.0.0.1:4321'));
});

test('consumer preparation import has no setup/network/install side effects', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = pathToFileURL(join(import.meta.dirname, 'fixtures/consumer-preparation.mjs')).href;
  const result = await run(inputs.node.path, ['--input-type=module', '-e', `let fetches=0;globalThis.fetch=()=>{fetches++;throw Error('unexpected network')};
    const module=await import(${JSON.stringify(module)});console.log(JSON.stringify({fetches,exported:typeof module.prepareConsumerClosure}));`], {
    env: childEnv(root, { TIDY_TEST_INPUTS: undefined }, inputs), timeout: 10000 });
  assert.deepEqual(JSON.parse(result.stdout), { fetches: 0, exported: 'function' });
});

test('offline consumer preparation requires explicit frozen consumer metadata before npm or output creation', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-offline-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparation = join(root, 'not-created');
  await assert.rejects(prepareConsumerClosure({ ...inputs, preparation, registry: { packages: [{ name: 'seed' }] } }, { offline: true }), /explicit previously frozen consumer registry/);
  await assert.rejects(access(preparation), { code: 'ENOENT' });
});


test('consumer seed uses exact prepared host lock identities and rejects missing or changed archive records', () => {
  const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-fixture', dev: true };
  const lock = { name: 'source', version: '9.0.0', lockfileVersion: 3, packages: { '': { devDependencies: { fixture: '^1.0.0' } }, 'node_modules/fixture': entry } };
  const records = [{ name: 'fixture', version: '1.0.0', integrity: entry.integrity }];
  const manifest = { name: 'consumer', version: '0.0.0', dependencies: { fixture: '1.0.0', extension: '1.0.0' } };
  const seeded = seedConsumerLock(lock, records, manifest, 'http://127.0.0.1:4321');
  assert.equal(seeded.name, manifest.name); assert.deepEqual(seeded.packages[''].dependencies, manifest.dependencies);
  const projected = seeded.packages['node_modules/fixture'];
  assert.equal(projected.version, entry.version); assert.equal(projected.integrity, entry.integrity); assert.equal(projected.dev, true);
  assert.equal(new URL(projected.resolved).origin, 'http://127.0.0.1:4321');
  assert.equal(lock.packages['node_modules/fixture'].resolved, entry.resolved); assert.equal(lock.name, 'source');
  assert.throws(() => seedConsumerLock(lock, [], manifest, 'http://127.0.0.1:4321'), /lock archive missing/);
  assert.throws(() => seedConsumerLock(lock, [{ ...records[0], integrity: 'changed' }], manifest, 'http://127.0.0.1:4321'), /integrity changed/);
});
