import { fileURLToPath } from 'node:url';

export const demo = {
  title: 'Health-check endpoint',
  theme: { name: 'gruvbox-dark-hard', path: fileURLToPath(new URL('./themes/gruvbox-dark-hard.json', import.meta.url)) },
  model: { provider: 'openai-codex', id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'tidy-ui-demo' },
  thinkingLevel: 'max',
  terminalColorsEnabled: true,
  working: true,
  agentSettings: { editorPaddingX: 1, outputPad: 1, hideThinkingBlock: false },
  editorText: 'Also add a /ready endpoint that checks the database connection and returns',
  thinking: 'The health check should stay dependency-free and follow the existing router conventions. I’ll inspect the surrounding code, add the route and its test, then run the suite.',
  context: { window: 272000, promptTokens: 144500, outputTokens: 800 },
  previousResponse: '**Research complete.** The router is dependency-free, and the tests use Node’s built-in runner. We can add `/health` in `src/router.ts`, preserve existing routes, and verify the response with a focused test.',
  prompt: 'Add a /health endpoint, cover it with a test, and run the test suite.',
  dimensions: { columns: 160, rows: 104 },
  style: { font: 'Cousine Nerd Font Mono', foreground: '#b2b2b2', background: '#000000' },
  cacheHits: [96, 95, 97, 94, 95, 72, 91, 95, 96, 97],
  oldSource: `export function handleRequest(path: string) {
  if (path === "/") return { status: 200, body: "Hello" };
  return { status: 404, body: "Not found" };
}
`,
  newSource: `export function handleRequest(path: string) {
  const pathname = path.split("?")[0];
  if (pathname === "/health") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { status: "ok" },
    };
  }
  if (pathname === "/") return { status: 200, body: "Hello" };
  return { status: 404, body: "Not found" };
}
`,
  testSource: `import { test } from "node:test";
import { strict as assert } from "node:assert";
import { handleRequest } from "../src/router.ts";

test("GET /health returns a healthy response", () => {
  const response = handleRequest("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
  assert.equal(response.headers?.["cache-control"], "no-store");
});
`,
  testAddition: `
test("GET /health accepts probe query parameters", () => {
  const response = handleRequest("/health?probe=1");
  assert.equal(response.status, 200);
});
`,
  additionPatch: `--- a/tests/health.test.ts
+++ b/tests/health.test.ts
@@ -8,3 +8,8 @@
   assert.deepEqual(response.body, { status: "ok" });
   assert.equal(response.headers?.["cache-control"], "no-store");
 });
+
+test("GET /health accepts probe query parameters", () => {
+  const response = handleRequest("/health?probe=1");
+  assert.equal(response.status, 200);
+});
`,
  patch: `--- a/src/router.ts
+++ b/src/router.ts
@@ -1,4 +1,12 @@
 export function handleRequest(path: string) {
-  if (path === "/") return { status: 200, body: "Hello" };
+  const pathname = path.split("?")[0];
+  if (pathname === "/health") {
+    return {
+      status: 200,
+      headers: { "content-type": "application/json" },
+      body: { status: "ok" },
+    };
+  }
+  if (pathname === "/") return { status: 200, body: "Hello" };
   return { status: 404, body: "Not found" };
 }
`,
  command: "node --check src/router.ts && node --check tests/health.test.ts && NODE_ENV=test node --test --test-reporter=spec --test-name-pattern='GET /health returns a healthy response' tests/health.test.ts && git diff --check -- src/router.ts tests/health.test.ts && git diff --stat -- src/router.ts tests/health.test.ts && git status --short -- src/router.ts tests/health.test.ts",
  commandDescription: 'Check TypeScript syntax, run the health test, and review changed files',
  readyText: ['export function handleRequest', 'test("GET /health returns', 'test("GET /health accepts probe', '$ node --check'],
};

export function assistantMessage(content, hit) {
  if (!Number.isFinite(hit) || hit < 0 || hit > 100) throw new Error('Demo cache hit must be between 0 and 100');
  const cacheRead = Math.round(demo.context.promptTokens * hit / 100), input = demo.context.promptTokens - cacheRead;
  const output = demo.context.outputTokens;
  return { role: 'assistant', api: demo.model.api, provider: demo.model.provider, model: demo.model.id,
    timestamp: Date.now(), content, stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: { input, cacheRead, cacheWrite: 0, output, totalTokens: input + cacheRead + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export function toolSequence(commandResult) {
  return [
    { name: 'read', arguments: { path: 'src/router.ts' }, result: { text: demo.oldSource } },
    { name: 'edit', arguments: { path: 'src/router.ts', oldText: demo.oldSource, newText: demo.newSource },
      result: { text: 'Successfully replaced text in src/router.ts.', details: { patch: demo.patch } } },
    { name: 'find', arguments: { pattern: '*router*', path: 'src' }, result: { text: 'src/router.ts' } },
    { name: 'read', arguments: { path: 'package.json', offset: 1, limit: 50 },
      result: { text: '{ "type": "module", "scripts": { "test": "node --test tests/*.test.ts" } }' } },
    { name: 'grep', arguments: { pattern: 'handleRequest', path: 'src', glob: '*.ts' },
      result: { text: 'src/router.ts:1:export function handleRequest(path: string) {' } },
    { name: 'read', arguments: { path: 'tests/router.test.ts', offset: 1, limit: 80 },
      result: { text: "ENOENT: no such file or directory, open 'tests/router.test.ts'", isError: true } },
    { name: 'find', arguments: { pattern: '*.test.ts', path: 'tests' }, result: { text: 'tests/home.test.ts' } },
    { name: 'read', arguments: { path: 'tests/home.test.ts', offset: 1, limit: 40 },
      result: { text: 'import { test } from "node:test";\nimport { strict as assert } from "node:assert";\nimport { handleRequest } from "../src/router.ts";\n\ntest("GET / preserves the welcome response", () => {\n  assert.deepEqual(handleRequest("/"), { status: 200, body: "Hello" });\n});\n' } },
    { name: 'aft_search', arguments: {
      query: 'Find existing tests for health and readiness endpoints, JSON response shapes, and the conventions for unknown paths so the new health-check test follows the same assertion style and response contract as the surrounding application.',
      includeTests: true,
    }, result: { text: 'src/router.ts: handleRequest implements the request routing and response shapes.' } },
    { name: 'read', arguments: { path: 'src/router.ts', offset: 1, limit: 80 }, result: { text: demo.newSource } },
    { name: 'write', arguments: { path: 'tests/health.test.ts', content: demo.testSource },
      result: { text: 'Successfully wrote tests/health.test.ts.' } },
    { name: 'bash', arguments: { command: demo.command, description: demo.commandDescription }, result: commandResult },
    { name: 'find', arguments: { pattern: '*.test.ts', path: 'tests' }, result: { text: 'tests/home.test.ts\ntests/health.test.ts' } },
    { name: 'grep', arguments: { pattern: '/health', path: 'tests', glob: '*.ts' },
      result: { text: 'tests/health.test.ts:5:test("GET /health returns a healthy response", () => {\ntests/health.test.ts:6:  const response = handleRequest("/health");' } },
    { name: 'edit', arguments: { path: 'tests/health.test.ts', oldText: '});\n', newText: '});\n' + demo.testAddition },
      result: { text: 'Successfully added query-parameter coverage.', details: { patch: demo.additionPatch } } },
    { name: 'read', arguments: { path: 'tests/health.test.ts', offset: 1, limit: 40 }, result: { text: demo.testSource + demo.testAddition } },
  ];
}

export function captureReady(capture) {
  if (capture.screen.some(row => /Warning:|TERMINAL_CAPTURE/.test(row))) return false;
  if (!capture.screen.some(row => row.includes(`CH${demo.cacheHits.at(-1).toFixed(1)}%`) && row.includes('147k/272k'))) return false;
  if (!capture.screen.some(row => row.includes('Research complete.'))) return false;
  if (!capture.screen.some(row => row.includes('tests/router.test.ts'))) return false;
  if (!capture.screen.some(row => row.includes('The health check should stay dependency-free'))) return false;
  if (!capture.screen.some(row => row.includes('aft_search'))) return false;
  if (!capture.screen.some(row => row.includes('[exit code: 1]'))) return false;
  const metadata = capture.screen.find(row => row.includes(demo.model.name) && row.includes(`(${demo.model.provider})`) && row.includes(`• ${demo.thinkingLevel}`));
  if (!metadata) return false;
  if (demo.working) {
    if (/\bIdle\b/.test(metadata) || !capture.screen.some(row => /^\s*\S+\s+Working\b/.test(row))) return false;
  } else if (!metadata.includes('• Idle')) return false;
  return demo.readyText.every(text => capture.screen.some((row, y) => {
    const start = row.indexOf(text);
    return start >= 0 && new Set(capture.cells[y].slice(start).filter(cell => cell?.text.trim() && cell.fgMode).map(cell => `${cell.fgMode}:${cell.fg}`)).size >= 3;
  }));
}
