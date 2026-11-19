import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Spacer, type Component } from '@earendil-works/pi-tui';
import { UserMessageComponent } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { initTheme } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import type { DiagnosticSink, RuntimeEvent } from '../../../src/diagnostics.ts';
import { Container, CustomEditor, Root, Tool, color, editorSetup, installTidyUi } from '../../fixtures/sdk-contract-support.ts';

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

test('late user hook-publication exception rolls back methods that were already written', () => {
  initTheme('dark', false);
  const user = new UserMessageComponent('PRESERVED_USER_TEXT');
  const nativeRows = user.render(80);
  const root = new Root(), prototype = UserMessageComponent.prototype;
  const originalRender = Object.getOwnPropertyDescriptor(prototype, 'render')!;
  const originals = ['render', 'rebuild', 'setOutputPad', 'invalidate'].map(name =>
    ({ name, descriptor: Object.getOwnPropertyDescriptor(prototype, name) }));
  const observed = observeAdmission();
  const define = Object.defineProperty;
  let renderWrites = 0, renderWritesAtFault = 0, faults = 0;
  const controller = installTidyUi(root, () => color, observed.options);
  try {
    assert.equal(controller.active, true);
    assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(prototype, 'render'), originalRender), true);
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
    Object.defineProperty = define;
    assert.equal(faults, 1);
    assert.equal(renderWritesAtFault, 1, 'a render hook was published before the fault');
    assert.equal(root.children.length === 1 && root.children[0] === user, true);
    assertAddedWithoutError(error, controller.active);
    assertAdmissionFailure(controller, observed);
    for (const { name, descriptor } of originals)
      assert.equal(sameDescriptor(Object.getOwnPropertyDescriptor(prototype, name), descriptor), true, `exact prior ${name} descriptor`);
    assert.deepEqual(user.render(80), nativeRows);
  } finally {
    Object.defineProperty = define;
    controller.restore();
  }
});

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
