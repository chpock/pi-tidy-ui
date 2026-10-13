// Research-only Lezer and modern highlight.js control, not a terminal adapter.
// npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 --no-package-lock --ignore-scripts --no-audit --no-fund @lezer/javascript@1.5.6 @lezer/python@1.1.19 @lezer/highlight@1.2.5 highlight.js@11.12.0
// node docs/research/syntax-highlighting/probes/pure-js-highlight.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = process.env.SHIKI_RESEARCH_ROOT ?? '/tmp/pi-tidy-ui-syntax-research-20261006';
const at = p => import(pathToFileURL(`${root}/node_modules/${p}`).href);
const started = performance.now();
const { parser: js } = await at('@lezer/javascript/dist/index.js');
const { parser: py } = await at('@lezer/python/dist/index.js');
const { tags: t, highlightTree, tagHighlighter } = await at('@lezer/highlight/dist/index.js');
const style = tagHighlighter([
  { tag: [t.variableName, t.propertyName], class: 'syntaxVariable' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'syntaxFunction' },
  { tag: [t.typeName, t.className], class: 'syntaxType' },
  { tag: t.keyword, class: 'syntaxKeyword' },
  { tag: t.number, class: 'syntaxNumber' }, { tag: t.string, class: 'syntaxString' },
  { tag: t.comment, class: 'syntaxComment' }, { tag: t.operator, class: 'syntaxOperator' },
  { tag: t.punctuation, class: 'syntaxPunctuation' },
]);
const parsers = { typescript: js.configure({ dialect: 'ts' }), python: py };
const initializationMs = performance.now() - started;
const lezer = (code, lang) => {
  const tree = parsers[lang].parse(code), spans = [];
  let previous = 0;
  highlightTree(tree, style, (from, to, role) => {
    if (from > previous) spans.push({ text: code.slice(previous, from), role: 'toolOutput' });
    spans.push({ text: code.slice(from, to), role }); previous = to;
  });
  if (previous < code.length) spans.push({ text: code.slice(previous), role: 'toolOutput' });
  assert.equal(spans.map(s => s.text).join(''), code);
  return spans;
};
const { default: modern } = await at('highlight.js/es/core.js');
modern.registerLanguage('typescript', (await at('highlight.js/es/languages/typescript.js')).default);
modern.registerLanguage('python', (await at('highlight.js/es/languages/python.js')).default);
console.log(JSON.stringify({ node: process.version, packages: { '@lezer/javascript': '1.5.6', '@lezer/python': '1.1.19', '@lezer/highlight': '1.2.5', 'highlight.js': '11.12.0' }, initializationMs }));
const samples = [
  ['typescript', 'const result: User = client.fetch(user.id) ?? fallback;'],
  ['typescript', 'interface User { name: string; active: boolean }\nfunction greet(user: User): string { return user.name; }'],
  ['python', 'result = client.fetch(user.id) if user.active else fallback'],
];
for (const [lang, code] of samples) {
  const spans = lezer(code, lang);
  const differentiated = spans.filter(s => !['toolOutput', 'syntaxComment', 'syntaxOperator', 'syntaxPunctuation'].includes(s.role));
  const coloredNameCells = spans.filter(s => /^(syntaxVariable|syntaxFunction|syntaxType)$/u.test(s.role)).reduce((n, s) => n + [...s.text].filter(c => !/\s/u.test(c)).length, 0);
  const visuallyOrdinary = spans.filter(s => !differentiated.includes(s)).reduce((n, s) => n + [...s.text].filter(c => !/\s/u.test(c)).length, 0);
  console.log(JSON.stringify({ lang, code, lezerSpans: spans, recognizedNameCells: coloredNameCells, ordinaryRoleNonWhitespace: visuallyOrdinary,
    modernHighlightHtml: modern.highlight(code, { language: lang, ignoreIllegals: true }).value }));
}
const code = Array.from({ length: 1000 }, (_, i) => `const result${i}: User = client.fetch(user.id) ?? fallback;`).join('\n');
const measure = fn => { const times = []; for (let i = 0; i < 21; i++) { const started = performance.now(); fn(); times.push(performance.now() - started); } const firstMs = times.shift(); times.sort((a, b) => a - b); return { calls: 21, firstMs, medianMs: times[10], p95Ms: times[18] }; };
console.log(JSON.stringify({ benchmark: { lines: 1000, utf16Units: code.length, lezerParseAndSpans: measure(() => lezer(code, 'typescript')),
  modernHighlightHtml: measure(() => modern.highlight(code, { language: 'typescript', ignoreIllegals: true }).value) },
  caveat: 'Same TS text as Shiki, but different classification/output representations. No ANSI/TUI work, minimum-Node or general ranking proof.' }));
