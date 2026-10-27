import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cache = new Map();
const methods = ['getUserInput', 'setupEditorSubmitHandler', 'mountInteractiveTui'];

export function planTerminalObserver(inputs) {
  if (cache.has(inputs.pi.cli)) return cache.get(inputs.pi.cli);
  const ts = createRequire(join(inputs.pi.root, 'package.json'))('typescript');
  const visited = new Set(), candidates = [], editors = [];
  const packageRoot = pathToFileURL(join(inputs.pi.root, 'node_modules/@earendil-works/pi-coding-agent/')).href;
  function visit(url) {
    if (visited.has(url)) return;
    assert.ok(url.startsWith(packageRoot), `Observer module escapes selected CLI package: ${url}`);
    visited.add(url);
    const bytes = readFileSync(new URL(url));
    const ast = ts.createSourceFile(fileURLToPath(url), bytes.toString(), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0, `Cannot parse selected Pi module: ${url}`);
    function candidate(binding, node) {
      if (!node || !ts.isClassExpression(node) && !ts.isClassDeclaration(node)) return;
      const names = new Set(node.members.map(member => member.name?.getText(ast)));
      if (['startAutocompleteRequest', 'cancelAutocompleteRequest'].every(name => names.has(name))) {
        const exports = ast.statements.filter(ts.isExportDeclaration).flatMap(statement =>
          statement.exportClause && ts.isNamedExports(statement.exportClause) ? statement.exportClause.elements : []);
        const exported = exports.find(entry => (entry.propertyName ?? entry.name).text === binding);
        const declarationExport = ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        editors.push({ module: url, binding, sha256: createHash('sha256').update(bytes).digest('hex'),
          exportName: exported?.name.text ?? (declarationExport ? binding : undefined) });
      }
      if (!methods.every(name => names.has(name))) return;
      const clear = node.members.find(member => member.name?.getText(ast) === 'handleCtrlC');
      const windows = [];
      function clearWindow(child) {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.LessThanToken &&
          ts.isNumericLiteral(child.right) && ts.isBinaryExpression(child.left) &&
          child.left.operatorToken.kind === ts.SyntaxKind.MinusToken &&
          ts.isPropertyAccessExpression(child.left.right) && child.left.right.name.text === 'lastSigintTime') {
          windows.push(Number(child.right.text));
        }
        ts.forEachChild(child, clearWindow);
      }
      if (clear) clearWindow(clear);
      assert.equal(windows.length, 1, 'Unsupported native double-interrupt window');
      candidates.push({ module: url, binding, sha256: createHash('sha256').update(bytes).digest('hex'), interruptWindow: windows[0] });
    }
    for (const statement of ast.statements) {
      if (ts.isClassDeclaration(statement) && statement.name) candidate(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) candidate(declaration.name.text, declaration.initializer);
      }
    }
    const imports = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(callee) && callee.text === 'require' ||
          ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'createRequire') {
          imports.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, scan);
    }
    scan(ast);
    for (const specifier of imports) if (specifier.startsWith('.') && /\.m?js$/.test(specifier)) visit(new URL(specifier, url).href);
  }
  visit(pathToFileURL(inputs.pi.cli).href);
  assert.equal(candidates.length, 1, `Unsupported selected Pi CLI: expected one native interactive class, found ${candidates.length}`);
  assert.equal(editors.length, 1, `Unsupported selected Pi CLI: expected one native autocomplete class, found ${editors.length}`);
  assert.ok(editors[0].module === candidates[0].module || editors[0].exportName, 'Loaded native Editor is not importable');
  const plan = { schema: 1, ...candidates[0], editor: editors[0], visited: [...visited] };
  cache.set(inputs.pi.cli, plan);
  return plan;
}
