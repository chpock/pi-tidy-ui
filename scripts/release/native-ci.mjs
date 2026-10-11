import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { candidateTargets, daemonVersion, executableDigest, stageRelease } from './native-release.mjs';
import { prepareNotices } from './native-notices.mjs';
import { releaseRef } from './version.mjs';

const run = promisify(execFile);
export function assetName(version, target) {
  if (!Object.hasOwn(candidateTargets, target)) throw new Error('Unknown native target');
  return `occipital-v${version}-${target}${candidateTargets[target].os === 'win32' ? '.exe' : ''}`;
}
export const artifactName = (version, target) => `occipital-v${version}-${target}`;
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function identity(repository, commit) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected repository and exact commit SHA');
}
function url(repository, tag, version, target) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName(version, target))}`;
}

/** Runs only after the native job builds/tests its stamped version. */
export async function stageCI({ root, target, binary, repository, commit, output }) {
  identity(repository, commit);
  if (!Object.hasOwn(candidateTargets, target)) throw new Error('Unknown native target');
  const version = await daemonVersion(root);
  const result = await run(binary, ['--version'], { timeout: 30000 });
  if (result.stdout.trim() !== `occipital ${version}`) throw new Error('Executable version differs from stamped Cargo version');
  const { stdout } = await run('cargo', ['metadata', '--locked', '--offline', '--format-version', '1'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const supplements = (await json(join(root, 'scripts/release/notices/supplements.json'))).map(item => ({ ...item, file: join(root, 'scripts/release/notices', item.file) }));
  const notices = join(dirname(output), `native-notices-${target}`);
  const report = await prepareNotices({ metadata: JSON.parse(stdout), output: notices, supplements });
  if (report.gaps.length) throw new Error(report.gaps.join('\n'));
  await stageRelease({ root, output, input: { notice: join(notices, 'NOTICE'), artifacts: [{ target, path: binary,
    url: url(repository, 'occipital-v' + version, version, target) }] } });
  await rename(notices, join(output, 'notices'));
  await writeFile(join(output, 'build-info.json'), JSON.stringify({ commit, version, target }, null, 2) + '\n');
}

/** No remote APIs: only all-six, exact-tag, exact-commit CI outputs may be published. */
export async function assembleRelease({ directory, tag, repository, commit, output }) {
  identity(repository, commit);
  const release = releaseRef('refs/tags/' + tag);
  if (release.product !== 'occipital') throw new Error('Only occipital tags create a native release');
  const prepared = [], metadata = { version: release.version, artifacts: [] };
  let license;
  for (const target of Object.keys(candidateTargets)) {
    const root = join(directory, artifactName(release.version, target)), info = await json(join(root, 'build-info.json'));
    if (info.commit !== commit || info.version !== release.version || info.target !== target) throw new Error('CI artifact commit/version/target differs');
    const notices = await json(join(root, 'notices/notice-sources.json'));
    if (!Array.isArray(notices.gaps) || notices.gaps.length || !Array.isArray(notices.inventory) || !notices.inventory.length) throw new Error('Unresolved native notice inventory');
    const staged = await json(join(root, 'native-release.staged.json')), record = staged.artifacts?.[0];
    if (staged.version !== release.version || staged.artifacts?.length !== 1 || record?.target !== target || record.url !== url(repository, tag, release.version, target)) throw new Error('Unexpected staged release metadata');
    const name = assetName(release.version, target), path = join(root, 'assets', name), digest = await executableDigest(path);
    if (digest.sha256 !== record.sha256 || digest.maxBytes !== record.maxBytes) throw new Error('CI executable differs from its checksum/size');
    const notice = await readFile(join(root, 'assets/NOTICE')), own = await readFile(join(root, 'assets/LICENSE'));
    if (!notice.toString('utf8').trim() || !own.toString('utf8').trim() || (license && !license.equals(own))) throw new Error('Missing or inconsistent release notices');
    license = own;
    prepared.push({ name, path, notice }); metadata.artifacts.push(record);
  }
  // Refuse an existing output instead of mixing this run with partial older files.
  await mkdir(output);
  for (const artifact of prepared) {
    await copyFile(artifact.path, join(output, artifact.name));
    await writeFile(join(output, artifact.name + '.NOTICE'), artifact.notice);
  }
  await writeFile(join(output, 'LICENSE'), license);
  await writeFile(join(output, 'native-release.json'), JSON.stringify(metadata, null, 2) + '\n');
  const sums = [];
  for (const name of (await readdir(output)).sort()) sums.push(`${createHash('sha256').update(await readFile(join(output, name))).digest('hex')}  ${name}\n`);
  await writeFile(join(output, 'SHA256SUMS'), sums.join(''));
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2), root = resolve(import.meta.dirname, '../..');
  if (mode === 'stage' && args.length === 3) await stageCI({ root, target: args[0], binary: resolve(args[1]), output: resolve(args[2]), repository: process.env.GITHUB_REPOSITORY, commit: process.env.SOURCE_COMMIT });
  else if (mode === 'assemble' && args.length === 3) await assembleRelease({ directory: resolve(args[0]), tag: args[1], output: resolve(args[2]), repository: process.env.GITHUB_REPOSITORY, commit: process.env.SOURCE_COMMIT });
  else throw new Error('Usage: native-ci.mjs stage TARGET BINARY NEW-DIR | assemble ARTIFACTS TAG NEW-DIR (GITHUB_REPOSITORY, SOURCE_COMMIT required)');
}
