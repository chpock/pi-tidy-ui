import type { ContextRef } from './storage/context-arena.ts';
import type { ContextArena } from './storage/context-arena.ts';
import type { SemanticRetentionPool } from './storage/semantic-retention.ts';
import type { CaptureSelection } from './storage/ready-display-publication.ts';

export interface StyleContextPlan<Ref extends ContextRef> {
  readonly refs: Ref[];
  readonly missing: Ref[];
}
export interface StyleRepresentationEstimate {
  readonly fits: boolean;
  readonly encodedPeak: number;
  readonly capturePeak: number;
}

export function collectStyleContexts<Member extends { generation: number }, Ref extends ContextRef>(members: readonly Member[],
  visit: (member: Member, add: (ref: Ref) => void) => boolean,
  hasStyle: (ref: Ref) => boolean, visited: () => void): StyleContextPlan<Ref> | undefined {
  const unique = new Set<Ref>();
  const add = (ref: Ref) => { visited(); unique.add(ref); };
  for (const member of members) if (!visit(member, add)) return undefined;
  const refs = [...unique];
  return { refs, missing: refs.filter(ref => !hasStyle(ref)) };
}

export function estimateStyleRepresentation(arena: ContextArena, pool: SemanticRetentionPool, vocabulary: string,
  missing: readonly ContextRef[], captures: readonly CaptureSelection[], maxWords: number): StyleRepresentationEstimate {
  let encodedPeak = 0, capturePeak = 0, fits = false;
  arena.encode(vocabulary, missing, bytes => { fits = true; encodedPeak = bytes; return false; }, maxWords);
  if (fits && captures.length) pool.captureDisplays(captures, bytes => { capturePeak = bytes; return false; });
  return { fits, encodedPeak, capturePeak };
}
