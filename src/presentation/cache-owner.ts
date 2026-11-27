import { LAYOUT_KINDS, MEMORY_FIELDS, RenderCache, type CacheStats, type LayoutKind, type LayoutMemory } from '../render-cache.ts';

export interface PresentationCacheStats extends CacheStats {
  ordinary: CacheStats;
  cards: CacheStats;
}

export class PresentationCacheOwner {
  readonly ordinary = new RenderCache();
  readonly cards = new RenderCache();

  stats(): PresentationCacheStats {
    const ordinary = this.ordinary.stats(), cards = this.cards.stats();
    return { ordinary, cards,
      retainedBytes: ordinary.retainedBytes + cards.retainedBytes,
      stringBytes: ordinary.stringBytes + cards.stringBytes,
      overheadBytes: ordinary.overheadBytes + cards.overheadBytes,
      rows: ordinary.rows + cards.rows,
      entries: ordinary.entries + cards.entries,
      hits: ordinary.hits + cards.hits,
      misses: ordinary.misses + cards.misses,
      builds: ordinary.builds + cards.builds,
      releases: ordinary.releases + cards.releases,
      collected: ordinary.collected + cards.collected,
      byKind: Object.fromEntries(LAYOUT_KINDS.map(kind => {
        const memory = { ...ordinary.byKind[kind] };
        for (const field of MEMORY_FIELDS) memory[field] += cards.byKind[kind][field];
        return [kind, memory];
      })) as Record<LayoutKind, LayoutMemory> };
  }

  reconcileCollected(): void {
    this.ordinary.reconcileCollected();
    this.cards.reconcileCollected();
  }

  clear(): number {
    return this.ordinary.clear() + this.cards.clear();
  }
}
