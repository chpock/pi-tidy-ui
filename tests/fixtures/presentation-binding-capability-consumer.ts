import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FooterSession } from '../../src/application/footer-session.ts';
import { TerminalColorSession } from '../../src/application/terminal-color-session.ts';

// Compiled but never invoked: application facts do not grant other owners' authority.
export function consumePresentationBindings(context: () => ExtensionContext | undefined) {
  const footerFacts = { context, editorEligible: () => false, appearanceEnabled: () => true,
    journalSink: () => undefined, autoCompaction: () => true };
  const colorFacts = { context, appearanceEnabled: () => true, terminalColorsEnabled: () => false,
    diagnosticSink: () => undefined, journalSink: () => undefined, themeSetting: () => undefined,
    terminalLifecycle: () => ({ suspend() {}, resume() {} }) };
  const footer = new FooterSession(footerFacts), colors = new TerminalColorSession(colorFacts);
  footer.advance(); footer.resetName(); footer.nameChanged(); footer.cancelDeferred();
  footer.clearLayouts(); footer.retainedMemory(); footer.restore();
  colors.status(); colors.stats(); colors.stop();
  // @ts-expect-error slot ownership is read-only to composition
  footer.active = true;
  // @ts-expect-error the actual footer view is not a public mutation capability
  footer.owned.clear();
  // @ts-expect-error color-controller disposal belongs to the binding
  colors.current.dispose();
  // @ts-expect-error acquiring terminal lifecycle does not expose a syntax owner
  colors.syntaxRuntime.setEnabled(false);
  // @ts-expect-error a complete facts object must not accept preference ownership
  new FooterSession({ ...footerFacts, preferences: {} });
  // @ts-expect-error a complete facts object must not accept diagnostic-owner authority
  new TerminalColorSession({ ...colorFacts, diagnostics: {} });
}
