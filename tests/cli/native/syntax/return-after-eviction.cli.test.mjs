import '../../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiTerminal } from '../../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../../fixtures/terminal-cleanup.mjs';
import { readPendingJson, semanticStyle } from '../../../fixtures/syntax-observation.mjs';
import { chooseTheme, expressionForeground, finish, prepareSyntaxNative, syntaxReady, traffic, until } from '../../../fixtures/syntax-cli-support.mjs';

const marker = 'RETURN_EVICTION_TARGET';
const palette = 'aura-dark';
const { fixture, descriptor } = await prepareSyntaxNative();
const extension = resolve(dirname(fixture), '../cli/native/syntax/support/pressure-driver.ts');
mkdirSync(dirname(extension), { recursive: true });
copyFileSync(new URL('./support/pressure-driver.ts', import.meta.url), extension);

function history(directory) {
  const manager = SessionManager.create(directory, join(directory, 'sessions'));
  manager.appendModelChange('tidy-ui-offline', 'scripted'); manager.appendThinkingLevelChange('off');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 18; i++) {
    const id = `return-${i}`, command = `printf '${i === 17 ? marker : `BACKGROUND_${i}`}\\n'`;
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `saved command ${i}` }], timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
      api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage, stopReason: 'toolUse', timestamp: Date.now() });
    manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: `saved result ${i}` }],
      details: { exit_code: 0 }, isError: false, timestamp: Date.now() });
  }
  return manager.getSessionFile();
}

function requests({ sample }) {
  const { sourceRequests, styleRequests } = sample.counts;
  assert.ok(Number.isSafeInteger(sourceRequests) && sourceRequests > 0 && Number.isSafeInteger(styleRequests) && styleRequests > 0);
  return { sourceRequests, styleRequests };
}
function ink({ screen, cells }) {
  const row = screen.findIndex(line => line.includes(marker));
  assert.notEqual(row, -1, 'target word is fully visible');
  const column = screen[row].indexOf(marker), span = cells[row].slice(column, column + marker.length);
  assert.equal(span.map(cell => cell.text).join(''), marker);
  return span.map(cell => cell.fg);
}
const aboveTarget = screen => screen.some(line => /BACKGROUND_\d+/u.test(line)) &&
  screen.every(line => !line.includes(marker) && !line.includes('saved command 17') && !line.includes('saved result 17'));
async function page(terminal, back, label) {
  for (let i = 0; i < 12; i++) {
    const top = () => terminal.screen().slice(0, 9).join('\n'), previous = top();
    terminal.send(back ? '\x1b[6~' : '\x1b[5~');
    // Observe emulator output only: a host frame fence could refresh a stale card before the assertion.
    await until(async () => { await terminal.queue; terminal.health(); return !terminal.rendering && top() !== previous; }, `${label}: Pi scrolled`);
    const shot = terminal.captureScreen(`${label}-${i}`, {});
    if (back ? shot.screen.some(line => line.includes(marker)) : aboveTarget(shot.screen)) return shot;
  }
  assert.fail(`physical ${back ? 'PageDown' : 'PageUp'} did not ${back ? 'restore' : 'hide'} target`);
}

test('a restored Bash card keeps its accepted string colors on repeated scroll and resize after parser eviction', { timeout: 120000 }, async () => {
  const directory = mkdtempSync(resolve('.test-artifacts/return-history-')), session = history(directory), saved = readFileSync(session);
  const terminal = new PiTerminal('return-after-parser-pressure', { mode: 'fullscreen', session, dimensions: { columns: 100, rows: 16 },
    extensions: [extension], extraEnv: { ...descriptor, TIDY_UI_TEST_PALETTE_OBSERVE: '1' } });
  try {
    await terminal.ready(); await terminal.resize(100, 16); await syntaxReady(terminal); await chooseTheme(terminal, palette);
    const initial = await terminal.captureSettled('before-eviction');
    const expression = semanticStyle(terminal.events(), marker, undefined, 'bash')?.expression;
    assert.equal(expression?.foreground.kind, 'binding');
    const expected = Array(marker.length).fill(expressionForeground(expression, {}, palette, 'toolTitle'));
    assert.deepEqual(ink(initial), expected);
    await page(terminal, false, 'hide');
    writeFileSync(join(terminal.output, 'pressure-go'), 'go');
    const pressure = await until(() => { terminal.health(); return readPendingJson(join(terminal.output, 'pressure-result.json')); }, 'target pressure receipt');
    assert.equal(pressure.error, undefined);
    assert.ok(pressure.releases.some(r => r.generation === pressure.generation && r.reason === 'pressure' && r.retainedBytes > 0));
    assert.equal(pressure.after?.version, pressure.version); assert.equal(pressure.after?.generation, undefined);
    assert.equal(pressure.budget.outstandingPeakBytes, 0);
    const hidden = await terminal.captureSettled('after-eviction');
    assert.ok(aboveTarget(hidden.screen), 'an older command is visible; neither the target nor its preceding user message is on screen');
    const counts = requests(initial);
    assert.deepEqual(requests(hidden), counts, 'pressure itself did not admit parser or style work');
    const observed = [];
    for (const phase of ['first-return', 'second-return']) {
      const natural = await page(terminal, true, phase);
      observed.push([`${phase} before frame fence`, ink(natural)]);
      const shown = await terminal.captureSettled(phase);
      observed.push([phase, ink(shown)]);
      assert.deepEqual(requests(shown), counts, `${phase} requested no SOURCE/STYLE work`);
      if (phase === 'first-return') await page(terminal, false, 'hide-again');
    }
    await terminal.resize(84, 16);
    const resized = await terminal.captureSettled('resized');
    observed.push(['resized', ink(resized)]); assert.deepEqual(requests(resized), counts);
    await terminal.observeAnimation();
    const idle = await terminal.captureSettled('at-rest');
    observed.push(['at-rest', ink(idle)]); assert.deepEqual(requests(idle), counts);
    assert.equal(traffic(terminal).length, 0); assert.ok(readFileSync(session).equals(saved));
    await finish(terminal);
    for (const [phase, colors] of observed) assert.deepEqual(colors, expected, `${phase}: all returned letters retain their accepted color`);
  } finally { try { await closeTerminals([terminal]); } finally { rmSync(directory, { recursive: true, force: true }); } }
});
