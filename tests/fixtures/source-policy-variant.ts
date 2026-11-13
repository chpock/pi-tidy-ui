import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function withVariant<Module, T>(url: URL, name: string, expected: number | boolean, value: number | boolean,
  consume: (module: Module) => T | Promise<T>): Promise<T> {
  const text = readFileSync(url, 'utf8');
  const source = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = ts.transpileModule(text, { fileName: url.pathname, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).diagnostics ?? [];
  assert.equal(diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error).length, 0,
    'configured module must parse before transformation');
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement =>
    statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
      .map(declaration => ({ statement, declaration })));
  assert.equal(declarations.length, 1, `expected one module-level ${name} declaration`);
  const { statement, declaration } = declarations[0]!;
  assert.ok(statement.declarationList.flags & ts.NodeFlags.Const, `${name} must remain a source constant`);
  let literal = declaration.initializer;
  assert.ok(literal, `${name} must have an initializer`);
  while (ts.isAsExpression(literal) || ts.isParenthesizedExpression(literal) || ts.isSatisfiesExpression(literal)) literal = literal.expression;
  const original = ts.isNumericLiteral(literal) ? Number(literal.text)
    : literal.kind === ts.SyntaxKind.TrueKeyword ? true : literal.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
  assert.equal(original, expected, `${name} shipped policy changed`);
  const edits = [{ start: declaration.initializer!.getStart(source), end: declaration.initializer!.end, text: JSON.stringify(value) }];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node)) continue;
    assert.ok(ts.isStringLiteral(node.moduleSpecifier), 'only literal static imports are relocated');
    const specifier = node.moduleSpecifier.text;
    edits.push({ start: node.moduleSpecifier.getStart(source), end: node.moduleSpecifier.end,
      text: JSON.stringify(specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)) });
  }
  const visit = (node: ts.Node): void => {
    assert.ok(!ts.isMetaProperty(node), 'configured copies cannot relocate import.meta resources');
    if (ts.isCallExpression(node)) assert.ok(node.expression.kind !== ts.SyntaxKind.ImportKeyword
      && !(ts.isIdentifier(node.expression) && node.expression.text === 'require'), 'configured copies support static imports only');
    ts.forEachChild(node, visit);
  };
  visit(source);
  let configured = text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    configured = configured.slice(0, edit.start) + edit.text + configured.slice(edit.end);
  const directory = mkdtempSync(join(tmpdir(), 'tidy-source-policy-'));
  try {
    const file = join(directory, 'variant.ts');
    writeFileSync(file, configured);
    return await consume(await import(pathToFileURL(file).href));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function withFileContext<T>(count: 0 | 1 | 6,
  consume: (module: typeof import('../../src/cards/file-display.ts')) => T | Promise<T>): Promise<T> {
  return withVariant(new URL('../../src/cards/file-display.ts', import.meta.url), 'DIFF_CONTEXT_LINES', 3, count, consume);
}

export function withCompletionMarkers<T>(
  consume: (module: typeof import('../../src/presentation/tool-summary-presenter.ts')) => T | Promise<T>): Promise<T> {
  return withVariant(new URL('../../src/presentation/tool-summary-presenter.ts', import.meta.url), 'SHOW_COMPLETION_MARKERS', false, true, consume);
}
