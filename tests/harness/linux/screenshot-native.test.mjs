import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { childEnv, digest, readInputs } from '../../../scripts/test/context.mjs';
import { renderFoot } from '../../../scripts/screenshot/foot.mjs';

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-tools-')), output = join(root, 'output'), groups = [];
  mkdirSync(output);
  writeFileSync(join(root, 'control.json'), JSON.stringify({ mode, output }));
  writeFileSync(join(output, 'preview.json'), JSON.stringify({ dimensions: { columns: 160, rows: 104 } }));
  const actor = fileURLToPath(new URL('../../fixtures/screenshot-tools.mjs', import.meta.url));
  const tools = Object.fromEntries(['foot', 'grim', 'hyprctl', 'python3', 'fc-match', 'rg', 'fd', 'bwrap'].map(name => {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\nimport { runTool } from ${JSON.stringify(actor)};\nawait runTool(${JSON.stringify(name)}, ${JSON.stringify(root)});\n`, { mode: 0o755 });
    return [name, path];
  }));
  const inputs = { ...readInputs(), tools: { ...readInputs().tools, ...tools } };
  const native = join(root, 'inert-native'); writeFileSync(native, 'not executed: orchestration fixture only');
  const bytes = readFileSync(native);
  inputs.native = { path: native, commit: inputs.source.commit, nativeTree: inputs.source.nativeTree, bytes: bytes.length, sha256: digest(bytes) };
  const inputPath = join(root, 'inputs.json'); writeFileSync(inputPath, JSON.stringify(inputs));
  const journal = () => readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  t.after(async () => {
    for (const child of groups) {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await child.closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, output, inputs, inputPath, journal, groups };
}

for (const mode of ['success', 'grim-failure', 'wrong-grid', 'missing-ack']) {
  test(`native screenshot orchestration with inert tools: ${mode}`, { timeout: 30000 }, async t => {
    const f = fixture(t, mode);
    if (mode === 'success') {
      await renderFoot(f.output, f.inputs);
      const preview = JSON.parse(readFileSync(join(f.output, 'preview.json'), 'utf8'));
      assert.equal(preview.renderer, 'foot'); assert.equal(preview.capture, 'grim-toplevel');
      assert.equal(preview.toplevel, 'fixture-owned-toplevel');
    } else await assert.rejects(renderFoot(f.output, f.inputs));
    const journal = f.journal(), captures = journal.filter(row => row.tool === 'grim');
    if (mode === 'success' || mode === 'grim-failure') {
      assert.equal(captures.length, 1);
      assert.deepEqual(captures[0].args, ['-T', 'fixture-owned-toplevel', join(f.output, 'preview.png')]);
    } else assert.equal(captures.length, 0, 'no grid/ack means no capture');
    if (mode !== 'success') assert.equal(existsSync(join(f.output, 'preview.png')), false);
    const stopped = journal.findIndex(row => row.tool === 'foot' && ['stopped', 'no-ack'].includes(row.event));
    const disabled = journal.findIndex(row => row.rule === 'disabled');
    assert.ok(stopped >= 0 && disabled > stopped, 'stop the owned renderer before disabling its rule');
    assert.equal(journal.filter(row => row.rule === 'enabled').length, 1);
    assert.equal(journal.filter(row => row.rule === 'disabled').length, 1);
  });
}

function launchOwner(f, marker) {
  const env = childEnv(join(f.root, 'owner'), { XDG_RUNTIME_DIR: join(f.root, 'wayland'), WAYLAND_DISPLAY: 'fixture-only', HYPRLAND_INSTANCE_SIGNATURE: 'fixture-only' }, f.inputs);
  const child = spawn(f.inputs.node.path, [join(f.inputs.pi.root, 'scripts/screenshot/run.mjs'), '--inputs', f.inputPath, '--output', join(f.root, 'owner-output')],
    { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.groups.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-16384); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384); });
  child.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inert graphical supervisor did not start')), 10000);
    const check = () => { if (stdout.includes(marker)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); if (!stdout.includes(marker)) reject(new Error('Owner exited before the inert supervisor started: ' + stderr)); });
  });
  return { child, ready, closed: child.closed };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`screenshot owner forwards ${signal}, awaits the supervisor and cleans only its runtime`, { timeout: 30000 }, async t => {
    const f = fixture(t, 'cancel'), owner = launchOwner(f, 'fixture-graphics-live');
    await owner.ready;
    const output = join(f.root, 'owner-output');
    const runtime = dirname(JSON.parse(readFileSync(join(output, 'foot-environment.json'), 'utf8')).HOME);
    assert.equal(existsSync(runtime), true);
    owner.child.kill(signal);
    const result = await owner.closed;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp('Screenshot interrupted by ' + signal));
    assert.equal(existsSync(runtime), false);
    assert.equal(existsSync(f.inputs.pi.root), true);
    const journal = f.journal(), stopped = journal.findIndex(row => row.event === 'supervisor-stopped');
    assert.ok(stopped >= 0);
    assert.equal(journal[stopped].signal, signal);
    assert.ok(journal.findIndex(row => row.rule === 'disabled') > stopped, 'the supervisor closes before compositor cleanup');
    assert.equal(journal.some(row => row.tool === 'foot' || row.tool === 'grim'), false, 'the cancellation control never opens a real window');
  });
}
