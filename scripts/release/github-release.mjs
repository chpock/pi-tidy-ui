import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { notesForRef, publicationRef } from './release-notes.mjs';

const run = promisify(execFile);
const normalized = text => typeof text === 'string' ? text.replace(/\r\n/g, '\n').replace(/\n+$/, '') : undefined;

function sourceIdentity({ tag, repository, commit, env }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('Expected repository and exact commit SHA');
  }
  const release = publicationRef('refs/tags/' + tag);
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/tags/' + tag
    || env.GITHUB_REPOSITORY !== repository || env.GITHUB_SHA !== commit || !env.GH_TOKEN) {
    throw new Error('GitHub publication requires the exact authenticated push-tag source');
  }
  return release;
}

async function releaseAssets(release, directory) {
  if (release.product === 'pi-tidy-ui') {
    if (directory !== undefined) throw new Error('Extension GitHub releases contain notes, not additional package assets');
    return new Map();
  }
  if (typeof directory !== 'string') throw new Error('Expected admitted native release assets');
  const names = (await readdir(directory)).sort();
  for (const name of ['native-release.json', 'NOTICE', 'LICENSE', 'SHA256SUMS']) {
    if (!names.includes(name)) throw new Error('Missing admitted release assets');
  }
  return new Map(await Promise.all(names.map(async name => [name, await readFile(join(directory, name))])));
}

async function lookupRelease(execute, repository, tag, options) {
  let reply;
  try { reply = await execute('gh', ['api', '--include', `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], options); }
  catch (error) {
    if (!/^HTTP\/[\d.]+\s+\d{3}\b/.test(error.stdout ?? '')) throw error;
    reply = error;
  }
  const text = reply.stdout.replace(/\r\n/g, '\n'), status = /^HTTP\/[\d.]+\s+(\d{3})\b/.exec(text), split = text.indexOf('\n\n');
  if (!status || split < 0) throw new Error('Invalid GitHub release lookup response');
  if (status[1] === '404') return undefined;
  if (status[1] !== '200') throw new Error('GitHub release lookup failed: HTTP ' + status[1]);
  return JSON.parse(text.slice(split + 2));
}

function verifyMetadata(published, { tag, release, title, notes, files }) {
  if (published.tag_name !== tag || published.draft !== false || published.prerelease !== release.prerelease
    || published.name !== title || normalized(published.body) !== normalized(notes) || !Array.isArray(published.assets)) {
    throw new Error('Existing release differs from the completed changelog publication');
  }
  verifyAssetInventory(published.assets, files);
}

function verifyAssetInventory(assets, files) {
  const names = [...files.keys()];
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names)
    || new Set(assets.map(asset => asset.id)).size !== names.length) {
    throw new Error('Existing release asset inventory differs');
  }
  for (const asset of assets) {
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.size !== files.get(asset.name).length) {
      throw new Error('Existing release asset size/identity differs');
    }
  }
}

async function verifyAssets(execute, tag, repository, files, options) {
  if (!files.size) return;
  const temporary = await mkdtemp(join(tmpdir(), 'tidy-release-existing-'));
  try {
    await execute('gh', ['release', 'download', tag, '--repo', repository, '--dir', temporary, '--pattern', '*'], { ...options, timeout: 0 });
    if (JSON.stringify((await readdir(temporary)).sort()) !== JSON.stringify([...files.keys()])) throw new Error('Downloaded release asset inventory differs');
    for (const [name, bytes] of files) {
      if (!bytes.equals(await readFile(join(temporary, name)))) throw new Error('Existing published release bytes differ: ' + name);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Publication is retryable only by verifying the exact completed release; existing public records are never edited. */
export async function publishGitHubRelease({ root, directory, tag, repository, commit, env = process.env, execute = run }) {
  const release = sourceIdentity({ tag, repository, commit, env });
  const options = { cwd: root, env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 };
  for (const revision of ['HEAD', `refs/tags/${tag}^{commit}`]) {
    const actual = await execute('git', ['rev-parse', '--verify', '--end-of-options', revision], options);
    if (actual.stdout.trim() !== commit) throw new Error('GitHub publication source/tag commit differs');
  }
  const notes = await notesForRef(root, 'refs/tags/' + tag), files = await releaseAssets(release, directory);
  const title = `${release.product === 'occipital' ? 'Occipital' : 'pi-tidy-ui'} ${release.version}`;
  const published = await lookupRelease(execute, repository, tag, options);
  if (!published) {
    const latestFlags = release.product === 'pi-tidy-ui' ? ['--latest=false'] : [];
    const args = ['release', 'create', tag, ...[...files.keys()].map(name => join(directory, name)), '--repo', repository,
      '--verify-tag', '--draft', '--title', title, '--notes', notes];
    if (release.prerelease) args.push('--prerelease');
    args.push(...latestFlags);
    await execute('gh', args, { ...options, timeout: 0 });
    await execute('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', ...latestFlags], { ...options, timeout: 0 });
    return { status: 'published', assets: files.size };
  }
  verifyMetadata(published, { tag, release, title, notes, files });
  await verifyAssets(execute, tag, repository, files, options);
  return { status: 'already-published', assets: files.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, directory, ...extra] = process.argv.slice(2);
  if (!tag || extra.length) throw new Error('Usage: github-release.mjs PRODUCT-TAG [ADMITTED-NATIVE-DIR]');
  console.log(JSON.stringify(await publishGitHubRelease({ root: resolve(import.meta.dirname, '../..'), tag,
    directory: directory === undefined ? undefined : resolve(directory), repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA })));
}
