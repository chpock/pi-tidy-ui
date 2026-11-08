import { strict as assert } from 'node:assert';

/* Comments are syntax; keyword-like spellings in a string are data. */
// Keep both comment forms in this inert module.
export const keywordText = 'await class function return';

export const count = 1_000_000;
export const integerForms = [42, 0x2A, 0o52, 0b101010];
export const decimalForms = [42.5, 1.25e+2];
export const bigCount = 42n;
export const escaped = "quote: \" slash: \\ newline: \n tab: \t";
export const rawText = `first line\nsecond: ${count.toString(16)}`;
export const matcher = /^(?:ready|done)\s+\p{L}+$/u;
export const quotient = count / 4;

export class Shelf {
  #items = [];
  static label = 'items';
  static { this.label = this.label.toUpperCase(); }

  constructor({ capacity = 3, ...metadata } = {}) {
    this.capacity = capacity;
    this.metadata = metadata;
  }

  add(...values) { this.#items.push(...values); }
  first() { return this.#items[0] ?? null; }
  get size() { return this.#items?.length ?? 0; }
}

export async function* records(source = []) {
  const [first, ...rest] = source;
  yield first?.name ?? 'empty';
  for await (const item of rest) yield item;
}

export async function resolveName(load) {
  const select = value => value?.name ?? 'anonymous';
  return select(await load());
}

export default function verify(value) {
  assert.ok(value !== undefined);
  return value?.name ?? 'anonymous';
}
