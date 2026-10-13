import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersion } from '../../src/occipital/version.ts';

const run = promisify(execFile);

export async function nearestDaemonTag(root, revision = 'HEAD') {
  const options = { cwd: root, timeout: 30000, maxBuffer: 65536 };
  const shallow = await run('git', ['rev-parse', '--is-shallow-repository'], options);
  if (shallow.stdout.trim() !== 'false') throw new Error('Nearest daemon tag requires complete history, not a shallow checkout');
  const { stdout: resolved } = await run('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], options);
  const commit = resolved.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected an exact Git commit');
  const { stdout } = await run('git', ['describe', '--tags', '--match', 'occipital-v*', '--abbrev=0', commit], options);
  const tag = stdout.trim(), release = releaseRef('refs/tags/' + tag);
  if (release.product !== 'occipital') throw new Error('Expected a nearest Occipital tag');
  return { tag, version: release.version };
}

export async function resolveCI(root, ref) {
  const release = releaseRef(ref);
  // A native tag is itself the release authority, even if another tag shares its commit.
  const daemon = release.product === 'occipital'
    ? { tag: ref.slice('refs/tags/'.length), version: release.version }
    : await nearestDaemonTag(root);
  return { ...release, daemonTag: daemon.tag, daemonVersion: daemon.version };
}

export async function rustToolchain(root) {
  const text = await readFile(join(root, 'rust-toolchain.toml'), 'utf8');
  const version = text.match(/^channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
  if (!version) throw new Error('Expected an exact Rust toolchain version');
  return version;
}

export function releaseRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new Error('Expected a full Git ref');
  if (!ref.startsWith('refs/tags/')) return { product: undefined, version: '0.0.0', prerelease: false };
  const tag = ref.slice('refs/tags/'.length), match = /^(pi-tidy-ui|occipital)-v(.+)$/.exec(tag);
  const version = match?.[2], valid = parseVersion(version);
  if (!valid) throw new Error('Expected pi-tidy-ui-vSEMVER or occipital-vSEMVER');
  return { product: match[1], version, prerelease: valid.prerelease };
}

function packageBlock(text, pattern) {
  const blocks = [...text.matchAll(pattern)].filter(match => /^name\s*=\s*"occipital"\s*$/m.test(match[0]));
  if (blocks.length !== 1) throw new Error('Expected exactly one occipital package');
  const block = blocks[0], version = block[0].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) throw new Error('Expected explicit occipital version');
  return { block, version };
}
function replaceVersion(text, block, version) {
  const next = block[0].replace(/^version[ \t]*=[ \t]*"[^"]+"([ \t]*\r?)$/m, (_line, tail) => `version = "${version}"${tail}`);
  return text.slice(0, block.index) + next + text.slice(block.index + block[0].length);
}

export async function stampDaemonVersion(root, version) {
  if (!parseVersion(version)) throw new Error('Expected a complete daemon SemVer version');
  const manifestPath = join(root, 'crates/occipital/Cargo.toml'), lockPath = join(root, 'Cargo.lock');
  const manifest = await readFile(manifestPath, 'utf8'), lock = await readFile(lockPath, 'utf8');
  const pkg = packageBlock(manifest, /^\[package\][\s\S]*?(?=^\[|$(?![\s\S]))/gm);
  const locked = packageBlock(lock, /^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm);
  if (pkg.version !== locked.version) throw new Error('Cargo manifest/lock occipital versions do not match');
  await writeFile(manifestPath, replaceVersion(manifest, pkg.block, version));
  await writeFile(lockPath, replaceVersion(lock, locked.block, version));
}

/** CI worktree only. Never changes a dependency version or the other product. */
export async function stampVersion(root, ref) {
  const release = releaseRef(ref);
  if (!release.product) return release;
  const changes = [];
  if (release.product === 'pi-tidy-ui') {
    const manifestPath = join(root, 'package.json'), lockPath = join(root, 'package-lock.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!manifest.name || lock.name !== manifest.name || lock.packages?.['']?.name !== manifest.name ||
        lock.version !== manifest.version || lock.packages[''].version !== manifest.version) throw new Error('npm manifest/lock roots do not match');
    manifest.version = lock.version = lock.packages[''].version = release.version;
    changes.push([manifestPath, JSON.stringify(manifest, null, 2) + '\n'], [lockPath, JSON.stringify(lock, null, 2) + '\n']);
  } else {
    await stampDaemonVersion(root, release.version);
  }
  for (const [path, text] of changes) await writeFile(path, text);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), root = resolve(import.meta.dirname, '../..');
  const mode = args[0]?.startsWith('--') ? args.shift() : undefined;
  let output;
  if (mode === '--toolchain' && args.length === 0) output = { version: await rustToolchain(root) };
  else if (mode === '--daemon-version' && args.length === 1) {
    await stampDaemonVersion(root, args[0]); output = { daemon_version: args[0] };
  } else if ((!mode || mode === '--resolve') && args.length === 1) {
    const release = mode === '--resolve' ? await resolveCI(root, args[0]) : await stampVersion(root, args[0]);
    output = { product: release.product ?? '', version: release.version, prerelease: String(release.prerelease) };
    if (mode === '--resolve') Object.assign(output, { daemon_version: release.daemonVersion, daemon_tag: release.daemonTag });
  } else throw new Error('Usage: version.mjs [--resolve] FULL-GIT-REF | --daemon-version SEMVER | --toolchain');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(output));
}
