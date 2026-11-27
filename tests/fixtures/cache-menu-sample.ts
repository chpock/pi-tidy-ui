import type { CacheMenuSnapshot } from '../../src/application/menu-contract.ts';
import { PresentationCacheOwner } from '../../src/presentation/cache-owner.ts';

export function cacheMenuSample(layouts = 2): CacheMenuSnapshot {
  const owner = new PresentationCacheOwner();
  for (let i = 0; i < layouts; i++) owner.ordinary.put('summary', ['→ read file.ts']);
  return { active: true, stats: owner.stats(), heapUsedBytes: 123456 };
}
