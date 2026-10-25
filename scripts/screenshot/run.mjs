import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { childEnv, readInputs, toolPath, validateHost, validateNative } from '../test/context.mjs';
import { sourceIdentity, snapshotIdentity, validateNeutralRunRoot } from '../test/prepare.mjs';
import { isolatedCommand } from '../test/run.mjs';
import { windowRule } from './foot.mjs';

export function parseOptions(args) {
  const { values } = parseArgs({ args, options: { inputs: { type: 'string' }, output: { type: 'string' }, workspace: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (!values.help && (!values.inputs || !values.output)) throw new Error('Supply --inputs /absolute/path/inputs.json and --output /new/output/directory');
  return values;
}

export async function screenshot(options) {
  if (process.platform !== 'linux') throw new Error('Screenshot generation currently requires the verified Linux systemd/bubblewrap scope');
  const inputs = readInputs(resolve(options.inputs)), output = resolve(options.output);
  validateHost(inputs, false); validateNative(inputs); validateNeutralRunRoot(inputs.runRoot);
  for (const tool of ['python3', 'bash', 'bwrap', 'foot', 'grim', 'hyprctl', 'fc-match', 'rg', 'fd']) toolPath(tool, inputs);
  const desktop = Object.fromEntries(['XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE'].map(key => {
    if (!process.env[key]) throw new Error('Run from the intended Wayland/Hyprland session: missing ' + key);
    return [key, process.env[key]];
  }));
  if (!isAbsolute(desktop.XDG_RUNTIME_DIR)) throw new Error('XDG_RUNTIME_DIR must be absolute');
  if (existsSync(output)) throw new Error('Screenshot output directory already exists; supply a fresh --output');
  const environment = childEnv(join(inputs.preparation, 'screenshot-validation'), {}, inputs);
  const workspace = options.workspace ? resolve(options.workspace) : '';
  if (workspace) {
    if (workspace === resolve(inputs.source.root) || workspace === resolve(inputs.pi.root)) throw new Error('Use a separate demo clone, not the extension source or prepared checkout');
    const git = args => execFileSync(toolPath('git', inputs), ['-C', workspace, ...args], { env: environment, encoding: 'utf8', timeout: 10000 });
    if (git(['rev-parse', '--show-toplevel']).trim() !== workspace) throw new Error('Screenshot workspace must be the Git repository root');
    if (git(['ls-files', '--', 'src/router.ts', 'tests/health.test.ts']).trim()) throw new Error('Screenshot demo files must not replace tracked project files');
  }
  const source = sourceIdentity(inputs.source.root, inputs.tools, environment);
  if (source.commit !== inputs.source.commit || source.tree !== inputs.source.tree || snapshotIdentity(inputs.pi.root, source.files).tree !== source.tree) throw new Error('Screenshot sources are stale; run test:prepare --refresh-inputs first');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(inputs.runRoot, 'screenshot-'));
  let graphicsStarted = false, graphicsEnvironment, active, interrupted;
  const interrupt = signal => { interrupted ??= signal; active?.kill(signal); };
  const checkInterruption = () => { if (interrupted) throw new Error('Screenshot interrupted by ' + interrupted); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    graphicsEnvironment = childEnv(directory, desktop, inputs);
    for (const stage of [
      { name: 'capture', script: 'capture.mjs', args: [output, directory, workspace], desktop: {}, seconds: '120', receipt: 'scope.json' },
      { name: 'foot', script: 'foot.mjs', args: [output], desktop, seconds: '60', receipt: 'foot-scope.json' },
    ]) {
      checkInterruption();
      if (stage.name === 'foot') graphicsStarted = true;
      const env = childEnv(directory, { TIDY_TEST_CONTEXT_READY: '1', ...stage.desktop }, inputs);
      const environmentFile = join(output, stage.name + '-environment.json'), receipt = join(output, stage.receipt);
      writeFileSync(environmentFile, JSON.stringify(env), { mode: 0o600, flag: 'wx' });
      const args = ['--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href,
        join(inputs.pi.root, 'scripts/screenshot', stage.script), ...stage.args];
      const target = isolatedCommand(inputs.node.path, args, inputs);
      active = spawn(toolPath('python3', inputs), ['-I', '-S', join(inputs.pi.root, 'scripts/test/safe-run.py'),
        '--label', 'screenshot-' + stage.name, '--receipt', receipt, '--limit-seconds', stage.seconds, '--env-file', environmentFile,
        '--', target.command, ...target.args], { cwd: inputs.pi.root, stdio: 'inherit' });
      const code = await new Promise((resolve, reject) => { active.once('error', reject); active.once('close', resolve); });
      active = undefined;
      checkInterruption();
      if (code !== 0 || !existsSync(receipt) || JSON.parse(readFileSync(receipt, 'utf8')).outcome !== 'passed') throw new Error('Screenshot ' + stage.name + ' failed; inspect ' + output);
    }
    return join(output, 'preview.png');
  } finally {
    try {
      if (graphicsStarted) {
        const result = execFileSync(toolPath('hyprctl', inputs), ['eval', windowRule(false)], { env: graphicsEnvironment, encoding: 'utf8', timeout: 10000 });
        if (result.trim() !== 'ok') throw new Error('Cannot disable the screenshot-only window rule: ' + result.trim());
      }
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); }
      finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log('npm run screenshot -- --inputs /absolute/prepared/inputs.json --output /new/output/directory [--workspace /absolute/separate-demo-clone]\nRequires a Wayland/Hyprland session, foot/grim, prepared same-source native inputs and declared screenshot tools. Opens a temporary foot window. See docs/screenshots.md.');
  else await screenshot(options);
}
