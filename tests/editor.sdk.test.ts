import "./fixtures/test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { Editor, CURSOR_MARKER, Spacer, visibleWidth, truncateToWidth, colorToRgb, type Component } from "@earendil-works/pi-tui";
import { editorGeometry } from "../src/editor-card.ts";
import { editorPaint, editorPlain } from "./fixtures/editor-paint.ts";
import { renderEditorStatus } from "../src/editor-status.ts";
import { IdleStatus, StatusIndicator } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { initTheme, theme as nativeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { setAppearance } from "./helpers/menu-driver.ts";
import { Container, CustomEditor, Text, color, editorSetup, extensionHarness, installTidyUi, mouse, type ExtensionContext, type TidyUiOptions } from "./fixtures/sdk-contract-support.ts";

test("editor card uses configured exterior geometry without exchanging native state or caching input", () => {
  const nativeRender = Editor.prototype.render;
  for (const padding of [0, 1, 2, 3, 6]) {
    const { root, editor } = editorSetup(padding), originalInput = editor.handleInput;
    editor.setText("EDITOR_LINE\n  indented\n> literal");
    const before = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
    const controller = installTidyUi(root, () => color);
    try {
      for (const width of [100, 24, 12, 8, 7]) {
        const rows = editor.render(width), geometry = editorGeometry(width, padding);
        assert.ok(rows.every(row => visibleWidth(row) <= width), `editor fits width ${width}, native padding ${padding}`);
        if (geometry.contentWidth < 2) {
          assert.deepEqual(rows, nativeRender.call(editor, width), "impossible margins delegate to native actual width");
          continue;
        }
        assert.ok(rows.every(row => editorPlain(row)[geometry.panelX] === "┃"), "top/bottom padding and every text row share the stripe");
        assert.doesNotMatch(rows.map(editorPlain).join(""), /─/u);
        assert.equal(rows.filter(row => row.includes(CURSOR_MARKER)).length, 1);
        assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, before);
      }
      assert.equal(editor.handleInput, originalInput, "input implementation is never wrapped");
      assert.equal(controller.cacheStats().entries, 0, "draft rows never enter either transcript pool");
      assert.equal(controller.cacheStats().builds, 0);
    } finally { controller.restore(); }
    assert.match(editor.render(100).map(editorPlain).join(""), /─/u);
  }
});

test("editor card retains full-width hardware cursor in right internal padding", () => {
  for (const padding of [0, 1, 2, 3]) {
    const { root, editor } = editorSetup(padding);
    const controller = installTidyUi(root, () => color);
    try {
      const width = 24, geometry = editorGeometry(width, padding);
      editor.setText("x".repeat(geometry.contentWidth));
      const rows = editor.render(width), cursorRow = rows.find(row => row.includes(CURSOR_MARKER))!;
      assert.ok(cursorRow, "focused end cursor survives framing");
      assert.equal(visibleWidth(cursorRow.slice(0, cursorRow.indexOf(CURSOR_MARKER))), width - padding - 1);
      assert.equal(editorPlain(cursorRow).slice(geometry.contentX, width - padding - 1), editor.getText());
      assert.equal(visibleWidth(cursorRow), width);
      if (padding) assert.equal(editorPlain(cursorRow).slice(-padding), " ".repeat(padding), "cursor never consumes exterior margin");
    } finally { controller.restore(); }
  }
});

test("editor card keeps paste maps undo history shortcuts and nested text insertion on the same engine", () => {
  const { root, editor } = editorSetup(2), input = editor.handleInput;
  const paste = "PASTE_界é_".repeat(200);
  editor.handleInput("\x1b[200~" + paste + "\x1b[201~");
  editor.handleInput("\x1b[D");
  const text = editor.getText(), cursor = editor.getCursor();
  let controller = installTidyUi(root, () => color);
  try {
    editor.render(60); assert.equal(editor.getExpandedText(), paste);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), cursor);
    assert.equal(editor.handleInput, input);
    controller.restore(); editor.render(60);
    assert.equal(editor.getExpandedText(), paste); assert.deepEqual(editor.getCursor(), cursor);
    controller = installTidyUi(root, () => color); editor.render(24);
    assert.equal(editor.getExpandedText(), paste); assert.equal(editor.getText(), text);
    editor.insertTextAtCursor("PROGRAMMATIC_TEXT_INSERTION");
    editor.handleInput("\x1f");
    assert.equal(editor.getExpandedText(), paste, "native undo restores expanded paste, not marker text");
    editor.addToHistory("NATIVE_HISTORY"); editor.setText(""); editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "NATIVE_HISTORY");
  } finally { controller.restore(); }
});

test("editor card maps normalized clicks to native CJK combining and wrapped cursor positions", () => {
  const originalRender = Editor.prototype.render, originalMouse = Editor.prototype.handleMouse;
  for (const padding of [0, 1, 2, 3]) {
    const { root, editor, theme, keybindings } = editorSetup(padding);
    const control = new CustomEditor(root as never, theme, keybindings as never, { paddingX: padding });
    const value = "word 界é ".repeat(8);
    editor.setText(value); control.setText(value);
    const controller = installTidyUi(root, () => color);
    try {
      for (const width of [24, 60]) {
        const geometry = editorGeometry(width, padding), nativeWidth = geometry.contentWidth + (padding ? 2 * padding : 1);
        const actualRows = editor.render(width); originalRender.call(control, nativeWidth);
        for (const [x, y] of [[geometry.contentX, 1], [geometry.contentX + 7, 2], [width - padding - 1, actualRows.length - 2]]) {
          editor.handleMouse({ ...mouse(y!, width), x: x!, screenX: x!, height: actualRows.length });
          originalMouse.call(control, { ...mouse(y!, nativeWidth), x: x! - geometry.contentX + padding, height: actualRows.length });
          assert.deepEqual(editor.getCursor(), control.getCursor(), `cursor mapping padding ${padding} width ${width}`);
          assert.equal(editor.getText(), value);
        }
        for (const type of ["press", "drag", "release", "wheel"] as const)
          assert.equal(editor.handleMouse({ ...mouse(1, width), type }), undefined, "native selection/wheel authority is unchanged");
      }
    } finally { controller.restore(); }
  }
});

test("editor card preserves native status literals scroll indicators and border-color ownership", () => {
  const { root, editor } = editorSetup();
  const border = Object.getOwnPropertyDescriptor(editor, "borderColor");
  editor.setWorkingStatusIndicator({ renderInBorder: () => "RUN─STATUS", renderSpinnerInBorder: () => "S" } as never);
  editor.setText(Array.from({ length: 20 }, (_, i) => `EDITOR_SCROLL_${i}`).join("\n"));
  const controller = installTidyUi(root, () => color);
  try {
    const rows = editor.render(60).map(editorPlain);
    assert.ok(rows[0]!.includes("RUN─STATUS"), "native status is not an optional model information row");
    assert.match(rows[0]!, /↑ \d+ more/u);
    assert.equal(rows[0]!.replace("RUN─STATUS", "").includes("─"), false, "only known horizontal decoration is removed");
    assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "borderColor"), border);
    editor.handleInput("\x01"); for (let i = 0; i < 25; i++) editor.handleInput("\x1b[A");
    assert.match(editor.render(60).map(editorPlain).at(-1)!, /↓ \d+ more/u);
  } finally { controller.restore(); }
});

test("editor card leaves custom editors and later presentation owners native", () => {
  const { root, editor, theme, keybindings } = editorSetup();
  class AlternateEditor extends CustomEditor {}
  const alternate = new AlternateEditor(root as never, theme, keybindings as never);
  root.addChild(alternate);
  const native = alternate.render(60);
  const original = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "render");
  const controller = installTidyUi(root, () => color);
  try {
    assert.deepEqual(alternate.render(60), native, "inherited wrappers do not style a subclass");
    assert.match(editor.render(60).map(editorPlain).join(""), /┃/u);
    const later = () => ["LATER_EDITOR_OWNER"];
    Object.defineProperty(CustomEditor.prototype, "render", { configurable: true, writable: true, value: later });
    controller.restore(); assert.equal(CustomEditor.prototype.render, later);
  } finally {
    controller.restore();
    if (original) Object.defineProperty(CustomEditor.prototype, "render", original);
    else Reflect.deleteProperty(CustomEditor.prototype, "render");
  }
});

test("editor card keeps native autocomplete outside frame and routes its normalized click", async () => {
  const { root, editor } = editorSetup(2);
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({ items: [{ value: "/editor-result", label: "/editor-result", description: "NATIVE_MENU" }], prefix: "/ed" }),
    applyCompletion: () => ({ lines: ["/editor-result "], cursorLine: 0, cursorCol: 15 }),
  });
  const controller = installTidyUi(root, () => color);
  try {
    editor.handleInput("/ed"); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(editor.isShowingAutocomplete(), true);
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("NATIVE_MENU"));
    assert.ok(menu > 0);
    assert.equal(editorPlain(rows[menu]!).includes("┃"), false);
    assert.equal(editorPlain(rows[menu - 1]!)[2], "┃", "menu begins below bottom panel padding");
    assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
    assert.equal(editor.getText(), "/editor-result ");
    assert.equal(editor.isShowingAutocomplete(), false);
  } finally { controller.restore(); }
});

test("editor card skips unknown factory instance overrides and preexisting renderer owners", () => {
  for (const method of ["renderTopBorder", "renderBottomBorder", "handleMouse", "getPaddingX"] as const) {
    const { root, editor } = editorSetup();
    const original = (editor as unknown as Record<string, Function>)[method]!;
    Object.defineProperty(editor, method, { configurable: true, writable: true, value: function (this: CustomEditor, ...args: unknown[]) { return original.apply(this, args); } });
    const controller = installTidyUi(root, () => color);
    try { assert.doesNotMatch(editor.render(60).map(editorPlain).join(""), /┃/u, `instance ${method} override is not stock proof`); }
    finally { controller.restore(); }
  }
  const { root, editor } = editorSetup();
  const controller = installTidyUi(root, () => color, { nativeEditor: () => false });
  try { assert.doesNotMatch(editor.render(60).map(editorPlain).join(""), /┃/u, "a registered editor factory retains authority"); }
  finally { controller.restore(); }
  const previous = Object.getOwnPropertyDescriptor(CustomEditor.prototype, "render");
  const other = () => ["OTHER_EDITOR_RENDERER"];
  Object.defineProperty(CustomEditor.prototype, "render", { configurable: true, writable: true, value: other });
  const guarded = installTidyUi(root, () => color);
  try { assert.deepEqual(editor.render(60), ["OTHER_EDITOR_RENDERER"]); assert.equal(CustomEditor.prototype.render, other); }
  finally {
    guarded.restore();
    if (previous) Object.defineProperty(CustomEditor.prototype, "render", previous); else Reflect.deleteProperty(CustomEditor.prototype, "render");
  }
});

test("editor card restores exact paint descriptor on failures and zero/tiny widths remain native", () => {
  const { root, editor } = editorSetup();
  editor.setText("界");
  const original = Editor.prototype.render;
  const descriptor = Object.getOwnPropertyDescriptor(editor, "borderColor");
  const controller = installTidyUi(root, () => color);
  try {
    assert.deepEqual(editor.render(0), []);
    for (const width of [1, 2]) {
      assert.throws(() => original.call(editor, width), RangeError, "stock Pi wide-glyph recursion is not repaired here");
      assert.throws(() => editor.render(width), RangeError);
      assert.equal(controller.active, true, "native tiny-width failures are not custom projection failures");
    }
    for (const width of [3, 4, 5, 6])
      assert.deepEqual(editor.render(width), original.call(editor, width), `native authority for impossible width ${width}`);
    editor.setWorkingStatusIndicator({ renderInBorder: () => { throw new Error("STATUS_FAILURE"); } } as never);
    assert.throws(() => editor.render(60), /STATUS_FAILURE/u);
    assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "borderColor"), descriptor);
    assert.equal(controller.active, false, "projection failure restores owned hooks");
  } finally { controller.restore(); }
});

test("editor card foreground and padding retain user paint after the native inverse-cursor reset", async () => {
  const terminal = new xterm.Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const { root, editor } = editorSetup(2); editor.setText("BEFORE AFTER");
      for (let i = 0; i < 6; i++) editor.handleInput("\x1b[D");
      const controller = installTidyUi(root, () => nativeTheme);
      try {
        const rows = editor.render(24);
        terminal.reset(); await new Promise<void>(resolve => terminal.write(editorPaint(rows).join("\r\n"), resolve));
        const bg = colorToRgb(nativeTheme.colors.userMessageBg), fg = colorToRgb(nativeTheme.colors.userMessageText);
        const line = terminal.buffer.active.getLine(1)!;
        for (let x = 3; x < 22; x++) {
          assert.equal(line.getCell(x)!.getBgColor(), (bg.r << 16) | (bg.g << 8) | bg.b);
          assert.equal(line.getCell(x)!.getFgColor(), (fg.r << 16) | (fg.g << 8) | fg.b);
        }
        assert.equal(line.getCell(0)!.getBgColorMode(), 0); assert.equal(line.getCell(23)!.getBgColorMode(), 0);
        assert.equal(line.getCell(1)!.getBgColorMode(), 0); assert.equal(line.getCell(22)!.getBgColorMode(), 0);
        assert.equal(line.getCell(2)!.getBgColorMode(), 0, "stripe retains page background");
        assert.ok(line.getCell(10)!.isInverse(), "native fake cursor style survives");
      } finally { controller.restore(); }
    }
  } finally { terminal.dispose(); }
});

test("editor card keeps excessive native padding bounded by actual-width delegation", (t) => {
  const { root, editor } = editorSetup(1_000_000); editor.setText("x");
  const native = Editor.prototype.render, widths: number[] = [];
  const probe = t.mock.method(Editor.prototype, "render", function (this: Editor, width: number) {
    widths.push(width); return native.call(this, width);
  });
  const controller = installTidyUi(root, () => color);
  try {
    const rows = editor.render(60);
    assert.deepEqual(widths, [60], "do not materialize million-column native padding for a small input frame");
    assert.deepEqual(rows, native.call(editor, 60));
    assert.equal(controller.active, true);
  } finally { controller.restore(); probe.mock.restore(); }
});

test("editor full-line cursor inverse never paints exterior margins or subsequent padding", async () => {
  initTheme("dark");
  const terminal = new xterm.Terminal({ cols: 24, rows: 10, allowProposedApi: true });
  const { root, editor } = editorSetup(1); editor.setText("x".repeat(editorGeometry(24, 1).contentWidth));
  const controller = installTidyUi(root, () => nativeTheme);
  try {
    await new Promise<void>(resolve => terminal.write(editorPaint(editor.render(24)).join("\r\n"), resolve));
    const line = terminal.buffer.active.getLine(1)!;
    assert.ok(line.getCell(22)!.isInverse(), "end cursor occupies internal right padding");
    assert.equal(line.getCell(23)!.isInverse(), 0, "exterior right margin must not inherit inverse cursor");
    for (let x = 0; x < 24; x++) assert.equal(terminal.buffer.active.getLine(2)!.getCell(x)!.isInverse(), 0);
  } finally { controller.restore(); terminal.dispose(); }
});

function nativeStatusEditorSetup() {
  const value = editorWidgetSetup();
  const { root, editor, host, input } = value;
  Object.assign(root, { setFocus: (node: Component | null) => { editor.focused = node === editor; }, getClearOnShrink: () => true });
  Object.assign(host, { defaultEditor: editor, editor, editorContainer: input, statusContainer: root.children[2],
    idleStatus: new IdleStatus(), options: { tuiMode: "regular" } });
  const options = { editorStatus: true, nativeEditor: () => host.editorComponentFactory === undefined,
    rerouteEditorStatus: () => host.setCustomEditorComponent(undefined) } as TidyUiOptions;
  return { ...value, options };
}

// Exercise the actual SDK switch/clear logic, not a reconstructed status state machine.
test("native status container preserves active unknown indicator and same-editor draft across on/off", () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, options, frame } = nativeStatusEditorSetup();
    host.options.tuiMode = mode;
    editor.handleInput("\x1b[200~" + "PASTE_".repeat(300) + "\x1b[201~");
    editor.handleInput("x"); editor.handleInput("\x1b[D");
    const snapshot = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor(),
      pastes: [...(editor as any).pastes.entries()], undo: structuredClone((editor as any).undoStack), history: structuredClone((editor as any).history) });
    const before = snapshot(), descriptor = Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus");
    assert.ok(descriptor?.writable && descriptor.configurable, "SDK placement field must remain interceptable");
    let disposed = 0, borderCalls = 0;
    const indicator = { kind: "unknown-future-kind", render: () => ["", "FUTURE A─B ───"], invalidate() {},
      renderInBorder: () => { borderCalls++; return "FUTURE A─B ───"; }, renderSpinnerInBorder: () => "S", dispose: () => disposed++ };
    host.showStatusIndicator(indicator); assert.equal(host.activeWorkingIndicatorEmbedded, true);
    const controller = installTidyUi(root, () => color, options);
    try {
      assert.equal(editor.embedWorkingStatus, false, "native SDK must select its own separate container");
      assert.equal(host.editor, editor); assert.equal(host.editorComponentFactory, undefined);
      assert.equal(host.activeStatusIndicator, indicator); assert.equal(host.activeWorkingIndicatorEmbedded, false);
      assert.equal(host.statusContainer.children[0], indicator); assert.equal(disposed, 0);
      assert.deepEqual(snapshot(), before, "native self-transfer must not alter paste/cursor/undo/history");
      borderCalls = 0; frame(mode);
      assert.doesNotMatch(editor.render(100).map(editorPlain).join("\n"), /FUTURE/u);
      assert.equal(borderCalls, 0, "no discarded native border/status extraction");
      // Capture at the same width as the preceding editor and native status group frame.
      frame(mode, 100);
      const metadata = controller.renderEditorStatus(100, { model: "MODEL", provider: "raw-id", thinking: "high", idle: true });
      assert.equal(metadata.length, 2); assert.doesNotMatch(metadata.map(editorPlain).join("\n"), /FUTURE|Idle/u);
      controller.restore();
      assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "embedWorkingStatus"), descriptor);
      assert.equal(host.activeStatusIndicator, indicator); assert.equal(host.activeWorkingIndicatorEmbedded, true);
      assert.equal(host.statusContainer.children.length, 0); assert.equal(disposed, 0); assert.deepEqual(snapshot(), before);
      assert.match(editor.render(100).map(editorPlain).join("\n"), /FUTURE/u);
      host.clearStatusIndicator(); assert.equal(disposed, 1, "only native lifecycle disposes the indicator");
    } finally { controller.restore(); }
  }
});

// Below-editor rows display Idle only; Pi owns all active status rendering.
test("editor status never extracts native operation text and retains fixed editor geometry", () => {
  const { root, editor, host, options, frame } = nativeStatusEditorSetup();
  const controller = installTidyUi(root, () => color, options);
  const info = { model: "GPT-6 Astra", provider: "openai-codex", thinking: "high", idle: true };
  try {
    for (const value of ["Working", "A─B ───", "── beginning", "界é", "\u0301leading", "ending\u0600"]) {
      const raw = "\x1b[33m" + value + "\x1b[39m";
      const indicator = { kind: "future-kind", render: () => [raw], invalidate() {}, dispose() {},
        renderInBorder: () => assert.fail("no border extraction"), renderSpinnerInBorder: () => assert.fail("no border extraction") };
      host.showStatusIndicator(indicator); frame("regular", 100);
      assert.deepEqual(host.statusContainer.render(100), [raw], "native output and all semantic ANSI remain unchanged");
      const rows = editor.render(100), footer = controller.renderEditorStatus(100, info);
      assert.equal(footer.length, 2); assert.match(editorPlain(footer[0]!), /GPT-6 Astra \(openai-codex\) • high/u);
      assert.doesNotMatch(editorPlain(footer[0]!), /Idle/u); assert.match(editorPlain(footer[1]!), /^ ╹▀+ $/u);
      assert.equal(rows.filter(row => row.includes(CURSOR_MARKER)).length, 1); assert.equal(controller.cacheStats().entries, 0);
    }
    host.clearStatusIndicator(); frame("regular", 100);
    assert.match(editorPlain(controller.renderEditorStatus(100, info)[0]!), / • Idle/u);
  } finally { controller.restore(); }
});

test("editor status distinguishes native status, idle and busy-hidden and updates metadata without a draft", () => {
  const { root, editor } = editorSetup();
  const controller = installTidyUi(root, () => color, { editorStatus: true } as TidyUiOptions);
  const info = { model: "GPT-6 Astra", provider: "openai-codex", thinking: "off", idle: true };
  try {
    editor.render(100);
    const render = () => (controller as any).renderEditorStatus(100, info).map(editorPlain);
    assert.match(render()[0], /GPT-6 Astra \(openai-codex\) • off • Idle/u);
    info.idle = false; assert.doesNotMatch(render()[0], /Idle/u);
    info.model = "New Model"; info.provider = "custom-id"; info.thinking = "max";
    assert.match(render()[0], /New Model \(custom-id\) • max/u);
    editor.setWorkingStatusIndicator({ renderInBorder: () => "ACTIVE", renderSpinnerInBorder: () => "S" } as never);
    editor.render(100); assert.doesNotMatch(render()[0], /ACTIVE/u, "operation text never enters metadata");
    editor.setWorkingStatusIndicator(undefined); editor.render(100);
    assert.doesNotMatch(render()[0], /ACTIVE|Idle/u);
    info.idle = true; assert.match(render()[0], / • Idle/u);
  } finally { controller.restore(); }
});

test("editor status preserves native overflow and menu clicks with no added editor-local rows", async () => {
  const { root, editor } = editorSetup(2);
  const controller = installTidyUi(root, () => color, { editorStatus: true } as TidyUiOptions);
  try {
    editor.setWorkingStatusIndicator({ renderInBorder: () => "ACTIVE", renderSpinnerInBorder: () => "S" } as never);
    editor.setText(Array.from({ length: 30 }, (_, i) => `ROW_${i}`).join("\n"));
    assert.match(editorPlain(editor.render(60)[0]!), /↑ \d+ more/u);
    for (let i = 0; i < 35; i++) editor.handleInput("\x1b[A");
    assert.match(editorPlain(editor.render(60).at(-1)!), /↓ \d+ more/u);
    editor.setText("");
    editor.setAutocompleteProvider({
      getSuggestions: async () => ({ items: [{ value: "/result", label: "/result", description: "STATUS_MENU" }], prefix: "/r" }),
      applyCompletion: () => ({ lines: ["/result "], cursorLine: 0, cursorCol: 8 }),
    });
    editor.handleInput("/r"); await new Promise<void>(resolve => setImmediate(resolve));
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("STATUS_MENU"));
    assert.equal(menu, 3, "native top/input/bottom positions stay unchanged");
    assert.deepEqual((controller as any).renderEditorStatus(60, { model: "M", provider: "P", thinking: "high", idle: false }), []);
    assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
    assert.equal(editor.getText(), "/result ");
  } finally { controller.restore(); }
});

test("editor status delegates tiny widths and foreign ownership without reading operation headers", () => {
  const { root, editor } = editorSetup();
  let stock = true, restored = 0;
  const controller = installTidyUi(root, () => color, { editorStatus: true, nativeEditor: () => stock, editorStatusRestored: () => restored++ } as TidyUiOptions);
  const info = { model: "M", provider: "P", thinking: "high", idle: true };
  try {
    for (const width of [0, 3, 6]) { editor.render(width); assert.deepEqual((controller as any).renderEditorStatus(width, info), []); }
    editor.render(24); assert.equal((controller as any).renderEditorStatus(24, info).length, 2);
    stock = false; assert.deepEqual((controller as any).renderEditorStatus(24, info), []);
    assert.doesNotMatch(editor.render(24).map(editorPlain).join(""), /┃/u);
    stock = true;
    editor.setWorkingStatusIndicator({ renderInBorder: () => "X".repeat(100), renderSpinnerInBorder: () => "S" } as never);
    editor.render(24);
    assert.equal(controller.active, true, "opaque operation header is no longer inspected");
    assert.equal(restored, 0);
  } finally { controller.restore(); }
});

test("editor status renders exact half-block palette and default background in dark and light", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const width of [7, 24, 60, 100]) {
        const rows = renderEditorStatus(width, nativeTheme, { model: "GPT-6 Astra", provider: "openai-codex", thinking: "high", idle: true });
        assert.equal(rows.length, 2); assert.ok(rows.every(row => visibleWidth(row) === width));
        assert.match(editorPlain(rows[1]!), /^ ╹▀+ $/u);
        assert.ok(editorPlain(rows[0]!).includes(width >= 9 ? "Idle" : "I…"));
        terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
        const rgb = colorToRgb(nativeTheme.colors.userMessageBg), panel = (rgb.r << 16) | (rgb.g << 8) | rgb.b;
        for (let x = 2; x < width - 1; x++) {
          assert.equal(terminal.buffer.active.getLine(0)!.getCell(x)!.getBgColor(), panel);
          const cell = terminal.buffer.active.getLine(1)!.getCell(x)!;
          assert.equal(cell.getChars(), "▀"); assert.equal(cell.getFgColor(), panel);
          assert.equal(cell.getBgColorMode(), 0, "lower half is terminal-default background");
        }
        assert.equal(terminal.buffer.active.getLine(1)!.getCell(1)!.getChars(), "╹");
        for (const y of [0, 1]) for (const x of [0, 1, width - 1])
          assert.equal(terminal.buffer.active.getLine(y)!.getCell(x)!.getBgColorMode(), 0);
      }
    }
  } finally { terminal.dispose(); }
});

test("editor status unsupported immutable placement preserves native editor and omits metadata", () => {
  const { root, editor } = editorSetup();
  Object.defineProperty(editor, "embedWorkingStatus", { value: true, writable: false, configurable: false });
  const native = editor.render(100);
  const controller = installTidyUi(root, () => color, { editorStatus: true });
  try {
    assert.deepEqual(editor.render(100), native);
    assert.deepEqual(controller.renderEditorStatus(100, { model: "M", provider: "P", thinking: "high", idle: true }), []);
    assert.equal(controller.active, true, "other pi-tidy-ui features need not fail with the editor feature");
    assert.deepEqual(renderEditorStatus(0, color, {} as never), []);
    assert.deepEqual(renderEditorStatus(6, color, {} as never), []);
  } finally { controller.restore(); }
});

test("editor status native clock stays in its container across animation off/on and native clearing", async t => {
  const intervals = t.mock.method(globalThis, "setInterval"), clears = t.mock.method(globalThis, "clearInterval");
  const { root, editor, host, options, frame } = nativeStatusEditorSetup();
  const indicator = new StatusIndicator("unknown-future-kind" as never, root as never, text => text, text => text, "Future operation ───");
  host.showStatusIndicator(indicator);
  let controller = installTidyUi(root, () => color, options);
  const info = { model: "M", provider: "P", thinking: "high", idle: true };
  try {
    frame("regular", 100); const before = editor.render(100), first = host.statusContainer.render(100);
    assert.equal(intervals.mock.calls.length, 1); assert.doesNotMatch(controller.renderEditorStatus(100, info).map(editorPlain).join("\n"), /Idle|Future operation/u);
    await new Promise<void>(resolve => setTimeout(resolve, 100)); frame("regular", 100);
    assert.notDeepEqual(host.statusContainer.render(100), first, "native container frames advance");
    assert.equal(editor.render(100).length, before.length); assert.equal(intervals.mock.calls.length, 1);
    controller.restore(); assert.equal(clears.mock.calls.length, 0, "rerouting never disposes the indicator");
    assert.match(editor.render(100).map(editorPlain).join("\n"), /Future operation ───/u);
    controller = installTidyUi(root, () => color, options); frame("regular", 100);
    assert.equal(host.statusContainer.children[0], indicator); assert.equal(intervals.mock.calls.length, 1);
    host.clearStatusIndicator(); frame("regular", 100);
    assert.match(controller.renderEditorStatus(100, info).map(editorPlain).join("\n"), / • Idle/u);
    assert.equal(clears.mock.calls.length, 1);
  } finally { controller.restore(); }
});

test("editor status public widget reads fresh session metadata and is removed on shutdown", async () => {
  const h = extensionHarness(), { editor } = editorSetup();
  Object.assign(h.root, { terminal: { rows: 24 }, setFocus() {}, getClearOnShrink: () => true });
  const slots = Array.from({ length: 7 }, () => new Container()); slots[4]!.addChild(editor);
  for (const child of h.root.children) slots[0]!.addChild(child);
  h.root.clear(); for (const slot of slots) h.root.addChild(slot);
  const host = Object.assign(Object.create(InteractiveMode.prototype), { ui: h.root, editor, defaultEditor: editor,
    editorContainer: slots[4], statusContainer: slots[2], idleStatus: new IdleStatus(), options: { tuiMode: "regular" } });
  Object.assign(h.ctx.ui, { setEditorComponent: (factory: unknown) => host.setCustomEditorComponent(factory),
    getEditorComponent: () => host.editorComponentFactory });
  const first = Object.assign(h.ctx, { model: { name: "First Name", provider: "literal-provider-id" }, thinkingLevel: "high" });
  try {
    await h.events.get("session_start")!({}, first); editor.render(100);
    const widget = h.widgetComponents.get("pi-tidy-ui-editor-status")!;
    assert.match(widget.render(100).map(editorPlain).join("\n"), /First Name \(literal-provider-id\) • high • Idle/u);
    const next = { ...first, model: { name: "Second Name", provider: "other-id" }, thinkingLevel: "off" } as unknown as ExtensionContext;
    await h.events.get("session_start")!({}, next); editor.render(100);
    assert.equal(h.widgetComponents.get("pi-tidy-ui-editor-status"), widget, "no stacked widget on session events");
    assert.match(widget.render(100).map(editorPlain).join("\n"), /Second Name \(other-id\) • off • Idle/u);
    await setAppearance(h.commands.get('tidy-ui')!.handler, next, false); assert.equal(h.widgetComponents.size, 0);
    await setAppearance(h.commands.get('tidy-ui')!.handler, next, true); editor.render(100);
    assert.match(h.widgetComponents.get("pi-tidy-ui-editor-status")!.render(100).map(editorPlain).join("\n"), /Second Name/u);
  } finally { await h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(h.widgetComponents.size, 0);
});

test("editor status semantic colors use heading parenthesized provider and thinking roles without activity", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 4, allowProposedApi: true });
  const rgb = (role: keyof typeof nativeTheme.colors) => {
    const value = colorToRgb(nativeTheme.colors[role]); return (value.r << 16) | (value.g << 8) | value.b;
  };
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "future"]) {
        const rows = renderEditorStatus(100, nativeTheme, { model: "MODEL", provider: "raw-id", thinking: level, idle: false });
        const text = editorPlain(rows[0]!);
        assert.match(text, new RegExp(`MODEL \\(raw-id\\) • ${level}`, "u"));
        assert.doesNotMatch(text, /Working|Idle/u);
        terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
        const line = terminal.buffer.active.getLine(0)!;
        const check = (value: string, role: keyof typeof nativeTheme.colors) => {
          const start = text.indexOf(value); assert.ok(start >= 0, value);
          for (let x = start; x < start + value.length; x++) assert.equal(line.getCell(x)!.getFgColor(), rgb(role), `${mode}/${level}/${value}`);
        };
        check("MODEL", "mdHeading"); check("raw-id", "muted"); check("(", "dim"); check(")", "dim");
        for (let x = 0; x < text.length; x++) if (text[x] === "•") assert.equal(line.getCell(x)!.getFgColor(), rgb("dim"));
        const roles = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" } as const;
        const role = Object.hasOwn(roles, level) ? roles[level as keyof typeof roles] : "thinkingOff";
        check(level, role);
        for (const width of [7, 24, 40, 60]) {
          const compact = renderEditorStatus(width, nativeTheme, { model: "界MODEL".repeat(30), provider: "RAW".repeat(50), thinking: level, idle: true });
          assert.ok(compact.every(row => visibleWidth(row) === width));
          const plain = editorPlain(compact[0]!); assert.equal(plain.includes("("), plain.includes(")"), "provider parentheses remain balanced after fitting");
        }
      }
    }
  } finally { terminal.dispose(); }
});

test("editor status Idle uses muted while its preceding bullet remains dim", async () => {
  const terminal = new xterm.Terminal({ cols: 100, rows: 4, allowProposedApi: true });
  try {
    for (const mode of ["dark", "light"]) {
      initTheme(mode);
      const rows = renderEditorStatus(100, nativeTheme, { model: "MODEL", provider: "provider-id", thinking: "high", idle: true });
      const text = editorPlain(rows[0]!), idle = text.indexOf("Idle"), bullet = text.lastIndexOf("•");
      assert.ok(idle > bullet && bullet >= 0);
      terminal.reset(); await new Promise<void>(resolve => terminal.write(rows.join("\r\n"), resolve));
      const line = terminal.buffer.active.getLine(0)!;
      const rgb = (role: "muted" | "dim") => { const c = colorToRgb(nativeTheme.colors[role]); return (c.r << 16) | (c.g << 8) | c.b; };
      for (let x = idle; x < idle + 4; x++) assert.equal(line.getCell(x)!.getFgColor(), rgb("muted"), `${mode}: Idle muted`);
      assert.equal(line.getCell(bullet)!.getFgColor(), rgb("dim"), `${mode}: separator dim`);
    }
  } finally { terminal.dispose(); }
});

test("editor status hides both metadata rows for autocomplete but native activity stays in its container", async t => {
  const intervals = t.mock.method(globalThis, "setInterval"), clears = t.mock.method(globalThis, "clearInterval");
  const { root, editor, host, options } = nativeStatusEditorSetup();
  let resolve!: (value: any) => void;
  editor.setAutocompleteProvider({
    getSuggestions: () => new Promise(done => { resolve = done; }),
    applyCompletion: () => ({ lines: ["/result "], cursorLine: 0, cursorCol: 8 }),
  });
  const indicator = new StatusIndicator("unknown-future-kind" as never, root as never, text => text, text => text, "ACTIVE");
  host.showStatusIndicator(indicator);
  const controller = installTidyUi(root, () => color, options);
  const info = { model: "M", provider: "P", thinking: "high", idle: false };
  const status = () => controller.renderEditorStatus(60, info);
  try {
    editor.render(60); assert.equal(status().length, 2);
    editor.handleInput("/r"); await new Promise<void>(done => setImmediate(done));
    assert.equal(editor.isShowingAutocomplete(), false, "pending provider request is not an open menu");
    editor.render(60); assert.equal(status().length, 2, "do not hide during pending-only lookup");
    resolve({ items: [{ value: "/result", label: "/result", description: "AUTOCOMPLETE_HIDE" }], prefix: "/r" });
    await new Promise<void>(done => setImmediate(done));
    assert.equal(editor.isShowingAutocomplete(), true);
    const rows = editor.render(60), menu = rows.findIndex(row => editorPlain(row).includes("AUTOCOMPLETE_HIDE"));
    assert.equal(menu, 3, "native editor/menu y coordinates remain unchanged");
    assert.deepEqual(status(), [], "both metadata rows disappear");
    assert.match(host.statusContainer.render(60).map(editorPlain).join("\n"), /ACTIVE/u, "native activity is independent of autocomplete");
    assert.deepEqual(status(), [], "unchanged menu has no widget output");
    assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
    controller.restore(); assert.match(editor.render(60).map(editorPlain).join("\n"), /ACTIVE/u);
    const again = installTidyUi(root, () => color, options);
    try {
      editor.render(60); assert.deepEqual(again.renderEditorStatus(60, info), [], "on while menu open still hides widget");
      assert.equal(editor.handleMouse({ ...mouse(menu, 60), x: 5, height: rows.length })?.handled, true);
      assert.equal(editor.getText(), "/result "); assert.equal(editor.isShowingAutocomplete(), false);
      editor.render(60);
      assert.doesNotMatch(again.renderEditorStatus(60, info).map(editorPlain).join("\n"), /ACTIVE|Idle/u);
      assert.equal(host.statusContainer.children[0], indicator, "completion retains the same native indicator");
      assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
      editor.setText(""); editor.handleInput("/r"); await new Promise<void>(done => setImmediate(done));
      resolve({ items: [{ value: "/result", label: "/result" }], prefix: "/r" });
      await new Promise<void>(done => setImmediate(done)); editor.render(60);
      assert.deepEqual(again.renderEditorStatus(60, info), []);
      const draft = editor.getText(); editor.handleInput("\x1b");
      assert.equal(editor.isShowingAutocomplete(), false); assert.equal(editor.getText(), draft);
      editor.render(60); assert.equal(again.renderEditorStatus(60, info).length, 2, "Escape restores both rows");
      editor.setText(""); editor.handleInput("/none"); await new Promise<void>(done => setImmediate(done));
      resolve({ items: [], prefix: "/none" }); await new Promise<void>(done => setImmediate(done));
      assert.equal(editor.isShowingAutocomplete(), false); editor.render(60);
      assert.equal(again.renderEditorStatus(60, info).length, 2, "empty suggestions do not hide the widget");
      assert.equal(intervals.mock.calls.length, 1); assert.equal(clears.mock.calls.length, 0);
    } finally { again.restore(); }
  } finally { controller.restore(); host.clearStatusIndicator(); }
});

test("editor padding moves the whole input and status panel live while inner spacing stays one", () => {
  const { root, editor } = editorSetup(1);
  const controller = installTidyUi(root, () => color, { editorStatus: true });
  const info = { model: "MODEL", provider: "raw-id", thinking: "high", idle: false };
  const budgets: number[] = [];
  editor.setWorkingStatusIndicator({ renderInBorder: (width: number) => { budgets.push(width); return truncateToWidth("ACTIVE", width, ""); }, renderSpinnerInBorder: () => "S" } as never);
  editor.setText("TEXT 界é");
  const before = { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() };
  try {
    for (const width of [100, 24]) for (const padding of [0, 3, 2, 1, 0]) {
      editor.setPaddingX(padding);
      const rows = editor.render(width), status = controller.renderEditorStatus(width, info), contentX = padding + 2;
      assert.equal(status.length, 2);
      for (const row of [...rows, ...status.slice(0, 1)]) {
        const plain = editorPlain(row);
        assert.equal(visibleWidth(row), width);
        assert.equal(plain[padding], "┃", `padding ${padding}: entire panel stripe moves`);
        assert.equal(plain[padding + 1], " ", "fixed inner left gap separates text and stripe");
        assert.equal(plain[width - padding - 1], " ", "fixed inner right gap");
        assert.equal(plain.slice(0, padding), " ".repeat(padding));
        if (padding) assert.equal(plain.slice(-padding), " ".repeat(padding));
      }
      assert.equal(editorPlain(rows[1]!).slice(contentX, contentX + 4), "TEXT");
      assert.equal(editorPlain(status[1]!), " ".repeat(padding) + "╹" + "▀".repeat(width - 2 * padding - 1) + " ".repeat(padding));
      assert.deepEqual(budgets, [], "metadata and geometry never format native operation text");
      assert.deepEqual({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() }, before);
    }
    controller.restore();
    const native = editor.render(100); assert.ok(editorPlain(native[1]!).startsWith("TEXT"), "off restores selected native zero padding");
  } finally { controller.restore(); }
});

// Native widget methods and fullscreen composition are deliberate SDK contract probes.
// Do not replace these with a mock registry when upgrading the development host.
function editorWidgetSetup() {
  const { root, editor } = editorSetup(1); root.clear();
  const document = new Container(), pendingMessages = new Container(), status = new Container();
  const above = new Container(), input = new Container(), below = new Container(), footer = new Container();
  input.addChild(editor);
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: root, widgetContainerAbove: above, widgetContainerBelow: below,
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
  });
  host.renderWidgets();
  host.mountInteractiveTui(root, [document, pendingMessages, status, above, input, below, footer]);
  const viewport = createChatViewport({ document, pendingMessages, status, widgetsAbove: above,
    editor: input, widgetsBelow: below, footer });
  const frame = (mode: string, width = 80) => mode === "fullscreen"
    ? renderLayoutFrame(viewport.root, width, 40, () => {}).lines : root.render(width);
  return { root, editor, host, above, input, below, viewport, frame };
}

test("editor widget gap SDK compatibility: stock spacer dock ordering and current-pass render contract", () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, above, input, below, viewport, frame } = editorWidgetSetup();
    assert.equal(root.children.length, 7, "host mounting retains seven managed slots");
    assert.equal(root.children[3], above); assert.equal(root.children[4], input); assert.equal(root.children[5], below);
    assert.equal(above.children.length, 1, "native empty group supplies exactly one spacer");
    assert.equal(Object.getPrototypeOf(above.children[0]!), Spacer.prototype);
    assert.deepEqual(above.render(80), [""], "native empty spacer is one unpainted row");
    assert.ok(viewport.root instanceof Container);
    const dock = viewport.root.children[1] as Container;
    assert.equal(dock.children.length, 6, "actual fullscreen dock keeps the known six slots");
    assert.equal(dock.children[2], above); assert.equal(dock.children[3], input); assert.equal(dock.children[4], below);
    const events: string[] = [], order: string[] = [];
    host.setExtensionWidget("compat-upper", () => ({ render() { events.push("upper"); order.push("upper"); return ["SDK_WIDGET"]; }, invalidate() {} }));
    frame(mode);
    const nativeCalls = events.length;
    assert.equal(nativeCalls, mode === "regular" ? 1 : 2, "actual SDK frame has an explicit native render-count control");
    events.length = 0; order.length = 0;
    const controller = installTidyUi(root, () => { order.push("editor"); return color; });
    try {
      const rows = frame(mode);
      assert.deepEqual(order, Array.from({ length: nativeCalls }, () => ["upper", "editor"]).flat(), "SDK must render the upper group before every editor projection in the current pass");
      const painted = editor.render(80).map(editorPlain);
      assert.deepEqual(events, Array(nativeCalls).fill("upper"), "spacing adds no widget renders beyond the same native frame");
      assert.equal(painted[0], "", "compatible native layout must activate the separator, not silently fall back");
      assert.equal(painted[1]![1], "┃");
      const widgetY = rows.findIndex(row => editorPlain(row).includes("SDK_WIDGET"));
      assert.ok(widgetY >= 0); assert.equal(editorPlain(rows[widgetY + 1]!), "");
      assert.equal(editorPlain(rows[widgetY + 2]!)[1], "┃", "separator follows the native upper group immediately");
      host.setExtensionWidget("compat-upper", () => ({ render() { events.push("empty"); order.push("empty"); return []; }, invalidate() {} }));
      assert.equal(above.children.length, 2, "native registered zero-height widgets retain the leading spacer");
      order.length = 0; frame(mode);
      assert.deepEqual(order, Array.from({ length: nativeCalls }, () => ["empty", "editor"]).flat(), "height-zero observation must precede the editor, not arrive a frame late");
      assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "zero-row current pass must replace the positive observation");
      assert.deepEqual(events, [...Array(nativeCalls).fill("upper"), ...Array(nativeCalls).fill("empty")]);
    } finally { controller.restore(); }
  }
});

test("editor widget gap excludes absent zero-height and below-only widgets and follows live height", t => {
  const clock = t.mock.method(globalThis, "setInterval");
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, frame } = editorWidgetSetup();
    editor.setText("GAP_INPUT_界é");
    const records: { explanation: string; fields?: import('../src/diagnostics.ts').DiagnosticFields }[] = [];
    const controller = installTidyUi(root, () => color, { editorStatus: true,
      diagnostic: (_level, area, explanation, fields) => { if (area === 'editor') records.push({ explanation, fields }); } });
    let content: string[] = [], calls = 0;
    const nativeCalls = mode === "regular" ? 1 : 2;
    try {
      const draw = () => { frame(mode); return editor.render(80); };
      const baseline = draw();
      assert.equal(editorPlain(baseline[0]!)[1], "┃", "native empty-group spacer does not add an editor row");
      host.setExtensionWidget("lower-only", () => ({ render: () => ["LOWER_WIDGET"], invalidate() {} }), { placement: "belowEditor" });
      assert.deepEqual(draw(), baseline, "lower widgets cannot trigger an upper separator");
      host.setExtensionWidget("live-height", () => ({ render() { calls++; return content; }, invalidate() {} }));
      assert.deepEqual(draw(), baseline, "registered zero-row component reserves no additional editor height");
      assert.equal(calls, nativeCalls);
      content = ["UPPER_ONE", "UPPER_TWO"];
      const shown = draw(); assert.deepEqual(shown, ["", ...baseline]); assert.equal(calls, 2 * nativeCalls);
      assert.equal(records.at(-1)?.fields?.offsetY, 1, "same-size editor must report its newly computed separator mapping");
      assert.equal(records.length, 2, "zero-height observations deduplicate; positive mapping emits once");
      assert.equal(shown.findIndex(row => row.includes(CURSOR_MARKER)), baseline.findIndex(row => row.includes(CURSOR_MARKER)) + 1);
      host.setExtensionWidget("later-registration", () => ({ render: () => ["LAST_UPPER"], invalidate() {} }));
      assert.deepEqual(draw(), shown, "new widget registration cannot cross the editor-owned gap"); assert.equal(calls, 3 * nativeCalls);
      assert.equal(records.length, 2, "unchanged positive mapping emits no repeated record");
      content = []; host.setExtensionWidget("later-registration", undefined);
      assert.deepEqual(draw(), baseline, "same registered component becoming zero-height removes the gap"); assert.equal(calls, 4 * nativeCalls);
      assert.equal(records.at(-1)?.fields?.offsetY, 0); assert.equal(records.length, 3);
      host.setExtensionWidget("live-height", undefined);
      assert.deepEqual(draw(), baseline, "removing the last upper widget removes the gap"); assert.equal(calls, 4 * nativeCalls);
      assert.equal(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }).length, 2);
      assert.equal(clock.mock.calls.length, 0, "widget spacing introduces no animation or polling clock");
    } finally { controller.restore(); }
  }
});

test("editor widget gap maps native text menu clicks and leaves the empty row noninteractive", async () => {
  for (const mode of ["regular", "fullscreen"]) {
    const { root, editor, host, frame } = editorWidgetSetup();
    host.setExtensionWidget("upper", ["CLICK_WIDGET"]);
    const controller = installTidyUi(root, () => color, { editorStatus: true });
    try {
      editor.setText("abc界éXYZ"); frame(mode);
      const rows = editor.render(80); assert.equal(rows[0], "");
      const cursor = editor.getCursor();
      assert.equal(editor.handleMouse({ ...mouse(0), height: rows.length }), undefined);
      assert.deepEqual(editor.getCursor(), cursor, "separator cannot move the cursor");
      assert.equal(editor.handleMouse({ ...mouse(2), x: 3, height: rows.length })?.handled, true);
      assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, "painted text y maps back to native y");
      editor.setText("");
      editor.setAutocompleteProvider({
        getSuggestions: async () => ({ items: [{ value: "/gap-result", label: "/gap-result", description: "GAP_MENU" }], prefix: "/g" }),
        applyCompletion: () => ({ lines: ["/gap-result "], cursorLine: 0, cursorCol: 12 }),
      });
      editor.handleInput("/g"); await new Promise<void>(resolve => setImmediate(resolve)); frame(mode);
      const menuRows = editor.render(80), menu = menuRows.findIndex(row => editorPlain(row).includes("GAP_MENU"));
      assert.equal(menu, 4, "only the one external row shifts native autocomplete");
      assert.deepEqual(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }), []);
      assert.equal(editor.handleMouse({ ...mouse(menu), x: 3, height: menuRows.length })?.handled, true);
      assert.equal(editor.getText(), "/gap-result ");
      frame(mode); assert.equal(editor.render(80)[0], "", "completion retains gap while upper widgets exist");
      assert.equal(controller.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }).length, 2);
    } finally { controller.restore(); }
  }
});

test("editor widget gap rejects changed managed layout spacer and later container-render owners", () => {
  const { root, editor, host, above, frame } = editorWidgetSetup();
  host.setExtensionWidget("upper", ["GUARD_WIDGET"]);
  const original = Object.getOwnPropertyDescriptor(Container.prototype, "render")!;
  const controller = installTidyUi(root, () => color);
  try {
    frame("regular"); const valid = editor.render(80); assert.equal(valid[0], "");
    root.addChild(new Container()); frame("regular");
    assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "unknown managed slots omit optional gap rather than guessing");
    root.removeChild(root.children.at(-1)!);
    (above.children[0] as Spacer).setLines(2); frame("regular");
    assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "unknown stock spacer shape fails closed");
    host.renderWidgets(); frame("regular"); assert.equal(editor.render(80)[0], "");
    above.render = () => ["FOREIGN_GROUP"];
    frame("regular"); assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "foreign group renderer is not interpreted");
    Reflect.deleteProperty(above, "render"); frame("regular"); assert.equal(editor.render(80)[0], "");
    const later = function (this: Container, width: number) { return original.value.call(this, width); };
    Container.prototype.render = later;
    frame("regular"); assert.equal(editorPlain(editor.render(80)[0]!)[1], "┃", "later prototype owner invalidates measurements");
    controller.restore(); assert.equal(Container.prototype.render, later, "restoration respects later owner");
  } finally { controller.restore(); Object.defineProperty(Container.prototype, "render", original); }
});

test("editor widget gap ignores stale-width observations and restores both public render descriptors", () => {
  const { root, editor, host, above, frame } = editorWidgetSetup();
  host.setExtensionWidget("upper", ["WIDTH_WIDGET"]);
  const container = Object.getOwnPropertyDescriptor(Container.prototype, "render")!;
  const spacer = Object.getOwnPropertyDescriptor(Spacer.prototype, "render")!;
  const controller = installTidyUi(root, () => color);
  try {
    frame("regular", 80); assert.equal(editor.render(80)[0], "");
    assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "another width cannot use the retained group height");
    frame("fullscreen", 60); assert.equal(editor.render(60)[0], "");
    host.renderWidgets();
    assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "replaced native spacer invalidates a previous group observation");
    frame("regular", 60); assert.equal(editor.render(60)[0], "");
    (above.children[0] as Spacer).render = () => [""];
    frame("regular", 60); assert.equal(editorPlain(editor.render(60)[0]!)[1], "┃", "an instance spacer owner invalidates the proof");
    controller.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(Container.prototype, "render"), container);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Spacer.prototype, "render"), spacer);
    assert.notEqual(editor.render(80)[0], "", "off restores native rows rather than a lingering prefix");
  } finally { controller.restore(); }
});

test("native activity same-editor routing restores another focused component", () => {
  const { root, editor, host, options } = nativeStatusEditorSetup();
  const other = new Text("focus-owner", 0, 0); (root.children[0] as Container).addChild(other);
  let focused: Component | null = other;
  Object.assign(root, { getFocusedComponent: () => focused,
    setFocus: (node: Component | null) => { focused = node; editor.focused = node === editor; } });
  const text = "PRESERVED_DRAFT"; editor.setText(text);
  const before = editor.getCursor(); const controller = installTidyUi(root, () => color, options);
  try {
    assert.equal(focused, other); assert.equal(editor.focused, false); assert.equal(host.editor, editor);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), before);
    controller.restore(); assert.equal(focused, other); assert.equal(editor.focused, false);
    assert.equal(editor.getText(), text); assert.deepEqual(editor.getCursor(), before);
  } finally { controller.restore(); }
});
