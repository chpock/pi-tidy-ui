import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SyntaxRuntime } from '../../src/syntax/runtime.ts';

interface PerformanceAdapter {
  runtime(): SyntaxRuntime | undefined;
  controller(): object | undefined;
  ready(ids: Set<string>, profile?: string): boolean;
  diagnostics(ids: Set<string>): unknown;
  restore(): void;
}

export function registerPerformanceDriver(pi: ExtensionAPI,
  adapter?: (pi: ExtensionAPI, scenario: { variant: 'on' | 'off' }) => PerformanceAdapter): Promise<void>;
export default function performanceDriver(pi: ExtensionAPI): Promise<void>;
