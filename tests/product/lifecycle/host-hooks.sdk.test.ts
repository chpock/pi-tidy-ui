import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Spacer, type Component } from '@earendil-works/pi-tui';
import { UserMessageComponent } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { initTheme } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import type { DiagnosticSink, RuntimeEvent } from '../../../src/diagnostics.ts';
import type { ProviderTransport } from '../../../src/occipital/provider.ts';
import { Container, CustomEditor, Root, Tool, color, editorSetup, extensionHarness, installTidyUi } from '../../fixtures/sdk-contract-support.ts';
import { semanticDescriptor } from '../../fixtures/semantic-provider.ts';
import { menuPage, setAppearance } from '../../helpers/menu-driver.ts';

const families = [
  { prototype: Container.prototype, names: ['addChild', 'clear', 'removeChild', 'render'] },
  { prototype: Spacer.prototype, names: ['render'] },
  { prototype: Tool.prototype, names: ['render', 'handleMouse', 'updateArgs', 'updateResult', 'setExpanded', 'invalidate', 'markExecutionStarted'] },
  { prototype: UserMessageComponent.prototype, names: ['render', 'rebuild', 'setOutputPad', 'invalidate'] },
  { prototype: CustomEditor.prototype, names: ['render', 'handleMouse', 'renderTopBorder', 'renderBottomBorder'] },
];
const descriptorKeys = ['configurable', 'enumerable', 'writable', 'value', 'get', 'set'] as const;
function sameDescriptor(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return descriptorKeys.every(key => Object.hasOwn(actual, key) === Object.hasOwn(expected, key) && actual[key] === expected[key]);
}

for (const fault of [
  { label: 'tool lifecycle', prototype: Tool.prototype, name: 'markExecutionStarted' },
  { label: 'user lifecycle', prototype: UserMessageComponent.prototype, name: 'setOutputPad' },
  { label: 'editor border', prototype: CustomEditor.prototype, name: 'renderBottomBorder' },
  { label: 'shared container render', prototype: Container.prototype, name: 'render' },
]) {
  test(`partial ${fault.label} installation restores all earlier native hook families`, () => {
    initTheme('dark', false);
    const { root, editor } = editorSetup(1);
    root.addChild(new Tool('foreign-tool'));
    root.addChild(new UserMessageComponent('PRESERVED_USER_TEXT'));
    editor.handleInput('\x1b[200~' + 'PRESERVED_界_'.repeat(40) + '\x1b[201~');
    editor.handleInput('\x1b[D');
    const draft = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
    const nativeRows = root.render(80);
    const placement = Object.getOwnPropertyDescriptor(editor, 'embedWorkingStatus');
    const setter = Object.getOwnPropertyDescriptor(editor, 'setText');
    const originals = families.flatMap(({ prototype, names }) => names.map(name => ({ prototype, name,
      descriptor: Object.getOwnPropertyDescriptor(prototype, name) })));
    const define = Object.defineProperty;
    let faults = 0, publications = 0;
    let controller: ReturnType<typeof installTidyUi> | undefined;
    try {
      Object.defineProperty = ((target: object, name: PropertyKey, descriptor: PropertyDescriptor) => {
        if (target === fault.prototype && name === fault.name && faults === 0) {
          faults++;
          throw new Error('Native hook publication failed');
        }
        const prior = originals.find(entry => entry.prototype === target && entry.name === name);
        if (prior && typeof descriptor.value === 'function' && descriptor.value !== prior.descriptor?.value) publications++;
        return define(target, name, descriptor);
      }) as typeof Object.defineProperty;
      controller = installTidyUi(root, () => color, { editorStatus: true });
      Object.defineProperty = define;
      assert.equal(faults, 1, 'the selected publication boundary was actually reached');
      assert.ok(publications > 0, 'the fault followed real hook writes rather than preflight rejection');
      assert.equal(controller.active, false);
      for (const { prototype, name, descriptor } of originals)
        assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(prototype, name), descriptor), true, `exact prior ${name} descriptor`);
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(editor, 'embedWorkingStatus'), placement), true);
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(editor, 'setText'), setter), true);
      assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, draft);
      assert.deepEqual(root.render(80), nativeRows);
      controller.restore();
      assert.equal(controller.active, false, 'restoring a failed installation is idempotent');
    } finally {
      Object.defineProperty = define;
      controller?.restore();
      for (const { prototype, name, descriptor } of originals) {
        if (descriptor) define(prototype, name, descriptor); else Reflect.deleteProperty(prototype, name);
      }
      if (placement) define(editor, 'embedWorkingStatus', placement);
      if (setter) define(editor, 'setText', setter); else Reflect.deleteProperty(editor, 'setText');
    }
  });
}

function watchNativeAdd(child: Component, beforeAdd: (receiver: Container) => void) {
  const prototype = Container.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'addChild')!;
  const native = prototype.addChild;
  const probe = { ...original, value(this: Container, added: Component) {
    if (added === child) beforeAdd(this);
    return native.call(this, added);
  } };
  Object.defineProperty(prototype, 'addChild', probe);
  return { probe, restore: () => Object.defineProperty(prototype, 'addChild', original) };
}

function addError(parent: Container, child: Component): { thrown: unknown } | undefined {
  try { parent.addChild(child); }
  catch (thrown) { return { thrown }; }
  return undefined;
}

function assertAddedWithoutError(error: ReturnType<typeof addError>, active: boolean): void {
  if (error) {
    const cause = error.thrown instanceof Error ? error.thrown.stack : 'non-Error exception';
    assert.fail(`addChild threw after attaching the child (adapter active: ${active}):\n${cause}`);
  }
}

function observeAdmission() {
  const warnings: string[] = [], failures: Extract<RuntimeEvent, { kind: 'failure' }>[] = [];
  const diagnostic: DiagnosticSink = () => {};
  diagnostic.runtime = event => { if (event.kind === 'failure') failures.push(event); };
  const warn = (message: string) => { warnings.push(message); };
  return { warnings, failures, options: { diagnostic, warn } };
}

type Controller = ReturnType<typeof installTidyUi>;
function assertAdmissionFailure(controller: Controller, observed: ReturnType<typeof observeAdmission>): void {
  const reason = 'pi-tidy-ui could not install its UI hooks; native rendering restored';
  assert.equal(controller.active, false);
  assert.equal(controller.reason, reason);
  assert.deepEqual(observed.warnings, [reason]);
  assert.equal(observed.failures.length, 1);
  const failure = observed.failures[0]!;
  assert.equal(failure.scope === controller, true);
  assert.equal(failure.operation, 'appearance');
  assert.equal(failure.area, 'appearance');
  assert.equal(failure.code, 'unsupported_host');
}

test('late tool update-hook rejection retains the native subtree and restores the active installation', () => {
  const toolRender = Object.getOwnPropertyDescriptor(Tool.prototype, 'render')!;
  const updateArgs = Object.getOwnPropertyDescriptor(Tool.prototype, 'updateArgs')!;
  const containerRender = Object.getOwnPropertyDescriptor(Container.prototype, 'render');
  class UnwrappableTool extends Tool {}
  const unwrappable = { ...updateArgs, writable: false };
  Object.defineProperties(UnwrappableTool.prototype, {
    render: toolRender, handleMouse: Object.getOwnPropertyDescriptor(Tool.prototype, 'handleMouse')!, updateArgs: unwrappable,
  });
  const root = new Root(), sibling = new Container(), subtree = new Container();
  const normal = new Tool(), leaf = new UnwrappableTool();
  const nativeRows = normal.render(80);
  root.addChild(sibling);
  subtree.addChild(leaf);
  let calls = 0, correctReceiver = false;
  const add = watchNativeAdd(subtree, receiver => { calls++; correctReceiver = receiver === root; });
  const observed = observeAdmission();
  let controller: Controller | undefined;
  try {
    controller = installTidyUi(root, () => color, observed.options);
    assert.equal(controller.active, true);
    root.addChild(normal);
    assert.equal(root.children.length, 2);
    assert.equal(root.children[1] === normal, true);
    assert.equal(normal.render(80).at(-1), ' → read a.txt');
    assert.equal(controller.active, true);
    assert.equal(observed.warnings.length + observed.failures.length, 0);

    const start = root.children.length;
    const error = addError(root, subtree);
    assert.equal(calls, 1);
    assert.equal(correctReceiver, true);
    assert.equal(root.children.length, start + 1);
    assert.equal(root.children.filter(child => child === subtree).length, 1);
    assert.equal(root.children[start] === subtree && root.children[0] === sibling && root.children[1] === normal, true);
    assert.equal(subtree.children.length === 1 && subtree.children[0] === leaf, true);
    assertAddedWithoutError(error, controller.active);
    assertAdmissionFailure(controller, observed);
    assert.deepEqual(normal.render(80), nativeRows);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'addChild'), add.probe), true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'render'), containerRender), true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Tool.prototype, 'render'), toolRender), true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Tool.prototype, 'updateArgs'), updateArgs), true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(UnwrappableTool.prototype, 'updateArgs'), unwrappable), true);

    const next = new Tool();
    root.addChild(next);
    assert.equal(root.children.at(-1) === next, true);
    assert.deepEqual(next.render(80), nativeRows);
    controller.restore();
    controller.restore();
    assertAdmissionFailure(controller, observed);
  } finally {
    try { controller?.restore(); } finally { add.restore(); }
  }
});

function addUserWithPublicationFault(root: Container, user: UserMessageComponent) {
  const prototype = UserMessageComponent.prototype, define = Object.defineProperty;
  const originalRender = Object.getOwnPropertyDescriptor(prototype, 'render')!;
  let renderWrites = 0, renderWritesAtFault = 0, faults = 0;
  try {
    Object.defineProperty = ((target: object, name: PropertyKey, descriptor: PropertyDescriptor) => {
      if (target === prototype && name === 'setOutputPad' && faults === 0) {
        faults++;
        renderWritesAtFault = renderWrites;
        throw new Error('Injected late user setOutputPad publication fault');
      }
      const result = define(target, name, descriptor);
      if (target === prototype && name === 'render' && descriptor.value !== originalRender.value) renderWrites++;
      return result;
    }) as typeof Object.defineProperty;
    const error = addError(root, user);
    assert.equal(faults, 1);
    assert.equal(renderWritesAtFault, 1, 'a render hook was published before the fault');
    return error;
  } finally { Object.defineProperty = define; }
}

test('late user hook-publication exception rolls back methods that were already written', () => {
  initTheme('dark', false);
  const user = new UserMessageComponent('PRESERVED_USER_TEXT');
  const nativeRows = user.render(80);
  const root = new Root(), prototype = UserMessageComponent.prototype;
  const originals = ['render', 'rebuild', 'setOutputPad', 'invalidate'].map(name =>
    ({ name, descriptor: Object.getOwnPropertyDescriptor(prototype, name) }));
  const observed = observeAdmission();
  const controller = installTidyUi(root, () => color, observed.options);
  try {
    assert.equal(controller.active, true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(prototype, 'render'), originals[0]!.descriptor), true);
    const error = addUserWithPublicationFault(root, user);
    assert.equal(root.children.length === 1 && root.children[0] === user, true);
    assertAddedWithoutError(error, controller.active);
    assertAdmissionFailure(controller, observed);
    for (const { name, descriptor } of originals)
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(prototype, name), descriptor), true, `exact prior ${name} descriptor`);
    assert.deepEqual(user.render(80), nativeRows);
  } finally { controller.restore(); }
});

for (const phase of ['queued', 'describing', 'ready'] as const) {
  test(`entry late presentation failure retires a ${phase} highlighting activation`, async () => {
    initTheme('dark', false);
    const traffic = { factory: 0, describe: 0, close: 0 };
    const unexpected: string[] = [];
    let releaseDescribe: (() => void) | undefined, describeSignal: AbortSignal | undefined;
    let restoredWhenClosing: boolean | undefined;
    let finishClose!: () => void;
    const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
    const h = extensionHarness('tui', {}, () => ({ standaloneVersion: 'fixture', provider: {
      async tryShared(): Promise<ProviderTransport> {
        const first = ++traffic.factory === 1;
        let closed = false, end!: (reason: 'closed') => void;
        const ended = new Promise<'closed'>(resolve => { end = resolve; });
        return { ended, get endReason() { return closed ? 'closed' as const : undefined; }, async request(request, options) {
          if (request.op !== 'describe') { unexpected.push(request.op); throw new Error('unexpected data request'); }
          traffic.describe++;
          const reply = semanticDescriptor(request.ticket);
          if (first && phase === 'describing') {
            describeSignal = options?.signal;
            return new Promise(resolve => { releaseDescribe = () => resolve(reply); });
          }
          return reply;
        }, async close() {
          traffic.close++;
          if (first && phase === 'ready') {
            restoredWhenClosing = sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'addChild'), nativeAdd)
              && sameDescriptor(Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, 'render'), nativeRender);
            await closeGate;
          }
          closed = true; end('closed');
        } };
      },
      async acquireOwned() { unexpected.push('owned factory'); throw new Error('unexpected owned launch'); },
    } }));
    const settle = async () => { for (let i = 0; i < 5; i++) await turn(); };
    const user = new UserMessageComponent('NATIVE_AFTER_PRESENTATION_FAILURE');
    const nativeRows = user.render(80), terminal = h.root.terminal;
    const nativeAdd = Object.getOwnPropertyDescriptor(Container.prototype, 'addChild');
    const nativeRender = Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, 'render');
    const assertNative = () => {
      assert.equal(h.root.children.includes(user), true, 'the child added by Pi remains attached');
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'addChild'), nativeAdd), true);
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, 'render'), nativeRender), true);
      assert.deepEqual(user.render(80), nativeRows);
    };
    const fail = () => {
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'addChild'), nativeAdd), false);
      assertAddedWithoutError(addUserWithPublicationFault(h.root, user), false);
      assertNative();
    };
    const command = h.commands.get('tidy-ui')!.handler;
    const service = () => menuPage(command, h.ctx, ['Status & troubleshooting', 'Highlighting service details']);
    try {
      h.root.clear(); await h.ready;
      if (phase === 'queued') {
        // The capture factory already returned and attached; activation's microtask has not run.
        const widget = h.ctx.ui.setWidget;
        let injected = false;
        Object.assign(h.ctx.ui, { setWidget(name: string, factory: unknown, ...args: unknown[]) {
          Reflect.apply(widget, this, [name, factory, ...args]);
          if (!injected && name === 'pi-tidy-ui-capture' && factory === undefined) { injected = true; fail(); }
        } });
      }
      await h.events.get('session_start')!({ type: 'session_start', reason: 'startup' }, h.ctx); await settle();
      const opened = phase === 'queued' ? 0 : 1;
      assert.deepEqual(traffic, { factory: opened, describe: opened, close: 0 });
      if (phase === 'ready') assert.match(await service(), /Service: ready/u);
      if (phase !== 'queued') fail(); else assertNative();
      await settle();
      assert.equal(traffic.close, opened, 'failure itself releases the existing route or candidate');
      if (phase === 'ready') assert.equal(restoredWhenClosing, true, 'native methods are already restored when cleanup starts');
      if (phase === 'describing') {
        assert.equal(describeSignal?.aborted, true, 'a pending descriptor cannot publish into the failed presentation');
        assert.ok(releaseDescribe); releaseDescribe(); await settle();
      }
      terminal.stop(); terminal.start(); await settle();
      assertNative();
      assert.deepEqual(traffic, { factory: opened, describe: opened, close: opened }, 'native terminal return does not reacquire');
      assert.equal(h.notices.filter(message => message.includes('unsupported_host')).length, 1);
      const disabled = await service();
      assert.match(disabled, /Native highlighting: On/u, 'effective deactivation does not change the saved preference');
      assert.match(disabled, /Service: disabled \(disabled\)/u, 'no late reply publishes a provider into the failed installation');
      await setAppearance(command, h.ctx, true); await settle();
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(Container.prototype, 'addChild'), nativeAdd), false,
        'explicit reapply installs a new eligible presentation');
      if (phase === 'ready') assert.equal(traffic.factory, opened, 'new acquisition waits for the old route close');
      finishClose(); await settle();
      assert.deepEqual(traffic, { factory: opened + 1, describe: opened + 1, close: opened });
      terminal.stop(); await settle(); terminal.start(); await settle();
      assert.deepEqual(traffic, { factory: opened + 2, describe: opened + 2, close: opened + 1 },
        'ordinary terminal reentry still reacquires for an active installation');
      assert.deepEqual(unexpected, [], 'the UI lifecycle issues no data requests or owned launch in this fixture');
    } finally {
      releaseDescribe?.(); finishClose();
      await h.events.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, h.ctx);
    }
  });
}

test('an exception from the captured native add propagates without disabling the adapter', () => {
  const root = new Root(), normal = new Tool(), child = new Container();
  root.addChild(normal);
  const sentinel = new Error('Injected original addChild error');
  let calls = 0;
  const add = watchNativeAdd(child, () => { calls++; throw sentinel; });
  const observed = observeAdmission();
  let controller: Controller | undefined;
  try {
    controller = installTidyUi(root, () => color, observed.options);
    assert.equal(controller.active, true);
    assert.equal(normal.render(80).at(-1), ' → read a.txt');
    const error = addError(root, child);
    assert.equal(error?.thrown === sentinel, true);
    assert.equal(calls, 1);
    assert.equal(root.children.length === 1 && root.children[0] === normal, true);
    assert.equal(controller.active, true);
    assert.equal(controller.reason, undefined);
    assert.equal(observed.warnings.length + observed.failures.length, 0);
    assert.equal(normal.render(80).at(-1), ' → read a.txt');
  } finally {
    try { controller?.restore(); } finally { add.restore(); }
  }
});

test('a warning error from an already-recorded late compatibility failure still propagates', () => {
  const root = new Root(), child = new Tool();
  Object.defineProperty(child, 'expanded', { value: 'not-a-boolean' });
  const sentinel = new Error('Injected late compatibility warning error');
  let calls = 0;
  const controller = installTidyUi(root, () => color, { warn: () => { calls++; throw sentinel; } });
  try {
    assert.equal(controller.active, true);
    const error = addError(root, child);
    assert.equal(error?.thrown === sentinel, true);
    assert.equal(calls, 1);
    assert.equal(controller.active, false);
    assert.equal(controller.reason, 'Tool component contract is incompatible; native rendering retained');
    assert.equal(root.children.length === 1 && root.children[0] === child, true);
  } finally { controller.restore(); }
});
