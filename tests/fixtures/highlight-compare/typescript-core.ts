/* Type syntax remains distinct from keyword-looking literal text. */
import type { Buffer } from 'node:buffer';

// This comment is part of the source context, not an executable statement.
export const keywordText = 'interface class await return';

export interface Entry<T extends string | number = string> {
  readonly key: T;
  value?: T;
}

export type PartialEntry<T> = { [K in keyof T]?: T[K] };
export type Unwrap<T> = T extends PromiseLike<infer Value> ? Unwrap<Value> : T;
export type EventName<Key extends string> = `on:${Key}`;

export const phases = ['idle', 'busy', 'done'] as const;
export type Phase = typeof phases[number];
export const rank = { idle: 0, busy: 1, done: 2 } satisfies Readonly<Record<Phase, number>>;

export enum Direction { Forward = 1, Backward = -1 }
export namespace Labels {
  export const ready = 'ready';
}

function register<T extends Function>(value: T, context: ClassDecoratorContext): T {
  void context;
  return value;
}

@register
export class QueueItem {
  constructor(public readonly name: string, private retries = 2) {}

  get remaining(): number { return this.retries; }
  retry(): void { this.retries -= 1; }
}

export function byteLength(buffer: Buffer): number {
  return buffer.byteLength;
}
