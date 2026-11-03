import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changelogPaths, loadChangelog, parseChangelog, releaseNotes } from './changelog.mjs';
import { nearestDaemonTag, releaseRef } from './version.mjs';

function checkedPublication(release) {
  if (!release.product || release.version === '0.0.0' || release.version.includes('+')) {
    throw new Error('Expected a product release tag without development or npm-incompatible build metadata');
  }
  return release;
}

export function publicationRef(ref) {
  return checkedPublication(releaseRef(ref));
}

function optionalCIRef(ref) {
  if (ref === undefined) return;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new Error('Expected a full CI ref');
  return releaseRef(ref);
}

function checkDevelopmentManifest(manifest) {
  if (!manifest || manifest.version !== '0.0.0' || manifest.pi?.changelogPath !== ''
    || !Array.isArray(manifest.files) || !manifest.files.includes('CHANGELOG.md')) {
    throw new Error('Development package must keep version 0.0.0, include CHANGELOG.md and disable automatic changelog display');
  }
}

export function releasedEntry(text, version) {
  const entries = parseChangelog(text);
  if (entries[0].markdown.split('\n').slice(1).join('\n').trim()) {
    throw new Error('Move this product\'s Unreleased changes into its dated version entry before releasing');
  }
  const entry = entries.find(entry => entry.version === version);
  if (!entry) throw new Error('Release tag must have an exact dated changelog entry');
  return entry;
}

export async function checkChangelogs(root, ref) {
  const histories = new Map();
  for (const product of Object.keys(changelogPaths)) histories.set(product, await loadChangelog(root, product));
  checkDevelopmentManifest(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')));
  const release = optionalCIRef(ref);
  if (release?.product) {
    checkedPublication(release);
    releasedEntry(histories.get(release.product), release.version);
  }
  return { products: [...histories.keys()], release: release?.product ?? null };
}

export async function notesForRef(root, ref) {
  const release = publicationRef(ref);
  const text = await loadChangelog(root, release.product);
  releasedEntry(text, release.version);
  const daemon = release.product === 'pi-tidy-ui' ? await nearestDaemonTag(root) : undefined;
  return releaseNotes(text, release.version, daemon?.version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, tag, ...extra] = process.argv.slice(2), root = resolve(import.meta.dirname, '../..');
  if (extra.length) throw new Error('Usage: release-notes.mjs check [FULL-REF] | notes PRODUCT-TAG');
  if (mode === 'check') console.log(JSON.stringify(await checkChangelogs(root, tag)));
  else if (mode === 'notes' && tag) process.stdout.write(await notesForRef(root, tag.startsWith('refs/') ? tag : 'refs/tags/' + tag));
  else throw new Error('Usage: release-notes.mjs check [FULL-REF] | notes PRODUCT-TAG');
}
