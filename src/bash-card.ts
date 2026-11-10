import { blockText } from './plain-text.ts';
import { displayPath } from './display-path.ts';
import type { BashService, BashServiceInput } from './rendering/card-values.ts';

/** Normalize the frame labels and freeze adapter-owned rows; no producer format is decoded here. */
export function prepareBashService(input: BashServiceInput, directory?: string): BashService {
  const description = typeof input.description === 'string' ? blockText(input.description).replace(/\s+/gu, ' ').trim() : '';
  const heading = directory ? `# Running in ${blockText(displayPath(directory)).replace(/[\n\t]/gu, ' ')}` : '';
  return Object.freeze({ ...input, description, heading, output: Object.freeze(input.output) });
}
