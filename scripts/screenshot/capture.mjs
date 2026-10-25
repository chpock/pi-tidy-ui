import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from '../../tests/fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../tests/fixtures/terminal-cleanup.mjs';
import { childEnv, readInputs, toolPath, validateNative } from '../test/context.mjs';
import { demo, assistantMessage, captureReady, toolSequence } from './demo.mjs';
import { captureFrame, observeTerminalDefaults } from './terminal.mjs';

const output = process.argv[2], directory = process.argv[3], inputs = readInputs(), native = validateNative(inputs);
const environment = childEnv(join(directory, 'command-environment'), {}, inputs);
const font = execFileSync(toolPath('fc-match'), ['-f', '%{family}', demo.style.font], { env: environment, encoding: 'utf8' }).trim();
if (!font.split(',').map(name => name.trim()).includes(demo.style.font)) throw new Error(`Install the screenshot font: ${demo.style.font}; found ${font}`);
await copyFile(native.path, join(inputs.pi.root, 'occipital'));
const work = process.argv[4] || join(directory, 'taskboard');
const branch = process.argv[4] ? execFileSync(toolPath('git'), ['branch', '--show-current'], { cwd: work, env: environment, encoding: 'utf8', timeout: 10000 }).trim() : undefined;
if (process.argv[4] && !branch) throw new Error('Screenshot workspace must have a named Git branch');
await mkdir(join(work, 'src'), { recursive: true }); await mkdir(join(work, 'tests'), { recursive: true });
await writeFile(join(work, 'src/router.ts'), demo.newSource);
await writeFile(join(work, 'tests/health.test.ts'), demo.testSource);
const result = spawnSync(toolPath('bash'), ['-e', '-c', demo.command], {
  cwd: work, env: environment, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 1, 'The demo command must preserve the failed test exit status');
// This demo models a completed command, not a tool execution failure.
const commandResult = { text: result.stdout + result.stderr, details: { exit_code: result.status }, isError: false };
await writeFile(join(work, 'tests/health.test.ts'), demo.testSource + demo.testAddition);
await mkdir(join(output, 'taskboard/src'), { recursive: true }); await mkdir(join(output, 'taskboard/tests'), { recursive: true });
await copyFile(join(work, 'src/router.ts'), join(output, 'taskboard/src/router.ts'));
await copyFile(join(work, 'tests/health.test.ts'), join(output, 'taskboard/tests/health.test.ts'));
const manager = SessionManager.create(work, join(output, 'sessions'));
manager.appendModelChange(demo.model.provider, demo.model.id); manager.appendSessionInfo(demo.title); manager.appendThinkingLevelChange(demo.thinkingLevel);
for (const hit of demo.cacheHits.slice(0, -2)) manager.appendMessage(assistantMessage([], hit));
manager.appendMessage(assistantMessage([{ type: 'text', text: demo.previousResponse }], demo.cacheHits.at(-2)));
manager.appendMessage({ role: 'user', content: [{ type: 'text', text: demo.prompt }], timestamp: Date.now() });
const steps = toolSequence(commandResult);
const calls = steps.map(({ name, arguments: args }, index) => ({ type: 'toolCall', id: 'demo-' + index, name, arguments: args }));
manager.appendMessage(assistantMessage([{ type: 'thinking', thinking: demo.thinking }, ...calls], demo.cacheHits.at(-1)));
const results = steps.map(step => step.result);
for (let i = 0; i < calls.length; i++) manager.appendMessage({ role: 'toolResult', toolCallId: calls[i].id, toolName: calls[i].name,
  content: [{ type: 'text', text: results[i].text }], details: results[i].details, isError: results[i].isError ?? false, timestamp: Date.now() });
const terminal = new PiTerminal('screenshot', { workspace: work, session: manager.getSessionFile(), mode: 'fullscreen',
  dimensions: demo.dimensions, seedFixtures: false, tidyUiSettings: { terminalColorsEnabled: demo.terminalColorsEnabled },
  agentSettings: { theme: demo.theme.name, ...demo.agentSettings },
  flags: ['--approve', '--theme', demo.theme.path, '--use-theme', demo.theme.name, '--model', `${demo.model.provider}/${demo.model.id}`, '--thinking', demo.thinkingLevel],
  extensions: [join(import.meta.dirname, 'demo-extension.ts')] });
const colors = observeTerminalDefaults(terminal, demo.style);
let capture, ansi, defaults, activity = { requests: 0, aborted: 0 };
try {
  await terminal.ready();
  assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'restoring the demo must not replay tools or request a model');
  if (demo.working) {
    await terminal.command('/tidy-ui-demo-working');
    await terminal.event('demo_working');
  }
  for (const end = Date.now() + 12000; Date.now() < end;) {
    await terminal.settle();
    ({ capture, ansi } = await captureFrame(terminal));
    if (captureReady(capture) && (!demo.terminalColorsEnabled || colors.applied.foreground && colors.applied.background)) break;
  }
  assert.ok(capture && captureReady(capture), 'all demo cards and their actual syntax colors must be visible before capture');
  if (demo.terminalColorsEnabled) assert.ok(colors.applied.foreground && colors.applied.background, 'both terminal defaults must be applied by actual OSC traffic');
  defaults = colors.snapshot();
  if (branch) assert.ok(capture.screen.some(row => row.includes(work + ':' + branch)), 'actual cwd and Git branch must be visible');
  assert.equal(terminal.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0, 'the offline demonstration must not execute additional tools or use another provider');
  assert.equal(terminal.events().filter(event => event.type === 'demo_working').length, demo.working ? 1 : 0, 'exactly the requested offline turn must be active');
  await writeFile(join(output, 'terminal-colors.json'), JSON.stringify({ ...defaults, enabled: demo.terminalColorsEnabled, events: colors.events }, null, 2) + '\n');
  await writeFile(join(output, 'preview.ansi'), ansi);
  await writeFile(join(output, 'capture.json'), JSON.stringify(capture));
  await writeFile(join(output, 'screen.txt'), capture.screen.join('\n') + '\n');
} finally {
  try {
    const events = terminal.events();
    if (events.some(event => event.type === 'demo_working') && !events.some(event => event.type === 'demo_aborted')) {
      const ends = events.filter(event => event.type === 'agent_end').length;
      terminal.send('\x1b');
      await terminal.event('demo_aborted');
      await terminal.event('agent_end', ends + 1);
    }
    activity = { requests: terminal.events().filter(event => event.type === 'demo_working').length,
      aborted: terminal.events().filter(event => event.type === 'demo_aborted').length };
    assert.equal(activity.aborted, activity.requests, 'all offline responses must be cancelled before closing Pi');
  } finally { await closeTerminals([terminal]); }
}
await writeFile(join(output, 'preview.json'), JSON.stringify({ schema: 1, kind: 'offline-pi-screenshot',
  source: inputs.source, node: inputs.node.version, pi: inputs.pi.version,
  native: { sha256: native.sha256, nativeTree: native.nativeTree }, font,
  modelRequests: activity.requests, externalModelRequests: 0, working: demo.working, cancelledOfflineRequests: activity.aborted,
  sampleUsage: true, sampleModel: true, model: demo.model, thinkingLevel: demo.thinkingLevel,
  theme: demo.theme.name, dimensions: demo.dimensions, agentSettings: demo.agentSettings, context: demo.context,
  terminalColors: { enabled: demo.terminalColorsEnabled, ...defaults },
  workspace: { path: work, branch }, terminalArtifacts: terminal.output }, null, 2) + '\n');
