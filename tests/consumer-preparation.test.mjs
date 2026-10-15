import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs, toolPath } from '../scripts/test/context.mjs';
import { installConsumer, prepareConsumerClosure, readConsumerArchiveManifest, rewriteConsumerLock, seedConsumerLock, verifyConsumerReplay } from './fixtures/consumer-preparation.mjs';
import { runNpmPreparation } from './fixtures/npm-preparation.ts';

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


test('consumer preparation replays both optional modes through clean ci without changing the locked graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tidy-consumer-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'package-lock.json'), lock = { lockfileVersion: 3, packages: { '': { name: 'fixture' }, 'node_modules/fixture': { version: '1.0.0' } } };
  await writeFile(path, JSON.stringify(lock));
  const requests = [], registry = 'http://127.0.0.1:4321';
  const npm = async (args, url, cwd) => { requests.push({ args, url, cwd }); };
  for (const installed of [true, false]) await verifyConsumerReplay(npm, root, installed, registry);
  assert.deepEqual(requests, [true, false].map(installed => ({
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional'])], url: registry, cwd: root,
  })));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), lock);
  const failure = new Error('required ci metadata unavailable');
  await assert.rejects(verifyConsumerReplay(async () => { throw failure; }, root, true, registry), error => error === failure);
  await assert.rejects(verifyConsumerReplay(async () => {
    await writeFile(path, JSON.stringify({ ...lock, packages: {} }));
  }, root, true, registry), /preserve the frozen graph/);
});

test('consumer preparation extracts unchanged real archives from LF and CRLF listings and rejects non-root or ambiguous manifests', { skip: process.platform === 'win32' }, async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy-consumer-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "Node Runtime's bin", 'node');
  await mkdir(join(root, "Node Runtime's bin")); await copyFile(inputs.node.path, executable);
  const script = join(root, "tar wrapper's code.mjs"), wrapper = join(root, 'tar-crlf');
  await writeFile(script, `import {execFileSync} from 'node:child_process';\nconst args=process.argv.slice(2), bytes=execFileSync(${JSON.stringify(toolPath('tar'))},args);\nprocess.stdout.write(args[0]==='-tzf'?bytes.toString().replace(/\\r?\\n/g,'\\r\\n'):bytes);\n`);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  for (const [name, members, valid] of [
    ['root', ['package/package.json'], true],
    ['dot-root', ['./package/package.json'], true],
    ['nested', ['package/nested/package.json'], false],
    ['ambiguous', ['first/package.json', 'second/package.json'], false],
  ]) {
    const source = join(root, name); await mkdir(source);
    const manifest = { name: 'archive-fixture', version: '1.2.3' };
    for (const member of members) {
      const directory = join(source, member, '..'); await mkdir(directory, { recursive: true });
      await writeFile(join(source, member), JSON.stringify(manifest));
    }
    const archive = join(root, name + '.tgz');
    execFileSync(toolPath('tar'), ['-czf', archive, '-C', source, ...members], { env: childEnv(join(root, 'environment'), {}, inputs) });
    const bytes = await readFile(archive);
    for (const tar of [toolPath('tar'), wrapper]) {
      const selected = { ...inputs, tools: { ...inputs.tools, tar } };
      if (valid) assert.deepEqual(readConsumerArchiveManifest(selected, join(root, 'environment'), archive), manifest);
      else assert.throws(() => readConsumerArchiveManifest(selected, join(root, 'environment'), archive), /exactly one root manifest/);
      assert.deepEqual(await readFile(archive), bytes, 'listing conversion must not rewrite archive bytes');
    }
  }
});

test('consumer npm installs from its own cwd without the Windows prefix self-install branch', async t => {
  const inputs = readInputs(), root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'tidy-consumer-npm-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmPath = join(root, 'windows-layout.cjs');
  // Use the actual selected npm; only its global-directory layout models Windows on POSIX.
  await writeFile(npmPath, `const {createRequire}=require('node:module'),{join}=require('node:path');\nconst cli=${JSON.stringify(inputs.tools.npm)},load=createRequire(cli),Npm=load('../lib/npm.js');\nObject.defineProperty(Npm.prototype,'globalDir',{get(){return join(this.globalPrefix,'node_modules')}});\nprocess.argv[1]=cli;load(cli);\n`);
  let commands = 0;
  const npm = async (args, url, cwd = root) => runNpmPreparation([...args, `--registry=${url}`], {
    cwd, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath,
    env: childEnv(join(root, `command-${commands++}`), { npm_config_registry: url }, inputs),
    logsRoot: join(root, 'logs'), reportsRoot: join(root, 'reports'),
  });
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'present' : 'absent'); await mkdir(consumer);
    const manifest = { name: 'cwd-consumer', version: '0.0.0', private: true };
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest));
    await installConsumer(npm, consumer, installed, 'http://127.0.0.1:9');
    await verifyConsumerReplay(npm, consumer, installed, 'http://127.0.0.1:9');
    assert.deepEqual(JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8')), manifest, 'do not install the consumer or its parent as a dependency');
    const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(lock.packages), [''], 'only the consumer root belongs in this empty locked graph');
    assert.equal(lock.packages[''].name, manifest.name);
    await assert.rejects(access(join(root, 'package.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' });
  }
});
