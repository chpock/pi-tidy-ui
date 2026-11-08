import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv, readInputs, toolPath, validateHost } from '../test/context.mjs';
import { sourceIdentity, snapshotIdentity, validateNeutralRunRoot } from '../test/prepare.mjs';
import { isolatedCommand } from '../test/run.mjs';
import { adapters } from './adapters/index.mjs';

export function parseOptions(args) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries([
    'inputs', 'output', 'adapter', 'fixture', 'theme', 'variant', 'columns', 'rows', 'binary', 'prepared', 'left', 'right',
  ].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]])) });
  const command = positionals[0];
  if (values.help) return { help: true };
  if (positionals.length !== 1 || !['prepare', 'collect', 'compare', 'fixtures'].includes(command)) throw new Error('Choose prepare, collect, compare or fixtures');
  if (!isAbsolute(values.inputs ?? '') || !isAbsolute(values.output ?? '')) throw new Error('Supply absolute --inputs and a fresh absolute --output');
  const adapter = Object.hasOwn(adapters, values.adapter) ? adapters[values.adapter] : undefined;
  if (['prepare', 'collect'].includes(command) && !adapter) throw new Error('Choose a registered --adapter');
  if (command === 'prepare' && !adapter.prepare) throw new Error('Selected adapter uses the prepared input graph, not separate reference preparation');
  if (['prepare', 'collect'].includes(command) && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.theme ?? '') || !['dark', 'light'].includes(values.variant))) throw new Error('Preparation and collection require native --theme and --variant dark|light');
  if (command === 'collect' && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(values.fixture ?? '')) throw new Error('Collection requires --fixture');
  if (command === 'compare' && (!isAbsolute(values.left ?? '') || !isAbsolute(values.right ?? ''))) throw new Error('Comparison requires absolute --left and --right capture files');
  const columns = Number(values.columns ?? 180), rows = Number(values.rows ?? 150);
  if (!Number.isInteger(columns) || columns < 24 || columns > 240 || !Number.isInteger(rows) || rows < 10 || rows > 150) throw new Error('Terminal dimensions must be bounded: 24–240 columns, 10–150 rows');
  return { ...values, command, columns, rows };
}

function within(root, path) { const value = relative(root, path); return value === '' || !value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value); }

export async function run(options) {
  if (process.platform !== 'linux') throw new Error('Real comparison capture currently requires verified Linux scope/network isolation');
  const inputs = readInputs(options.inputs), output = resolve(options.output);
  validateHost(inputs, false); validateNeutralRunRoot(inputs.runRoot);
  if (existsSync(output)) throw new Error('Output already exists; preserve prior evidence and choose a fresh directory');
  if (within(inputs.pi.root, output)) throw new Error('Do not place comparison output inside the prepared source tree');
  if (within(inputs.source.root, output)) {
    const ignored = spawnSync(toolPath('git', inputs), ['-C', inputs.source.root, 'check-ignore', '--quiet', '--no-index', '--', output], { env: childEnv(join(inputs.preparation, 'comparison-path-check'), {}, inputs) });
    if (ignored.status !== 0) throw new Error('Generated comparison output must be outside Git or explicitly ignored');
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const environment = childEnv(join(output, 'environment'), { TIDY_TEST_CONTEXT_READY: '1' }, inputs);
  const source = sourceIdentity(inputs.source.root, inputs.tools, environment);
  if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree || snapshotIdentity(inputs.pi.root, source.files).tree !== source.tree) throw new Error('Comparison sources changed; refresh the prepared source snapshot');
  const request = join(output, 'request.json'), envFile = join(output, 'environment.json');
  writeFileSync(request, JSON.stringify(options, null, 2), { flag: 'wx', mode: 0o600 });
  writeFileSync(envFile, JSON.stringify(environment), { flag: 'wx', mode: 0o600 });
  const args = ['--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
    join(inputs.pi.root, 'scripts/highlight-compare/capture.mjs'), request];
  const network = options.command === 'prepare' ? { command: inputs.node.path, args } : isolatedCommand(inputs.node.path, args, inputs);
  const child = spawn(toolPath('python3', inputs), ['-I', '-S', join(inputs.pi.root, 'scripts/test/safe-run.py'),
    '--label', 'highlight-' + options.command, '--receipt', join(output, 'scope.json'), '--limit-seconds', '120', '--env-file', envFile,
    '--', network.command, ...network.args], { cwd: inputs.pi.root, stdio: 'inherit' });
  const interrupt = signal => child.kill(signal);
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes); });
    if (code !== 0) throw new Error('Comparison command failed; inspect ' + output);
    const scope = JSON.parse(readFileSync(join(output, 'scope.json'), 'utf8'));
    if (scope.outcome !== 'passed') throw new Error('Comparison scope did not complete successfully');
    return output;
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log('node scripts/highlight-compare/run.mjs <prepare|collect|compare|fixtures> --inputs /absolute/inputs.json --output /new/output [--adapter ' + Object.keys(adapters).join('|') + ' --fixture ID --theme github --variant dark --columns 180 --rows 150] [--binary /absolute/opencode --prepared /absolute/prepared.json] [--left /absolute/capture.json --right /absolute/capture.json]');
  else await run(options);
}
