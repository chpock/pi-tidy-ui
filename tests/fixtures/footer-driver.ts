// Real CLI footer/data controls; no production monkey-patches or model credentials.
import { AgentSession, SessionManager, CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { footerDiagnostics } from "../../src/footer.ts";
import toolview from "./presentation-driver.ts";

export default function footerDriver(pi: ExtensionAPI) {
  // One loader graph keeps numeric diagnostics attached to the actual presenter.
  // The native control does not activate Toolview or install any of its hooks.
  if (process.env.TOOLVIEW_TEST_FOOTER_PRESENTATION === "1") toolview(pi);
  const output = process.env.TOOLVIEW_TEST_OUTPUT!;
  let tui: any;
  const observed = { scans: 0, contextReads: 0 };
  const entries = SessionManager.prototype.getEntries, context = AgentSession.prototype.getContextUsage;
  SessionManager.prototype.getEntries = function () { observed.scans++; return entries.call(this); };
  AgentSession.prototype.getContextUsage = function () { observed.contextReads++; return context.call(this); };
  const statuses = new Map<string, string>();
  let foreignDisposals = 0;
  const identities = new WeakMap<object, number>(); let nextIdentity = 0;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("footer-probe", value => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("footer-probe", undefined);
    if (!(ctx.sessionManager instanceof SessionManager)) throw new Error("Public SDK SessionManager identity differs from the real CLI");
    // An explicit persisted side-usage fixture, not another model request or context message.
    // Readonly API is a type restriction: test-only native record creation uses the exported class.
    const manager = ctx.sessionManager as SessionManager;
    if (!manager.getEntries().some(e => e.type === "usage" && e.kind === "footer-fixture")) manager.appendUsage("footer-fixture", "toolview-offline", "scripted", {
      input: 11000000, output: 1500000, cacheRead: 243000000, cacheWrite: 0, totalTokens: 255500000,
      cost: { input: 61.761, output: 0, cacheRead: 0, cacheWrite: 0, total: 61.761 },
    });
  });
  pi.on("session_shutdown", () => {
    SessionManager.prototype.getEntries = entries; AgentSession.prototype.getContextUsage = context;
  });
  pi.registerShortcut("ctrl+alt+f", {
    description: "Observe real footer/status slots and native session work without exchanging draft input",
    handler: async ctx => {
      const { name, action = "snapshot" } = JSON.parse(readFileSync(join(output, "footer-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid footer observation name");
      const publish = (key: string, value?: string) => {
        if (value === undefined) statuses.delete(key); else statuses.set(key, value);
        ctx.ui.setStatus(key, value);
      };
      if (action === "statuses") {
        publish("z-probe", ctx.ui.theme.style("OTHER_STATUS", { fg: "accent", bold: true }));
        publish("a-probe", ctx.ui.theme.fg("success", "mc: 104.5K (51%) · idle"));
      } else if (action === "long") publish("a-probe", ctx.ui.theme.fg("success", "LONG_STATUS_" + "界é".repeat(60)));
      else if (action === "clear") { for (const key of [...statuses.keys()]) publish(key); }
      else if (action === "delete") publish("z-probe");
      else if (action === "light" || action === "dark") ctx.ui.setTheme(action);
      else if (action === "native-separate") ctx.ui.setEditorComponent((value, theme, keys) => new CustomEditor(value, theme, keys, { embedWorkingStatus: false }));
      else if (action === "foreign") ctx.ui.setFooter(() => ({ render: () => ["FOREIGN_FOOTER"], invalidate() {}, dispose() { foreignDisposals++; } }));
      else if (action !== "snapshot" && action !== "accounting") throw new Error("Unknown footer action");
      if (tui.children.length !== 7) throw new Error("Native seven-slot layout changed; footer control must be updated");
      const width = process.stdout.columns || 100, footer = tui.children[6].children[0];
      const rows = footer.render(width);
      const indicator = tui.children[2].children.find((node: any) => typeof node.kind === "string") ?? tui.children[4].children[0]?.workingStatusIndicator; // Test-only ownership observation.
      if (indicator && !identities.has(indicator)) identities.set(indicator, ++nextIdentity);
      const record = action === "accounting" ? { entries: ctx.sessionManager.getEntries(), context: ctx.getContextUsage(),
        settings: pi.getSettings(), model: ctx.model } : {};
      writeFileSync(join(output, `${name}.json`), JSON.stringify({ width, rows, owner: footer.constructor.name,
        counters: { ...observed, ...footerDiagnostics() }, statuses: [...statuses], foreignDisposals,
        session: ctx.sessionManager.getSessionFile(), idle: ctx.isIdle(), ...record,
        nativeStatusRows: tui.children[2].render(width), statusIdentity: indicator ? identities.get(indicator) : undefined,
        styles: Object.fromEntries((["text", "muted", "dim", "success", "warning", "error"] as const).map(role => [role, ctx.ui.theme.fg(role, "X")])) }, null, 2));
      tui.requestRender();
    },
  });
}
