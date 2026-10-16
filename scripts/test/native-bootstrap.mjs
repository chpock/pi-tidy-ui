import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { childEnv } from './context.mjs';
import { readNativeInputs } from './prepare-native.mjs';
import { snapshotIdentity, sourceIdentity } from './prepare.mjs';

export function ownedNativePath(project, relative, directory = false) {
  const root = realpathSync(project);
  const parts = relative.split('/');
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const entry = lstatSync(path);
    const needsDirectory = directory || index < parts.length - 1;
    if (entry.isSymbolicLink() || !(needsDirectory ? entry.isDirectory() : entry.isFile()) ||
        !realpathSync(path).startsWith(root + sep)) {
      throw new Error('Native test paths require owned regular files/directories, not symbolic links or external paths');
    }
  }
  return path;
}

export function admitNativeTests(path, environmentRoot, runtime = false) {
  const inputs = readNativeInputs(path);
  ownedNativePath(inputs.project, 'tests/native-build', true);
  ownedNativePath(inputs.project, 'scripts/test/native-bootstrap.mjs');
  ownedNativePath(inputs.project, 'scripts/test/native-guard.mjs');
  const env = childEnv(environmentRoot, {}, inputs);
  if (runtime && (realpathSync(process.execPath) !== realpathSync(inputs.node.path) || process.version !== inputs.node.version)) {
    throw new Error('Native test Node runtime differs from prepared runtime');
  }
  if (execFileSync(inputs.node.path, ['--version'], { cwd: inputs.runRoot, env, encoding: 'utf8', timeout: 30000 }).trim() !== inputs.node.version) {
    throw new Error('Native test Node runtime changed since preparation');
  }
  const source = sourceIdentity(inputs.source.root, inputs.tools, env);
  if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree || source.nativeTree !== inputs.source.nativeTree) {
    throw new Error('Native tested sources changed since preparation');
  }
  const inventory = JSON.parse(readFileSync(join(inputs.runRoot, 'source-files.json'), 'utf8'));
  if (!Array.isArray(inventory) || inventory.length !== source.files.length || inventory.some((name, index) => name !== source.files[index])) {
    throw new Error('Prepared native source inventory differs from tested sources');
  }
  if (snapshotIdentity(inputs.project, source.files).tree !== inputs.source.tree) {
    throw new Error('Prepared native source snapshot differs from tested sources; run before stamping');
  }
  const minimum = JSON.parse(readFileSync(join(inputs.project, 'package.json'), 'utf8')).engines?.node?.match(/^>=(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const actual = /^v(\d+)\.(\d+)\.(\d+)$/.exec(inputs.node.version)?.slice(1).map(Number);
  const difference = actual?.findIndex((value, index) => value !== minimum?.[index]);
  if (!minimum || !actual || difference !== -1 && actual[difference] < minimum[difference]) throw new Error('Native test Node runtime does not satisfy repository engine minimum');
  const expected = readFileSync(join(inputs.project, 'rust-toolchain.toml'), 'utf8').match(/^\s*channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
  if (!expected) throw new Error('Native tests require an exact repository Rust pin');
  const rustEnv = childEnv(environmentRoot, { ...inputs.rust.environment, CARGO_HOME: inputs.rust.home,
    CARGO_TARGET_DIR: inputs.rust.target, CARGO_NET_OFFLINE: 'true', RUSTC: inputs.rust.rustc, RUSTUP_AUTO_INSTALL: '0',
    PATH: join(inputs.rust.root, 'bin') + delimiter + (inputs.rust.environment?.PATH ?? env.PATH) }, inputs);
  for (const [name, executable] of [['cargo', inputs.rust.cargo], ['rustc', inputs.rust.rustc]]) {
    if (!execFileSync(executable, ['--version'], { cwd: inputs.project, env: rustEnv, encoding: 'utf8', timeout: 30000 }).trim().startsWith(`${name} ${expected} (`)) {
      throw new Error('Native test pinned Rust toolchain changed since preparation');
    }
  }
  return { inputs, files: source.files };
}

if (process.env.TIDY_NATIVE_TEST_CONTEXT_READY === '1') {
  try {
    process.umask(0o077);
    if (!process.env.TIDY_NATIVE_TEST_INPUTS || !process.env.TIDY_NATIVE_TEST_ENVIRONMENT) throw new Error('Native tests require the native harness context');
    admitNativeTests(process.env.TIDY_NATIVE_TEST_INPUTS, process.env.TIDY_NATIVE_TEST_ENVIRONMENT, true);
    globalThis[Symbol.for('pi-tidy-ui.native-test-context')] = true;
  } catch (error) {
    if (process.env.TIDY_NATIVE_TEST_BOOTSTRAP_STATUS) writeFileSync(process.env.TIDY_NATIVE_TEST_BOOTSTRAP_STATUS, JSON.stringify({ reason: 'native-bootstrap' }));
    throw error;
  }
}
