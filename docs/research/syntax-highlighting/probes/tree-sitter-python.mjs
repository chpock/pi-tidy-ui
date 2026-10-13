// Research-only complete upstream Python highlights query; no injections/locals renderer.
// Query provenance: tree-sitter/tree-sitter-python@26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64.
// See python-query-LICENSE.txt. WASM grammar comes from @vscode/tree-sitter-wasm@0.3.1.
// npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 --no-package-lock --ignore-scripts --no-audit --no-fund web-tree-sitter@0.27.0 @vscode/tree-sitter-wasm@0.3.1
// node docs/research/syntax-highlighting/probes/tree-sitter-python.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = process.env.SHIKI_RESEARCH_ROOT ?? '/tmp/pi-tidy-ui-syntax-research-20261006';
const start = performance.now();
const { Parser, Language, Query } = await import(pathToFileURL(`${root}/node_modules/web-tree-sitter/web-tree-sitter.js`).href);
await Parser.init();
const language = await Language.load(`${root}/node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm`);
const parser = new Parser();
parser.setLanguage(language);
const query = new Query(language, readFileSync(new URL('./python-highlights.scm', import.meta.url), 'utf8'));
const initializationMs = performance.now() - start;
const source = 'result = client.fetch(user.id) if user.active else fallback';
const tree = parser.parse(source);
assert.ok(tree);
assert.equal(tree.rootNode.hasError, false);
const captures = query.captures(tree.rootNode);
const captureSummary = captures.map(({ name, node, patternIndex }) => ({ name, text: node.text, start: node.startIndex, end: node.endIndex, patternIndex }));
for (const word of ['result', 'client', 'user', 'fallback']) assert.ok(captureSummary.some(c => c.name === 'variable' && c.text === word));
assert.ok(captureSummary.some(c => c.name === 'function.method' && c.text === 'fetch'));
assert.ok(captureSummary.some(c => c.name === 'property' && c.text === 'active'));
const nonWhitespace = [...source].filter(c => !/\s/u.test(c)).length;
const identifierCoverage = new Set(captures.filter(c => /^(variable|property|function)(\.|$)/u.test(c.name)).flatMap(c => Array.from({ length: c.node.endIndex - c.node.startIndex }, (_, i) => c.node.startIndex + i)));
const recognizedNameCells = [...identifierCoverage].filter(i => !/\s/u.test(source[i])).length;
console.log(JSON.stringify({ node: process.version, runtime: 'web-tree-sitter@0.27.0', grammarDistribution: '@vscode/tree-sitter-wasm@0.3.1',
  queryCommit: '26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64', initializationMs, source, parseError: tree.rootNode.hasError,
  recognizedNameCells, nonWhitespace, captures: captureSummary }));
// Parse + capture timing only; no overlap resolution, injections, ANSI or TUI.
const large = Array.from({ length: 1000 }, (_, i) => `result${i} = client.fetch(user.id) if user.active else fallback`).join('\n');
const times = []; let calls = 0;
for (let i = 0; i < 21; i++) {
  const started = performance.now(); const t = parser.parse(large); query.captures(t.rootNode); t.delete(); calls++;
  times.push(performance.now() - started);
}
const firstMs = times.shift(); times.sort((a, b) => a - b);
console.log(JSON.stringify({ benchmark: { lines: 1000, utf16Units: large.length, calls, firstMs, medianMs: times[10], p95Ms: times[18] },
  caveat: 'Python only; full terminal highlighting and other languages not benchmarked. Not comparable to the TypeScript Shiki workload.' }));
tree.delete(); query.delete(); parser.delete();
