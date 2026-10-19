/** One request's transport-populated admission evidence; never reuse for another reply. */
export interface ReplySize { ticket?: string; bytes?: number }

/** Transports already bounded this exact reply; raw decoder callers still need a full check. */
export function replyJsonBytes(value: unknown, ticket: string, cap: number, measured?: Readonly<ReplySize>): number {
  if (measured?.ticket !== ticket) return dataJsonBytes(value, cap);
  const bytes = measured.bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > cap) throw new Error('data JSON byte limit');
  return bytes;
}

// Canonical JSON policy bytes, without stringify, hooks or source-sized temporaries.
// Shared SDK ingress has already parsed its private frame before this boundary.
export function dataJsonBytes(value: unknown, cap: number, rejectHooks = false): number {
  let count = 0;
  const ancestors = new Set<object>();
  const add = (bytes: number) => { count += bytes; if (count > cap) throw new Error('data JSON byte limit'); };
  function string(text: string) {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 32) add(c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6);
      else if (c === 34 || c === 92) add(2);
      else if (c < 128) add(1);
      else if (c < 2048) add(2);
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (c >= 0xd800 && c <= 0xdfff) throw new Error('invalid data JSON surrogate');
      else add(3);
    }
  }
  function visit(item: unknown, depth: number) {
    if (depth > 64) throw new Error('invalid data JSON depth');
    if (item === null) { add(4); return; }
    if (typeof item === 'string') { string(item); return; }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return; }
    if (typeof item === 'number' && Number.isFinite(item)) { add(String(item).length); return; }
    if (typeof item !== 'object' || !item || ancestors.has(item)) throw new Error('invalid data JSON');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('invalid data JSON object');
    if (rejectHooks && 'toJSON' in item) throw new Error('invalid data JSON hook');
    ancestors.add(item); add(2);
    if (array) {
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor)) throw new Error('invalid data JSON accessor');
        if (i) add(1); visit(descriptor.value, depth + 1);
      }
    } else {
      let entries = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new Error('invalid data JSON accessor');
        if (entries++) add(1); string(key); add(1); visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return count;
}
