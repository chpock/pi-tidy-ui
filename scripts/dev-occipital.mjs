import { execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './test/context.mjs';
import { snapshotIdentity } from './test/prepare.mjs';

export const executable = process.platform === 'win32' ? 'occipital.exe' : 'occipital';
const record = '.occipital-build.json';

export function nativeFiles(root) {
  const files = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].filter(name => existsSync(join(root, name)));
  function collect(directory) {
    if (!existsSync(join(root, directory))) return;
    for (const name of readdirSync(join(root, directory))) {
      const path = `${directory}/${name}`, info = statSync(join(root, path));
      if (info.isDirectory()) collect(path);
      else if (info.isFile()) files.push(path);
    }
  }
  for (const directory of ['crates', 'protocol', '.cargo']) collect(directory);
  return files.sort();
}

const currentTree = root => snapshotIdentity(root, nativeFiles(root)).nativeTree;

export function installDevelopmentOccipital(root, binary, nativeTree) {
  if (!existsSync(binary)) throw new Error(`Cargo did not produce the expected executable: ${binary}`);
  const stage = mkdtempSync(join(root, '.occipital-build-'));
  try {
    const staged = join(stage, executable);
    copyFileSync(binary, staged);
    chmodSync(staged, 0o755);
    const version = execFileSync(staged, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).trim();
    if (version !== 'occipital 0.0.0') throw new Error(`Expected occipital 0.0.0; found ${JSON.stringify(version)}`);
    writeFileSync(join(stage, record), JSON.stringify({ nativeTree, sha256: digest(readFileSync(staged)) }) + '\n');
    if (currentTree(root) !== nativeTree) throw new Error('Native sources changed during build; rerun make build');
    // Existing processes may still be using the old executable inode.
    renameSync(staged, join(root, executable));
    renameSync(join(stage, record), join(root, record));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function check(root) {
  const binary = join(root, executable), path = join(root, record);
  if (!existsSync(binary)) throw new Error(`Missing ${executable}`);
  if (!lstatSync(binary).isFile()) throw new Error(`${executable} is not a regular file`);
  accessSync(binary, constants.X_OK);
  if (!existsSync(path)) throw new Error('No installation record');
  if (!lstatSync(path).isFile()) throw new Error('Invalid installation record');
  let installed;
  try { installed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('Invalid installation record');
  }
  const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!sha256(installed?.nativeTree) || !sha256(installed?.sha256)) throw new Error('Invalid installation record');
  if (digest(readFileSync(binary)) !== installed.sha256) throw new Error('Installed binary differs from its build record');
  if (currentTree(root) !== installed.nativeTree) throw new Error('Native sources changed since installation');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.cwd());
    console.log(`Installed ${executable} matches the current native sources`);
  } catch (error) {
    console.error(`${error.message}. Run make build to install the development helper.`);
    process.exitCode = 1;
  }
}
