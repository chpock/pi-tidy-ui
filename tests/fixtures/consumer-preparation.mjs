import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { childEnv, validateNative } from '../../scripts/test/context.mjs';
import { candidateTargets, stageRelease } from '../../scripts/release/native-release.mjs';
import { stageExtensionPackage } from '../../scripts/release/extension-release.mjs';
import { stampDaemonVersion } from '../../scripts/release/version.mjs';
import { startLocalRegistry } from './local-registry.mjs';
import { runNpmPreparation } from './npm-preparation.ts';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const synthetic = name => name === 'pi-tidy-ui' || name.startsWith('@kchpock/occipital-');
const publicURL = value => {
  const url = new URL(value);
  assert.equal(url.origin, 'https://registry.npmjs.org');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'Only exact public npm inputs may be prepared');
  return url.href;
};

export function seedConsumerLock(lock, packages, manifest, registryURL) {
  assert.equal(lock.lockfileVersion, 3, 'Selected host requires a prepared v3 lock');
  const records = new Map(packages.map(record => [`${record.name}@${record.version}`, record]));
  const projected = structuredClone(lock);
  projected.name = manifest.name; projected.version = manifest.version;
  projected.packages[''] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
  for (const [location, entry] of Object.entries(projected.packages)) {
    if (!location) continue;
    const name = entry.name ?? location.split('node_modules/').at(-1), identity = `${name}@${entry.version}`;
    const record = records.get(identity);
    assert.ok(record, `Selected host lock archive missing: ${identity}`);
    assert.equal(entry.integrity, record.integrity, 'Selected host lock archive integrity changed');
    publicURL(entry.resolved);
    entry.resolved = `${registryURL}/tarballs/${sha256(identity)}.tgz`;
  }
  return rewriteConsumerLock(projected, registryURL, registryURL);
}

export function rewriteConsumerLock(lock, sourceRegistry, registryURL) {
  for (const value of [sourceRegistry, registryURL]) {
    const url = new URL(value);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(!url.username && !url.password);
    assert.equal(url.href, value + '/', 'Expected an exact fixture registry origin');
  }
  const projected = structuredClone(lock);
  for (const [location, entry] of Object.entries(projected.packages)) {
    if (!location) continue;
    const url = new URL(entry.resolved);
    assert.equal(url.origin, sourceRegistry, 'Prepared lock must contain only its declared fixture registry');
    assert.ok(!url.search && !url.hash && !url.username && !url.password);
    assert.match(url.pathname, /^\/(?:tarballs\/[a-f0-9]{64}\.tgz|archives\/[a-f0-9]{64})$/);
    entry.resolved = registryURL + url.pathname;
  }
  return projected;
}

export async function verifyConsumerReplay(npm, consumer, installed, registryURL) {
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'));
  await npm(['ci', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional'])], registryURL);
  assert.deepEqual(JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8')), lock, 'Clean consumer replay must preserve the frozen graph');
}

async function stageConsumerPackages(inputs, root, pack) {
  const native = validateNative(inputs), repo = inputs.pi.root, target = native.target;
  assert.ok(native.version !== '0.0.0', 'Consumer requires a version-stamped same-source helper');
  assert.ok(candidateTargets[target], 'Known native target is required');
  const stagingRoot = join(root, 'native-input');
  await mkdir(join(stagingRoot, 'crates/occipital'), { recursive: true });
  await copyFile(join(repo, 'crates/occipital/Cargo.toml'), join(stagingRoot, 'crates/occipital/Cargo.toml'));
  await copyFile(join(repo, 'Cargo.lock'), join(stagingRoot, 'Cargo.lock'));
  await copyFile(join(repo, 'LICENSE'), join(stagingRoot, 'LICENSE'));
  await cp(join(repo, 'packages'), join(stagingRoot, 'packages'), { recursive: true });
  await stampDaemonVersion(stagingRoot, native.version);
  const notice = join(root, 'NOTICE');
  await writeFile(notice, 'Test-only same-source consumer fixture; not a publication or license-admission artifact.\n');
  const sourceURL = id => `https://github.com/chpock/pi-tidy-ui/releases/download/occipital-v${native.version}/occipital-v${native.version}-${id}${candidateTargets[id].os === 'win32' ? '.exe' : ''}`;
  const nativeOutput = join(root, 'native');
  const staged = await stageRelease({ root: stagingRoot, output: nativeOutput,
    input: { notice, artifacts: [{ target, path: native.path, url: sourceURL(target) }] } });
  const artifact = staged.artifacts[0], nativeRelease = { version: native.version, artifacts: Object.keys(candidateTargets).map(id =>
    ({ ...artifact, target: id, url: sourceURL(id) })) };
  const packages = [];
  for (const id of Object.keys(candidateTargets)) {
    let directory = join(nativeOutput, 'packages', id);
    if (id !== target) {
      // Nonhost optional metadata tests npm platform filtering, not cross-platform execution.
      directory = join(root, `metadata-only-${id}`); await mkdir(directory);
      const manifest = JSON.parse(await readFile(join(repo, 'packages/native', id, 'package.json.template'), 'utf8'));
      await writeFile(join(directory, 'package.json'), JSON.stringify({ ...manifest, version: native.version, files: [] }));
    }
    packages.push(await pack(directory));
  }
  const extension = join(root, 'extension'), extensionVersion = '0.0.0-installed';
  await stageExtensionPackage({ root: repo, output: extension, version: extensionVersion, release: nativeRelease });
  packages.push(await pack(extension));
  return { packages, nativeRelease, extensionVersion };
}

/** Preparation only. npm resolves through an owned recording HTTP fixture, never directly
 * through a public registry. Only requested authentic metadata/selected archives are frozen.
 * Importing this module performs no preparation, network, installation or helper execution.
 */
export async function prepareConsumerClosure(inputs, { offline = false } = {}) {
  assert.ok(isAbsolute(inputs.preparation), 'Consumer preparation needs an owned absolute preparation root');
  const native = validateNative(inputs);
  assert.match(inputs.source.commit, /^[a-f0-9]{40}$/);
  assert.match(inputs.source.tree, /^[a-f0-9]{64}$/);
  assert.match(inputs.source.nativeTree, /^[a-f0-9]{64}$/);
  assert.ok(inputs.registry?.packages?.length, 'Prepare baseline archive inputs before consumer closure');
  if (offline && !inputs.registry.consumer) throw new Error('Offline consumer preparation requires an explicit previously frozen consumer registry');
  const packages = inputs.registry.packages.filter(record => { assert.equal(typeof record?.name, 'string'); return !synthetic(record.name); });
  const documents = [...(inputs.registry.documents ?? [])];
  const output = join(inputs.preparation, 'consumer'); await mkdir(output, { recursive: true });
  const archives = join(output, 'archives'), documentRoot = join(output, 'documents'), locksRoot = join(output, 'locks');
  for (const directory of [archives, documentRoot, locksRoot]) await mkdir(directory, { recursive: true });
  const temporaryRoot = inputs.runRoot ?? tmpdir();
  assert.ok(isAbsolute(temporaryRoot), 'Consumer temporary root must be absolute');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(join(temporaryRoot, 'tidy-consumer-preparation-'));
  let registry, preparationError, npmVersion, commands = 0;
  const npm = async (args, url = 'http://127.0.0.1:9') => runNpmPreparation([...args, `--registry=${url}`, '--fetch-retries=0',
    ...['@earendil-works', '@cortexkit', '@kchpock'].map(scope => `--${scope}:registry=${url}`)], {
    cwd: root, nodePath: inputs.node.path, nodeVersion: inputs.node.version, npmPath: inputs.tools.npm,
    env: childEnv(join(root, `command-${commands++}`), { npm_config_offline: 'false', npm_config_registry: url,
      ...(process.platform === 'win32' ? { npm_config_loglevel: 'verbose' } : {}) }, inputs),
    logsRoot: join(root, 'logs'), reportsRoot: join(output, 'diagnostics') });
  try {
    npmVersion = execFileSync(inputs.node.path, [inputs.tools.npm, '--version'], { env: childEnv(root, {}, inputs), encoding: 'utf8' }).trim();
    assert.equal(execFileSync(native.path, ['--version'], { env: childEnv(root, {}, inputs), encoding: 'utf8' }).trim(), `occipital ${native.version}`);
    if (offline) {
      assert.deepEqual(inputs.registry.consumer.source, { commit: inputs.source.commit, tree: inputs.source.tree,
        nativeTree: inputs.source.nativeTree, nativeSha256: native.sha256 }, 'Frozen consumer closure source identity changed');
      assert.equal(inputs.registry.consumer.nodeVersion, inputs.node.version);
      assert.equal(inputs.registry.consumer.npmVersion, npmVersion);
    }
    const packRoot = join(root, 'pack'); await mkdir(packRoot);
    const staged = offline ? { packages: inputs.registry.packages.filter(record => synthetic(record.name)),
      nativeRelease: inputs.registry.consumer.nativeRelease, extensionVersion: inputs.registry.consumer.extensionVersion }
      : await stageConsumerPackages(inputs, root, async directory => {
      const output = JSON.parse((await npm(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', packRoot])).stdout);
      const records = Array.isArray(output) ? output : Object.values(output); assert.equal(records.length, 1);
      const bytes = await readFile(join(packRoot, records[0].filename)), path = join(archives, sha256(bytes) + '.tgz');
      await writeFile(path, bytes);
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      return { name: manifest.name, version: manifest.version, path, manifest, synthetic: true,
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
    });
    packages.push(...staged.packages);
    registry = await startLocalRegistry({ packages, documents, ...(!offline ? { prepareMissing: async request => {
      assert.ok(!synthetic(request.name), 'Published extension/Occipital input is forbidden in ordinary preparation');
      if (request.kind === 'document') {
        const reply = await fetch(publicURL('https://registry.npmjs.org/' + encodeURIComponent(request.name)), { redirect: 'error', signal: AbortSignal.timeout(120000) });
        assert.ok(reply.ok, 'Required public preparation metadata unavailable');
        const bytes = Buffer.from(await reply.arrayBuffer()), document = JSON.parse(bytes.toString('utf8'));
        assert.equal(document.name, request.name);
        const path = join(documentRoot, sha256(bytes) + '.json'); await writeFile(path, bytes);
        documents.push({ name: request.name, path, sha256: sha256(bytes) }); return document;
      }
      const reply = await fetch(publicURL(request.sourceURL), { redirect: 'error', signal: AbortSignal.timeout(120000) });
      assert.ok(reply.ok, 'Required public preparation archive unavailable');
      const bytes = Buffer.from(await reply.arrayBuffer()), path = join(archives, sha256(bytes) + '.tgz');
      await writeFile(path, bytes);
      const options = { env: childEnv(root, {}, inputs), maxBuffer: 16 * 1024 * 1024 };
      const members = execFileSync(inputs.tools.tar, ['-tzf', path], options).toString().split('\n').filter(name => /^(?:\.\/)?[^/]+\/package\.json$/.test(name));
      assert.equal(members.length, 1, 'Prepared archive must have exactly one root manifest');
      const manifest = JSON.parse(execFileSync(inputs.tools.tar, ['-xOzf', path, members[0]], options).toString());
      assert.equal(manifest.name, request.name); assert.equal(manifest.version, request.version);
      const record = { name: request.name, version: request.version, path, integrity: request.manifest.dist.integrity,
        manifest: request.manifest, sourceURL: request.sourceURL };
      packages.push(record); return record;
    } } : {}) });
    const peers = Object.fromEntries(inputs.pi.packages.map(record => [record.name, record.version]));
    assert.equal(peers['@earendil-works/pi-coding-agent'], inputs.pi.version);
    const locks = [];
    for (const installed of [true, false]) {
      const consumer = join(root, installed ? 'present' : 'absent'); await mkdir(consumer);
      let expectedLock;
      if (offline) {
        const receipt = inputs.registry.consumer.locks.find(item => item.installed === installed);
        assert.ok(receipt, 'Both frozen consumer locks are required');
        const lockBytes = await readFile(receipt.path), manifestBytes = await readFile(receipt.manifestPath);
        assert.equal(sha256(lockBytes), receipt.sha256); assert.equal(sha256(manifestBytes), receipt.manifestSha256);
        expectedLock = rewriteConsumerLock(JSON.parse(lockBytes.toString('utf8')), receipt.registryURL, registry.url);
        await writeFile(join(consumer, 'package.json'), manifestBytes);
        await writeFile(join(consumer, 'package-lock.json'), JSON.stringify(expectedLock));
      } else {
        const bytes = await readFile(inputs.pi.lock);
        assert.equal(sha256(bytes), inputs.pi.lockSha256, 'Selected host lock changed');
        const manifest = { name: 'tidy-installed-consumer', version: '0.0.0', private: true, type: 'module',
          dependencies: { ...peers, 'pi-tidy-ui': staged.extensionVersion } };
        const seeded = seedConsumerLock(JSON.parse(bytes.toString('utf8')), packages, manifest, registry.url);
        await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest));
        await writeFile(join(consumer, 'package-lock.json'), JSON.stringify(seeded));
        await npm(['install', '--prefix', consumer, '--ignore-scripts', '--no-audit', '--no-fund', ...(installed ? [] : ['--omit=optional'])], registry.url);
      }
      // A fresh ci can request metadata that install did not need; record it before freezing.
      await verifyConsumerReplay(npm, consumer, installed, registry.url);
      registry.assertNoRejectedRequests();
      const lockBytes = await readFile(join(consumer, 'package-lock.json')), manifestBytes = await readFile(join(consumer, 'package.json'));
      const lock = JSON.parse(lockBytes.toString('utf8'));
      if (offline) assert.deepEqual(lock, expectedLock, 'Offline replay must preserve the frozen consumer graph');
      for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location) continue;
        assert.equal(new URL(entry.resolved).origin, registry.url);
        // Even nonhost/omitted optional lock entries are byte inputs, not missing-input fallbacks.
        const reply = await fetch(entry.resolved); assert.ok(reply.ok, 'Prepared lock archive unavailable'); await reply.arrayBuffer();
      }
      for (const record of inputs.pi.packages) {
        for (const [location, entry] of Object.entries(lock.packages)) {
          if (location.endsWith(`node_modules/${record.name}`)) assert.equal(entry.version, record.version, 'Nested selected host identity drifted');
        }
        const manifest = JSON.parse(await readFile(join(consumer, 'node_modules', record.name, 'package.json'), 'utf8'));
        assert.equal(manifest.name, record.name); assert.equal(manifest.version, record.version, 'Consumer must retain selected host identity');
      }
      if (!offline) {
        const path = join(locksRoot, sha256(lockBytes) + '.json'), manifestPath = join(locksRoot, sha256(manifestBytes) + '.manifest.json');
        await writeFile(path, lockBytes); await writeFile(manifestPath, manifestBytes);
        locks.push({ installed, path, sha256: sha256(lockBytes), manifestPath, manifestSha256: sha256(manifestBytes), registryURL: registry.url });
      }
    }
    registry.assertNoRejectedRequests();
    if (offline) return inputs.registry;
    return { packages, documents, consumer: { nativeRelease: staged.nativeRelease, extensionVersion: staged.extensionVersion, locks, nodeVersion: inputs.node.version, npmVersion,
      source: { commit: inputs.source.commit, tree: inputs.source.tree, nativeTree: inputs.source.nativeTree, nativeSha256: native.sha256 } } };
  } catch (error) {
    preparationError = error;
    if (offline) throw new Error('Frozen offline consumer closure is incomplete; explicitly prepare the missing inputs before execution', { cause: error });
    throw error;
  } finally {
    try { await registry?.close(); await rm(root, { recursive: true, force: true }); }
    catch (error) { if (preparationError) throw new AggregateError([preparationError, error], 'Consumer preparation and cleanup failed'); throw error; }
  }
}
