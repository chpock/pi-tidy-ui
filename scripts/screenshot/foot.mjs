import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readInputs, toolPath } from '../test/context.mjs';

export const windowRule = (enabled, monitor) => enabled ? `
  _G.__pi_tidy_ui_screenshot_rule = hl.window_rule({
    name = "pi-tidy-ui-screenshot", match = { class = "^pi-tidy-ui-screenshot-.*$" },
    float = true, no_anim = true, no_dim = true, render_unfocused = true,
    monitor = ${JSON.stringify(monitor)}, move = { 0, 0 },
  })
` : 'if _G.__pi_tidy_ui_screenshot_rule then _G.__pi_tidy_ui_screenshot_rule:set_enabled(false) end';

export function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('grim did not produce a PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('Invalid PNG dimensions');
  return { width, height };
}

export async function renderFoot(output, inputs = readInputs()) {
  const preview = JSON.parse(readFileSync(join(output, 'preview.json'), 'utf8'));
  const appId = 'pi-tidy-ui-screenshot-' + randomUUID();
  const hypr = args => execFileSync(toolPath('hyprctl', inputs), args, { encoding: 'utf8', timeout: 10000 });
  const monitors = JSON.parse(hypr(['-j', 'monitors']));
  const monitor = monitors.find(m => m.scale === 1) ?? monitors.find(m => m.focused);
  if (!monitor) throw new Error('No active screenshot monitor');
  const rule = enabled => {
    const result = hypr(['eval', windowRule(enabled, monitor.name)]).trim();
    if (result !== 'ok') throw new Error('Cannot configure the screenshot-only floating rule: ' + result);
  };
  const log = openSync(join(output, 'foot.log'), 'wx', 0o600);
  let child, exited, ruleEnabled = false;
  const wait = async (predicate, label) => {
    for (const end = Date.now() + 15000; Date.now() < end;) {
      if (exited) throw new Error(`foot exited while ${label}: ${JSON.stringify(exited)}; see foot.log`);
      const value = predicate(); if (value) return value;
      await delay(50);
    }
    throw new Error('Timed out: ' + label);
  };
  const read = name => existsSync(join(output, name)) && JSON.parse(readFileSync(join(output, name), 'utf8'));
  try {
    rule(true); ruleEnabled = true;
    child = spawn(toolPath('foot', inputs), [
      '--config', join(import.meta.dirname, 'foot.ini'), '--app-id', appId,
      '--title', 'pi-tidy-ui screenshot', '--log-level', 'info',
      '--window-size-chars', `${preview.dimensions.columns}x${preview.dimensions.rows}`,
      toolPath('python3', inputs), '-I', '-S', join(import.meta.dirname, 'replay.py'), output,
    ], { stdio: ['ignore', 'ignore', log] });
    const closed = new Promise(resolve => {
      child.once('error', error => { exited = { error: error.message }; resolve(exited); });
      child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited); });
    });
    child.closedResult = closed;
    const ownWindow = () => JSON.parse(hypr(['-j', 'clients'])).find(w => w.class === appId && w.mapped);
    let window = await wait(ownWindow, 'waiting for the foot window');
    if (typeof window.stableId !== 'string' || !window.stableId) throw new Error('Hyprland does not expose a stable toplevel identifier');
    writeFileSync(join(output, 'foot-start'), 'start\n', { flag: 'wx' });
    const metrics = await wait(() => read('foot-metrics.json'), 'waiting for the native font metrics');
    if (!Number.isInteger(metrics.cellWidth) || metrics.cellWidth <= 0 || !Number.isInteger(metrics.cellHeight) || metrics.cellHeight <= 0) throw new Error('Invalid foot cell metrics');
    window = ownWindow();
    const scale = Math.ceil(monitor.scale);
    if (metrics.columns !== preview.dimensions.columns || metrics.rows !== preview.dimensions.rows) {
      const width = Math.ceil(window.size[0] + (preview.dimensions.columns - metrics.columns) * metrics.cellWidth / scale);
      const height = Math.ceil(window.size[1] + (preview.dimensions.rows - metrics.rows) * metrics.cellHeight / scale);
      const result = hypr(['eval', `hl.dispatch(hl.dsp.window.resize({ x = ${width}, y = ${height}, relative = false, window = ${JSON.stringify('address:' + window.address)} }))`]).trim();
      if (result !== 'ok') throw new Error('Cannot size the screenshot window: ' + result);
    }
    await wait(() => { const value = read('foot-size.json'); return value && value.columns === preview.dimensions.columns && value.rows === preview.dimensions.rows; }, 'waiting for the requested terminal grid');
    writeFileSync(join(output, 'foot-paint'), 'paint\n', { flag: 'wx' });
    const ready = await wait(() => read('foot-ready.json'), 'waiting for foot to parse the complete ANSI frame');
    assert.equal(ready.columns, preview.dimensions.columns); assert.equal(ready.rows, preview.dimensions.rows);
    execFileSync(toolPath('grim', inputs), ['-T', window.stableId, join(output, 'preview.png')], { stdio: 'inherit', timeout: 15000 });
    const dimensions = pngDimensions(readFileSync(join(output, 'preview.png')));
    writeFileSync(join(output, 'preview.json'), JSON.stringify({ ...preview, ...dimensions,
      renderer: 'foot', capture: 'grim-toplevel', font: 'Cousine Nerd Font Mono:size=12',
      terminalPixels: ready, cellMetrics: metrics, monitor: { name: monitor.name, scale: monitor.scale }, appId, toplevel: window.stableId,
    }, null, 2) + '\n');
    console.log('Screenshot: ' + join(output, 'preview.png'));
  } finally {
    try {
      if (child) {
        writeFileSync(join(output, 'foot-stop'), 'stop\n');
        const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
        try { await child.closedResult; } finally { clearTimeout(timer); }
      }
    } finally {
      closeSync(log);
      if (ruleEnabled) rule(false);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await renderFoot(process.argv[2]);
