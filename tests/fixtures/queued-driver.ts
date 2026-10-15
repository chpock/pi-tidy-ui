// Real native queues and editing; only the observer/control shortcut is test-owned.
import { type ExtensionAPI, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { writeDiagnosticJson } from './terminal-output.ts';
import { join } from "node:path";
import tidyUi from "./presentation-driver.ts";

const nativeRender = Container.prototype.render;
export default function queuedDriver(pi: ExtensionAPI) {
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  const native = process.env.TIDY_UI_TEST_QUEUE_NATIVE === "1";
  let control: RegisteredCommand["handler"] | undefined, tui: any;
  if (!native) tidyUi({ ...pi, registerCommand(name, options) {
    if (name === "tidy-ui") control = options.handler;
    pi.registerCommand(name, options);
  } });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("queued-probe", value => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("queued-probe", undefined);
  });
  pi.registerShortcut("ctrl+alt+y", {
    description: "Observe queue cards without submitting or exchanging the current draft",
    handler: async ctx => {
      const { name, action = "snapshot" } = JSON.parse(readFileSync(join(output, "queued-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid queue observation name");
      const context = ctx;
      const editor = tui.children[4].children[0];
      const state = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() });
      const before = state();
      if (action === 'dark' || action === 'light') ctx.ui.setTheme(action);
      else if (!['on', 'off', 'cache clear', 'snapshot'].includes(action)) throw new Error('Unknown queue action');
      // The PTY parent navigates the real overlay, preserving this pending draft.
      if (control) await control('', context as never);
      const width = tui.terminal.columns, height = tui.terminal.rows, group = tui.children[1];
      const rows = group.render(width);
      // A native-control render must not refresh the production group's mouse
      // bookkeeping and conceal stale-owner/geometry defects in the adapter.
      const nativeProbe = new Container(); nativeProbe.children = group.children;
      const nativeRows = nativeRender.call(nativeProbe, width);
      const stats = control ? JSON.parse(readFileSync(join(output, `${name}-menu-stats.json`), 'utf8')) : undefined;
      writeDiagnosticJson(output, name, { width, height, rows,
        nativeRows, raw: group.children.map((node: object) => Object.getOwnPropertyDescriptor(node, "text")?.value).filter((value: unknown) => typeof value === "string"),
        before, after: state(), pending: ctx.hasPendingMessages(), session: ctx.sessionManager.getSessionFile(),
        stats,
        styles: { border: ctx.ui.theme.fg("customMessageLabel", "X"), panel: ctx.ui.theme.bg("userMessageBg", "X"),
          text: ctx.ui.theme.fg("userMessageText", "X"), dim: ctx.ui.theme.fg("dim", "X"), muted: ctx.ui.theme.fg("muted", "X") },
      }, 2);
      tui.requestRender();
    },
  });
}
