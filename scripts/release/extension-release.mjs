import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { candidateTargets } from './native-release.mjs';
import { assetName, assembleRelease } from './native-ci.mjs';
import { releaseRef, nearestDaemonTag } from './version.mjs';
import { validatePublicRelease } from './npm-release.mjs';

const run = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const publicRegistry = ['--registry=https://registry.npmjs.org', '--@kchpock:registry=https://registry.npmjs.org'];
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

const repository = 'chpock/pi-tidy-ui';
function checkedDeclaration(input) {
  const version = input?.version;
  if (typeof version !== 'string') throw new Error('Expected a publishable Occipital version');
  const parsed = releaseRef(`refs/tags/occipital-v${version}`);
  if (parsed.product !== 'occipital' || version === '0.0.0' || version.includes('+')) throw new Error('Expected a publishable Occipital version');
  const targets = Object.keys(candidateTargets);
  if (!Array.isArray(input.artifacts) || input.artifacts.length !== targets.length) throw new Error('Expected one complete six-platform native family');
  const artifacts = targets.map(target => {
    const records = input.artifacts.filter(record => record?.target === target);
    if (records.length !== 1) throw new Error('Expected one artifact per native target');
    const record = records[0], suffix = candidateTargets[target].executable.endsWith('.exe') ? '.exe' : '';
    const url = `https://github.com/${repository}/releases/download/occipital-v${version}/occipital-v${version}-${target}${suffix}`;
    if (record.url !== url || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.maxBytes)
      || record.maxBytes <= 0 || record.maxBytes > 64 * 1024 * 1024) throw new Error('Invalid exact native artifact declaration');
    return { target, sha256: record.sha256, maxBytes: record.maxBytes, url };
  });
  return { version, artifacts };
}

/** Stage only package inputs. Production callers first use prepareExtensionRelease's release/raw-hash admission. */
export async function stageExtensionPackage({ root, output, version, release }) {
  if (typeof version !== 'string') throw new Error('Expected a real npm extension version');
  const extension = releaseRef(`refs/tags/pi-tidy-ui-v${version}`);
  if (extension.product !== 'pi-tidy-ui' || version === '0.0.0' || version.includes('+')) throw new Error('Expected a real npm extension version');
  const metadata = checkedDeclaration(release);
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (source.version !== '0.0.0' || !source.name || !Array.isArray(source.files)) throw new Error('Expected the unmodified development package manifest');
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
    if (Object.keys(source[field] ?? {}).some(name => name.startsWith('@kchpock/occipital-'))) throw new Error('Native pins must not be committed to repository manifests');
  }
  const template = await readFile(join(root, 'src/occipital/release.ts'), 'utf8');
  const marker = 'export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = undefined;';
  if (!template.includes(marker) || template.indexOf(marker) !== template.lastIndexOf(marker)) throw new Error('Expected the unpinned native declaration template');
  // A fresh destination prevents accidental reuse of another version's files or lockfile.
  await mkdir(output);
  for (const path of source.files) await cp(join(root, path), join(output, path), { recursive: true });
  const manifest = { ...source, version, optionalDependencies: { ...source.optionalDependencies } };
  for (const target of Object.keys(candidateTargets)) manifest.optionalDependencies[`@kchpock/occipital-${target}`] = metadata.version;
  await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(output, 'src/occipital/release.ts'), template.replace(marker,
    `export const NATIVE_RELEASE: NativeReleaseDeclaration | undefined = ${JSON.stringify(metadata, null, 2)};`));
  return manifest;
}

// Installed-consumer checks exercise the selected public release without a source pin or payload override.
export async function publishedDeclaration(root, revision = 'HEAD') {
  const daemon = await nearestDaemonTag(root, revision);
  const url = `https://github.com/${repository}/releases/download/${daemon.tag}/native-release.json`;
  const reply = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!reply.ok) throw new Error(`Selected Occipital release metadata unavailable: HTTP ${reply.status}`);
  const declaration = checkedDeclaration(await reply.json());
  if (declaration.version !== daemon.version) throw new Error('Selected Occipital release metadata version differs');
  return declaration;
}

function singleRecord(text, packed = false) {
  const value = JSON.parse(text), records = Array.isArray(value) ? value : packed ? Object.values(value) : undefined;
  if (!records) return value;
  if (records.length !== 1) throw new Error('Expected one exact npm package record');
  return records[0];
}
function checkedPackageRecord(record, target, version) {
  const platform = candidateTargets[target], name = `@kchpock/occipital-${target}`;
  if (record?.name !== name || record.version !== version || !isDeepStrictEqual(record.os, [platform.os])
    || !isDeepStrictEqual(record.cpu, [platform.cpu]) || !isDeepStrictEqual(record.libc, platform.libc ? [platform.libc] : undefined)
    || !isDeepStrictEqual(record.exports, { './package.json': './package.json' })) {
    throw new Error(`Native registry package identity/ABI differs: ${target}`);
  }
  for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies', 'bin', 'main', 'private', 'publishConfig']) {
    if (record[key] !== undefined) throw new Error(`Unexpected native registry package field: ${target}/${key}`);
  }
  return record;
}
function checkedRegistryRecord(record, target, version) {
  checkedPackageRecord(record, target, version);
  if (typeof record.dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.dist.integrity)) throw new Error(`Native registry package integrity differs: ${target}`);
  return record;
}

/** Release-only gate. Ordinary CI and independent daemon releases may legitimately produce changed native bytes. */
export async function prepareExtensionRelease({ root, ref, commit, directory, publicDirectory, output, execute = run }) {
  const extension = releaseRef(ref);
  if (extension.product !== 'pi-tidy-ui' || extension.version === '0.0.0' || extension.version.includes('+')) throw new Error('Expected a real npm extension release ref');
  const git = args => run('git', args, { cwd: root, timeout: 30000, maxBuffer: 65536 });
  const exact = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.trim();
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || exact !== commit || head !== commit) throw new Error('Expected the exact checked-out extension release commit');
  const daemon = await nearestDaemonTag(root, ref);
  const published = await json(join(publicDirectory, 'release.json')); validatePublicRelease(published, daemon.tag);
  const declaration = checkedDeclaration(await json(join(publicDirectory, 'native-release.json')));
  if (declaration.version !== daemon.version) throw new Error('Selected native release metadata version differs');
  for (const record of declaration.artifacts) {
    const assets = published.assets?.filter(asset => asset.name === assetName(declaration.version, record.target));
    if (assets?.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== record.maxBytes) throw new Error('Selected native release assets are incomplete');
  }
  await mkdir(output);
  const checked = join(output, 'checked-native');
  const current = await assembleRelease({ directory, tag: daemon.tag, repository, commit, output: checked });
  if (!isDeepStrictEqual(checkedDeclaration(current), declaration)) throw new Error('Current CI native bytes differ; publish the matching Occipital release first');
  for (const record of declaration.artifacts) {
    const name = assetName(declaration.version, record.target);
    const [a, b] = await Promise.all([checked, publicDirectory].map(path => readFile(join(path, name))));
    if (!a.equals(b)) throw new Error(`Public native bytes differ from current CI: ${record.target}`);
  }
  // Admit every published npm identity before packing any archive; never choose an older release on failure.
  const records = [];
  for (const target of Object.keys(candidateTargets)) {
    const name = `@kchpock/occipital-${target}`, spec = `${name}@${daemon.version}`;
    const { stdout } = await execute(npm, ['view', spec, ...publicRegistry, '--json'], { timeout: 300000, maxBuffer: 1024 * 1024 });
    records.push({ target, spec, record: checkedRegistryRecord(singleRecord(stdout), target, daemon.version) });
  }
  const downloads = join(output, 'native-npm'); await mkdir(downloads);
  for (const item of records) {
    const { stdout } = await execute(npm, ['pack', item.spec, ...publicRegistry, '--ignore-scripts', '--json', '--pack-destination', downloads],
      { timeout: 300000, maxBuffer: 1024 * 1024 });
    const packed = singleRecord(stdout, true), filename = `kchpock-occipital-${item.target}-${daemon.version}.tgz`;
    const files = ['LICENSE', 'NOTICE', 'package.json', candidateTargets[item.target].executable].sort();
    if (packed.name !== item.record.name || packed.version !== daemon.version || packed.filename !== filename
      || !isDeepStrictEqual(packed.files?.map(file => file.path).sort(), files)) throw new Error('Native npm archive identity/contents differs');
    const archive = join(downloads, filename), hash = integrity(await readFile(archive));
    if (hash !== item.record.dist.integrity || hash !== packed.integrity) throw new Error('Native npm archive integrity differs from registry');
    // npm pack's name/version come from registry metadata, not the archived manifest.
    const { stdout: packageJSON } = await execute('tar', ['-xOf', archive, 'package/package.json'],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    checkedPackageRecord(JSON.parse(packageJSON), item.target, daemon.version);
    const artifact = declaration.artifacts.find(record => record.target === item.target);
    const { stdout: bytes } = await execute('tar', ['-xOf', archive, `package/${candidateTargets[item.target].executable}`],
      { encoding: null, timeout: 30000, maxBuffer: artifact.maxBytes + 1 });
    if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.maxBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error(`Native npm executable differs from public release: ${item.target}`);
    }
  }
  const packageDirectory = join(output, 'extension');
  await stageExtensionPackage({ root, output: packageDirectory, version: extension.version, release: declaration });
  const plan = { ref, commit, version: extension.version, daemonTag: daemon.tag, release: declaration, packageDirectory };
  await writeFile(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [ref, directory, publicDirectory, output, ...extra] = process.argv.slice(2);
  if (!ref || !directory || !publicDirectory || !output || extra.length) throw new Error('Usage: extension-release.mjs EXTENSION-REF CI-ARTIFACTS PUBLIC-ASSETS NEW-OUTPUT');
  const root = resolve(import.meta.dirname, '../..');
  console.log(JSON.stringify(await prepareExtensionRelease({ root, ref, commit: process.env.SOURCE_COMMIT,
    directory: resolve(directory), publicDirectory: resolve(publicDirectory), output: resolve(output) })));
}
