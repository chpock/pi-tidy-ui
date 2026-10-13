// Real isolated extension-owned editor. No production adapter or simulated owner flag:
// every takeover goes through Pi's public editor factory API.
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitDiagnostics } from "../../src/git-branch.ts";

export default function foreignEditorExtension(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let tui: any, current: CustomEditor | undefined;
  let sequence = 0, identity = 0;
  const embedWorkingStatus = process.env.TIDY_UI_TEST_FOREIGN_EMBED === "1";
  let factory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

  class ForeignEditor extends CustomEditor {
    mode = false;
    mouseEvents: TuiMouseEvent[] = [];
    override handleInput(data: string) {
      if (matchesKey(data, "ctrl+alt+x")) { this.mode = !this.mode; tui.requestRender(); return; }
      super.handleInput(data);
    }
    override handleMouse(event: TuiMouseEvent) {
      this.mouseEvents.push({ ...event });
      return super.handleMouse(event);
    }
    protected override renderBottomBorder(width: number, hidden: number) {
      const native = super.renderBottomBorder(width, hidden);
      const label = this.mode ? " OWNER_ON " : " OWNER_OFF ";
      return truncateToWidth(native, Math.max(0, width - label.length), "") + this.borderColor(label);
    }
    override render(width: number) { return super.render(width); }
  }
  const install = (ctx: ExtensionContext, plain = false) => {
    factory = (value, theme, keybindings) => {
      const options = { paddingX: 2, embedWorkingStatus };
      current = plain ? new CustomEditor(value, theme, keybindings, options) :
        new ForeignEditor(value, theme, keybindings, options);
      identity = ++sequence;
      return current;
    };
    ctx.ui.setEditorComponent(factory);
    // The same extension reinstalls its owner on /reload after the one initial
    // deferred takeover. This marker is isolated test control, not session data.
    writeFileSync(join(output, "foreign-installed"), "ready");
  };
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("foreign-observer", value => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("foreign-observer", undefined);
    ctx.ui.setWidget("foreign-upper", () => ({ render: () => ["FOREIGN_UPPER_ROW"], invalidate() {} }));
    ctx.ui.setWidget("foreign-lower", () => ({ render: () => ["FOREIGN_LOWER_ROW"], invalidate() {} }), { placement: "belowEditor" });
    if (process.env.TIDY_UI_TEST_DEFER_EDITOR !== "1" || existsSync(join(output, "foreign-installed"))) install(ctx);
  });
  pi.registerShortcut("ctrl+alt+d", {
    description: "Observe foreign editor state without submitting or replacing its draft",
    handler: async ctx => {
      const { name, action = "snapshot" } = JSON.parse(readFileSync(join(output, "foreign-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid foreign editor observation name");
      const nodes: any[] = [];
      const visit = (node: any) => { if (nodes.includes(node)) return; nodes.push(node); for (const child of node.children ?? []) visit(child); };
      visit(tui);
      const previous = current ?? nodes.find(node => Object.getPrototypeOf(node) === CustomEditor.prototype);
      if (!previous || !nodes.includes(previous)) throw new Error("Actual public editor not found in the live tree");
      const state = (editor: CustomEditor) => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() });
      const before = state(previous);
      if (action === "install" || action === "factory-stock") {
        if (before.text) throw new Error("Test-only owner replacement requires an empty draft; native paste transfer is not claimed");
        install(ctx, action === "factory-stock");
      } else if (action === "dark" || action === "light") ctx.ui.setTheme(action);
      else if (action !== "snapshot") throw new Error("Unknown foreign editor action");
      const editor = current ?? previous;
      const width = process.stdout.columns || 100;
      const rows = editor.render(width);
      // Actual managed groups, not a string-pattern search for our two-row widget.
      if (tui.children.length !== 7) throw new Error("Native managed layout changed; update the integration contract");
      const aboveRows = tui.children[3].render(width), belowRows = tui.children[5].render(width);
      const nativeStatusRows = tui.children[2].render(width);
      writeFileSync(join(output, `${name}.json`), JSON.stringify({ width, rows, aboveRows, belowRows, nativeStatusRows, embedWorkingStatus,
        git: gitDiagnostics(), footerRows: tui.children[6].render(width), footerOwner: tui.children[6].children[0]?.constructor?.name,
        before, after: state(editor), identity, factoryOwned: !!factory && ctx.ui.getEditorComponent() === factory,
        custom: editor instanceof ForeignEditor, mode: editor instanceof ForeignEditor ? editor.mode : undefined,
        mouseEvents: editor instanceof ForeignEditor ? editor.mouseEvents : [],
        ownerMethods: editor instanceof ForeignEditor && editor.render === ForeignEditor.prototype.render &&
          editor.handleInput === ForeignEditor.prototype.handleInput && editor.handleMouse === ForeignEditor.prototype.handleMouse,
        padding: editor.getPaddingX(), menu: editor.isShowingAutocomplete(), idle: ctx.isIdle(),
        session: ctx.sessionManager.getSessionFile(),
      }, null, 2));
      tui.requestRender();
    },
  });
}
