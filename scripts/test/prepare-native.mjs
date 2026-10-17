import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv, rustLoaderEnvironment } from './context.mjs';
import { materializeSource, materializeTools, sourceIdentity, systemTools, validateNeutralRunRoot } from './prepare.mjs';

const project = resolve(import.meta.dirname, '../..');
const optionNames = ['root', 'output', 'node', 'tools', 'rust-root', 'rust-environment', 'run-root'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const inside = (root, path) => path === root || path.startsWith(root + sep);
const suffix = process.platform === 'win32' ? '.exe' : '';

function absoluteFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isFile()) throw new Error('Native preparation requires absolute executable/file paths');
  return realpathSync(path);
}

function buildEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['PATH', 'INCLUDE', 'LIB', 'LIBPATH'].includes(key)) ||
      Object.values(value).some(value => typeof value !== 'string' || value.includes('\0')) ||
      (process.platform !== 'win32' && Object.keys(value).length)) {
    throw new Error('Only explicit Windows build PATH/INCLUDE/LIB/LIBPATH are allowed');
  }
  return value;
}

function validateDescriptor(inputs) {
  if (!inputs || inputs.schema !== 1 || inputs.kind !== 'native-build' ||
      Object.keys(inputs).some(key => !['schema', 'kind', 'preparation', 'node', 'tools', 'systemRoot', 'source', 'runRoot', 'project', 'rust'].includes(key))) {
    throw new Error('Invalid prepared native-build inputs');
  }
  const paths = [inputs.preparation, inputs.node?.path, inputs.tools?.bin, inputs.source?.root,
    inputs.runRoot, inputs.project, inputs.rust?.root, inputs.rust?.cargo, inputs.rust?.rustc, inputs.rust?.home, inputs.rust?.target];
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Prepared native input paths must be absolute');
  if (!/^v\d+\.\d+\.\d+$/.test(inputs.node.version) || !/^[a-f0-9]{40}$/.test(inputs.source.commit) ||
      !/^[a-f0-9]{64}$/.test(inputs.source.tree) || !/^[a-f0-9]{64}$/.test(inputs.source.nativeTree)) throw new Error('Invalid prepared native source/runtime identity');
  const preparation = realpathSync(inputs.preparation), runRoot = realpathSync(inputs.runRoot), source = realpathSync(inputs.source.root);
  validateNeutralRunRoot(runRoot);
  if (inside(source, runRoot) || realpathSync(inputs.project) !== join(runRoot, 'project') ||
      realpathSync(inputs.tools.bin) !== join(preparation, 'bin') || inputs.rust.home !== join(preparation, 'cargo-home') ||
      inputs.rust.target !== join(preparation, 'cargo-target') || inputs.rust.cargo !== join(inputs.rust.root, 'bin/cargo' + suffix) ||
      inputs.rust.rustc !== join(inputs.rust.root, 'bin/rustc' + suffix)) throw new Error('Prepared native inputs must use their owned neutral paths');
  absoluteFile(inputs.node.path);
  for (const name of ['git', 'tar', 'npm']) absoluteFile(inputs.tools[name]);
  for (const path of [inputs.rust.cargo, inputs.rust.rustc]) absoluteFile(path);
  if (typeof inputs.tools.path !== 'string' || !inputs.tools.path || inputs.tools.path.includes('\0')) throw new Error('Invalid prepared native tool PATH');
  if (process.platform === 'win32' && inputs.systemRoot !== 'C:\\Windows') throw new Error('Native preparation requires the fixed Windows system root');
  buildEnvironment(inputs.rust.environment);
  return inputs;
}

// Stamping intentionally changes the owned Cargo sources after preparation. This
// reader validates admission/placement, not those post-stamp source bytes.
export function readNativeInputs(path) {
  absoluteFile(path);
  return validateDescriptor(json(path));
}

export function prepareNative(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.entries(options).some(([name, value]) => !optionNames.includes(name) || typeof value !== 'string' || !value || value.includes('\0'))) {
    throw new Error('Invalid native preparation options');
  }
  if (!options['rust-root'] || !isAbsolute(options['rust-root'])) throw new Error('Native preparation requires an explicit absolute --rust-root');
  const root = realpathSync(resolve(options.root ?? project));
  const output = resolve(options.output ?? join(root, '.test-artifacts/native-build'));
  const node = absoluteFile(options.node ?? process.execPath), rustRoot = realpathSync(options['rust-root']);
  const declaredTools = options.tools ? json(resolve(options.tools)) : {};
  if (!declaredTools || typeof declaredTools !== 'object' || Array.isArray(declaredTools) ||
      Object.keys(declaredTools).some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || ['bin', 'path', 'node'].includes(name))) throw new Error('Invalid declared native tools');
  for (const path of Object.values(declaredTools)) absoluteFile(path);
  const tools = systemTools(node, declaredTools);
  const rustEnvironment = options['rust-environment'] ? buildEnvironment(json(resolve(options['rust-environment']))) : {};
  if (options['rust-environment'] && process.platform !== 'win32') throw new Error('Only explicit Windows build PATH/INCLUDE/LIB/LIBPATH are allowed');
  const expected = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').match(/^\s*channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
  const minimum = json(join(root, 'package.json')).engines?.node?.match(/^>=(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!expected || !minimum) throw new Error('Native preparation requires exact repository Rust pin and Node minimum');
  const cargo = join(rustRoot, 'bin/cargo' + suffix), rustc = join(rustRoot, 'bin/rustc' + suffix);
  for (const path of [cargo, rustc]) absoluteFile(path);
  // Never replace source or compiler directories with the owned tool/environment tree.
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const preparation = realpathSync(output);
  if (inside(preparation, root) || inside(preparation, rustRoot) || inside(rustRoot, preparation)) throw new Error('Native preparation output overlaps source or compiler root');
  process.umask(0o077);
  const inputs = { schema: 1, kind: 'native-build', preparation, node: { path: node, version: '' }, tools: materializeTools(preparation, node, tools) };
  if (process.platform === 'win32') inputs.systemRoot = 'C:\\Windows';
  const runParent = options['run-root'] ? resolve(options['run-root']) : process.platform === 'win32' ? join(inputs.systemRoot, 'Temp') : '/tmp';
  mkdirSync(runParent, { recursive: true, mode: 0o700 });
  validateNeutralRunRoot(runParent);
  inputs.rust = { root: rustRoot, cargo, rustc, home: join(preparation, 'cargo-home'), target: join(preparation, 'cargo-target'), environment: rustEnvironment };
  const environment = childEnv(join(preparation, 'environment'), {}, inputs);
  inputs.node.version = execFileSync(node, ['--version'], { cwd: runParent, env: environment, encoding: 'utf8' }).trim();
  const actual = /^v(\d+)\.(\d+)\.(\d+)$/.exec(inputs.node.version)?.slice(1).map(Number);
  const difference = actual?.findIndex((value, index) => value !== minimum[index]);
  if (!actual || difference !== -1 && actual[difference] < minimum[difference]) {
    throw new Error('Prepared Node runtime does not satisfy repository engine minimum');
  }
  const rustEnv = childEnv(join(preparation, 'environment'), { ...rustEnvironment, ...rustLoaderEnvironment(rustRoot), CARGO_HOME: inputs.rust.home,
    CARGO_TARGET_DIR: inputs.rust.target, RUSTC: rustc, RUSTUP_AUTO_INSTALL: '0' }, inputs);
  for (const [name, path] of [['cargo', cargo], ['rustc', rustc]]) {
    const observed = execFileSync(path, ['--version'], { cwd: runParent, env: rustEnv, encoding: 'utf8' }).trim();
    if (!observed.startsWith(`${name} ${expected} (`)) throw new Error('Prepared Rust toolchain version mismatch');
  }
  const source = sourceIdentity(root, tools, environment);
  if (source.files.some(name => name.split(/[\\/]/).includes('node_modules'))) throw new Error('Native source inventory must not contain node_modules');
  inputs.runRoot = mkdtempSync(join(realpathSync(runParent), 'tt-'));
  try {
    if (inside(root, realpathSync(inputs.runRoot))) throw new Error('Native runtime root must be outside the tested checkout');
    inputs.project = join(inputs.runRoot, 'project');
    const materialized = materializeSource(root, inputs.project, source.files);
    if (materialized.tree !== source.tree || materialized.nativeTree !== source.nativeTree) throw new Error('Materialized native source snapshot differs from tested source');
    writeFileSync(join(inputs.runRoot, 'source-files.json'), JSON.stringify(source.files, null, 2) + '\n');
    const { files, ...identity } = source;
    inputs.source = identity;
    validateDescriptor(inputs);
    writeFileSync(join(preparation, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
    return inputs;
  } catch (error) {
    rmSync(inputs.runRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(optionNames.map(name => [name, { type: 'string' }])) });
  const inputs = prepareNative(values);
  console.log(join(inputs.preparation, 'inputs.json'));
}
