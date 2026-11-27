import type { LayoutKind } from '../render-cache.ts';
import type { CacheMenuPage, CacheMenuSnapshot, TidyMenuPage } from './menu-contract.ts';

export function isCacheMenuPage(page: TidyMenuPage): page is CacheMenuPage {
  return page === 'cache' || page === 'cacheActivity';
}

const layoutLabels = {
  summary: 'Compact tool summaries', bash: 'Bash cards', read: 'Read cards', edit: 'Edit cards', write: 'Write cards',
  user: 'User messages', queued: 'Queued messages',
} satisfies Record<LayoutKind, string>;
const activity = {
  hits: 'Cache hits', misses: 'Cache misses', builds: 'Layouts built', releases: 'Layouts released',
  collected: 'Of those, collected by GC',
} as const;
const integers = new Intl.NumberFormat('en-US');
const count = (value: number) => integers.format(value);
const sizeUnits = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;
function displaySize(bytes: number): string {
  let amount = bytes / 1024, unit = 0;
  while (amount >= 1024 && unit < sizeUnits.length - 1) { amount /= 1024; unit++; }
  const decimal = amount.toPrecision(amount < 1 ? 3 : 4);
  return `${decimal.includes('.') ? decimal.replace(/\.?0+$/u, '') : decimal} ${sizeUnits[unit]}`;
}

/** Fixed ASCII labels and numeric values; lengths here are terminal column counts. */
function table(headings: string[], values: string[][], width: number): string[] {
  const rows = [headings, ...values];
  const columns = headings.map((_, i) => Math.max(...rows.map(row => row[i]!.length)));
  if (columns.reduce((total, cells) => total + cells, 2 * (columns.length - 1)) > width)
    return values.flatMap(([label, ...cells]) => [label!, ...cells.map((cell, i) => `  ${headings[i + 1]}: ${cell}`)]);
  return rows.map(row => row.map((text, i) => i === 0 ? text.padEnd(columns[0]!) : text.padStart(columns[i]!)).join('  '));
}

export function cacheClearResult(layouts: number): string {
  return layouts === 0 ? 'No saved layouts to clear.' : `Cleared ${count(layouts)} ${layouts === 1 ? 'layout' : 'layouts'}.`;
}

export function cacheMenuDetails(page: CacheMenuPage, snapshot: CacheMenuSnapshot | undefined, width: number): string[] {
  if (!snapshot) return [page === 'cache' ? 'Display cache unavailable.' : 'Layout cache activity unavailable.'];
  const { active, stats, footer, heapUsedBytes } = snapshot;
  if (page === 'cacheActivity') {
    const rows = (Object.keys(activity) as (keyof typeof activity)[]).map(key =>
      [activity[key], count(stats[key]), count(stats.cards[key]), count(stats.ordinary[key])]);
    return [...table(['', 'Total', 'Tool cards', 'Other layouts'], rows, width), '',
      'Cumulative since the cache started. Footer not counted.', 'A cache miss does not always build a layout.'];
  }
  const layoutRow = (label: string, { entries, rows, retainedBytes }: typeof stats.byKind.summary) =>
    [label, count(entries), count(rows), displaySize(retainedBytes)];
  const total = { entries: stats.entries + (footer?.entries ?? 0), rows: stats.rows + (footer?.rows ?? 0),
    retainedBytes: stats.retainedBytes + (footer?.retainedBytes ?? 0),
    stringBytes: stats.stringBytes + (footer?.stringBytes ?? 0), overheadBytes: stats.overheadBytes + (footer?.overheadBytes ?? 0) };
  const rows = [layoutRow('Total', total), ...(Object.keys(layoutLabels) as LayoutKind[]).map(kind => layoutRow(layoutLabels[kind], stats.byKind[kind]))];
  if (footer) rows.push(layoutRow('Tidy UI footer', footer));
  return [...table(['Type', 'Layouts', 'Rows', 'Est. size'], rows, width),
    ...(!footer ? ['Tidy UI footer: Not owned by Tidy UI.'] : []), '',
    'Tidy UI display layouts only. Not the model prompt cache.',
    ...(!active ? ['Tidy UI appearance is inactive.'] : []),
    `Estimated text: ${displaySize(total.stringBytes)}`,
    `Estimated bookkeeping: ${displaySize(total.overheadBytes)}`,
    ...(heapUsedBytes === undefined ? [] : [`Whole Pi JS heap: ${displaySize(heapUsedBytes)} (not the display cache).`])];
}
