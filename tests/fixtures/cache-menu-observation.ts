import assert from 'node:assert/strict';

const layoutTypes = {
  summary: 'Compact tool summaries', bash: 'Bash cards', read: 'Read cards', edit: 'Edit cards',
  write: 'Write cards', user: 'User messages', queued: 'Queued messages', footer: 'Tidy UI footer',
};
const counters = {
  hits: 'Cache hits', misses: 'Cache misses', builds: 'Layouts built', releases: 'Layouts released',
  collected: 'Of those, collected by GC',
} as const;

type Counters = Record<keyof typeof counters, number>;
function integer(text: string, label: string) {
  assert.match(text, /^\d+(?:,\d{3})*$/u, label);
  const value = Number(text.replaceAll(',', ''));
  assert.ok(Number.isSafeInteger(value), label);
  return value;
}

function dataRow(rows: string[], label: string, headings: readonly [string, string, string]): [string, string, string] {
  let end = -1, cells: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith(`${label}  `)) { end = i; cells = row.split(/ {2,}/u).slice(1); break; }
    if (!row) continue;
    let candidate = row, last = i;
    while (label.startsWith(`${candidate} `) && rows[last + 1]) candidate += ` ${rows[++last]}`;
    if (candidate === label) { end = last; break; }
  }
  assert.ok(end >= 0, `missing ${label} in the visible details`);
  const cell = (i: number) => {
    const prefix = `${headings[i]}: `;
    const line = rows[end + 1 + i]?.trim();
    const text = cells.length ? cells[i] : line?.startsWith(prefix) ? line.slice(prefix.length) : undefined;
    assert.ok(text !== undefined, `${label}: ${headings[i]} is visible`);
    return text;
  };
  return [cell(0), cell(1), cell(2)];
}

const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
function displayedSize(text: string, label: string) {
  const match = /^(\d+(?:\.\d+)?) ([KMGTPE]iB)$/u.exec(text);
  assert.ok(match, `${label}: expected a binary size, got ${text}`);
  const amount = Number(match[1]), scale = 1024 ** (1 + units.indexOf(match[2]!));
  const bytes = amount * scale;
  // Decimal zeroes are stripped by presentation, so the mantissa's magnitude sets the precision.
  const error = amount === 0 ? 0 : 0.5 * scale * 10 ** (Math.floor(Math.log10(amount)) - (amount < 1 ? 2 : 3));
  return { bytes, error };
}

function assertSizeSum(total: ReturnType<typeof displayedSize>, parts: ReturnType<typeof displayedSize>[], label: string) {
  const sum = parts.reduce((value, part) => value + part.bytes, 0);
  const error = parts.reduce((value, part) => value + part.error, total.error);
  assert.ok(Math.abs(total.bytes - sum) <= error, `${label}: ${total.bytes} differs from ${sum} by more than ${error} bytes`);
}

export function observedCacheLayouts(rows: string[]) {
  const read = (label: string) => {
    const [entries, rowCount, est] = dataRow(rows, label, ['Layouts', 'Rows', 'Est. size']);
    return { entries: integer(entries, `${label}: Layouts`), rows: integer(rowCount, `${label}: Rows`), size: displayedSize(est, `${label}: Est. size`) };
  };
  const reported = read('Total');
  const sizes: ReturnType<typeof displayedSize>[] = [];
  const readPart = (label: string) => {
    const { size, ...counts } = read(label);
    sizes.push(size);
    return { ...counts, retainedBytes: size.bytes };
  };
  const byKind = Object.fromEntries(Object.entries(layoutTypes).filter(([kind]) => kind !== 'footer').map(([kind, label]) => [kind, readPart(label)]));
  const memory = rows.join(' ').replace(/\s+/gu, ' ');
  const footerLayout = memory.includes('Tidy UI footer: Not owned by Tidy UI.') ? undefined : readPart(layoutTypes.footer);
  const fields = ['entries', 'rows', 'retainedBytes'] as const;
  const totals = Object.fromEntries(fields.map(field => [field, Object.values(byKind).reduce((total, kind) => total + kind[field], 0)])) as
    Record<typeof fields[number], number>;
  const sample = (label: string) => {
    const text = new RegExp(`${label}: (\\d+(?:\\.\\d+)? [KMGTPE]iB)`, 'u').exec(memory)?.[1];
    assert.ok(text !== undefined, `${label} is visible`);
    return displayedSize(text, label);
  };
  const text = sample('Estimated text'), bookkeeping = sample('Estimated bookkeeping');
  for (const field of ['entries', 'rows'] as const)
    assert.equal(reported[field], totals[field] + (footerLayout?.[field] ?? 0), `Total ${field} includes exactly the displayed rows`);
  assertSizeSum(reported.size, sizes, 'Total estimated size by layout type');
  assertSizeSum(reported.size, [text, bookkeeping], 'Total estimated size by memory type');
  return { ...totals, byKind, footerLayout, presentationEntries: reported.entries,
    presentationRows: reported.rows, presentationRetainedBytes: reported.size.bytes,
    estimatedTextBytes: text.bytes, estimatedBookkeepingBytes: bookkeeping.bytes,
    processHeapUsedBytes: sample('Whole Pi JS heap').bytes };
}

export function observedCacheActivity(rows: string[]) {
  const total = {} as Counters, ordinary = {} as Counters, cards = {} as Counters;
  for (const [field, label] of Object.entries(counters) as [keyof Counters, string][]) {
    const [all, toolCards, other] = dataRow(rows, label, ['Total', 'Tool cards', 'Other layouts']);
    total[field] = integer(all, `${label}: Total`);
    cards[field] = integer(toolCards, `${label}: Tool cards`);
    ordinary[field] = integer(other, `${label}: Other layouts`);
    assert.equal(total[field], ordinary[field] + cards[field], `${label}: the displayed total equals both groups`);
  }
  // Every insertion creates one entry, and every release removes one.
  const withEntries = (group: Counters) => ({ ...group, entries: group.builds - group.releases });
  return { ...total, ordinary: withEntries(ordinary), cards: withEntries(cards) };
}

export function observedClearResult(rows: string[]): number | undefined {
  if (rows.includes('No saved layouts to clear.')) return 0;
  const receipt = rows.map(row => /^Cleared (\d+(?:,\d{3})*) layouts?\.$/u.exec(row)?.[1]).find(value => value !== undefined);
  return receipt === undefined ? undefined : integer(receipt, 'Cleared layouts');
}
