import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { installPerformanceObserver } from '../../fixtures/performance-observer.mjs';
import { instrumentPerformanceLayout, planPerformanceLayout } from '../../fixtures/performance-layout-plan.mjs';
import { readInputs } from '../../../scripts/test/context.mjs';

const key = Symbol.for('pi-tidy-ui.performance.observer');
test('performance observer: completed frames include actual root/layout work without per-frame receipts', async () => {
  class Mode { mountInteractiveTui() {} getUserInput() {} }
  const output = [];
  const bridge = installPerformanceObserver(Mode);
  const tui = { stopped: false, terminal: { write(data) { output.push(data); } },
    render() {}, doRender() { this.render(); bridge.layout(); this.terminal.write('x'); },
    requestRender() { setImmediate(() => this.doRender()); }, addInputListener() {} };
  try {
    const mode = new Mode(); mode.mountInteractiveTui(tui); mode.getUserInput();
    await bridge.frame(); await turn();
    const packets = output.filter(value => value.includes('tidy-test;')).length;
    bridge.observe(true); await bridge.frames(3); bridge.observe(false); await turn();
    assert.deepEqual(bridge.counts(), { nativeRequests: 4, forcedRequests: 0, nativeCalls: 4, rootRenders: 4, layoutPasses: 4, terminalWrites: 3, terminalBytes: 3 });
    assert.equal(packets, 1); assert.equal(output.filter(value => value.includes('tidy-test;')).length, packets);
    assert.throws(() => installPerformanceObserver(Mode), /Duplicate/);
  } finally { delete globalThis[key]; }
});

test('performance observer: planned fullscreen layout instrumentation is exact-source guarded', async () => {
  const plan = planPerformanceLayout(readInputs()); assert.match(plan.module, /^file:/); assert.match(plan.marker, /function renderLayoutFrame\(/); assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  const source = 'export function renderLayoutFrame(root, width, height, requestRender) { return [root, width, height]; }';
  const fixture = { marker: 'export function renderLayoutFrame(root, width, height, requestRender) {', sha256: createHash('sha256').update(source).digest('hex') };
  const rewritten = instrumentPerformanceLayout(source, fixture); let calls = 0;
  globalThis[key] = { layout() { calls++; } };
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`);
    assert.deepEqual(module.renderLayoutFrame('root', 100, 40, () => {}), ['root', 100, 40]); assert.equal(calls, 1);
    assert.throws(() => instrumentPerformanceLayout(source + '\n', fixture), /changed/);
    assert.throws(() => instrumentPerformanceLayout(source, { ...fixture, marker: '' }), /changed/);
    const doubled = source + source;
    assert.throws(() => instrumentPerformanceLayout(doubled, { ...fixture, sha256: createHash('sha256').update(doubled).digest('hex') }), /changed/);
  } finally { delete globalThis[key]; }
});

test('performance observer: actual coalesced/forced requests stay distinct from completion and can be calibrated without wrappers', async () => {
  class Mode { mountInteractiveTui() {} getUserInput() {} }
  const bridge = installPerformanceObserver(Mode); let scheduled = false, rendered = 0;
  const tui = { stopped: false, terminal: { write() {} }, render() { rendered++; },
    doRender() { this.render(); }, addInputListener() {},
    requestRender() { if (!scheduled) { scheduled = true; setImmediate(() => { scheduled = false; this.doRender(); }); } } };
  try {
    new Mode().mountInteractiveTui(tui);
    tui.requestRender(); tui.requestRender(true); tui.requestRender(); await turn();
    assert.equal(bridge.counts().nativeRequests, 3); assert.equal(bridge.counts().forcedRequests, 1);
    assert.equal(bridge.counts().nativeCalls, 1); assert.equal(rendered, 1);
    bridge.instrument(false); tui.doRender(); assert.equal(rendered, 2); assert.equal(bridge.counts().nativeCalls, 1);
    bridge.instrument(true); tui.doRender(); assert.equal(rendered, 3); assert.equal(bridge.counts().nativeCalls, 2);
  } finally { delete globalThis[key]; }
});
