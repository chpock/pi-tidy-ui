import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseRef } from './version.mjs';
import { verifyPublicArchive } from './npm-release.mjs';

const run = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const repository = 'chpock/pi-tidy-ui', name = 'pi-tidy-ui';
const registry = '--registry=https://registry.npmjs.org';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

function releasePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Invalid extension publication plan');
  const release = releaseRef(plan.ref);
  if (release.product !== name || release.version === '0.0.0' || release.version.includes('+') || plan.version !== release.version
    || typeof plan.commit !== 'string' || !/^[a-f0-9]{40}$/.test(plan.commit)) throw new Error('Invalid extension release identity');
  return release;
}

function singleRecord(text) {
  const value = JSON.parse(text);
  if (value?.name) return value;
  const records = Array.isArray(value) ? value : Object.values(value);
  if (records.length !== 1) throw new Error('Expected exactly one npm package record');
  return records[0];
}

export async function packExtensionRelease({ planPath, execute = run }) {
  const plan = await json(planPath), release = releasePlan(plan);
  if (typeof plan.packageDirectory !== 'string' || !isAbsolute(plan.packageDirectory)) throw new Error('Expected an absolute admitted package directory');
  const manifest = await json(join(plan.packageDirectory, 'package.json'));
  if (manifest.name !== name || manifest.version !== release.version
    || manifest.repository?.type !== 'git' || manifest.repository.url !== `git+https://github.com/${repository}.git`) {
    throw new Error('Admitted extension manifest identity/repository differs');
  }
  const directory = join(dirname(planPath), 'tarballs');
  await mkdir(directory);
  let packed;
  try {
    const { stdout } = await execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
      { cwd: plan.packageDirectory, timeout: 300000, maxBuffer: 1024 * 1024 });
    packed = singleRecord(stdout);
  } catch { throw new Error('npm pack failed'); }
  if (packed.name !== name || packed.version !== release.version || packed.filename !== `${name}-${release.version}.tgz`) {
    throw new Error('npm pack changed extension identity');
  }
  const tarball = join(directory, packed.filename), actual = integrity(await readFile(tarball));
  if (actual !== packed.integrity) throw new Error('npm pack integrity differs from its bytes');
  const publication = { schema: 1, ref: plan.ref, commit: plan.commit, version: release.version, prerelease: release.prerelease, tarball, integrity: actual };
  await save(join(dirname(planPath), 'publication.json'), publication);
  return publication;
}

export async function publishExtensionRelease({ planPath, env = process.env, execute = run, fetcher = fetch, report = value => console.log(JSON.stringify(value)) }) {
  const plan = await json(planPath), release = releasePlan(plan);
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'push'
    || env.GITHUB_REF !== plan.ref || env.GITHUB_SHA !== plan.commit || env.GITHUB_WORKFLOW_SHA !== plan.commit
    || env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/ci.yml@${plan.ref}`
    || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Publication requires the exact push-tag CI caller and OIDC, not local npm credentials');
  }
  if (plan.schema !== 1 || plan.prerelease !== release.prerelease || typeof plan.tarball !== 'string' || !isAbsolute(plan.tarball)
    || integrity(await readFile(plan.tarball)) !== plan.integrity) throw new Error('Extension tarball identity/integrity changed after preparation');
  let existing;
  try {
    existing = singleRecord((await execute(npm, ['view', `${name}@${release.version}`, '--json', registry],
      { env, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout);
  } catch (error) {
    let code; try { code = JSON.parse(error.stdout).error?.code; } catch {}
    if (code !== 'E404') throw new Error('Registry version lookup failed');
  }
  if (existing !== undefined && (existing?.name !== name || existing.version !== release.version || existing.dist?.integrity !== plan.integrity)) {
    throw new Error('Existing registry version differs from the prepared extension');
  }
  const receipt = { name, version: release.version, commit: plan.commit, integrity: plan.integrity, outcome: existing ? 'already-published' : 'not-started' };
  const checkpoint = async () => { await save(join(dirname(planPath), 'receipts.json'), receipt); report({ ...receipt }); };
  await checkpoint();
  if (!existing) {
    receipt.outcome = 'unconfirmed'; await checkpoint();
    const args = ['publish', plan.tarball, '--access=public', '--provenance', '--ignore-scripts', '--json', registry];
    if (release.prerelease) args.push('--tag=next');
    let published;
    try { published = singleRecord((await execute(npm, args, { env, timeout: 300000, maxBuffer: 1024 * 1024 })).stdout); }
    catch { throw new Error('npm publish failed; publication remains unconfirmed'); }
    if (published.name !== name || published.version !== release.version || published.integrity !== plan.integrity) {
      throw new Error('npm publish reply differs from the prepared extension');
    }
    receipt.outcome = 'published'; await checkpoint();
  }
  try { await verifyPublicArchive({ name, version: release.version, tarball: plan.tarball, integrity: plan.integrity }, fetcher); }
  catch { throw new Error('Public registry archive verification failed'); }
  receipt.registryByteVerified = true; await checkpoint();
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, path, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['pack', 'publish'].includes(mode)) throw new Error('Usage: extension-publication.mjs pack|publish PLAN');
  if (mode === 'pack') console.log(JSON.stringify(await packExtensionRelease({ planPath: resolve(path) })));
  else await publishExtensionRelease({ planPath: resolve(path) });
}
