// Real CLI footer/data controls; no production monkey-patches or model credentials.
import { AgentSession, SessionManager, CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { writeDiagnosticJson } from './terminal-output.ts';
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { footerDiagnostics } from "../../src/footer.ts";
import tidyUi from "./presentation-driver.ts";

export default function footerDriver(pi: ExtensionAPI) {
  let nameGate: Promise<void> | undefined, releaseName: (() => void) | undefined, nameDelivered: (() => void) | undefined;
  pi.on("session_info_changed", async () => {
    if (nameGate) { const gate = nameGate; nameGate = undefined; await gate; }
  });
  // One loader graph keeps numeric diagnostics attached to the actual presenter.
  // The native control does not activate pi-tidy-ui or install any of its hooks.
  if (process.env.TIDY_UI_TEST_FOOTER_PRESENTATION === "1") tidyUi(pi);
  pi.on("session_info_changed", () => { nameDelivered?.(); nameDelivered = undefined; });
  const output = process.env.TIDY_UI_TEST_OUTPUT!;
  let tui: any;
  const observed = { scans: 0, contextReads: 0, nameReads: 0 };
  const entries = SessionManager.prototype.getEntries, context = AgentSession.prototype.getContextUsage, getName = SessionManager.prototype.getSessionName;
  SessionManager.prototype.getEntries = function () { observed.scans++; return entries.call(this); };
  AgentSession.prototype.getContextUsage = function () { observed.contextReads++; return context.call(this); };
  SessionManager.prototype.getSessionName = function () { observed.nameReads++; return getName.call(this); };
  const statuses = new Map<string, string>();
  let foreignDisposals = 0, nameActionReads = 0;
  const identities = new WeakMap<object, number>(); let nextIdentity = 0;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("footer-probe", value => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("footer-probe", undefined);
    if (!(ctx.sessionManager instanceof SessionManager)) throw new Error("Public SDK SessionManager identity differs from the real CLI");
    // An explicit persisted side-usage fixture, not another model request or context message.
    // Readonly API is a type restriction: test-only native record creation uses the exported class.
    const manager = ctx.sessionManager as SessionManager;
    if (!manager.getEntries().some(e => e.type === "usage" && e.kind === "footer-fixture")) manager.appendUsage("footer-fixture", "tidy-ui-offline", "scripted", {
      input: 11000000, output: 1500000, cacheRead: 243000000, cacheWrite: 0, totalTokens: 255500000,
      cost: { input: 61.761, output: 0, cacheRead: 0, cacheWrite: 0, total: 61.761 },
    });
  });
  pi.on("session_shutdown", () => {
    releaseName?.(); releaseName = undefined;
    SessionManager.prototype.getEntries = entries; AgentSession.prototype.getContextUsage = context; SessionManager.prototype.getSessionName = getName;
  });
  pi.registerShortcut("ctrl+alt+f", {
    description: "Observe real footer/status slots and native session work without exchanging draft input",
    handler: async ctx => {
      const { name, action = "snapshot", sessionName } = JSON.parse(readFileSync(join(output, "footer-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid footer observation name");
      const publish = (key: string, value?: string) => {
        if (value === undefined) statuses.delete(key); else statuses.set(key, value);
        ctx.ui.setStatus(key, value);
      };
      if (action === "name" || action === "delayed-name") {
        if (action === "delayed-name") {
          const signal = join(output, "footer-name-release");
          nameGate = new Promise(resolve => {
            const watcher = watch(output, () => { if (existsSync(signal)) releaseName?.(); });
            releaseName = () => { watcher.close(); releaseName = undefined; resolve(); };
          });
          const component = tui.children[6].children[0], original = component.render;
          const descriptor = Object.getOwnPropertyDescriptor(component, "render");
          Object.defineProperty(component, "render", { configurable: true, value(width: number) {
            const rows = original.call(this, width);
            writeFileSync(join(output, "delayed-name-frame.json"), JSON.stringify({ width, rows, counters: { ...observed, ...footerDiagnostics() } }));
            if (rows.some((row: string) => stripVTControlCharacters(row).includes(sessionName))) {
              if (descriptor) Object.defineProperty(component, "render", descriptor); else delete component.render;
            }
            return rows;
          } });
        }
        const delivered = action === "name" ? new Promise<void>(resolve => { nameDelivered = resolve; }) : undefined;
        const before = observed.nameReads;
        pi.setSessionName(sessionName);
        nameActionReads = observed.nameReads - before;
        if (delivered) await delivered;
      }
      else if (action === "statuses") {
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
      writeDiagnosticJson(output, name, { width, rows, owner: footer.constructor.name,
        counters: { ...observed, ...footerDiagnostics() }, statuses: [...statuses], foreignDisposals, nameActionReads,
        session: ctx.sessionManager.getSessionFile(), idle: ctx.isIdle(), ...record,
        nativeStatusRows: tui.children[2].render(width), statusIdentity: indicator ? identities.get(indicator) : undefined,
        styles: Object.fromEntries((["text", "muted", "dim", "success", "warning", "error"] as const).map(role => [role, ctx.ui.theme.fg(role, "X")])) }, 2);
      tui.requestRender();
    },
  });
}
