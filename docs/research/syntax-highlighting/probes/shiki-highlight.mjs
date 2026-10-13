// Research-only isolated comparison, not a production adapter.
// npm install --prefix /tmp/pi-tidy-ui-syntax-research-20261006 --no-package-lock --ignore-scripts --no-audit --no-fund shiki@4.5.0
// node --expose-gc docs/research/syntax-highlighting/probes/shiki-highlight.mjs oniguruma
// node --expose-gc docs/research/syntax-highlighting/probes/shiki-highlight.mjs javascript
// Override the dependency directory with SHIKI_RESEARCH_ROOT.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { initTheme, theme } from '../../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { colorToRgb } from '@earendil-works/pi-tui';
import { highlightCode } from '@earendil-works/pi-coding-agent';
const root = process.env.SHIKI_RESEARCH_ROOT ?? '/tmp/pi-tidy-ui-syntax-research-20261006';
const moduleAt = (path) => import(pathToFileURL(`${root}/node_modules/${path}`).href);
const engineName = process.argv[2] ?? 'oniguruma';
assert.ok(['oniguruma', 'javascript'].includes(engineName));
initTheme('dark', false);
const hex = (role) => { const { r, g, b } = colorToRgb(theme.colors[role]); return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''); };
const roleRules = [
  [['variable', 'entity.other.attribute-name'], 'syntaxVariable'],
  [['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], 'syntaxType'],
  [['entity.name.function', 'support.function'], 'syntaxFunction'],
  [['keyword', 'storage', 'entity.name.tag'], 'syntaxKeyword'],
  [['constant.numeric', 'constant.language'], 'syntaxNumber'],
  [['string', 'constant.other.symbol'], 'syntaxString'],
  [['comment'], 'syntaxComment'],
  [['keyword.operator'], 'syntaxOperator'],
  [['punctuation'], 'syntaxPunctuation'],
];
const hostTheme = { name: 'tidy-ui-research-dark', type: 'dark', colors: { 'editor.foreground': hex('toolOutput'), 'editor.background': hex('toolPendingBg') },
  tokenColors: roleRules.map(([scope, role]) => ({ scope, settings: { foreground: hex(role) } })) };
global.gc?.();
const startMemory = process.memoryUsage();
const started = performance.now();
const { createHighlighterCore } = await moduleAt('@shikijs/core/dist/index.mjs');
const engine = engineName === 'oniguruma'
  ? (await moduleAt('@shikijs/engine-oniguruma/dist/index.mjs')).createOnigurumaEngine(moduleAt('@shikijs/engine-oniguruma/dist/wasm-inlined.mjs'))
  : (await moduleAt('@shikijs/engine-javascript/dist/index.mjs')).createJavaScriptRegexEngine();
const languages = ['typescript', 'javascript', 'python', 'rust', 'html', 'css', 'json', 'shellscript', 'vue'];
const highlighter = await createHighlighterCore({ themes: [hostTheme], langs: languages.map(lang => moduleAt(`@shikijs/langs/dist/${lang}.mjs`)), engine });
const initializationMs = performance.now() - started;
const samples = [
  ['typescript', 'const result: User = client.fetch(user.id) ?? fallback;'],
  ['typescript', 'interface User { name: string; active: boolean }\nfunction greet(user: User): string { return user.name; }'],
  ['python', 'result = client.fetch(user.id) if user.active else fallback'],
  ['rust', 'let result: User = client.fetch(user.id)?;'],
  ['html', '<button class="primary" onclick="submit()">Save</button>'],
  ['shellscript', 'npm test && printf "%s\\n" "$HOME" | tee result.txt'],
  ['vue', '<script setup lang="ts">const count = ref(0)</script>'],
];
let exactSamples = 0;
console.log(JSON.stringify({ shiki: '4.5.0', node: process.version, engine: engineName, loadedLanguages: highlighter.getLoadedLanguages(), initializationMs }));
for (const [lang, code] of samples) {
  const tokens = highlighter.codeToTokensBase(code, { lang, theme: hostTheme.name, includeExplanation: 'scopeName' });
  assert.equal(tokens.map(row => row.map(token => token.content).join('')).join('\n'), code);
  let ordinary = 0, total = 0;
  const spans = tokens.flatMap(row => row.map(token => {
    const count = [...token.content].filter(c => !/\s/u.test(c)).length;
    total += count; if (token.color?.toLowerCase() === hex('toolOutput').toLowerCase()) ordinary += count;
    return { content: token.content, color: token.color, scopes: token.explanation?.flatMap(part => part.scopes.map(scope => scope.scopeName)) };
  }));
  exactSamples++;
  console.log(JSON.stringify({ lang, ordinaryColorNonWhitespace: ordinary, totalNonWhitespace: total, spans }));
}
// Tokenization-only microbenchmark: same 1000-line TypeScript input; no diff parsing,
// ANSI serialization, TUI rendering, retained-layout hits, or UI latency measurements.
const code = Array.from({ length: 1000 }, (_, i) => `const result${i}: User = client.fetch(user.id) ?? fallback;`).join('\n');
const measure = (fn) => {
  let calls = 0; const times = [];
  const firstStart = performance.now(); fn(); calls++; const firstMs = performance.now() - firstStart;
  for (let i = 0; i < 20; i++) { const start = performance.now(); fn(); calls++; times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  return { calls, firstMs, medianMs: times[10], p95Ms: times[18] };
};
const native = measure(() => highlightCode(code, 'typescript'));
const candidate = measure(() => highlighter.codeToTokensBase(code, { lang: 'typescript', theme: hostTheme.name }));
global.gc?.();
const memory = process.memoryUsage();
console.log(JSON.stringify({ benchmark: { lines: 1000, utf16Units: code.length, nativePiHtmlToAnsi: native, shikiTokens: candidate },
  memoryDeltaBytes: Object.fromEntries(['rss', 'heapUsed', 'external', 'arrayBuffers'].map(key => [key, memory[key] - startMemory[key]])), exactSamples,
  caveat: 'Different output representations and grammar coverage; single environment/process sample, not a general speed or memory ranking.' }));
highlighter.dispose();
