import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

// two-face 0.5.2+bat-0.26.1 acknowledgement/core_types.rs and Syntect 5.3.0
// dumps.rs: zlib + bincode 1 fixed-width vectors/enum/String/PathBuf.
export function decodeAcknowledgements(compressed) {
  const bytes = inflateSync(compressed, { maxOutputLength: 4 * 1024 * 1024 });
  let offset = 0;
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('Invalid two-face acknowledgement dump');
    const value = bytes.subarray(offset, offset + length); offset += length; return value;
  }
  function size() {
    const value = take(8).readBigUInt64LE();
    if (value > BigInt(bytes.length)) throw new Error('Invalid two-face acknowledgement size');
    return Number(value);
  }
  function string() { return new TextDecoder('utf-8', { fatal: true }).decode(take(size())); }
  function licenses() {
    return Array.from({ length: size() }, () => {
      const kind = take(4).readUInt32LE();
      if (kind > 7) throw new Error('Unknown pinned two-face license kind');
      return { kind, text: string(), path: string() };
    });
  }
  const result = { syntaxes: licenses(), themes: licenses() };
  if (offset !== bytes.length) throw new Error('Trailing two-face acknowledgement data');
  return result;
}

async function licenseFiles(root, relative = '') {
  const result = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await licenseFiles(root, path));
    else if (entry.isFile() && /^(?:licen[cs]e|copying|notice|unlicense)(?:$|[._-])/i.test(entry.name)) result.push(path);
  }
  return result.sort();
}

/** Copies pinned-source texts, not a legal-compliance certification. The inventory
 * deliberately includes resolved build/target dependencies, even when not linked.
 * Missing source texts are explicit gaps; SPDX labels alone never invent notices.
 */
export async function prepareNotices({ metadata, output, supplements = [] }) {
  if (!Array.isArray(metadata?.packages) || !metadata.packages.some(p => p.name === 'occipital')) throw new Error('Expected locked offline Cargo metadata for occipital');
  const inventory = [], gaps = [], sections = ['Occipital native third-party source notices\n\nResolved Cargo inventory (including build/target dependencies); review against each final binary before publication.\n'];
  async function add(pkg, path, bytes, source) {
    if (!bytes.toString('utf8').trim()) throw new Error(`Empty notice: ${pkg.name}/${path}`);
    inventory.push({ name: pkg.name, version: pkg.version, path, source,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    sections.push(`\n===== ${pkg.name} ${pkg.version}: ${path} =====\n${bytes.toString('utf8')}\n`);
  }
  const packages = [...metadata.packages].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
  for (const pkg of packages) {
    if (pkg.name === 'occipital') continue;
    const root = dirname(pkg.manifest_path);
    const files = await licenseFiles(root);
    // r-efi's README points to AUTHORS, which contains its licenses/copyrights.
    if (pkg.name === 'r-efi' && pkg.version === '5.3.0') files.push('AUTHORS');
    for (const file of files) await add(pkg, file, await readFile(join(root, file)), `${pkg.name}-${pkg.version}/${file}`);
    const supplied = supplements.filter(item => item.name === pkg.name && item.version === pkg.version);
    for (const item of supplied) {
      if (typeof item.source !== 'string' || !item.source.startsWith('https://')) throw new Error('Supplement requires an explicit upstream text URL');
      await add(pkg, item.label ?? 'upstream LICENSE', await readFile(item.file), item.source);
    }
    if (!files.length && !supplied.length) gaps.push(`${pkg.name} ${pkg.version}: no license/notice text in pinned crate (${pkg.manifest_path})`);
    if (pkg.name === 'two-face') {
      if (pkg.version !== '0.5.2+bat-0.26.1') throw new Error('Review two-face acknowledgement format for new version');
      const file = 'generated/acknowledgements_full.bin';
      const bytes = await readFile(join(root, file));
      const acknowledgements = decodeAcknowledgements(bytes);
      for (const licenses of Object.values(acknowledgements)) {
        for (const license of licenses) await add(pkg, license.path, Buffer.from(license.text), `${pkg.name}-${pkg.version}/${file}`);
      }
      const readme = await readFile(join(root, 'README.md'), 'utf8');
      const bat = readme.split("### `bat`'s NOTICE\n")[1];
      if (!bat?.includes('Copyright')) throw new Error('Missing pinned bat NOTICE');
      await add(pkg, 'bat NOTICE', Buffer.from(bat.trim() + '\n'), `${pkg.name}-${pkg.version}/README.md`);
    }
  }
  await mkdir(output);
  await writeFile(join(output, 'NOTICE'), sections.join(''));
  const report = { inventory, gaps };
  await writeFile(join(output, 'notice-sources.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [metadataPath, output, supplementsPath, ...extra] = process.argv.slice(2);
  if (!metadataPath || !output || extra.length) throw new Error('Usage: node scripts/release/native-notices.mjs CARGO-METADATA.json NEW-DIRECTORY [SUPPLEMENTS.json]');
  const report = await prepareNotices({ metadata: JSON.parse(await readFile(metadataPath, 'utf8')), output: resolve(output),
    supplements: supplementsPath ? JSON.parse(await readFile(supplementsPath, 'utf8')) : [] });
  if (report.gaps.length) { console.error(report.gaps.join('\n')); process.exitCode = 1; }
}
