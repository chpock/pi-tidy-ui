import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalRegistry } from './fixtures/local-registry.mjs';

async function archive(t, name = '@fixture/scoped', version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'tidy-local-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('prepared archive bytes'), path = join(root, 'prepared.tgz');
  await writeFile(path, bytes);
  return { name, version, path, synthetic: true, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    manifest: { name, version, dependencies: { 'fixture-dependency': '2.0.0' }, dist: { tarball: 'https://must-not-be-used.invalid/archive.tgz' } } };
}

async function registry(t, options) {
  const fixture = await startLocalRegistry(options);
  t.after(() => fixture.close());
  return fixture;
}

test('local registry serves exact prepared metadata and archive bytes over real HTTP', async t => {
  const record = await archive(t), fixture = await registry(t, { packages: [record] });
  for (const route of ['/@fixture%2fscoped', '/@fixture/scoped']) {
    const reply = await fetch(fixture.url + route);
    assert.equal(reply.status, 200);
    const document = await reply.json();
    assert.equal(document.name, record.name);
    assert.deepEqual(Object.keys(document.versions), [record.version]);
    const manifest = document.versions[record.version];
    assert.deepEqual(manifest.dependencies, record.manifest.dependencies);
    assert.equal(manifest.dist.integrity, record.integrity);
    assert.equal(new URL(manifest.dist.tarball).origin, fixture.url);
    assert.deepEqual(Buffer.from(await (await fetch(manifest.dist.tarball)).arrayBuffer()), await readFile(record.path));
  }
  assert.deepEqual(fixture.counts(), { manifests: 2, tarballs: 2, downloads: 0, rejected: 0 });
  assert.deepEqual(record.manifest.dist, { tarball: 'https://must-not-be-used.invalid/archive.tgz' });
});

test('local registry rejects and records unknown routes and non-read methods', async t => {
  const fixture = await registry(t, { packages: [await archive(t)] });
  for (const [path, method] of [['/missing', 'GET'], ['/tarballs/999.tgz', 'GET'], ['/-/npm/v1/security/audits/quick', 'POST'], ['/@fixture%2fscoped?unknown=1', 'GET']]) {
    assert.equal((await fetch(fixture.url + path, { method })).status, 404);
  }
  assert.equal(fixture.counts().rejected, 4);
  assert.throws(() => fixture.assertNoRejectedRequests(), /Unexpected fixture registry request/);
  assert.equal(fixture.requests.length, 4);
});

test('local registry validates mandatory archive integrity, manifest identity and duplicates before listen', async t => {
  const record = await archive(t);
  for (const packages of [[], [{ ...record, integrity: 'sha512-' + Buffer.alloc(64).toString('base64') }],
    [{ ...record, manifest: { ...record.manifest, version: 'wrong' } }], [record, record]]) {
    await assert.rejects(startLocalRegistry({ packages }));
  }
  await writeFile(record.path, 'corrupt archive');
  await assert.rejects(startLocalRegistry({ packages: [record] }), /integrity/);
});

test('local registry exposes only declared raw download and verifies its exact bytes', async t => {
  const record = await archive(t), bytes = await readFile(record.path), sourceURL = 'https://github.com/fixture/exact-native';
  const fixture = await registry(t, { packages: [record], downloads: [{ sourceURL, path: record.path,
    sha256: createHash('sha256').update(bytes).digest('hex') }] });
  assert.throws(() => fixture.downloadURL(sourceURL + '-other'), /Undeclared/);
  const reply = await fetch(fixture.downloadURL(sourceURL));
  assert.equal(reply.status, 200); assert.equal(Number(reply.headers.get('content-length')), bytes.length);
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()), bytes);
  assert.deepEqual(fixture.counts(), { manifests: 0, tarballs: 0, downloads: 1, rejected: 0 });
});

test('local registry close releases the listening endpoint', async t => {
  const fixture = await startLocalRegistry({ packages: [await archive(t)] });
  await fixture.close();
  await assert.rejects(fetch(fixture.url + '/@fixture%2fscoped'));
});


test('actual npm installs prepared closure with optional present/absent using only the fixture registry', async t => {
  const { readInputs, childEnv } = await import('../scripts/test/context.mjs');
  const { runNpmPreparation } = await import('./fixtures/npm-preparation.ts');
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-registry-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const poisonCache = join(root, 'ambient-cache'), poisonConfig = join(root, 'ambient.npmrc'), poisonStartup = join(root, 'ambient-startup.mjs');
  const poisonBytes = `cache=${poisonCache}\nregistry=http://127.0.0.1:9\n`;
  await writeFile(poisonConfig, poisonBytes);
  await writeFile(poisonStartup, 'throw new Error("ambient Node startup must not execute");');
  const pollution = { npm_config_cache: poisonCache, npm_config_userconfig: poisonConfig, NODE_OPTIONS: `--import=${poisonStartup}` };
  const original = Object.fromEntries(Object.keys(pollution).map(key => [key, process.env[key]]));
  Object.assign(process.env, pollution);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const pack = join(root, 'pack'); await mkdir(pack);
  let commands = 0;
  const npm = async (args, url = 'http://127.0.0.1:9') => {
    const config = join(root, `config-${commands++}`), env = childEnv(config, { npm_config_offline: 'false', npm_config_registry: url });
    return runNpmPreparation([...args, `--registry=${url}`, `--@fixture:registry=${url}`], {
      cwd: root, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath: inputs.tools.npm, env,
      logsRoot: join(root, 'logs'), reportsRoot: join(root, 'reports') });
  };
  const packages = [];
  for (const [name, extras] of [['required', {}], ['optional', { os: [process.platform], cpu: [process.arch] }],
    ['consumer', { dependencies: { '@fixture/required': '1.0.0' }, optionalDependencies: { '@fixture/optional': '1.0.0' } }]]) {
    const directory = join(root, name); await mkdir(directory);
    const manifest = { name: `@fixture/${name}`, version: '1.0.0', files: ['marker.txt'],
      scripts: { postinstall: 'exit 41' }, ...extras };
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'marker.txt'), name);
    if (name === 'consumer') {
      const entries = Object.fromEntries(packages.map(record => [`node_modules/${record.name}`, { version: record.version, integrity: record.integrity,
        resolved: `https://registry.npmjs.org/${record.name}/-/${record.name.split('/').at(-1)}-${record.version}.tgz`,
        ...(record.name.endsWith('/optional') ? { optional: true } : {}) }]));
      await writeFile(join(directory, 'npm-shrinkwrap.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3,
        packages: { '': manifest, ...entries } }));
    }
    const result = JSON.parse((await npm(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', pack])).stdout);
    const records = Array.isArray(result) ? result : Object.values(result);
    assert.equal(records.length, 1);
    const path = join(pack, records[0].filename), bytes = await readFile(path);
    packages.push({ name: manifest.name, version: manifest.version, path, manifest, synthetic: true,
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') });
  }
  const fixture = await registry(t, { packages });
  for (const installed of [true, false]) {
    const consumer = join(root, installed ? 'present' : 'absent'); await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    const before = fixture.counts().tarballs;
    await npm(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund',
      ...(installed ? [] : ['--omit=optional']), '@fixture/consumer@1.0.0'], fixture.url);
    assert.equal(await readFile(join(consumer, 'node_modules/@fixture/required/marker.txt'), 'utf8'), 'required');
    const optional = join(consumer, 'node_modules/@fixture/optional/marker.txt');
    if (installed) assert.equal(await readFile(optional, 'utf8'), 'optional');
    else await assert.rejects(readFile(optional), { code: 'ENOENT' });
    assert.equal(fixture.counts().tarballs - before, installed ? 3 : 2);
    const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
    for (const [location, record] of Object.entries(lock.packages)) {
      if (!location) continue;
      assert.equal(new URL(record.resolved).origin, fixture.url);
      assert.ok(packages.some(item => item.integrity === record.integrity));
    }
  }
  fixture.assertNoRejectedRequests();
  const missingConsumer = join(root, 'missing'); await mkdir(missingConsumer);
  await writeFile(join(missingConsumer, 'package.json'), '{"private":true}');
  await assert.rejects(npm(['install', '--prefix', missingConsumer, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '@fixture/missing@1.0.0'], fixture.url), { code: 1 });
  assert.ok(fixture.counts().rejected > 0);
  assert.throws(() => fixture.assertNoRejectedRequests(), /Unexpected fixture registry request/);
  await assert.rejects(access(poisonCache), { code: 'ENOENT' });
  assert.equal(await readFile(poisonConfig, 'utf8'), poisonBytes);
});


test('local registry serves frozen metadata but rejects unprepared historical tarballs without public fallback', async t => {
  const record = await archive(t), path = join(record.path, '..', 'document.json');
  const document = { name: record.name, 'dist-tags': { latest: '2.0.0' }, versions: {
    [record.version]: { ...record.manifest, dist: { integrity: record.integrity, tarball: 'https://registry.npmjs.org/fixture/prepared.tgz' } },
    '2.0.0': { name: record.name, version: '2.0.0', dist: { integrity: record.integrity, tarball: 'https://registry.npmjs.org/fixture/unprepared.tgz' } },
  } };
  const bytes = Buffer.from(JSON.stringify(document)); await writeFile(path, bytes);
  const documents = [{ name: record.name, path, sha256: createHash('sha256').update(bytes).digest('hex') }];
  const fixture = await registry(t, { packages: [record], documents });
  const projected = await (await fetch(fixture.url + '/@fixture%2fscoped')).json();
  assert.deepEqual(projected['dist-tags'], document['dist-tags']);
  assert.deepEqual(Buffer.from(await (await fetch(projected.versions[record.version].dist.tarball)).arrayBuffer()), await readFile(record.path));
  assert.equal((await fetch(projected.versions['2.0.0'].dist.tarball)).status, 404);
  assert.equal(fixture.counts().rejected, 1);
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(startLocalRegistry({ packages: [record], documents: [{ ...documents[0], sha256: '0'.repeat(64) }] }), /integrity/);
});


test('explicit preparation resolver freezes only requested metadata and byte archives once over real HTTP', async t => {
  const seed = await archive(t), next = await archive(t, '@fixture/recording'), calls = [];
  const sourceURL = 'https://registry.npmjs.org/@fixture/recording/-/recording-1.2.3.tgz';
  const document = { name: next.name, versions: { [next.version]: { ...next.manifest,
    dist: { integrity: next.integrity, tarball: sourceURL, unpackedSize: 123 } } } };
  const fixture = await registry(t, { packages: [seed], prepareMissing: async request => {
    calls.push(request);
    if (request.kind === 'document') { assert.equal(request.name, next.name); return document; }
    assert.equal(request.sourceURL, sourceURL); assert.equal(request.name, next.name); assert.equal(request.version, next.version);
    return { ...next, manifest: request.manifest };
  } });
  const projected = await (await fetch(fixture.url + '/@fixture%2frecording')).json();
  const replies = await Promise.all([fetch(projected.versions[next.version].dist.tarball), fetch(projected.versions[next.version].dist.tarball)]);
  for (const reply of replies) assert.deepEqual(Buffer.from(await reply.arrayBuffer()), await readFile(next.path));
  const again = await (await fetch(fixture.url + '/@fixture%2frecording')).json();
  assert.equal(again.versions[next.version].dist.unpackedSize, 123);
  assert.deepEqual(calls.map(request => request.kind), ['document', 'tarball']);
  assert.equal(document.versions[next.version].dist.tarball, sourceURL);
  fixture.assertNoRejectedRequests();
});


test('seeded third-party archives never replace authentic full registry metadata during preparation or replay', async t => {
  const record = { ...await archive(t), synthetic: false }, requests = [], path = join(record.path, '..', 'authentic.json');
  const document = { name: record.name, 'dist-tags': { latest: '2.0.0' }, time: { created: '2020-01-01T00:00:00Z' }, versions: {
    [record.version]: { ...record.manifest, _hasShrinkwrap: true, dist: { integrity: record.integrity, tarball: 'https://registry.npmjs.org/fixture/a.tgz' } },
    '2.0.0': { name: record.name, version: '2.0.0', deprecated: 'Registry-only metadata', dist: { integrity: record.integrity, tarball: 'https://registry.npmjs.org/fixture/b.tgz' } },
  } };
  const bytes = Buffer.from(JSON.stringify(document)); await writeFile(path, bytes);
  const documents = [{ name: record.name, path, sha256: createHash('sha256').update(bytes).digest('hex') }];
  const prepared = await registry(t, { packages: [record], prepareMissing: async request => {
    requests.push(request); assert.equal(request.kind, 'document'); assert.equal(request.name, record.name); return document;
  } });
  const routes = ['/@fixture%2fscoped', '/@fixture/scoped'];
  const replies = await Promise.all(routes.map(route => fetch(prepared.url + route).then(reply => reply.json())));
  assert.equal(requests.length, 1);
  function restoreURLs(projected) {
    for (const [version, manifest] of Object.entries(projected.versions)) manifest.dist.tarball = document.versions[version].dist.tarball;
    return projected;
  }
  for (const reply of replies) assert.deepEqual(restoreURLs(reply), document);
  const projected = await (await fetch(prepared.url + routes[0])).json();
  assert.deepEqual(Buffer.from(await (await fetch(projected.versions[record.version].dist.tarball)).arrayBuffer()), await readFile(record.path));
  assert.equal(requests.length, 1); prepared.assertNoRejectedRequests();
  const replay = await registry(t, { packages: [record], documents });
  assert.deepEqual(restoreURLs(await (await fetch(replay.url + routes[0])).json()), document);
  const unknown = await registry(t, { packages: [record] });
  assert.equal((await fetch(unknown.url + routes[0])).status, 404, 'Archive bytes alone must not authorize reconstructed third-party metadata');
  assert.deepEqual(await readFile(path), bytes);
});


test('actual npm preserves satisfying selected host lock versions while authentic metadata exposes newer versions', async t => {
  const { readInputs, childEnv } = await import('../scripts/test/context.mjs');
  const { runNpmPreparation } = await import('./fixtures/npm-preparation.ts');
  const { seedConsumerLock, rewriteConsumerLock } = await import('./fixtures/consumer-preparation.mjs');
  const inputs = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-locked-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pack = join(root, 'pack'); await mkdir(pack);
  let command = 0;
  const npm = (args, url = 'http://127.0.0.1:9') => runNpmPreparation([...args, `--registry=${url}`, `--@fixture:registry=${url}`, '--fetch-retries=0'], {
    cwd: root, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath: inputs.tools.npm,
    env: childEnv(join(root, `command-${command++}`), { npm_config_registry: url, npm_config_offline: 'false' }, inputs),
    logsRoot: join(root, 'logs'), reportsRoot: join(root, 'reports') });
  const packages = [];
  for (const manifest of [{ name: '@fixture/core', version: '1.0.0' }, { name: '@fixture/core', version: '1.2.0' },
    { name: '@fixture/host', version: '1.0.0', dependencies: { '@fixture/core': '^1.0.0' } },
    { name: '@fixture/extension', version: '1.0.0', peerDependencies: { '@fixture/host': '^1.0.0' } }]) {
    const directory = join(root, `package-${packages.length}`); await mkdir(directory);
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    const output = JSON.parse((await npm(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', pack])).stdout);
    const [packed] = Array.isArray(output) ? output : Object.values(output), path = join(pack, packed.filename), bytes = await readFile(path);
    packages.push({ name: manifest.name, version: manifest.version, manifest, path,
      synthetic: manifest.name === '@fixture/extension', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') });
  }
  const documents = [], acquired = [];
  const prepared = await registry(t, { packages, prepareMissing: async request => {
    assert.equal(request.kind, 'document'); acquired.push(request.name);
    const records = packages.filter(record => record.name === request.name);
    const document = { name: request.name, 'dist-tags': { latest: records.at(-1).version }, time: { created: '2020-01-01T00:00:00Z' },
      versions: Object.fromEntries(records.map(record => [record.version, { ...record.manifest,
        dist: { integrity: record.integrity, tarball: `https://registry.npmjs.org/${record.name}/-/${record.version}.tgz` } }])) };
    const bytes = Buffer.from(JSON.stringify(document)), path = join(root, `document-${documents.length}.json`); await writeFile(path, bytes);
    documents.push({ name: request.name, path, sha256: createHash('sha256').update(bytes).digest('hex') }); return document;
  } });
  for (const name of ['@fixture/core', '@fixture/host']) {
    const document = await (await fetch(prepared.url + '/' + encodeURIComponent(name))).json();
    if (name === '@fixture/core') assert.equal(document['dist-tags'].latest, '1.2.0');
  }
  const baseline = { lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(packages.filter(record => record.version === '1.0.0' && !record.synthetic).map(record =>
    [`node_modules/${record.name}`, { version: record.version, integrity: record.integrity, resolved: `https://registry.npmjs.org/${record.name}/-/${record.version}.tgz`,
      dev: true, ...(record.manifest.dependencies ? { dependencies: record.manifest.dependencies } : {}) }])) } };
  const manifest = { name: 'consumer', version: '0.0.0', private: true, dependencies: { '@fixture/host': '1.0.0', '@fixture/core': '1.0.0', '@fixture/extension': '1.0.0' } };
  const present = join(root, 'present'); await mkdir(present); await writeFile(join(present, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(present, 'package-lock.json'), JSON.stringify(seedConsumerLock(baseline, packages, manifest, prepared.url)));
  await npm(['install', '--prefix', present, '--ignore-scripts', '--no-audit', '--no-fund'], prepared.url);
  const lock = JSON.parse(await readFile(join(present, 'package-lock.json'), 'utf8'));
  for (const name of ['@fixture/core', '@fixture/host']) assert.equal(lock.packages[`node_modules/${name}`].version, '1.0.0');
  assert.deepEqual(acquired.sort(), ['@fixture/core', '@fixture/host']); prepared.assertNoRejectedRequests();
  const replay = await registry(t, { packages, documents }), absent = join(root, 'replay'); await mkdir(absent);
  const frozen = rewriteConsumerLock(lock, prepared.url, replay.url);
  await writeFile(join(absent, 'package.json'), JSON.stringify(manifest)); await writeFile(join(absent, 'package-lock.json'), JSON.stringify(frozen));
  await npm(['ci', '--prefix', absent, '--ignore-scripts', '--no-audit', '--no-fund'], replay.url);
  assert.deepEqual(JSON.parse(await readFile(join(absent, 'package-lock.json'), 'utf8')), frozen);
  for (const name of ['@fixture/core', '@fixture/host']) assert.equal(JSON.parse(await readFile(join(absent, 'node_modules', name, 'package.json'), 'utf8')).version, '1.0.0');
  replay.assertNoRejectedRequests();
});


test('malformed routes never invoke the explicit preparation resolver', async t => {
  let acquired = 0;
  const fixture = await registry(t, { packages: [await archive(t)], prepareMissing: async () => { acquired++; throw new Error('No lookup permitted'); } });
  assert.equal((await fetch(fixture.url + '/%FF')).status, 404);
  assert.equal(acquired, 0); assert.equal(fixture.counts().rejected, 1);
});
