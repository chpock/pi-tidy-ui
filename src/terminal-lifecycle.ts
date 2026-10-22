import type { Terminal } from '@earendil-works/pi-tui';

export interface TerminalLifecycle { suspend(): void; resume(): void }

/** The terminal object survives renderer switches; the TUI facade's method identities do not. */
export function bindTerminalLifecycle(terminal: unknown, ...owners: TerminalLifecycle[]): (() => void) | undefined {
  if (!terminal || typeof terminal !== 'object') return undefined;
  const host = terminal as Pick<Terminal, 'start' | 'stop'>;
  const hooks = (['start', 'stop'] as const).map(key => ({ key,
    own: Object.getOwnPropertyDescriptor(host, key), original: host[key] }));
  if (hooks.some(({ own, original }) => typeof original !== 'function' ||
    (own ? !('value' in own) || (!own.configurable && !own.writable) : !Object.isExtensible(host)))) return undefined;
  const state = { active: true, owners: owners.map(owner => new WeakRef(owner)) };
  const reference = new WeakRef(host);
  const wrappers = hooks.map(hook => {
    const wrapper = lifecycleMethod(hook.original, hook.key, state);
    return { ...hook, wrapper };
  });
  function detach() {
    state.active = false;
    const current = reference.deref();
    if (!current) return;
    for (const { key, own, wrapper } of wrappers) {
      if (Object.getOwnPropertyDescriptor(current, key)?.value !== wrapper) continue;
      if (own) Object.defineProperty(current, key, own);
      else delete (current as Partial<typeof current>)[key];
    }
  }
  try {
    for (const { key, own, wrapper } of wrappers)
      Object.defineProperty(host, key, own ? { ...own, value: wrapper } : { configurable: true, writable: true, value: wrapper });
  } catch { detach(); return undefined; }
  return detach;
}

function lifecycleMethod(original: (...args: never[]) => unknown, key: 'start' | 'stop',
  state: { active: boolean; owners: WeakRef<TerminalLifecycle>[] }) {
  return function(this: unknown, ...args: unknown[]) {
    if (key === 'stop' && state.active) for (const owner of state.owners) owner.deref()?.suspend();
    const result = Reflect.apply(original, this, args);
    if (key === 'start' && state.active) for (const owner of state.owners) owner.deref()?.resume();
    return result;
  };
}
