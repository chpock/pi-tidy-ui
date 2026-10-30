// One isolated controller per trial. Target Pi brackets its own metrics.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PiTerminal, until } from './terminal-harness.mjs';
import { readInputs, validateNative } from '../../scripts/test/context.mjs';
import { sessionText } from '../../scripts/test/performance/workloads.mjs';

export async function runPerformanceCLI(configPath, { name = 'performance', profilePath, created } = {}) {
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.preconditionOnly !== undefined && typeof config.preconditionOnly !== 'boolean') throw new Error('Invalid performance precondition mode');
const preconditionOnly = config.preconditionOnly === true;
const inputs = readInputs(), scenario = config.scenario, directory = dirname(configPath);
const sessionHash = () => createHash('sha256').update(readFileSync(session)).digest('hex');
const work = join(directory, 'workspace'); mkdirSync(work, { recursive: true });
const session = join(directory, 'synthetic.jsonl'); writeFileSync(session, sessionText(scenario.parameters, work));
const generatedSession = sessionHash();
if (scenario.variant === 'on') validateNative(inputs);
let terminal;
try {
  const started = preconditionOnly ? undefined : performance.now();
  const resultName = preconditionOnly ? 'precondition.json' : 'performance.json';
  terminal = new PiTerminal(name, { workspace: work, session, mode: config.mode ?? 'fullscreen',
    dimensions: { columns: scenario.parameters.width, rows: scenario.parameters.height },
    extensions: [join(inputs.pi.root, 'tests/fixtures', scenario.variant === 'native' ? 'performance-driver.mjs' : 'performance-tidy.ts')],
    tidyUiSettings: { terminalColorsEnabled: false, nativeHighlightingEnabled: true, syntaxTheme: { kind: 'pi' } },
    extraEnv: { TIDY_UI_TEST_PERFORMANCE: '1', TIDY_TEST_PERF_CONFIG: configPath,
      TIDY_TEST_PERF_PROFILE: profilePath,
      ...(preconditionOnly ? { TIDY_UI_TEST_PERFORMANCE_PRECONDITION: '1' } : {}),
      ...(scenario.variant === 'on' ? { OCCIPITAL_TEST_BIN: inputs.native.path } : {}) } });
  created?.(terminal);
  await terminal.ready();
  const launchToReadyMs = preconditionOnly ? undefined : performance.now() - started, readySession = sessionHash();
  terminal.send('/tidy-perf-run\r');
  const begin = preconditionOnly ? undefined : performance.now();
  const result = await until(() => {
    terminal.health();
    try { return JSON.parse(readFileSync(join(terminal.output, resultName), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
  }, preconditionOnly ? 'target correctness precondition' : 'target performance result', 90000);
  const controllerRoundtripMs = preconditionOnly ? undefined : performance.now() - begin;
  const events = terminal.events();
  assert.equal(events.filter(event => event.type === 'call' || event.type === 'result').length, 0, 'saved synthetic history never executes tools');
  assert.equal(events.filter(event => event.type === 'context').length, 0, 'benchmark never sends model traffic');
  assert.equal(terminal.raw.length, 1, 'benchmark controller retains only the latest PTY chunk');
  assert.ok(terminal.raw[0].length <= 65536);
  if (!preconditionOnly) result.controller = { launchToReadyMs, controllerRoundtripMs, rawBytesRetained: terminal.raw[0].length,
    scope: 'collector-and-PTY are distinct from measured target Pi', frameWidth: terminal.term.cols, frameHeight: terminal.term.rows };
  const viewport = Array.from({ length: terminal.term.rows }, (_, row) => terminal.term.buffer.active.getLine(row)?.translateToString(true) ?? '');
  assert.ok(viewport.some(row => row.trim().length), 'real terminal viewport contains rendered data');
  const bodyVisible = /PERF_|output_|Readbody|Updatedperf|value_|perf-\d+\.(?:txt|js)/.test(viewport.join('').replace(/[\s┃│╹▀]/gu, ''));
  if (scenario.parameters.height >= 40) assert.ok(bodyVisible, 'normal-height actual terminal shows synthetic tool content');
  assert.equal(sessionHash(), readySession, 'benchmark actions preserve saved session bytes');
  await terminal.quit();
  assert.equal(sessionHash(), readySession, 'benchmark shutdown preserves saved session bytes');
  result.integrity = { ...result.integrity, session: { generatedSha256: generatedSession, readySha256: readySession,
    startupChanged: generatedSession !== readySession, actionsAndShutdownUnchanged: true }, viewport: { rows: viewport.length,
    sha256: createHash('sha256').update(JSON.stringify(viewport)).digest('hex'), bodyVisible,
    bodyAssertion: scenario.parameters.height >= 40 ? 'verified' : 'small-viewport: representative-tool-render-proof-only' } };
  return result;
} finally {
  if (terminal) { try { await terminal.close(); } finally { terminal.dispose(); } }
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.env.TIDY_TEST_PERF_CONFIG, 'utf8'));
  const result = await runPerformanceCLI(process.env.TIDY_TEST_PERF_CONFIG, { profilePath: process.env.TIDY_TEST_PERF_PROFILE });
  const output = config.preconditionOnly ? process.env.TIDY_TEST_PERF_PRECONDITION_RESULT : process.env.TIDY_TEST_PERF_RESULT;
  if (!output) throw new Error('Missing performance result path');
  writeFileSync(output, JSON.stringify(result));
  if (result.outcome !== 'passed') process.exitCode = 1;
}
