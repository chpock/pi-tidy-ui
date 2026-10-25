import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { candidateTargets } from './native-release.mjs';
import { artifactName, assembleRelease } from './native-ci.mjs';
import { releaseRef, npmReleaseTag } from './version.mjs';
import { enabledTargets, validateTargets } from './platforms.mjs';

const run = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const registry = '--registry=https://registry.npmjs.org';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
function singleTarball(text) {
  const value = JSON.parse(text), items = Array.isArray(value) ? value : Object.values(value);
  if (items.length !== 1) throw new Error('Expected exactly one npm tarball record');
  return items[0];
}
function singleVersion(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new Error('Expected exactly one npm version record');
  return value[0];
}
export function validatePublicRelease(value, tag) {
  const release = npmReleaseTag(tag);
  if (value.tag_name !== tag || value.draft !== false || value.prerelease !== release.prerelease) {
    throw new Error('Expected the already-published exact Occipital GitHub release');
  }
}

export async function prepareNpmRelease({ directory, publicDirectory, tag, repository, commit, output, targets = enabledTargets(), execute = run }) {
  targets = validateTargets(targets);
  const release = npmReleaseTag(tag);
  await mkdir(output);
  const checked = join(output, 'checked-release');
  const metadata = await assembleRelease({ directory, tag, repository, commit, output: checked, targets });
  for (const name of await readdir(checked)) {
    if (!(await readFile(join(checked, name))).equals(await readFile(join(publicDirectory, name)))) throw new Error(`Public release differs from source CI: ${name}`);
  }
  const inputs = [];
  for (const target of targets) {
    const platform = candidateTargets[target];
    const source = join(directory, artifactName(release.version, target), 'packages', target), manifest = await json(join(source, 'package.json'));
    const expected = { name: `@kchpock/occipital-${target}`, version: release.version, os: [platform.os], cpu: [platform.cpu],
      libc: platform.libc ? [platform.libc] : undefined, files: [platform.executable, 'LICENSE', 'NOTICE'], exports: { './package.json': './package.json' },
      repository: { type: 'git', url: `git+https://github.com/${repository}.git` }, license: 'MIT' };
    for (const [key, value] of Object.entries(expected)) {
      if (!isDeepStrictEqual(manifest[key], value)) throw new Error(`Native manifest differs: ${target}/${key}`);
    }
    for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies', 'bin', 'main', 'private', 'publishConfig']) {
      if (manifest[key] !== undefined) throw new Error(`Unexpected native manifest field: ${target}/${key}`);
    }
    const files = [...expected.files, 'package.json'].sort();
    if (!isDeepStrictEqual((await readdir(source)).sort(), files)) throw new Error(`Unexpected native package contents: ${target}`);
    const record = metadata.artifacts.find(record => record.target === target), bytes = await readFile(join(source, platform.executable));
    if (bytes.length !== record.maxBytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error(`Native package binary differs: ${target}`);
    for (const name of ['LICENSE', 'NOTICE']) {
      if (!(await readFile(join(source, name))).equals(await readFile(join(directory, artifactName(release.version, target), 'assets', name)))) {
        throw new Error(`Native package notice differs: ${target}/${name}`);
      }
    }
    inputs.push({ target, source, manifest, files, executable: platform.executable });
  }
  // Admit every selected package before npm can pack or publish anything.
  const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
  const plan = { tag, version: release.version, prerelease: release.prerelease, repository, commit, packages: [] };
  for (const item of inputs) {
    const packageDir = join(output, 'packages', item.target); await mkdir(packageDir, { recursive: true });
    for (const name of item.files) await copyFile(join(item.source, name), join(packageDir, name));
    // GitHub artifact ZIPs do not preserve the executable mode.
    await chmod(join(packageDir, item.executable), 0o755);
    const { stdout } = await execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs], { cwd: packageDir, timeout: 300000, maxBuffer: 1024 * 1024 });
    const packed = singleTarball(stdout);
    if (packed.name !== item.manifest.name || packed.version !== release.version
      || !isDeepStrictEqual(packed.files.map(file => file.path).sort(), item.files)) throw new Error('npm pack changed native package identity/contents');
    const tarball = join(tarballs, packed.filename), actual = integrity(await readFile(tarball));
    if (actual !== packed.integrity) throw new Error('npm pack integrity differs from its bytes');
    plan.packages.push({ target: item.target, name: item.manifest.name, version: release.version, tarball, integrity: actual });
  }
  await writeFile(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

export async function verifyPublicArchive(row, fetcher) {
  // Verify the immutable version/archive directly: npm pack re-resolves the version
  // through package-wide metadata and returned ETARGET after a successful publication.
  const metadata = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!metadata.ok) {
    await metadata.body?.cancel().catch(() => {}); // Preserve the HTTP failure even if body cleanup fails.
    throw new Error(`Public registry version unavailable: HTTP ${metadata.status}`);
  }
  const item = await metadata.json();
  if (item.name !== row.name || item.version !== row.version || item.dist?.integrity !== row.integrity) throw new Error(`Public registry version differs: ${row.name}`);
  const url = new URL(item.dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.port) throw new Error('Unexpected public registry archive URL');
  const expected = (await stat(row.tarball)).size;
  const reply = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!reply.ok || !reply.body) {
    await reply.body?.cancel().catch(() => {});
    throw new Error(`Public registry archive unavailable: HTTP ${reply.status}`);
  }
  const hash = createHash('sha512'); let size = 0;
  for await (const chunk of reply.body) {
    size += chunk.byteLength;
    if (size > expected) throw new Error(`Public registry archive differs: ${row.name}`);
    hash.update(chunk);
  }
  if (size !== expected || 'sha512-' + hash.digest('base64') !== row.integrity) throw new Error(`Public registry archive differs: ${row.name}`);
}

export async function publishNpmRelease({ planPath, env = process.env, targets = enabledTargets(), execute = run, fetcher = fetch, report = value => console.log(JSON.stringify(value)) }) {
  targets = validateTargets(targets);
  const plan = await json(planPath), release = npmReleaseTag(plan.tag);
  const ref = `refs/tags/${plan.tag}`;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'chpock/pi-tidy-ui' || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== ref
    || !/^[a-f0-9]{40}$/.test(plan.commit) || env.GITHUB_SHA !== plan.commit || env.GITHUB_WORKFLOW_SHA !== plan.commit
    || env.GITHUB_WORKFLOW_REF !== `chpock/pi-tidy-ui/.github/workflows/ci.yml@${ref}`
    || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Publication requires the exact push-tag CI caller and OIDC, not local npm credentials');
  // npm trusted publishing matches the caller workflow; reusable calls retain its identity.
  if (plan.repository !== env.GITHUB_REPOSITORY || plan.version !== release.version || plan.prerelease !== release.prerelease
    || !isDeepStrictEqual(plan.packages.map(row => row.target), targets)) throw new Error('Unexpected native publication plan');
  for (const row of plan.packages) {
    if (row.name !== `@kchpock/occipital-${row.target}` || row.version !== release.version || integrity(await readFile(row.tarball)) !== row.integrity) {
      throw new Error('Native tarball identity/integrity changed after preparation');
    }
  }
  const receipts = { version: plan.version, commit: plan.commit, packages: [] }, receiptPath = join(dirname(planPath), 'receipts.json');
  const save = async () => {
    await writeFile(receiptPath, JSON.stringify(receipts, null, 2) + '\n');
    report(receipts);
  };
  for (const row of plan.packages) {
    let existing;
    try { existing = singleVersion((await execute(npm, ['view', `${row.name}@${row.version}`, '--json', registry], { env, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout); }
    catch (error) {
      let code; try { code = JSON.parse(error.stdout).error?.code; } catch { /* Non-JSON failures are not registry absence. */ }
      if (code !== 'E404') throw error;
    }
    if (existing !== undefined && (existing?.name !== row.name || existing?.version !== row.version || existing?.dist?.integrity !== row.integrity)) throw new Error(`Existing registry version differs: ${row.name}`);
    receipts.packages.push({ name: row.name, version: row.version, integrity: row.integrity, outcome: existing ? 'already-published' : 'not-started' });
  }
  await save();
  for (let i = 0; i < plan.packages.length; i++) {
    const row = plan.packages[i], receipt = receipts.packages[i];
    if (receipt.outcome === 'already-published') continue;
    receipt.outcome = 'unconfirmed'; await save();
    const args = ['publish', row.tarball, '--access=public', '--provenance', '--ignore-scripts', '--json', registry];
    if (plan.prerelease) args.push('--tag=next');
    const { stdout } = await execute(npm, args, { env, timeout: 300000, maxBuffer: 1024 * 1024 });
    const item = singleTarball(stdout);
    if (item.name !== row.name || item.version !== row.version || item.integrity !== row.integrity) throw new Error('npm publish reply differs from prepared native tarball');
    receipt.outcome = 'published'; await save();
  }
  for (let i = 0; i < plan.packages.length; i++) {
    await verifyPublicArchive(plan.packages[i], fetcher);
    receipts.packages[i].registryByteVerified = true; await save();
  }
  return receipts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2), repository = process.env.GITHUB_REPOSITORY;
  if (mode === 'validate-input' && args.length === 1) {
    const release = npmReleaseTag(args[0]);
    if (process.env.GITHUB_OUTPUT) await import('node:fs/promises').then(fs => fs.appendFile(process.env.GITHUB_OUTPUT, `version=${release.version}\n`));
  } else if (mode === 'check-release' && args.length === 2) validatePublicRelease(await json(args[0]), args[1]);
  else if (mode === 'prepare' && (args.length === 5 || args.length === 6)) await prepareNpmRelease({ directory: resolve(args[0]), publicDirectory: resolve(args[1]), tag: args[2], commit: args[3], output: resolve(args[4]), repository, targets: args[5] === undefined ? undefined : JSON.parse(args[5]) });
  else if (mode === 'publish' && (args.length === 1 || args.length === 2)) await publishNpmRelease({ planPath: resolve(args[0]), targets: args[1] === undefined ? undefined : JSON.parse(args[1]) });
  else throw new Error('Usage: npm-release.mjs validate-input TAG | check-release JSON TAG | prepare ARTIFACTS PUBLIC-ASSETS TAG COMMIT NEW-DIR [TARGETS-JSON] | publish PLAN [TARGETS-JSON]');
}
