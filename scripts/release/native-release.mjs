import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersion } from '../../src/occipital/version.ts';
import { candidateTargets, enabledTargets, validateTargets } from './platforms.mjs';
export { candidateTargets } from './platforms.mjs';
const maxExecutableBytes = 64 * 1024 * 1024; // Existing acquireNative boundary.

export async function daemonVersion(root) {
  const cargo = await readFile(join(root, 'crates/occipital/Cargo.toml'), 'utf8');
  const section = cargo.match(/^\[package\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const name = section?.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const version = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (name !== 'occipital' || !parseVersion(version)) {
    throw new Error('Expected explicit occipital package version in crates/occipital/Cargo.toml');
  }
  return version;
}

export async function executableDigest(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxExecutableBytes) throw new Error('Executable exceeds native acquisition size boundary or is empty');
  const hash = createHash('sha256');
  let maxBytes = 0;
  for await (const chunk of createReadStream(path)) {
    maxBytes += chunk.length;
    if (maxBytes > maxExecutableBytes) throw new Error('Executable exceeds native acquisition size boundary');
    hash.update(chunk);
  }
  if (!maxBytes) throw new Error('Empty executable');
  return { sha256: hash.digest('hex'), maxBytes };
}

function artifactURL(value) {
  if (typeof value !== 'string') throw new Error('Supply an explicit proposed raw executable URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Expected explicit credential-free HTTPS artifact URL');
  return url.href;
}

/** Preparation only: no build, launch, install, publish, tag, or production metadata edit.
 * Input paths and URLs are operator-supplied staging inputs, not runtime overrides.
 * A supplied NOTICE must be reviewed separately; file presence is not legal approval.
 */
export async function stageRelease({ root, input, output, targets = enabledTargets() }) {
  targets = validateTargets(targets);
  const version = await daemonVersion(root);
  if (!input || !Array.isArray(input.artifacts) || !input.artifacts.length || typeof input.notice !== 'string') {
    throw new Error('Expected {notice:path, artifacts:[{target,path,url}]}');
  }
  const supplied = validateTargets(input.artifacts.map(artifact => artifact?.target));
  if (supplied.some(target => !targets.includes(target))) throw new Error('Native staging input is not a selected target');
  const license = await readFile(join(root, 'LICENSE'));
  const notice = await readFile(input.notice);
  if (!license.toString('utf8').trim() || !notice.toString('utf8').trim()) throw new Error('LICENSE and reviewed NOTICE input must be nonempty');
  const prepared = [];
  for (const artifact of input.artifacts) {
    const target = candidateTargets[artifact.target];
    const url = artifactURL(artifact.url);
    const digest = await executableDigest(artifact.path);
    const manifest = JSON.parse(await readFile(join(root, 'packages/native', artifact.target, 'package.json.template'), 'utf8'));
    manifest.version = version;
    prepared.push({ id: artifact.target, path: artifact.path, url, digest, target, manifest });
  }
  // Refuse an existing destination, including a previously prepared candidate.
  await mkdir(output);
  const metadata = { version, artifacts: [] };
  await mkdir(join(output, 'assets'));
  await writeFile(join(output, 'assets', 'LICENSE'), license);
  await writeFile(join(output, 'assets', 'NOTICE'), notice);
  await mkdir(join(output, 'packages'));
  for (const artifact of prepared) {
    const directory = join(output, 'packages', artifact.id);
    await mkdir(directory);
    const executable = join(directory, artifact.target.executable);
    await copyFile(artifact.path, executable);
    const digest = await executableDigest(executable);
    if (digest.sha256 !== artifact.digest.sha256 || digest.maxBytes !== artifact.digest.maxBytes) throw new Error('Executable changed during preparation');
    await chmod(executable, 0o755);
    await writeFile(join(directory, 'package.json'), JSON.stringify(artifact.manifest, null, 2) + '\n');
    await writeFile(join(directory, 'LICENSE'), license);
    await writeFile(join(directory, 'NOTICE'), notice);
    const targetID = artifact.id;
    // acquireNative consumes raw executable bytes, not an npm tarball or archive.
    await copyFile(executable, join(output, 'assets', `occipital-v${version}-${targetID}${artifact.target.os === 'win32' ? '.exe' : ''}`));
    metadata.artifacts.push({ target: targetID, ...digest, url: artifact.url });
  }
  await writeFile(join(output, 'native-release.staged.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, output, targetsJSON, ...extra] = process.argv.slice(2);
  if (!inputPath || !output || extra.length) throw new Error('Usage: node scripts/release/native-release.mjs INPUT.json NEW-STAGING-DIRECTORY [TARGETS-JSON]');
  await stageRelease({ root: resolve(import.meta.dirname, '../..'), input: JSON.parse(await readFile(inputPath, 'utf8')), output: resolve(output), targets: targetsJSON === undefined ? undefined : JSON.parse(targetsJSON) });
}
