import { highlightCode } from '@earendil-works/pi-coding-agent';
import { Container, Text, type Component } from '@earendil-works/pi-tui';
import type { PiClassifier } from '../../syntax/work.ts';

export const classifyNativeCode: PiClassifier = (text, info) => highlightCode(text, info.language);

export function nativeServiceRows(text: string, width: number, inset: number): readonly string[] {
  return new Text(text, inset, 0).render(width);
}

/** Approved one-field read; absence or an unknown shape never implies fixed mode. */
export function terminalAppearanceTracking(tui: object): boolean | undefined {
  try {
    const value: unknown = Reflect.get(tui, 'terminalColorSchemeNotificationsEnabled');
    return typeof value === 'boolean' ? value : undefined;
  } catch { return undefined; }
}

export interface NativeFooterSlot { current(): boolean }

class FooterSlot implements NativeFooterSlot {
  private readonly slot: WeakRef<Container>;
  private readonly owner: WeakRef<Component>;

  constructor(slot: Container, owner: Component) {
    this.slot = new WeakRef(slot); this.owner = new WeakRef(owner);
  }

  current(): boolean {
    const owner = this.owner.deref();
    return !!owner && this.slot.deref()?.children[0] === owner;
  }
}

/** Observation only: application policy decides whether and when to replace its footer. */
export function observeFooterSlot(tui: object): NativeFooterSlot | undefined {
  const slot = tui instanceof Container && tui.children.length === 7 ? tui.children[6] : undefined;
  return slot instanceof Container && slot.children.length === 1 ? new FooterSlot(slot, slot.children[0]!) : undefined;
}
