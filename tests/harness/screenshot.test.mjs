import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseOptions } from '../../scripts/screenshot/run.mjs';
import { renderCapture, terminalColor } from '../../scripts/screenshot/render.mjs';
import { assistantMessage, demo, captureReady, toolSequence } from '../../scripts/screenshot/demo.mjs';
import { captureFrame, observeTerminalDefaults } from '../../scripts/screenshot/terminal.mjs';

const cell = (text, extra = {}) => ({ text, width: 1, fg: 0, fgMode: 0, bg: 0, bgMode: 0, ...extra });
const style = { font: 'Demo Mono', fontSize: 16, cellWidth: 10, cellHeight: 20, padding: 16, foreground: '#e5e5e5', background: '#101010' };

function readyCapture() {
  const screen = [...demo.readyText, 'Research complete.', 'read tests/router.test.ts',
    'The health check should stay dependency-free', 'aft_search', '[exit code: 1]',
    '⠋ Working...', 'GPT-6 Astra (openai-codex) • max', 'CH97.0% • 147k/272k'];
  return { screen, cells: screen.map(text => Array.from(text, (value, i) => cell(value, { fg: i % 3, fgMode: 0x3000000 }))) };
}

test('screenshot CLI requires explicit prepared inputs and output; rejects unknown flags', () => {
  assert.throws(() => parseOptions([]), /--inputs.*--output/);
  assert.throws(() => parseOptions(['--inputs', '/inputs.json']), /--inputs.*--output/);
  assert.throws(() => parseOptions(['--inputs', '/inputs.json', '--output', '/out', '--publish']), /Unknown option/);
  assert.equal(parseOptions(['--help']).help, true);
  const options = parseOptions(['--inputs', '/inputs.json', '--output', '/out']);
  assert.equal(options.inputs, '/inputs.json'); assert.equal(options.output, '/out');
  assert.equal(parseOptions(['--inputs', '/inputs.json', '--output', '/out', '--workspace', '/tmp/projects/pi-tidy-ui']).workspace, '/tmp/projects/pi-tidy-ui');
});

test('screenshot colors preserve default, ANSI, indexed and truecolor values', () => {
  assert.equal(terminalColor(0, 0, '#123456'), '#123456');
  assert.equal(terminalColor(1, 0x1000000, '#ffffff'), '#cd0000');
  assert.equal(terminalColor(196, 0x2000000, '#ffffff'), '#ff0000');
  assert.equal(terminalColor(232, 0x2000000, '#ffffff'), '#080808');
  assert.equal(terminalColor(255, 0x2000000, '#ffffff'), '#eeeeee');
  assert.equal(terminalColor(0x123456, 0x3000000, '#ffffff'), '#123456');
  assert.throws(() => terminalColor(256, 0x2000000, '#ffffff'), /color/);
  assert.throws(() => terminalColor(1, 42, '#ffffff'), /mode/);
});

test('screenshot SVG preserves captured text, wide cells, colors and font attributes', () => {
  const capture = { cells: [[cell('<&', { width: 2, fg: 0x00ff00, fgMode: 0x3000000, bold: true, italic: true, underline: true, strike: true }), cell('', { width: 0 })]] };
  const { svg, width, height } = renderCapture(capture, style);
  assert.equal(width, 52); assert.equal(height, 52);
  assert.match(svg, /&lt;&amp;/);
  assert.match(svg, /fill="#00ff00"/);
  assert.match(svg, /font-weight="bold"/);
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, /text-decoration="underline line-through"/);
  assert.equal((svg.match(/<text /g) ?? []).length, 1);
});

test('screenshot reverse/faint cells and continuous box glyphs retain terminal semantics', () => {
  const { svg } = renderCapture({ cells: [[cell('X', { fg: 0xffffff, fgMode: 0x3000000, bg: 0, bgMode: 0x3000000, inverse: true, dim: true }), cell('┃'), cell('▀'), cell('╹')]] }, style);
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /fill="#7f7f7f"/);
  assert.equal((svg.match(/<text /g) ?? []).length, 1, 'box graphics fill their cells without font-baseline gaps');
  assert.throws(() => renderCapture({ cells: [] }, style), /rectangular/);
  assert.throws(() => renderCapture({ cells: [[cell('a')], []] }, style), /rectangular/);
});

test('offline screenshot usage and readiness depend on actual visible colored cards', () => {
  const message = assistantMessage([], 97);
  const input = message.usage.input + message.usage.cacheRead;
  assert.equal(input, demo.context.promptTokens);
  assert.ok(Math.abs(message.usage.cacheRead / input - 0.97) <= 1 / input, 'cache share agrees within one rounded token');
  for (const [hit, cached] of [[0, 0], [50, input / 2], [100, input]]) {
    const usage = assistantMessage([], hit).usage;
    assert.equal(usage.cacheRead, cached); assert.equal(usage.input + usage.cacheRead, input);
  }
  assert.equal(message.usage.totalTokens, input + demo.context.outputTokens);
  assert.equal(message.usage.cost.total, 0);
  assert.equal(message.model, 'gpt-6-astra'); assert.equal(message.provider, 'openai-codex');
  assert.equal(demo.cacheHits.length, 10);
  const captured = readyCapture(), { screen } = captured;
  assert.equal(captureReady(captured), true);
  assert.equal(captureReady({ ...captured, cells: screen.map(text => Array.from(text, value => cell(value))) }), false, 'uncolored fallback is not ready');
  assert.equal(captureReady({ ...captured, screen: [...screen, 'Warning: missing tool'] }), false);
  for (const required of [...demo.readyText, 'Research complete.', 'tests/router.test.ts',
    'The health check should stay dependency-free', 'aft_search', '[exit code: 1]', '147k/272k']) {
    assert.equal(captureReady({ ...captured, screen: screen.map(row => row.includes(required) ? '' : row) }), false, required);
  }
});

test('screenshot example uses the requested wide screen, fixed tracked theme and opt-in colors', async () => {
  assert.equal(demo.dimensions.columns, 160);
  assert.ok(demo.dimensions.rows >= 80, 'allow the requested extra rows for additional cards');
  assert.equal(demo.thinkingLevel, 'max');
  assert.equal(demo.model.name, 'GPT-6 Astra'); assert.equal(demo.model.provider, 'openai-codex');
  assert.equal(demo.terminalColorsEnabled, true);
  assert.equal(demo.working, true);
  const theme = JSON.parse(await readFile(demo.theme.path, 'utf8'));
  assert.equal(theme.name, 'gruvbox-dark-hard'); assert.equal(theme.name, demo.theme.name);
  assert.equal(theme.vars[theme.export.pageBg], '#1d2021');
  assert.equal(theme.vars[theme.colors.text], '#ebdbb2');
});

test('screenshot readiness rejects missing model/provider/thinking metadata', () => {
  const { screen: rows, cells } = readyCapture();
  assert.equal(captureReady({ screen: rows, cells }), true);
  assert.equal(captureReady({ screen: rows.map(row => row.replace('⠋ Working...', '')), cells }), false, 'native Working must be visible');
  assert.equal(captureReady({ screen: rows.map(row => row.replace('• max', '• max • Idle')), cells }), false, 'Working must not coexist with Idle');
  for (const missing of ['GPT-6 Astra', 'openai-codex', 'max']) {
    const screen = rows.map(row => row.replace(missing, 'unavailable'));
    assert.equal(captureReady({ screen, cells }), false, missing);
  }
});

test('screenshot defaults follow actual independent OSC sets, queries and profile restoration', () => {
  const handlers = new Map(), replies = [];
  const terminal = { term: { parser: { registerOscHandler: (code, handler) => handlers.set(code, handler) } }, send: value => replies.push(value) };
  const state = observeTerminalDefaults(terminal, style);
  assert.deepEqual(state.snapshot(), { foreground: '#e5e5e5', background: '#101010' });
  handlers.get(10)('?'); assert.equal(replies.at(-1), '\x1b]10;rgb:e5e5/e5e5/e5e5\x07');
  handlers.get(11)('#1D2021'); handlers.get(10)('#ebdbb2');
  assert.deepEqual(state.snapshot(), { foreground: '#ebdbb2', background: '#1d2021' });
  handlers.get(11)('?'); assert.equal(replies.at(-1), '\x1b]11;rgb:1d1d/2020/2121\x07');
  const { svg } = renderCapture({ cells: [[cell('default text')]] }, { ...style, ...state.snapshot() });
  assert.match(svg, /fill="#1d2021"/); assert.match(svg, /fill="#ebdbb2"/);
  handlers.get(110)(''); assert.deepEqual(state.snapshot(), { foreground: '#e5e5e5', background: '#1d2021' });
  handlers.get(111)(''); assert.deepEqual(state.snapshot(), { foreground: '#e5e5e5', background: '#101010' });
  handlers.get(10)('invalid'); assert.deepEqual(state.applied, {});
  assert.deepEqual(state.events.filter(event => event.set), [{ set: 'background', value: '#1d2021' }, { set: 'foreground', value: '#ebdbb2' }]);
});


test('screenshot raster viewport scales independently of the captured terminal grid', () => {
  const capture = { cells: [[cell('A'), cell('B')], [cell('C'), cell('D')]] };
  const result = renderCapture(capture, { ...style, scale: 2 / 3 });
  assert.equal(result.width, 35); assert.equal(result.height, 48);
  assert.match(result.svg, /width="35" height="48" viewBox="0 0 52 72"/);
  assert.match(result.svg, /font-size="16"/);
  assert.equal((result.svg.match(/<text /g) ?? []).length, 4);
  assert.equal(capture.cells.length, 2); assert.equal(capture.cells[0].length, 2);
  for (const scale of [0, -1, NaN, Infinity]) assert.throws(() => renderCapture(capture, { ...style, scale }), /scale/);
  assert.throws(() => renderCapture(capture, { ...style, scale: 0.001 }), /pixel dimensions/);
});

test('screenshot retains one drained frame even when parsing and later asynchronous writes admit more bytes', async () => {
  let drainFirst, drainSecond, captures = 0;
  const terminal = {
    queue: new Promise(resolve => { drainFirst = resolve; }), raw: [Buffer.from('first')],
    captureScreen: () => { captures++; return { screen: ['firstsecond'], cells: [[cell('x')]] }; },
  };
  const pending = captureFrame(terminal);
  terminal.queue = new Promise(resolve => { drainSecond = resolve; });
  terminal.raw.push(Buffer.from('second'));
  drainFirst(); await Promise.resolve();
  assert.equal(captures, 0, 'a newer admitted parse must finish before taking the frame');
  drainSecond();
  const frame = await pending;
  await (async () => { terminal.raw.push(Buffer.from('later animation')); await Promise.resolve(); })();
  terminal.raw[0].fill(0);
  assert.equal(captures, 1);
  assert.deepEqual(frame.capture.screen, ['firstsecond']);
  assert.equal(frame.ansi.toString(), 'firstsecond', 'later arrivals and source-buffer mutations cannot change the retained ANSI');
});

test('screenshot story has one completed nonzero command and an additions-only edit', () => {
  const steps = toolSequence({ text: 'test failed\n', details: { exit_code: 1 }, isError: false });
  const commands = steps.filter(step => step.name === 'bash');
  assert.equal(commands.length, 1);
  assert.ok(commands[0].arguments.command.includes(' && '));
  assert.equal(commands[0].result.details.exit_code, 1);
  assert.equal(commands[0].result.isError, false);
  const edits = steps.filter(step => step.name === 'edit');
  assert.equal(edits.length, 2);
  const addition = edits.find(step => step.arguments.newText.startsWith(step.arguments.oldText));
  assert.ok(addition);
  assert.ok(addition.result.details.patch.split('\n').some(line => /^\+(?!\+\+)/.test(line)));
  assert.equal(addition.result.details.patch.split('\n').some(line => /^-(?!--)/.test(line)), false);
});
