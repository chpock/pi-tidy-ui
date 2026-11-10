import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = resolve(projectRoot, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const sourceTypes = [ts.ScriptKind.TS, ts.ScriptKind.TSX, ts.ScriptKind.TS, ts.ScriptKind.TS,
  ts.ScriptKind.JS, ts.ScriptKind.JSX, ts.ScriptKind.JS, ts.ScriptKind.JS];
const highlightingModules = [
  'src/highlighting/source-execution.ts',
  'src/highlighting/source-ports.ts',
  'src/highlighting/work-registry.ts',
  'src/highlighting/style-preparation.ts',
  'src/highlighting/controller-limits.ts',
  'src/highlighting/limits.ts',
  'src/highlighting/controller-styles.ts',
  'src/highlighting/storage/context-arena.ts',
  'src/highlighting/storage/semantic-ranges.ts',
  'src/highlighting/storage/semantic-capture.ts',
  'src/highlighting/storage/semantic-retention.ts',
  'src/highlighting/storage/retention.ts',
  'src/highlighting/storage/pi-projection.ts',
  'src/highlighting/storage/ready-presentation.ts',
  'src/highlighting/storage/ready-display-publication.ts',
];
const applicationModules = [
  'src/application/syntax-client.ts',
  'src/application/syntax-menu.ts',
  'src/application/syntax-runtime.ts',
  'src/application/syntax-options.ts',
];
const governedModules = new Set([
  'src/appearance/card-roles.ts',
  'src/appearance/theme-preference.ts',
  'src/appearance/style-materialization.ts',
  'src/occipital/style-types.ts',
  'src/resources/data-budget.ts',
  ...highlightingModules,
  ...applicationModules,
]);
const pureModules = new Set([
  'src/appearance/card-roles.ts',
  'src/appearance/theme-preference.ts',
  'src/occipital/style-types.ts',
]);
const movedRoleNames = new Set(['CARD_ROLES', 'CardRole']);
const movedPreferenceNames = new Set(['ThemeVariant', 'ThemePreference', 'copyThemePreference', 'sameThemePreference']);
const movedStyleTypeNames = new Set(['LiteralInk', 'Ink', 'StyleExpression', 'StyleIdentity']);
const entryPath = 'src/index.ts';
const genericStyleTypesPath = 'src/occipital/style-types.ts';
const presentationAndPayloadFiles = new Set([
  'src/bash-card.ts', 'src/card-frame.ts', 'src/card-theme.ts', 'src/diff-palette.ts',
  'src/display-path.ts', 'src/editor-card.ts', 'src/editor-status.ts', 'src/file-card.ts',
  'src/file-preview-state.ts', 'src/footer.ts', 'src/index.ts', 'src/notifications.ts',
  'src/plain-text.ts', 'src/queued-card.ts', 'src/render-cache.ts', 'src/summary-args.ts',
  'src/tidy-menu.ts', 'src/user-card.ts',
]);

function projectPath(path) {
  return relative(projectRoot, path).split(sep).join('/');
}

function productionFiles(directory = sourceRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.isFile() ? [projectPath(path)] : [];
  }).sort();
}

function parseSource(path, text) {
  if (text === undefined) {
    const absolute = resolve(projectRoot, path);
    assert.ok(existsSync(absolute), `required migrated source module is missing: ${path}`);
    text = readFileSync(absolute, 'utf8');
  }
  const extension = extname(path);
  const index = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].indexOf(extension);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceTypes[index] ?? ts.ScriptKind.TS);
  assert.deepEqual(source.parseDiagnostics, [], `cannot parse ${path}`);
  return source;
}

function hasModifier(node, modifier) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(item => item.kind === modifier) === true;
}

function declarationExportNames(source) {
  const names = new Set();
  for (const statement of source.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.add(element.name.text);
  }
  return names;
}

function reexportedSourceNames(sourcePath, targetPath, source = parseSource(sourcePath)) {
  const names = new Set();
  const importedLocals = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.startsWith('.')
      || resolveRelativeImport(sourcePath, statement.moduleSpecifier.text) !== targetPath) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) importedLocals.set(clause.name.text, 'default');
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        importedLocals.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      importedLocals.set(clause.namedBindings.name.text, '*');
    }
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.moduleSpecifier) {
      if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')
        || resolveRelativeImport(sourcePath, statement.moduleSpecifier.text) !== targetPath) continue;
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        names.add('*');
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.propertyName?.text ?? element.name.text);
      }
    } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const imported = importedLocals.get(element.propertyName?.text ?? element.name.text);
        if (imported !== undefined) names.add(imported);
      }
    }
  }
  return names;
}

function namedBindingsKind(bindings) {
  if (!bindings || !ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) return { hasValue: Boolean(bindings), hasType: false };
  const elements = bindings.elements;
  return {
    hasValue: elements.length === 0 || elements.some(element => !element.isTypeOnly),
    hasType: elements.some(element => element.isTypeOnly),
  };
}

function bindingKind(clause, isTypeOnly = false) {
  if (isTypeOnly || clause?.isTypeOnly) return 'type-only';
  if (!clause) return 'value';
  const named = namedBindingsKind(clause.namedBindings);
  const hasValue = Boolean(clause.name) || named.hasValue;
  if (!hasValue) return 'type-only';
  return named.hasType ? 'mixed' : 'value';
}

function exportKind(declaration) {
  if (declaration.isTypeOnly) return 'type-only';
  const clause = declaration.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return 'value';
  const named = namedBindingsKind(clause);
  if (!named.hasValue) return 'type-only';
  return named.hasType ? 'mixed' : 'value';
}

function moduleReferences(source) {
  const references = [];
  const add = (node, kind, syntax) => {
    if (ts.isStringLiteralLike(node)) references.push({ specifier: node.text, kind, syntax });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, bindingKind(node.importClause), 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, exportKind(node), 'export');
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, 'type-only', 'import-type');
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      add(node.arguments[0], 'value', 'dynamic-import');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'value', 'import-equals');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function existingFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function importCandidates(importer, specifier) {
  const base = resolve(dirname(resolve(projectRoot, importer)), specifier);
  const candidates = new Set();
  if (existingFile(base)) candidates.add(base);
  const extension = extname(specifier);
  const substitutions = {
    '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
  };
  if (extension) {
    if (!candidates.size) for (const replacement of substitutions[extension] ?? []) {
      const candidate = base.slice(0, -extension.length) + replacement;
      if (existingFile(candidate)) candidates.add(candidate);
    }
  } else {
    for (const candidateExtension of [...sourceExtensions, '.json']) {
      const candidate = base + candidateExtension;
      if (existingFile(candidate)) candidates.add(candidate);
      const indexCandidate = resolve(base, `index${candidateExtension}`);
      if (existingFile(indexCandidate)) candidates.add(indexCandidate);
    }
  }
  return [...candidates].sort();
}

function resolveRelativeImport(importer, specifier) {
  const candidates = importCandidates(importer, specifier);
  assert.equal(candidates.length, 1,
    `${candidates.length ? 'ambiguous' : 'unresolved'} relative source import ${specifier} in ${importer}${candidates.length ? `: ${candidates.map(projectPath).join(', ')}` : ''}`);
  return projectPath(candidates[0]);
}

function collectProductionEdges(files) {
  const edges = [];
  for (const path of files) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = parseSource(path);
    for (const reference of moduleReferences(source)) {
      if (!reference.specifier.startsWith('.')) continue;
      edges.push({ source: path, target: resolveRelativeImport(path, reference.specifier), kind: reference.kind, syntax: reference.syntax });
    }
  }
  return edges;
}

function assertKnownGovernedModule(path) {
  const governed = path.startsWith('src/resources/') || path.startsWith('src/appearance/')
    || path.startsWith('src/highlighting/') || path.startsWith('src/application/') || path === genericStyleTypesPath;
  if (governed && !governedModules.has(path)) throw new Error(`unclassified governed source module: ${path}`);
}

function edgeKey({ source, target, kind }) {
  return `${source} -> ${target} [${kind}]`;
}

function assertNoSyntaxApplicationEdges(actual) {
  if (actual.length) throw new Error(`syntax modules must not import application ownership: ${actual.map(edgeKey).join(', ')}`);
}

function assertNativeDependency(edge) {
  if (!edge.source.startsWith('src/occipital/')) return;
  const target = edge.target;
  if (target.startsWith('src/application/') || target.startsWith('src/highlighting/')
    || target.startsWith('src/syntax/') || target.startsWith('src/appearance/')
    || target.startsWith('src/themes/') || target.startsWith('src/tool-adapters/')
    || target === 'src/settings.ts' || presentationAndPayloadFiles.has(target)) {
    throw new Error(`native module imports application, highlighting or presentation ownership: ${edgeKey(edge)}`);
  }
}

function assertNativeReference(path, reference) {
  if (reference.specifier === '@earendil-works/pi-coding-agent'
    || reference.specifier.startsWith('@earendil-works/pi-coding-agent/')) {
    throw new Error(`native module imports the Pi host SDK: ${path} -> ${reference.specifier} [${reference.kind}]`);
  }
  if (reference.specifier.startsWith('.')) assertNativeDependency({
    source: path, target: resolveRelativeImport(path, reference.specifier), kind: reference.kind,
  });
}

function assertHighlightingDependency(edge) {
  if (!edge.source.startsWith('src/highlighting/')) return;
  const target = edge.target;
  if (target.startsWith('src/application/') || target.startsWith('src/syntax/') || target.startsWith('src/themes/')
    || target.startsWith('src/tool-adapters/') || target === 'src/settings.ts' || presentationAndPayloadFiles.has(target)) {
    throw new Error(`highlighting module imports application or presentation ownership: ${edgeKey(edge)}`);
  }
}

function assertStorageDependency(edge) {
  if (!edge.source.startsWith('src/highlighting/storage/')) return;
  const allowed = edge.target.startsWith('src/highlighting/storage/')
    || edge.target === 'src/resources/data-budget.ts'
    || edge.target === 'src/appearance/card-roles.ts'
    || edge.target === 'src/appearance/style-materialization.ts'
    || ['src/occipital/semantic-codec.ts', 'src/occipital/semantic-source.ts',
      'src/occipital/style-types.ts', 'src/occipital/limits.ts'].includes(edge.target);
  if (!allowed) throw new Error(`storage module imports execution or native operation ownership: ${edgeKey(edge)}`);
}

function assertEdgePolicy(edge) {
  assertStorageDependency(edge);
  assertNativeDependency(edge);
  assertHighlightingDependency(edge);
  if (edge.source.startsWith('src/resources/')) {
    const target = edge.target;
    const nativeOrPayload = target.startsWith('src/occipital/') && target !== genericStyleTypesPath
      || target.startsWith('src/highlighting/') || target.startsWith('src/application/')
      || target.startsWith('src/syntax/') || target.startsWith('src/themes/') || target.startsWith('src/tool-adapters/')
      || presentationAndPayloadFiles.has(target);
    if (nativeOrPayload) throw new Error(`resource module imports native, UI or payload implementation: ${edgeKey(edge)}`);
    if (target === genericStyleTypesPath && edge.kind !== 'type-only') {
      throw new Error(`resource module imports native style types as values: ${edgeKey(edge)}`);
    }
  }
  if (edge.source.startsWith('src/appearance/') && edge.target.startsWith('src/occipital/')) {
    if (edge.target !== genericStyleTypesPath || edge.kind !== 'type-only') {
      throw new Error(`appearance may depend on Occipital only through generic type-only style shapes: ${edgeKey(edge)}`);
    }
  }
  if (edge.source.startsWith('src/syntax/') && edge.target.startsWith('src/application/')) {
    throw new Error(`syntax module imports application ownership: ${edgeKey(edge)}`);
  }
  if (edge.target === entryPath && edge.source !== entryPath) {
    throw new Error(`production module back-imports the extension entry: ${edgeKey(edge)}`);
  }
}

function assertGovernedInventory(files) {
  for (const path of files) assertKnownGovernedModule(path);
  for (const path of governedModules) assert.ok(files.includes(path), `missing governed source module: ${path}`);
}

function assertBudgetBoundary(legacyExists, forwardedNames) {
  assert.equal(legacyExists, false, 'the legacy Occipital budget module must stay deleted');
  assert.equal(forwardedNames.size, 0, 'source execution must not forward the resource module');
}

function assertMigratedContracts() {
  assertBudgetBoundary(existsSync(resolve(projectRoot, 'src/occipital/data-budget.ts')),
    reexportedSourceNames('src/highlighting/source-execution.ts', 'src/resources/data-budget.ts'));
  const roles = declarationExportNames(parseSource('src/appearance/card-roles.ts'));
  const preference = declarationExportNames(parseSource('src/appearance/theme-preference.ts'));
  const styles = declarationExportNames(parseSource(genericStyleTypesPath));
  const codec = declarationExportNames(parseSource('src/occipital/semantic-codec.ts'));
  const settings = declarationExportNames(parseSource('src/settings.ts'));
  const sourceExecution = declarationExportNames(parseSource('src/highlighting/source-execution.ts'));
  const budget = declarationExportNames(parseSource('src/resources/data-budget.ts'));

  for (const name of movedRoleNames) assert.ok(roles.has(name), `appearance/card-roles.ts must own ${name}`);
  for (const name of movedPreferenceNames) assert.ok(preference.has(name), `appearance/theme-preference.ts must own ${name}`);
  for (const name of movedStyleTypeNames) assert.ok(styles.has(name), `occipital/style-types.ts must own ${name}`);
  for (const name of [...movedRoleNames, ...movedStyleTypeNames]) {
    assert.ok(!codec.has(name), `semantic-codec.ts must not export moved ${name}`);
  }
  const codecReexports = [
    ...reexportedSourceNames('src/occipital/semantic-codec.ts', 'src/appearance/card-roles.ts'),
    ...reexportedSourceNames('src/occipital/semantic-codec.ts', genericStyleTypesPath),
  ];
  assert.ok(!codecReexports.includes('*') && !codecReexports.some(name => movedRoleNames.has(name) || movedStyleTypeNames.has(name)),
    'semantic-codec.ts must not forward the moved role or style types');
  for (const name of movedPreferenceNames) assert.ok(!settings.has(name), `settings.ts must not forward or own moved ${name}`);
  const settingsReexports = reexportedSourceNames('src/settings.ts', 'src/appearance/theme-preference.ts');
  assert.ok(!settingsReexports.has('*') && ![...settingsReexports].some(name => movedPreferenceNames.has(name)),
    'settings.ts must not forward the pure preference model');
  assert.ok(codec.has('ContextBounds'), 'ContextBounds remains with the context decoder API');
  assert.ok(settings.has('SyntaxTheme') && settings.has('ThemeSettingsPatch')
    && settings.has('themePreferenceFromSettings') && settings.has('themePatch'),
  'settings.ts retains persistence shape, normalization and patch conversion');
  assert.ok(!sourceExecution.has('GeometryFunding') && budget.has('GeometryFunding'),
    'resources/data-budget.ts owns the existing GeometryFunding capability');
}

function assertImportFree(path, source) {
  const references = moduleReferences(source);
  assert.equal(references.length, 0, `${path} must remain import-free; found ${references.map(reference => reference.specifier).join(', ')}`);
}

function assertPureMigratedModules() {
  for (const path of pureModules) assertImportFree(path, parseSource(path));
}

test('appearance owns shared roles, preferences and concrete style conversion', () => {
  assertMigratedContracts();
});

test('production imports preserve the migrated module boundaries', () => {
  const files = productionFiles();
  assertGovernedInventory(files);
  const edges = collectProductionEdges(files);
  for (const edge of edges) assertEdgePolicy(edge);
  assertPureMigratedModules();
  const nativeAppearanceEdges = edges.filter(edge => edge.source.startsWith('src/occipital/') && edge.target.startsWith('src/appearance/'));
  assert.deepEqual(nativeAppearanceEdges, [], 'native modules no longer depend on appearance owners');
  const styleConversionEdges = edges.filter(edge => edge.source === 'src/appearance/style-materialization.ts');
  assert.deepEqual(styleConversionEdges.map(edgeKey), [
    `src/appearance/style-materialization.ts -> ${genericStyleTypesPath} [type-only]`,
  ], 'concrete style materialization depends only on generic type-only wire shapes');
  const syntaxApplicationEdges = edges.filter(edge => edge.source.startsWith('src/syntax/') && edge.target.startsWith('src/application/'));
  assertNoSyntaxApplicationEdges(syntaxApplicationEdges);
});

test('native modules are independent of application, highlighting, presentation and Pi host SDK', () => {
  for (const path of productionFiles().filter(path => path.startsWith('src/occipital/') && sourceExtensions.has(extname(path)))) {
    for (const reference of moduleReferences(parseSource(path))) assertNativeReference(path, reference);
  }
});

test('dependency parser and architecture rules reject synthetic boundary violations', () => {
  const synthetic = parseSource('synthetic.ts', `
    import type { Shape } from './types.ts';
    import { value, type Model } from './mixed.ts';
    import {} from './empty-import.ts';
    export type { Shape as PublicShape } from './exports.ts';
    export { value as publicValue, type Model as PublicModel } from './mixed-export.ts';
    export {} from './empty-export.ts';
    type ImportedShape = import('./import-type.ts').Shape;
    const loaded = import('./dynamic.ts', { with: { type: 'json' } });
    const templated = import(\u0060./dynamic-template.ts\u0060);
    import('@vendor/package');
  `);
  assert.deepEqual(moduleReferences(synthetic).filter(reference => reference.specifier.startsWith('.'))
    .map(({ specifier, kind, syntax }) => ({ specifier, kind, syntax })), [
    { specifier: './types.ts', kind: 'type-only', syntax: 'import' },
    { specifier: './mixed.ts', kind: 'mixed', syntax: 'import' },
    { specifier: './empty-import.ts', kind: 'value', syntax: 'import' },
    { specifier: './exports.ts', kind: 'type-only', syntax: 'export' },
    { specifier: './mixed-export.ts', kind: 'mixed', syntax: 'export' },
    { specifier: './empty-export.ts', kind: 'value', syntax: 'export' },
    { specifier: './import-type.ts', kind: 'type-only', syntax: 'import-type' },
    { specifier: './dynamic.ts', kind: 'value', syntax: 'dynamic-import' },
    { specifier: './dynamic-template.ts', kind: 'value', syntax: 'dynamic-import' },
  ]);

  const aliasedSettings = parseSource('src/settings.ts', `
    export type { LocalChoice as PublicChoice };
    import type { ThemePreference as LocalChoice } from './appearance/theme-preference.ts';
  `);
  assert.deepEqual([...reexportedSourceNames('src/settings.ts', 'src/appearance/theme-preference.ts', aliasedSettings)], ['ThemePreference']);
  const aliasedCodec = parseSource('src/occipital/semantic-codec.ts', `
    import type { StyleExpression as LocalExpression } from './style-types.ts';
    export type { LocalExpression as PublicExpression };
  `);
  assert.deepEqual([...reexportedSourceNames('src/occipital/semantic-codec.ts', genericStyleTypesPath, aliasedCodec)], ['StyleExpression']);
  assert.throws(() => assertImportFree('synthetic.ts', parseSource('synthetic.ts', "import { basename } from 'node:path';")), /must remain import-free/);

  assert.doesNotThrow(() => assertKnownGovernedModule('src/appearance/theme-preference.ts'));
  assert.doesNotThrow(() => assertKnownGovernedModule('src/highlighting/source-execution.ts'));
  assert.doesNotThrow(() => assertKnownGovernedModule('src/application/syntax-options.ts'));
  assert.throws(() => assertKnownGovernedModule('src/appearance/new-model.ts'), /unclassified governed source module/);
  assert.throws(() => assertKnownGovernedModule('src/highlighting/new-owner.ts'), /unclassified governed source module/);
  assert.throws(() => assertKnownGovernedModule('src/application/new-owner.ts'), /unclassified governed source module/);
  assert.doesNotThrow(() => assertEdgePolicy({
    source: 'src/appearance/new-adapter.ts', target: genericStyleTypesPath, kind: 'type-only',
  }));
  const emptyValueImport = moduleReferences(parseSource('src/appearance/new-adapter.ts',
    `import {} from '../occipital/style-types.ts';`))[0];
  assert.equal(emptyValueImport.kind, 'value');
  assert.throws(() => assertEdgePolicy({ source: 'src/appearance/new-adapter.ts',
    target: resolveRelativeImport('src/appearance/new-adapter.ts', emptyValueImport.specifier), kind: emptyValueImport.kind,
  }), /only through generic type-only style shapes/);
  assert.throws(() => assertEdgePolicy({
    source: 'src/appearance/new-adapter.ts', target: genericStyleTypesPath, kind: 'value',
  }), /only through generic type-only style shapes/);
  assert.throws(() => assertEdgePolicy({
    source: 'src/resources/new-budget.ts', target: 'src/tool-adapters/file.ts', kind: 'type-only',
  }), /resource module imports native, UI or payload implementation/);
  for (const target of ['src/highlighting/source-execution.ts', 'src/application/syntax-client.ts']) {
    assert.throws(() => assertEdgePolicy({ source: 'src/resources/new-budget.ts', target, kind: 'type-only' }),
      /resource module imports native, UI or payload implementation/);
  }
  assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/new-owner.ts',
    target: 'src/application/syntax-client.ts', kind: 'type-only' }), /highlighting module imports application/);
  assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/new-owner.ts',
    target: 'src/syntax/cards.ts', kind: 'type-only' }), /highlighting module imports application/);
  for (const source of ['src/syntax/cards.ts', 'src/syntax/work.ts', 'src/syntax/new-owner.ts']) {
    for (const kind of ['type-only', 'value']) assert.throws(() => assertEdgePolicy({ source,
      target: 'src/application/syntax-client.ts', kind }), /syntax module imports application ownership/);
  }

  for (const target of ['src/application/syntax-client.ts', 'src/highlighting/source-execution.ts',
    'src/syntax/cards.ts', 'src/appearance/card-roles.ts', 'src/themes/catalog.ts',
    'src/settings.ts', 'src/notifications.ts']) {
    for (const kind of ['type-only', 'value']) assert.throws(() => assertNativeDependency({
      source: 'src/occipital/new-native.ts', target, kind,
    }), /native module imports application, highlighting or presentation ownership/);
  }
  assert.doesNotThrow(() => assertNativeDependency({
    source: 'src/occipital/new-native.ts', target: 'src/resources/data-budget.ts', kind: 'type-only',
  }));
  for (const specifier of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/host']) {
    assert.throws(() => assertNativeReference('src/occipital/new-native.ts', { specifier, kind: 'type-only' }),
      /native module imports the Pi host SDK/);
  }
  assert.doesNotThrow(() => assertNativeReference('src/occipital/new-native.ts', {
    specifier: '@earendil-works/pi-tui', kind: 'value',
  }));

  assert.doesNotThrow(() => assertBudgetBoundary(false, new Set()));
  assert.throws(() => assertBudgetBoundary(true, new Set()), /legacy Occipital budget module must stay deleted/);
  const wildcard = parseSource('src/highlighting/source-execution.ts', "export * from '../resources/data-budget.ts';");
  assert.throws(() => assertBudgetBoundary(false,
    reexportedSourceNames('src/highlighting/source-execution.ts', 'src/resources/data-budget.ts', wildcard)), /source execution must not forward/);

  assert.doesNotThrow(() => assertNoSyntaxApplicationEdges([]));
  assert.throws(() => assertNoSyntaxApplicationEdges([
    { source: 'src/syntax/cards.ts', target: 'src/application/syntax-client.ts', kind: 'type-only' },
  ]), /syntax modules must not import application ownership/);
});


test('retained storage imports only its shared resource, model and wire-data leaves', () => {
  const sources = ['src/highlighting/storage/semantic-retention.ts',
    'src/highlighting/storage/pi-projection.ts', 'src/highlighting/storage/ready-display-publication.ts'];
  const forbidden = ['src/highlighting/source-execution.ts', 'src/highlighting/source-ports.ts',
    'src/highlighting/work-registry.ts', 'src/highlighting/style-preparation.ts',
    'src/highlighting/limits.ts', 'src/syntax/work.ts', 'src/application/syntax-client.ts',
    'src/occipital/provider.ts', 'src/occipital/broker.ts', 'src/occipital/client.ts',
    'src/occipital/stdio.ts', 'src/occipital/shared.ts', 'src/occipital/semantic-protocol.ts'];
  const allowed = ['src/highlighting/storage/context-arena.ts', 'src/resources/data-budget.ts',
    'src/appearance/card-roles.ts', 'src/appearance/style-materialization.ts',
    'src/occipital/semantic-codec.ts', 'src/occipital/semantic-source.ts',
    'src/occipital/style-types.ts', 'src/occipital/limits.ts'];
  for (const source of sources) for (const kind of ['type-only', 'value']) {
    for (const target of forbidden) {
      assert.throws(() => assertEdgePolicy({ source, target, kind }), /storage module imports execution or native operation ownership/);
    }
    for (const target of allowed) assert.doesNotThrow(() => assertEdgePolicy({ source, target, kind }));
  }
});
