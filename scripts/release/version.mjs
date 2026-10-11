import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersion } from '../../src/occipital/version.ts';

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
    const manifestPath = join(root, 'crates/occipital/Cargo.toml'), lockPath = join(root, 'Cargo.lock');
    const manifest = await readFile(manifestPath, 'utf8'), lock = await readFile(lockPath, 'utf8');
    const pkg = packageBlock(manifest, /^\[package\][\s\S]*?(?=^\[|$(?![\s\S]))/gm);
    const locked = packageBlock(lock, /^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm);
    if (pkg.version !== locked.version) throw new Error('Cargo manifest/lock occipital versions do not match');
    changes.push([manifestPath, replaceVersion(manifest, pkg.block, release.version)], [lockPath, replaceVersion(lock, locked.block, release.version)]);
  }
  for (const [path, text] of changes) await writeFile(path, text);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), onlyResolve = args[0] === '--resolve';
  if (onlyResolve) args.shift();
  if (args.length !== 1) throw new Error('Usage: node scripts/release/version.mjs [--resolve] FULL-GIT-REF');
  const release = onlyResolve ? releaseRef(args[0]) : await stampVersion(resolve(import.meta.dirname, '../..'), args[0]);
  const output = { product: release.product ?? '', version: release.version, prerelease: String(release.prerelease),
    daemon_version: release.product === 'occipital' ? release.version : '0.0.0' };
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(output));
}
