import type { ToolCallSnapshot } from '../contracts.ts';

export function resultDetails(call: ToolCallSnapshot): Record<string, unknown> {
  const value = call.result?.details;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
