import type { TidyMenuRow, TidyMenuIntent, TidyMenuAction } from '../../src/application/menu-contract.ts';

/** Native widget identities carry closed intentions, not captured action values or callbacks. */
export function menuContractCapabilities(row: TidyMenuRow): void {
  void row.intent;
  // @ts-expect-error A displayed row must have its own typed intention.
  const missing: TidyMenuRow = { value: 'colors', label: 'Terminal colors', help: '' };
  // @ts-expect-error Switch intentions resolve the current value only at activation.
  const stale: TidyMenuIntent = { kind: 'toggle', key: 'terminalColorsEnabled', value: false };
  // @ts-expect-error Menu data does not execute actions through retained callbacks.
  const callback: TidyMenuIntent = { kind: 'maintain', action: () => undefined };
  // @ts-expect-error Navigation has a fixed page model, not a dynamic registry.
  const page: TidyMenuIntent = { kind: 'navigate', page: 'unknown' };
  // @ts-expect-error Maintenance commands are a closed domain.
  const command: TidyMenuAction = { kind: 'restartProvider' };
  void [missing, stale, callback, page, command];
}
