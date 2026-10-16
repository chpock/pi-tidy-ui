import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Container } from '@earendil-works/pi-tui';
import { installTidyUi } from '../../../src/index.ts';

const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/components/tool-execution.js')).href);
const themes = await import(pathToFileURL(resolve(sdkDist, 'modes/interactive/theme/theme.js')).href);
themes.initTheme('dark', false);

class UI extends Container {
  requests = 0;
  requestRender() { this.requests++; }
}

test('public args finalization invalidates one owned layout without starting execution or another redraw', () => {
  const ui = new UI();
  const args = { path: '/tmp/a' };
  const tool = new ToolExecutionComponent('probe', 'g3-finalize', args, undefined, undefined, ui, '/tmp');
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tool), 'setArgsComplete');
  ui.addChild(tool);
  const adapter = installTidyUi(ui, () => themes.theme);
  try {
    assert.equal(adapter.active, true, adapter.reason);
    const rows = tool.render(60);
    const before = adapter.cacheStats();
    const renders = ui.requests;
    assert.equal(before.builds, 1);
    assert.equal(before.entries, 1);
    assert.equal(tool.getRenderContext().argsComplete, false);
    assert.equal(tool.executionStarted, false);

    tool.setArgsComplete();
    // Read only primitive context fields: its invalidate callback owns the tool.
    assert.equal(tool.getRenderContext().argsComplete, true);
    assert.equal(tool.executionStarted, false);
    assert.equal(tool.isPartial, true);
    assert.equal(tool.args, args);
    assert.equal(ui.requests, renders + 1, 'the original method is the only redraw requester');
    assert.equal(adapter.cacheStats().entries, 0, 'argument finalization retires the pre-finalization frame');
    assert.deepEqual(tool.render(60), rows, 'finalization does not change the visible command or summary');
    assert.equal(adapter.cacheStats().builds, before.builds + 1);
    assert.equal(adapter.cacheStats().releases, before.releases + 1);
  } finally { adapter.restore(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tool), 'setArgsComplete'), original);
});

test('an unobservable optional finalization method does not disable existing tool presentation', () => {
  const ui = new UI();
  const tool = new ToolExecutionComponent('probe', 'g3-foreign-finalize', { path: '/tmp/a' }, undefined, undefined, ui, '/tmp');
  const prototype = Object.getPrototypeOf(tool);
  const original = Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete')!;
  const foreign = { ...original, writable: false };
  Object.defineProperty(prototype, 'setArgsComplete', foreign);
  const adapter = installTidyUi(ui, () => themes.theme);
  try {
    assert.equal(adapter.active, true, adapter.reason);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete'), foreign);
    ui.addChild(tool);
    tool.render(60);
    assert.equal(adapter.cacheStats().builds, 1);
    const requests = ui.requests;
    tool.setArgsComplete();
    assert.equal(tool.getRenderContext().argsComplete, true);
    assert.equal(ui.requests, requests + 1);
  } finally {
    adapter.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete'), foreign);
    Object.defineProperty(prototype, 'setArgsComplete', original);
  }
});

test('restoration preserves a later owner of the public finalization method', () => {
  const ui = new UI();
  const tool = new ToolExecutionComponent('probe', 'g3-later-finalize', { path: '/tmp/a' }, undefined, undefined, ui, '/tmp');
  const prototype = Object.getPrototypeOf(tool);
  const original = Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete')!;
  ui.addChild(tool);
  const adapter = installTidyUi(ui, () => themes.theme);
  const later = { ...original, value: function (this: unknown, ...args: unknown[]) { return original.value.apply(this, args); } };
  try {
    assert.equal(adapter.active, true, adapter.reason);
    assert.notEqual(prototype.setArgsComplete, original.value);
    Object.defineProperty(prototype, 'setArgsComplete', later);
    adapter.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete'), later);
    const requests = ui.requests;
    tool.setArgsComplete();
    assert.equal(tool.getRenderContext().argsComplete, true);
    assert.equal(ui.requests, requests + 1);
  } finally {
    adapter.restore();
    Object.defineProperty(prototype, 'setArgsComplete', original);
  }
});

test('an optional accessor is not invoked or replaced during tool installation', () => {
  const ui = new UI();
  const tool = new ToolExecutionComponent('probe', 'g3-accessor-finalize', { path: '/tmp/a' }, undefined, undefined, ui, '/tmp');
  const prototype = Object.getPrototypeOf(tool);
  const original = Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete')!;
  let reads = 0;
  const foreign = { configurable: true, enumerable: false, set: undefined, get() { reads++; throw new Error('foreign finalization accessor'); } };
  Object.defineProperty(prototype, 'setArgsComplete', foreign);
  const adapter = installTidyUi(ui, () => themes.theme);
  try {
    assert.equal(adapter.active, true, adapter.reason);
    assert.equal(reads, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete'), foreign);
    ui.addChild(tool);
    assert.equal(adapter.active, true, adapter.reason);
    tool.render(60);
    assert.equal(adapter.cacheStats().builds, 1);
  } finally {
    adapter.restore();
    Object.defineProperty(prototype, 'setArgsComplete', original);
  }
  assert.equal(reads, 0);
});


test('public finalization wrapper preserves a decorated setter return value and its exact descriptor', () => {
  const ui = new UI();
  const tool = new ToolExecutionComponent('probe', 'g3-finalize-return', { path: '/tmp/a' }, undefined, undefined, ui, '/tmp');
  const prototype = Object.getPrototypeOf(tool);
  const original = Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete')!;
  const token = Symbol('setter return');
  const decorated = { ...original, enumerable: true, value: function (this: unknown, ...args: unknown[]) {
    original.value.apply(this, args); return token;
  } };
  Object.defineProperty(prototype, 'setArgsComplete', decorated);
  ui.addChild(tool);
  const adapter = installTidyUi(ui, () => themes.theme);
  try {
    assert.equal(adapter.active, true, adapter.reason);
    const requests = ui.requests;
    assert.equal(tool.setArgsComplete(), token);
    assert.equal(ui.requests, requests + 1);
    assert.equal(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete')!.enumerable, true);
    adapter.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'setArgsComplete'), decorated);
  } finally { adapter.restore(); Object.defineProperty(prototype, 'setArgsComplete', original); }
});
