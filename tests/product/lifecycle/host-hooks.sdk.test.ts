import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Spacer } from '@earendil-works/pi-tui';
import { UserMessageComponent } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { initTheme } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { Container, CustomEditor, Tool, color, editorSetup, installTidyUi } from '../../fixtures/sdk-contract-support.ts';

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
