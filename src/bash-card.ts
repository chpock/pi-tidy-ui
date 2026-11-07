import { blockText } from './plain-text.ts';
import { displayPath } from './display-path.ts';

export interface BashService {
  readonly description: string; readonly heading: string; readonly output: readonly string[];
  readonly first: number; readonly last: number; readonly reminder: number; readonly end: number;
  readonly footer: string; readonly error: boolean;
}
export type BashServiceInput = Omit<BashService, 'description' | 'heading'> & { readonly description?: string };

/** Normalize the frame labels and freeze adapter-owned rows; no producer format is decoded here. */
export function prepareBashService(input: BashServiceInput, directory?: string): BashService {
  const description = typeof input.description === 'string' ? blockText(input.description).replace(/\s+/gu, ' ').trim() : '';
  const heading = directory ? `# Running in ${blockText(displayPath(directory)).replace(/[\n\t]/gu, ' ')}` : '';
  return Object.freeze({ ...input, description, heading, output: Object.freeze(input.output) });
}
