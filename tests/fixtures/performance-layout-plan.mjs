import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planTerminalObserver } from './terminal-observer-plan.mjs';

export function planPerformanceLayout(inputs) {
  const ts = createRequire(join(inputs.pi.root, 'package.json'))('typescript');
  function candidates(urls) {
    const found = [];
    for (const url of urls) {
      const source = readFileSync(new URL(url), 'utf8');
      if (!source.includes('renderLayoutFrame')) continue;
      const ast = ts.createSourceFile(fileURLToPath(url), source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
      assert.equal(ast.parseDiagnostics.length, 0, 'Cannot parse selected performance layout module');
      for (const node of ast.statements) if (ts.isFunctionDeclaration(node) && node.name?.text === 'renderLayoutFrame' && node.body) {
        found.push({ module: url, sha256: createHash('sha256').update(source).digest('hex'),
          marker: source.slice(node.getStart(ast), node.body.getStart(ast) + 1) });
      }
    }
    return found;
  }
  // Published CLIs bundle their own TUI; the independently installed SDK is not that renderer.
  let found = candidates(planTerminalObserver(inputs).visited);
  if (!found.length) found = candidates([pathToFileURL(realpathSync(join(inputs.pi.root, 'node_modules/@earendil-works/pi-tui/dist/layout.js'))).href]);
  assert.equal(found.length, 1, 'Unsupported Pi performance layout entry');
  return found[0];
}

export function instrumentPerformanceLayout(source, plan) {
  if (typeof source !== 'string' || !plan || !/^(?:export\s+)?function\s+renderLayoutFrame\([^)]*\)\s*\{$/.test(plan.marker)
    || createHash('sha256').update(source).digest('hex') !== plan.sha256
    || source.split(plan.marker).length !== 2) throw new Error('Selected Pi performance layout changed');
  return source.replace(plan.marker, `${plan.marker}\n  globalThis[Symbol.for('pi-tidy-ui.performance.observer')]?.layout();`);
}
