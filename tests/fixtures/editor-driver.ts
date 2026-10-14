// Isolated real-CLI editor controls. Runs the production extension unchanged and
// observes drafts through a shortcut, never by submitting a capture command.
import { CustomEditor, type ExtensionAPI, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import tidyUi from "./presentation-driver.ts";
import { gitDiagnostics } from "../../src/git-branch.ts";

const originalEditorRender = CustomEditor.prototype.render;
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
export default function editorDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let control: RegisteredCommand["handler"];
  let tui: any;
  let upperRows: string[] = [], upperRegistered = false, widgetCalls = 0;
  tidyUi({ ...pi, registerCommand(name, options) {
    if (name === "tidy-ui") control = options.handler;
    pi.registerCommand(name, options);
  } });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("editor-probe", (value) => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("editor-probe", undefined);
  });
  pi.registerShortcut("ctrl+alt+d", {
    description: "Observe the unchanged draft or toggle production pi-tidy-ui without submitting it",
    handler: async ctx => {
      const { name, action = "snapshot" } = JSON.parse(readFileSync(join(output, "editor-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid editor observation name");
      const nodes: any[] = [];
      const visit = (node: any) => { if (nodes.includes(node)) return; nodes.push(node); for (const child of node.children ?? []) visit(child); };
      visit(tui);
      const editor = nodes.find(node => Object.getPrototypeOf(node) === CustomEditor.prototype);
      if (!editor) throw new Error("Exported stock CustomEditor identity does not match the actual CLI editor");
      if (!identities.has(editor)) identities.set(editor, ++nextIdentity);
      const state = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() });
      const before = state();
      if (action === "on" || action === "off") await control!('', ctx as never);
      else if (action === "dark" || action === "light") ctx.ui.setTheme(action);
      else if (action === "working-message") ctx.ui.setWorkingMessage("Working A─B ───");
      else if (action === "working-hide") ctx.ui.setWorkingVisible(false);
      else if (action === "working-show") ctx.ui.setWorkingVisible(true);
      else if (action === "thinking-off") pi.setThinkingLevel("off");
      else if (action === "widget-visible" || action === "widget-zero") {
        upperRows = action === "widget-visible" ? ["UPPER_WIDGET_A"] : [];
        if (!upperRegistered) ctx.ui.setWidget("editor-upper-probe", () => ({
          editorWidgetProbe: true,
          render(width: number) { widgetCalls++; return upperRows.map(row => ctx.ui.theme.bg("userMessageBg", row.slice(0, width))); },
          invalidate() {},
        }));
        upperRegistered = true;
      }
      else if (action === "widget-remove") {
        ctx.ui.setWidget("editor-upper-probe", undefined); upperRows = []; upperRegistered = false;
      }
      else if (action === "widget-extra") ctx.ui.setWidget("editor-upper-extra", () => ({
        editorWidgetProbe: true, render: () => ["LAST_UPPER_WIDGET_B"], invalidate() {},
      }));
      else if (action === "widget-extra-remove") ctx.ui.setWidget("editor-upper-extra", undefined);
      else if (action === "widget-lower") ctx.ui.setWidget("editor-lower-probe", () => ({
        editorWidgetProbe: true, render: () => ["LOWER_ONLY_WIDGET"], invalidate() {},
      }), { placement: "belowEditor" });
      else if (action === "widget-lower-remove") ctx.ui.setWidget("editor-lower-probe", undefined);
      else if (action !== "snapshot") throw new Error("Unknown editor action");
      const width = process.stdout.columns || 100;
      const widgetCallsBeforeEditor = widgetCalls;
      const rows = editor.render(width);
      const widgetCallsAfterEditor = widgetCalls;
      nodes.length = 0; visit(tui); // off/on changes the public widget tree, not the editor.
      const widgets = nodes.filter(node => Object.getPrototypeOf(node) === Object.prototype && typeof node.render === "function" && !node.editorWidgetProbe);
      const statusRows = widgets.flatMap(node => {
        const result = node.render(width);
        return result.length === 2 && result[1].includes("╹") ? result : [];
      });
      const indicator = tui.children[2]?.children.find((node: any) => typeof node.kind === "string") ??
        (editor as any).workingStatusIndicator; // Test-only native ownership observation.
      if (indicator && !identities.has(indicator)) identities.set(indicator, ++nextIdentity);
      writeFileSync(join(output, `${name}.json`), JSON.stringify({ width, rows, before, after: state(),
        widgetCallsBeforeEditor, widgetCallsAfterEditor, upperRegistered, upperRows,
        statusIdentity: indicator ? identities.get(indicator) : undefined, statusPresent: !!indicator,
        embedWorkingStatus: editor.embedWorkingStatus,
        nativeStatusRows: tui.children[2]?.render(width) ?? [],
        embeddedStatusPresent: !!(editor as any).workingStatusIndicator,
        tidyUiRenderOverride: editor.render !== originalEditorRender,
        identity: identities.get(editor), exactStockPrototype: true,
        sharedEditorPrototype: Object.getPrototypeOf(CustomEditor.prototype) === Editor.prototype,
        inputMethodUnchanged: editor.handleInput === CustomEditor.prototype.handleInput,
        padding: editor.getPaddingX(), menu: editor.isShowingAutocomplete(), session: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd, home: homedir(), git: gitDiagnostics(), statusRows, modelName: ctx.model?.name, provider: ctx.model?.provider, thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), idle: ctx.isIdle(),
        footerRows: tui.children[6]?.render(width) ?? [],
        footerOwner: tui.children[6]?.children[0]?.constructor?.name,
        styles: { border: ctx.ui.theme.fg("customMessageLabel", "┃"),
          text: ctx.ui.theme.fg("userMessageText", "X"), background: ctx.ui.theme.bg("userMessageBg", "X"),
          bottom: ctx.ui.theme.style("▀", { fg: ctx.ui.theme.colors.userMessageBg }),
          model: ctx.ui.theme.fg("mdHeading", "X"), provider: ctx.ui.theme.fg("muted", "X"),
          parent: ctx.ui.theme.fg("dim", "X"), directory: ctx.ui.theme.fg("mdLinkUrl", "X"), branch: ctx.ui.theme.fg("text", "X"),
          colon: ctx.ui.theme.fg("muted", "X"), separator: ctx.ui.theme.fg("dim", "X"), activity: ctx.ui.theme.fg("accent", "X"), idle: ctx.ui.theme.fg("muted", "X"),
          thinking: ctx.ui.theme.getThinkingBorderColor(ctx.thinkingLevel ?? pi.getThinkingLevel())("X") },
      }, null, 2));
      tui.requestRender();
    },
  });
}
