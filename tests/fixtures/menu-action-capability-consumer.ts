import type { MenuActionCapabilities, MenuThemeConfirmation } from '../../src/application/menu-actions.ts';

function consumer(capabilities: MenuActionCapabilities): void {
  // @ts-expect-error Action policy cannot start or watch preference loading.
  capabilities.preferences.watch();
  // @ts-expect-error Native scope creation remains in application composition.
  capabilities.preferences.openThemeScope();
  // @ts-expect-error Theme confirmation is one scoped operation, not a second preference capability.
  capabilities.preferences.confirmTheme();
  // @ts-expect-error A signal does not grant abort-controller authority.
  capabilities.scope.signal.abort();
  // @ts-expect-error Recording operations do not lend a mutable logger or sink.
  capabilities.recording.sink('INFO', 'runtime', 'arbitrary write');
  // @ts-expect-error Clearing must return an eager receipt, not a later collection promise.
  capabilities.clearLayouts = async () => [];
  // @ts-expect-error The policy has no native runtime to capture independently.
  capabilities.syntax.dispose();
}
function retiredReceipt(): MenuThemeConfirmation {
  // @ts-expect-error A retired confirmation does not carry a completed outcome.
  return { kind: 'retired', outcome: { ok: true } };
}
void consumer; void retiredReceipt;
