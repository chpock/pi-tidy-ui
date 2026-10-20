import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : (JSON.stringify(value) ?? '<undefined>')).digest('hex');
const words = value => stripVTControlCharacters(value).replace(/[\s┃│╹▀]/gu, '');

export function verifyPerformanceTools(nodes, expected, width, variant, carrier = 'sdk') {
  const byId = new Map(nodes.map(node => [node.toolCallId, node]));
  assert.equal(byId.size, expected.length, 'every synthetic native tool remains present');
  const samples = [], checked = new Set();
  for (const item of expected) {
    const actual = byId.get(item.id);
    assert.ok(actual, 'synthetic tool identity retained');
    assert.equal(digest(actual.args), digest(item.args), 'tool arguments preserved exactly');
    for (const field of ['content', 'details', 'isError'])
      assert.equal(digest(actual.result?.[field]), digest(item.result[field]), `restored result ${field} preserved exactly`);
    if (checked.has(item.name)) continue;
    checked.add(item.name);
    const rows = actual.render(width);
    // Every text row consumes input characters; allow fixed chrome without
    // rejecting valid long SDK output that has no native preview renderer.
    const maxRows = 64 + Buffer.byteLength(JSON.stringify({ args: item.args, result: item.result }));
    assert.ok(rows.length > 0 && rows.length <= maxRows, 'representative row count fits admitted data and fixed chrome');
    const text = words(rows.join('\n'));
    const index = item.id.split('-').at(-1);
    const outputLines = item.name === 'bash' ? item.result.content.filter(part => part.type === 'text').flatMap(part => part.text.trimEnd().split('\n')) : [];
    const outputMarker = outputLines[carrier === 'cli' && variant !== 'on' ? outputLines.length - 1 : 0]?.split(/\s/u)[0];
    const markers = item.name === 'bash' ? [`PERF_${index}`, ...(outputMarker ? [outputMarker] : [])]
      : item.name === 'read' ? [variant === 'on' || carrier === 'cli' ? `perf-${index}.txt` : `Readbody${index}`]
      : variant === 'on' ? [`value_${index}`] : [`perf-${index}.js`];
    for (const marker of markers) assert.ok(text.includes(marker), `${item.name} representative content is actually rendered: ${marker}`);
    samples.push({ name: item.name, id: item.id, rows: rows.length, renderedSha256: digest(rows) });
  }
  return { tools: expected.length, resultFieldsExact: true, samples };
}
