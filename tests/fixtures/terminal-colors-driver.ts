// Real-CLI color/state observations. All production code shares one module graph.
import { CustomEditor, type ExtensionAPI, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default async function colorDriver(pi: ExtensionAPI) {
  const output = process.env.TOOLVIEW_TEST_OUTPUT!;
  let control: RegisteredCommand["handler"];
  let tui: any, query: unknown, notify: unknown, scheme: unknown;
  const nativeOnly = process.env.TOOLVIEW_TEST_COLORS_NATIVE === "1";
  let diagnostics: typeof import("../../src/index.ts").terminalColorDiagnostics | undefined;
  let appearanceTracking: typeof import("../../src/index.ts").terminalAppearanceTracking = value => {
    try { const flag = Reflect.get(value, "terminalColorSchemeNotificationsEnabled"); return typeof flag === "boolean" ? flag : undefined; }
    catch { return undefined; }
  };
  // Native/first-late controls do not import production Toolview until it is actually installed.
  if (!nativeOnly) {
    const module = await import("../../src/index.ts");
    diagnostics = module.terminalColorDiagnostics; appearanceTracking = module.terminalAppearanceTracking;
    const { default: presentationDriver } = await import("./presentation-driver.ts");
    presentationDriver({ ...pi, registerCommand(name, options) {
      if (name === "toolview") control = options.handler;
      pi.registerCommand(name, options);
    } });
  }
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("terminal-colors-probe", value => {
      tui = value; const prototype = Object.getPrototypeOf(tui);
      query = prototype.queryTerminalColors; notify = prototype.setTerminalColorSchemeNotifications; scheme = prototype.onTerminalColorSchemeChange;
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("terminal-colors-probe", undefined);
  });
  pi.registerShortcut("ctrl+alt+b", {
    description: "Capture terminal-colors runtime without a submitted capture message",
    handler: async ctx => {
      const { name, action = "snapshot", theme } = JSON.parse(readFileSync(join(output, "colors-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/u.test(name)) throw new Error("Invalid color observation name");
      const width = process.stdout.columns || 100;
      const editor = ctx.ui.getEditorComponent() ?? tui.children[4]?.children.find((node: any) => Object.getPrototypeOf(node) === CustomEditor.prototype);
      const state = () => editor ? { text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() } : undefined;
      const before = state();
      let report;
      if (["on", "off", "colors on", "colors off", "colors status"].includes(action)) await control!(action, ctx as never);
      else if (action === "theme") { const result = ctx.ui.setTheme(theme); if (!result.success) throw new Error(result.error); }
      else if (action === "foreign-query") report = await tui.queryTerminalColors({ timeoutMs: 100 });
      else if (action === "foreign-enable" || action === "foreign-disable") {
        tui.setTerminalColorSchemeNotifications(action === "foreign-enable"); tui.invalidate();
      } else if (action === "warm") for (let frame = 0; frame < 50; frame++) tui.render(width);
      else if (action !== "snapshot") throw new Error("Unknown color observation action");
      const rows = tui.render(width);
      writeFileSync(join(output, `${name}.json`), JSON.stringify({ before, after: state(), rows,
        editorRows: editor?.render(width), belowRows: tui.children[5]?.render(width),
        theme: ctx.ui.theme.name, sourcePath: ctx.ui.theme.sourcePath, configured: pi.getSettings().theme,
        automatic: appearanceTracking(tui), diagnostic: diagnostics?.(),
        report, publicPrototypesUnchanged: query === Object.getPrototypeOf(tui).queryTerminalColors && notify === Object.getPrototypeOf(tui).setTerminalColorSchemeNotifications && scheme === Object.getPrototypeOf(tui).onTerminalColorSchemeChange,
        nativeBackground: colorToHex(ctx.ui.theme.colors.userMessageBg), nativeForeground: colorToHex(ctx.ui.theme.colors.text),
        session: ctx.sessionManager.getSessionFile() }));
    },
  });
}
