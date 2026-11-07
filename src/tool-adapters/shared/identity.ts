const identities = new WeakMap<object, object>();

export function weakIdentity(value: unknown): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  let identity = identities.get(value as object);
  if (!identity) { identity = {}; identities.set(value as object, identity); }
  return identity;
}
