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
const sourceDecisionModules = ['src/highlighting/source-state.ts', 'src/highlighting/style-state.ts'];
const executionPath = 'src/highlighting/source-execution.ts';
const publicationPath = 'src/highlighting/style-publication.ts';
const executionRecordsPath = 'src/highlighting/execution-records.ts';
const publicationTypeDependencies = new Set([
  executionPath, executionRecordsPath, 'src/highlighting/work-registry.ts', 'src/resources/data-budget.ts',
  'src/highlighting/storage/context-arena.ts', 'src/highlighting/storage/semantic-capture.ts',
  'src/highlighting/storage/ready-display-publication.ts', 'src/highlighting/storage/semantic-retention.ts',
  'src/highlighting/source-ports.ts', 'src/appearance/style-materialization.ts', 'src/occipital/provider.ts',
]);
const publicationRuntimeDependencies = new Set([
  ...sourceDecisionModules, 'src/highlighting/controller-styles.ts', 'src/highlighting/card-publication.ts',
  'src/highlighting/style-preparation.ts', 'src/appearance/card-roles.ts', 'src/occipital/semantic-protocol.ts',
  'src/diagnostics.ts', 'src/occipital/protocol.ts', 'src/occipital/limits.ts',
  'src/highlighting/limits.ts', 'src/highlighting/controller-limits.ts',
]);
const highlightingModules = [
  ...sourceDecisionModules,
  'src/highlighting/source-execution.ts',
  'src/highlighting/style-publication.ts',
  'src/highlighting/execution-records.ts',
  'src/highlighting/pi-fallback.ts',
  'src/highlighting/pi-flat.ts',
  'src/highlighting/card-publication.ts',
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
const syntaxApplicationModules = [
  'src/application/syntax-client.ts',
  'src/application/syntax-menu.ts',
  'src/application/syntax-runtime.ts',
  'src/application/syntax-options.ts',
];
const preferenceApplicationModules = ['src/application/preferences.ts'];
const menuDataModules = ['src/application/menu-contract.ts', 'src/application/menu-model.ts'];
const menuActionModules = ['src/application/menu-actions.ts'];
const diagnosticSessionModules = ['src/application/diagnostic-session.ts'];
const presentationBindingModules = ['src/application/footer-session.ts', 'src/application/terminal-color-session.ts'];
const currentnessModules = ['src/application/scope.ts'];
const applicationModules = [...syntaxApplicationModules, ...preferenceApplicationModules, ...menuDataModules, ...menuActionModules, ...diagnosticSessionModules, ...presentationBindingModules, ...currentnessModules];
const cardModules = ['src/cards/file-model.ts', 'src/cards/file-sources.ts', 'src/cards/file-display.ts', 'src/cards/display-input.ts',
  'src/cards/file-preview-mode.ts', 'src/cards/file-input.ts', 'src/cards/shebang-language.ts',
  'src/cards/preparation.ts', 'src/cards/bash-preparation.ts', 'src/cards/file-preparation.ts'];
const renderingModules = ['src/rendering/card-values.ts', 'src/rendering/card-styles.ts',
  'src/rendering/measured-rows.ts', 'src/rendering/flat-paint.ts', 'src/rendering/card-layout.ts',
  'src/rendering/scene-model.ts', 'src/rendering/bash-scene.ts', 'src/rendering/file-scene.ts'];
const presentationModules = [
  'src/presentation/cache-owner.ts', 'src/presentation/card-preparation.ts', 'src/presentation/file-details.ts', 'src/presentation/file-preview-state.ts',
  'src/presentation/file-detail-presenter.ts', 'src/presentation/prepared-layout-presenter.ts',
  'src/presentation/queued-presenter.ts', 'src/presentation/tool-intents.ts', 'src/presentation/tool-policy.ts',
  'src/presentation/tool-producers.ts', 'src/presentation/tool-routing-presenter.ts', 'src/presentation/tool-sessions.ts', 'src/presentation/tool-summary-presenter.ts',
  'src/presentation/tool-preparation.ts', 'src/presentation/tool-view-presenter.ts',
  'src/presentation/user-presenter.ts', 'src/presentation/spinner.ts',
];
const governedModules = new Set([
  ...presentationModules,
  ...cardModules,
  ...renderingModules,
  'src/appearance/card-roles.ts',
  'src/appearance/style-ansi.ts',
  'src/appearance/theme-preference.ts',
  'src/appearance/style-materialization.ts',
  'src/occipital/style-types.ts',
  'src/resources/data-budget.ts',
  ...highlightingModules,
  ...applicationModules,
]);
const pureModules = new Set([
  ...sourceDecisionModules,
  'src/cards/file-model.ts',
  'src/cards/file-preview-mode.ts',
  'src/appearance/card-roles.ts',
  'src/appearance/theme-preference.ts',
  'src/occipital/style-types.ts',
]);
const movedRoleNames = new Set(['CARD_ROLES', 'CardRole']);
const movedPreferenceNames = new Set(['ThemeVariant', 'ThemePreference', 'copyThemePreference', 'sameThemePreference']);
const movedStyleTypeNames = new Set(['LiteralInk', 'Ink', 'StyleExpression', 'StyleIdentity']);
const entryPath = 'src/index.ts';
const measuredRowsPath = 'src/rendering/measured-rows.ts';
const presentationModePath = 'src/cards/file-preview-mode.ts';
const presentationModeType = 'FilePreviewMode';
const presentationCardModules = new Set(['src/cards/file-display.ts', 'src/cards/file-model.ts']);
const piTuiDisplayBindings = new Set([
  'visibleWidth', 'sliceByColumn', 'stripTerminalSequences', 'truncateToWidth', 'wrapTextWithAnsi', 'getOsc8LinkAtColumn',
  'backgroundAnsi', 'foregroundAnsi', 'styleText', 'styleTextWithAnsi', 'Color', 'IndexedColor', 'indexedColor',
  'colorToHex', 'colorToOkhsl', 'colorToOklch', 'colorToRgb', 'mixColors', 'ColorMixSpace', 'parseColor',
  'OkhslChannels', 'OklchChannels', 'OklchColorValue', 'okhslColor', 'oklchColor', 'RgbColorValue', 'rgbColor',
  'TerminalColorMode', 'TextAttributes', 'TextStyle', 'TuiMouseEvent', 'TuiMouseEventResult',
]);
const genericStyleTypesPath = 'src/occipital/style-types.ts';
const presentationAndPayloadFiles = new Set([
  'src/bash-card.ts', 'src/card-frame.ts', 'src/card-theme.ts', 'src/diff-palette.ts',
  'src/display-path.ts', 'src/editor-card.ts', 'src/editor-status.ts', 'src/file-card.ts',
  'src/footer.ts', 'src/index.ts', 'src/notifications.ts',
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

function moduleReferences(source, { includeComputed = false } = {}) {
  const references = [];
  const add = (node, kind, syntax) => {
    if (ts.isStringLiteralLike(node)) references.push({ specifier: node.text, kind, syntax });
    else if (includeComputed) references.push({ specifier: `<computed ${syntax}>`, kind, syntax });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, bindingKind(node.importClause), 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, exportKind(node), 'export');
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal, 'type-only', 'import-type');
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length > 0) {
      add(node.arguments[0], 'value', 'dynamic-import');
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'require' && node.arguments.length > 0) {
      add(node.arguments[0], 'value', 'require');
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

function targetsRelativeModule(importer, node, target) {
  return Boolean(node) && ts.isStringLiteralLike(node) && node.text.startsWith('.')
    && resolveRelativeImport(importer, node.text) === target;
}

function isPresentationModule(path) {
  return path.startsWith('src/presentation/');
}

function collectProductionEdges(files) {
  const edges = [];
  for (const path of files) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = parseSource(path);
    assertPublicationModule(path, source);
    if (isPresentationModule(path)) {
      for (const reference of moduleReferences(source)) assertPresentationReference(path, reference);
      assertPresentationImports(path, source);
    }
    for (const reference of moduleReferences(source)) {
      assertRenderingReference(path, reference);
      if (!reference.specifier.startsWith('.')) continue;
      edges.push({ source: path, target: resolveRelativeImport(path, reference.specifier), kind: reference.kind, syntax: reference.syntax });
    }
  }
  return edges;
}

function assertKnownGovernedModule(path) {
  const governed = path.startsWith('src/cards/') || path.startsWith('src/rendering/') || path.startsWith('src/resources/') || path.startsWith('src/appearance/')
    || path.startsWith('src/highlighting/') || path.startsWith('src/application/') || path.startsWith('src/presentation/') || path === genericStyleTypesPath;
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
    || target.startsWith('src/cards/') || target.startsWith('src/rendering/') || isPresentationModule(target)
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
    || target.startsWith('src/tool-adapters/') || target.startsWith('src/cards/') || target.startsWith('src/rendering/')
    || isPresentationModule(target) || target === 'src/settings.ts' || presentationAndPayloadFiles.has(target)) {
    throw new Error(`highlighting module imports application or presentation ownership: ${edgeKey(edge)}`);
  }
}

function assertRegistryDependency(edge) {
  if (edge.source !== 'src/highlighting/work-registry.ts') return;
  const target = edge.target;
  const domain = ['src/resources/', 'src/appearance/', 'src/occipital/', 'src/application/',
    'src/syntax/', 'src/themes/', 'src/tool-adapters/', 'src/highlighting/storage/', 'src/cards/', 'src/rendering/'].some(prefix => target.startsWith(prefix))
    || isPresentationModule(target)
    || [...sourceDecisionModules, 'src/highlighting/source-execution.ts', 'src/highlighting/source-ports.ts',
      'src/highlighting/controller-styles.ts', 'src/highlighting/style-preparation.ts',
      'src/highlighting/pi-fallback.ts', 'src/highlighting/pi-flat.ts', 'src/highlighting/card-publication.ts',
      publicationPath, executionRecordsPath, 'src/highlighting/controller-limits.ts', 'src/highlighting/limits.ts'].includes(target)
    || presentationAndPayloadFiles.has(target);
  if (domain) throw new Error(`chronological registry imports source, style, storage or presentation ownership: ${edgeKey(edge)}`);
}

function assertPublicationDependency(edge) {
  if (edge.target === publicationPath && edge.source !== executionPath) {
    throw new Error(`private style publication is used outside execution: ${edgeKey(edge)}`);
  }
  if (edge.target === executionRecordsPath && (![executionPath, publicationPath].includes(edge.source) || edge.kind !== 'type-only')) {
    throw new Error(`execution records require a private type-only borrow: ${edgeKey(edge)}`);
  }
  if (edge.source !== publicationPath) return;
  const allowed = publicationRuntimeDependencies.has(edge.target)
    || publicationTypeDependencies.has(edge.target) && edge.kind === 'type-only';
  if (!allowed) throw new Error(`style publication imports execution or physical ownership: ${edgeKey(edge)}`);
}

function assertPublicationModule(path, source) {
  if (path === executionRecordsPath) {
    for (const statement of source.statements) {
      const erased = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly
        || ts.isExportDeclaration(statement) && statement.isTypeOnly || ts.isEmptyStatement(statement);
      if (!erased) throw new Error('execution records must contain only erased type declarations');
    }
  }
  if (path !== publicationPath) return;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const module = statement.moduleSpecifier;
    if (!module || !ts.isStringLiteralLike(module) || !module.text.startsWith('.')) continue;
    if (!publicationTypeDependencies.has(resolveRelativeImport(path, module.text))) continue;
    // Element-level type modifiers can leave an executable empty import after stripping.
    const erased = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly : statement.isTypeOnly;
    if (!erased) throw new Error('style publication type dependencies require whole-declaration erasure');
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

function assertCardDependency(edge) {
  if (!edge.source.startsWith('src/cards/')) return;
  const requestReaderTypes = edge.source === 'src/cards/display-input.ts'
    && edge.target === 'src/tool-adapters/contracts.ts' && edge.kind === 'type-only';
  const allowed = ['src/cards/', 'src/rendering/', 'src/resources/'].some(prefix => edge.target.startsWith(prefix))
    || edge.target === 'src/highlighting/source-ports.ts' || requestReaderTypes;
  if (!allowed) throw new Error(`card preparation imports outside its lower-level capabilities: ${edgeKey(edge)}`);
}

function assertCardReference(path, reference) {
  if (reference.specifier === '@earendil-works/pi-coding-agent'
    || reference.specifier.startsWith('@earendil-works/pi-coding-agent/')) {
    throw new Error(`card preparation imports the Pi host SDK: ${path} -> ${reference.specifier} [${reference.kind}]`);
  }
}

function isRenderingModule(path) {
  return path.startsWith('src/rendering/');
}

function assertRenderingDependency(edge) {
  if (!isRenderingModule(edge.source)) return;
  const models = ['src/appearance/card-roles.ts', 'src/appearance/style-materialization.ts', 'src/appearance/style-ansi.ts'];
  const geometryPrimitive = edge.source === 'src/rendering/card-layout.ts' && edge.target === 'src/card-frame.ts'
    || edge.source === 'src/rendering/scene-model.ts' && edge.target === 'src/card-frame.ts' && edge.kind === 'type-only'
    || edge.source === 'src/rendering/measured-rows.ts' && edge.target === 'src/text-wrap.ts';
  const allowed = edge.target.startsWith('src/rendering/') || edge.target.startsWith('src/resources/')
    || models.includes(edge.target) || geometryPrimitive;
  if (!allowed) throw new Error(`rendering imports card, source-work or host ownership: ${edgeKey(edge)}`);
}

function assertRenderingReference(path, reference) {
  if (!isRenderingModule(path)) return;
  if (reference.specifier === '@earendil-works/pi-coding-agent'
    || reference.specifier.startsWith('@earendil-works/pi-coding-agent/')) {
    throw new Error(`rendering imports the Pi host SDK: ${path} -> ${reference.specifier} [${reference.kind}]`);
  }
}

function assertPresentationReference(path, reference) {
  if (!isPresentationModule(path)) return;
  if (reference.specifier === '@earendil-works/pi-coding-agent'
    || reference.specifier.startsWith('@earendil-works/pi-coding-agent/')) {
    throw new Error(`presentation imports the Pi host SDK: ${path} -> ${reference.specifier} [${reference.kind}]`);
  }
}

function isPiTuiSpecifier(specifier) {
  const tui = '@earendil-works/pi-tui';
  return specifier === tui || specifier.startsWith(`${tui}/`)
    || specifier.includes(`/${tui}/`) || specifier.endsWith(`/${tui}`);
}

function importTypeName(qualifier) {
  if (!qualifier) return undefined;
  if (ts.isIdentifier(qualifier)) return qualifier.text;
  return ts.isQualifiedName(qualifier) ? qualifier.right.text : undefined;
}

function assertPresentationModeImports(path, source) {
  const violations = [];
  const isPreviewState = node => targetsRelativeModule(path, node, presentationModePath);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isPreviewState(statement.moduleSpecifier)) {
      const clause = statement.importClause, bindings = clause?.namedBindings;
      const onlyModeType = !clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every(element => (clause.isTypeOnly || element.isTypeOnly)
          && (element.propertyName?.text ?? element.name.text) === presentationModeType);
      if (!onlyModeType) violations.push('preview state other than its narrow type');
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isPreviewState(statement.moduleSpecifier)) {
      violations.push('preview-state re-export');
    }
  }
  const visit = node => {
    if (ts.isImportTypeNode(node) && isPreviewState(node.argument.literal)
      && (node.isTypeOf || importTypeName(node.qualifier) !== presentationModeType)) {
      violations.push('broad preview-state import type');
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isPreviewState(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push('dynamic preview-state import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') violations.push('preview-state require');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && isPreviewState(node.moduleReference.expression)) violations.push('preview-state import-equals');
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (violations.length) throw new Error(`presentation imports more than the narrow view-mode type: ${violations.join(', ')}`);
}

function assertPiTuiDisplayImports(path, source) {
  const violations = [];
  const isPiTui = node => Boolean(node) && ts.isStringLiteralLike(node) && isPiTuiSpecifier(node.text);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isPiTui(statement.moduleSpecifier) && statement.importClause) {
      const clause = statement.importClause, bindings = clause.namedBindings;
      if (clause.name || bindings && ts.isNamespaceImport(bindings)) violations.push('broad pi-tui component access');
      else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = element.propertyName?.text ?? element.name.text;
          if (!piTuiDisplayBindings.has(name)) violations.push(`pi-tui component ${name}`);
        }
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isPiTui(statement.moduleSpecifier)) {
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) violations.push('broad pi-tui re-export');
      else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const name = element.propertyName?.text ?? element.name.text;
          if (!piTuiDisplayBindings.has(name)) violations.push(`pi-tui component re-export ${name}`);
        }
      }
    }
  }
  const visit = node => {
    if (ts.isImportTypeNode(node) && isPiTui(node.argument.literal)
      && (!node.qualifier || !piTuiDisplayBindings.has(importTypeName(node.qualifier)))) {
      violations.push('pi-tui component import type');
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && isPiTui(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.push('dynamic pi-tui import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') violations.push('pi-tui require');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && isPiTui(node.moduleReference.expression)) violations.push('pi-tui import-equals');
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (violations.length) throw new Error(`${path} imports Pi UI component shapes: ${violations.join(', ')}`);
}

function assertPresentationImports(path, source) {
  assertPresentationModeImports(path, source);
  assertPiTuiDisplayImports(path, source);
}

function assertApplicationHostImports(path, source) {
  if (path !== entryPath && !path.startsWith('src/application/')) return;
  assertPiTuiDisplayImports(path, source);
  const sdk = '@earendil-works/pi-coding-agent';
  const contextTypes = new Set(['ExtensionAPI', 'ExtensionContext']);
  const configurationValues = new Set(['VERSION', 'getAgentDir']);
  const isSdkSpecifier = specifier => specifier === sdk || specifier.includes(`${sdk}/`) || specifier.endsWith(`/${sdk}`);
  const isSdk = node => Boolean(node) && ts.isStringLiteralLike(node) && isSdkSpecifier(node.text);
  const allowedBindings = (bindings, typeOnly) => {
    if (!bindings || !ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) return false;
    return bindings.elements.length > 0 && bindings.elements.every(element => {
      const name = element.propertyName?.text ?? element.name.text;
      return (typeOnly || element.isTypeOnly ? contextTypes : configurationValues).has(name);
    });
  };
  for (const reference of moduleReferences(source)) {
    if (!isSdkSpecifier(reference.specifier)) continue;
    if (reference.specifier !== sdk || ['dynamic-import', 'require', 'import-equals'].includes(reference.syntax))
      throw new Error(`application imports broad or private Pi host SDK: ${path} -> ${reference.specifier}`);
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && isSdk(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause || clause.name || !allowedBindings(clause.namedBindings, clause.isTypeOnly))
        throw new Error(`application imports native Pi bindings instead of public context/configuration: ${path}`);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isSdk(statement.moduleSpecifier)) {
      if (!allowedBindings(statement.exportClause, statement.isTypeOnly))
        throw new Error(`application forwards native Pi bindings: ${path}`);
    }
  }
  const visit = node => {
    if (ts.isImportTypeNode(node) && isSdk(node.argument.literal)) {
      const allowed = node.isTypeOf ? configurationValues : contextTypes;
      if (!allowed.has(importTypeName(node.qualifier))) throw new Error(`application imports native Pi shape types: ${path}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function assertSyntaxChoiceImports(path, source) {
  const supported = new Set(['src/diagnostics.ts', 'src/notifications.ts', ...syntaxApplicationModules]);
  const domains = ['src/appearance/', 'src/occipital/', 'src/highlighting/', 'src/resources/', 'src/themes/'];
  const paletteInputs = new Set(['src/syntax/pi-input.ts', 'src/syntax/pi-input-owner.ts']);
  for (const reference of moduleReferences(source)) {
    const target = reference.specifier.startsWith('.') ? resolveRelativeImport(path, reference.specifier) : reference.specifier;
    const allowed = supported.has(target) || paletteInputs.has(target) || domains.some(domain => target.startsWith(domain))
      || target === '@earendil-works/pi-coding-agent' || target === '@earendil-works/pi-tui';
    assert.ok(allowed, `syntax application dependency exceeds choice/provider capabilities: ${path} -> ${reference.specifier}`);
  }
}

function assertPreferenceImports(path, source) {
  const supported = new Set(['src/settings.ts', 'src/diagnostics.ts', 'src/appearance/theme-preference.ts', 'src/application/syntax-menu.ts']);
  for (const reference of moduleReferences(source)) {
    const target = reference.specifier.startsWith('.') ? resolveRelativeImport(path, reference.specifier) : reference.specifier;
    assert.ok(supported.has(target), `preference policy imports an implementation owner instead of decisions: ${path} -> ${reference.specifier}`);
  }
}

const menuDataDependencies = new Map([
  ['src/application/menu-contract.ts', new Map([
    ['src/appearance/theme-preference.ts', { types: ['ThemePreference', 'ThemeVariant'] }],
    ['src/settings.ts', { types: ['Switches'] }],
    ['src/application/syntax-menu.ts', { types: ['SyntaxMenuOutcome', 'SyntaxMenuSnapshot'] }],
    ['src/runtime-health.ts', { types: ['RuntimeHealthSnapshot'] }],
    ['src/session-logging.ts', { types: ['SessionLogging'] }],
  ])],
  ['src/application/menu-model.ts', new Map([
    ['src/application/menu-contract.ts', { types: ['TidyMenuAction', 'TidyMenuSnapshot', 'TidyMenuPage', 'TidyMenuRow', 'TidyMenuIntent', 'TidyMenuCommandIntent'] }],
    ['src/appearance/theme-preference.ts', { types: ['ThemePreference', 'ThemeVariant'] }],
    ['src/render-cache.ts', { types: ['CacheStats'] }],
    ['src/debug-log.ts', { values: ['readableDiagnosticText'] }],
    ['src/display-path.ts', { values: ['displayPath'] }],
    ['src/themes/catalogue.ts', { values: ['THEME_FAMILIES', 'themeFamilyEntry'] }],
    ['src/themes/selection.ts', { values: ['resolveTheme'] }],
    ['src/occipital/semantic-protocol.ts', { values: ['SEMANTIC_PROTOCOL_VERSION'] }],
  ])],
]);

const menuActionDependencies = new Map([
  ['src/application/menu-contract.ts', { types: ['TidyMenuAction', 'TidyMenuOwner'] }],
  ['src/application/preferences.ts', { types: ['ApplicationPreferences', 'PreferenceScope', 'SwitchApplication'] }],
  ['src/application/syntax-menu.ts', { types: ['SyntaxMenuOutcome'], values: ['RETIRED_SETTINGS_ACTION'] }],
  ['src/appearance/theme-preference.ts', { types: ['ThemePreference'] }],
  ['src/diagnostics.ts', { types: ['DiagnosticSink'], values: ['diagnose'] }],
]);

function assertNamedCapabilityImports(path, source, dependencies, label) {
  const rule = specifier => dependencies.get(specifier.startsWith('.') ? resolveRelativeImport(path, specifier) : specifier);
  const allowed = (dependency, name, typeOnly) => (dependency?.[typeOnly ? 'types' : 'values'] ?? []).includes(name);
  for (const reference of moduleReferences(source)) {
    assert.ok(['import', 'import-type'].includes(reference.syntax) && rule(reference.specifier),
      `${label} imports ownership or broad module authority: ${path} -> ${reference.specifier} [${reference.syntax}]`);
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause, bindings = clause?.namedBindings;
    assert.ok(!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length,
      `${label} requires explicit data or helper capabilities: ${path}`);
    for (const element of bindings.elements) assert.ok(allowed(rule(statement.moduleSpecifier.text),
      element.propertyName?.text ?? element.name.text, clause.isTypeOnly || element.isTypeOnly),
    `${label} imports an implementation capability: ${path} -> ${statement.moduleSpecifier.text}`);
  }
  const visit = node => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      assert.ok(!node.isTypeOf && allowed(rule(node.argument.literal.text), importTypeName(node.qualifier), true),
        `${label} imports an implementation capability: ${path} -> ${node.argument.literal.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
function assertMenuDataImports(path, source) {
  assertNamedCapabilityImports(path, source, menuDataDependencies.get(path), 'menu data');
}
function assertMenuActionImports(path, source) {
  assertNamedCapabilityImports(path, source, menuActionDependencies, 'menu action policy');
}

const diagnosticSessionDependencies = new Map([
  ['@earendil-works/pi-coding-agent', { types: ['ExtensionContext'], values: ['VERSION'] }],
  ['node:module', { values: ['createRequire'] }],
  ['src/diagnostics.ts', { types: ['DiagnosticSink'] }],
  ['src/debug-log.ts', { types: ['JournalOptions'] }],
  ['src/notifications.ts', { values: ['notify'] }],
  ['src/runtime-health.ts', { values: ['RuntimeHealth'] }],
  ['src/session-logging.ts', { values: ['SessionLogging'] }],
]);
function assertDiagnosticSessionImports(path, source) {
  assertNamedCapabilityImports(path, source, diagnosticSessionDependencies, 'session diagnostic binding');
}
const presentationBindingDependencies = new Map([
  ['src/application/footer-session.ts', new Map([
    ['@earendil-works/pi-coding-agent', { types: ['ExtensionContext'] }],
    ['src/diagnostics.ts', { values: ['diagnose'], types: ['DiagnosticSink'] }],
    ['src/footer.ts', { values: ['FOOTER_FIELDS', 'FooterView', 'footerFirstMessage', 'footerUsage'], types: ['FooterData'] }],
    ['src/host/pi/native-bindings.ts', { types: ['NativeFooterSlot'] }],
  ])],
  ['src/application/terminal-color-session.ts', new Map([
    ['@earendil-works/pi-coding-agent', { types: ['ExtensionContext'] }],
    ['src/diagnostics.ts', { values: ['diagnose'], types: ['DiagnosticSink'] }],
    ['src/notifications.ts', { values: ['notify'] }],
    ['src/terminal-colors.ts', { values: ['TerminalColors', 'processTerminalDefaults'], types: ['DefaultColors', 'ColorTheme'] }],
    ['src/terminal-lifecycle.ts', { values: ['bindTerminalLifecycle'], types: ['TerminalLifecycle'] }],
    ['src/host/pi/native-bindings.ts', { values: ['terminalAppearanceTracking'] }],
  ])],
]);
function assertPresentationBindingImports(path, source) {
  assertNamedCapabilityImports(path, source, presentationBindingDependencies.get(path), 'application presentation binding');
}
function assertEntryPresentationBindingOwnership(path, source) {
  const resolveTarget = specifier => {
    const explicit = projectPath(resolve(dirname(resolve(projectRoot, path)), specifier));
    const planned = [explicit, `${explicit}.ts`, explicit.replace(/\.js$/u, '.ts')].find(target => presentationBindingModules.includes(target));
    return planned ?? (explicit.endsWith('.ts') ? explicit : resolveRelativeImport(path, specifier));
  };
  const implementations = new Set(['src/footer.ts', 'src/terminal-colors.ts', 'src/terminal-lifecycle.ts']);
  for (const reference of moduleReferences(source)) {
    if (!reference.specifier.startsWith('.')) continue;
    const target = resolveTarget(reference.specifier);
    if (reference.kind !== 'type-only' && implementations.has(target))
      throw new Error(`entry owns footer or terminal-color binding implementation: ${target} [${reference.syntax}]`);
    if (presentationBindingModules.includes(target) && reference.syntax !== 'import')
      throw new Error(`entry forwards or broadly loads application presentation binding: ${target}`);
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = resolveTarget(specifier);
    if (!presentationBindingModules.includes(target)) continue;
    const expected = target.endsWith('/footer-session.ts') ? 'FooterSession' : 'TerminalColorSession';
    const clause = statement.importClause, bindings = clause?.namedBindings;
    assert.ok(clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
      && bindings.elements.every(element => (element.propertyName?.text ?? element.name.text) === expected),
    `entry imports observation or broad application binding authority: ${target}`);
  }
  if (declarationExportNames(source).has('terminalColorDiagnostics'))
    throw new Error('entry forwards application presentation binding: terminalColorDiagnostics');
}
const currentnessDependencies = new Map([['src/application/preferences.ts', { types: ['PreferenceScope'] }]]);
function assertCurrentnessImports(path, source) {
  assertNamedCapabilityImports(path, source, currentnessDependencies, 'application currentness scope');
}
function defaultEntryCallable(source) {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.body
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (declaration) return declaration;
  const assignment = source.statements.find(node => ts.isExportAssignment(node) && !node.isExportEquals);
  const localDefault = source.statements
    .filter(node => ts.isExportDeclaration(node) && !node.moduleSpecifier && !node.isTypeOnly)
    .flatMap(node => node.exportClause && ts.isNamedExports(node.exportClause) ? [...node.exportClause.elements] : [])
    .find(node => node.name.text === 'default' && !node.isTypeOnly);
  let expression = assignment?.expression ?? localDefault?.propertyName ?? localDefault?.name;
  const visited = new Set();
  while (expression) {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) { expression = expression.expression; continue; }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (!ts.isIdentifier(expression) || visited.has(expression.text)) return undefined;
    const name = expression.text; visited.add(name);
    const local = source.statements.find(node => ts.isFunctionDeclaration(node) && node.body && node.name?.text === name);
    if (local) return local;
    expression = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
      .find(node => ts.isIdentifier(node.name) && node.name.text === name)?.initializer;
  }
}
function assertEntryCurrentnessOwnership(path, source) {
  for (const reference of moduleReferences(source)) {
    if (!reference.specifier.startsWith('.')) continue;
    const explicit = projectPath(resolve(dirname(resolve(projectRoot, path)), reference.specifier));
    const target = [explicit, `${explicit}.ts`, explicit.replace(/\.js$/u, '.ts')].find(value => currentnessModules.includes(value));
    if (target && reference.syntax !== 'import') throw new Error('entry forwards or broadly loads application currentness scope');
  }
  const visit = node => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === 'AbortController')
      throw new Error('entry owns an application abort controller');
    ts.forEachChild(node, visit);
  };
  visit(source);
  const factory = defaultEntryCallable(source);
  for (const statement of factory?.body?.statements ?? []) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.flags & ts.NodeFlags.Const) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && ts.isNumericLiteral(declaration.initializer))
        throw new Error('entry owns a mutable application numeric generation slot');
    }
  }
}
function assertEntryDiagnosticOwnership(path, source) {
  const implementations = new Set(['src/runtime-health.ts', 'src/session-logging.ts']);
  for (const reference of moduleReferences(source)) {
    if (!reference.specifier.startsWith('.')) continue;
    const target = reference.specifier.endsWith('.ts')
      ? projectPath(resolve(dirname(resolve(projectRoot, path)), reference.specifier))
      : resolveRelativeImport(path, reference.specifier);
    if (reference.kind !== 'type-only' && implementations.has(target))
      throw new Error(`entry owns session diagnostic implementation: ${target} [${reference.syntax}]`);
    if (diagnosticSessionModules.includes(target) && reference.syntax.startsWith('export'))
      throw new Error(`entry forwards session diagnostic observation: ${target} [${reference.syntax}]`);
  }
  if (declarationExportNames(source).has('debugLoggingDiagnostics'))
    throw new Error('entry forwards session diagnostic observation: debugLoggingDiagnostics');
}

function assertEntryPresentationOwnership(path, source) {
  if (path !== entryPath) return;
  const implementations = new Set([
    'src/render-cache.ts', 'src/rendering/card-layout.ts', 'src/user-card.ts', 'src/queued-card.ts',
  ]);
  for (const reference of moduleReferences(source)) {
    if (reference.kind === 'type-only' || !reference.specifier.startsWith('.')) continue;
    const target = resolveRelativeImport(path, reference.specifier);
    if (implementations.has(target)) {
      throw new Error(`extension entry imports layout ownership or row construction: ${target} [${reference.syntax}]`);
    }
  }
}

function assertEntryMeasuredRowsCapability(path, source) {
  if (path !== entryPath) return;
  const violations = [];
  const add = reason => violations.push(reason);
  const targetsMeasuredRows = node => targetsRelativeModule(path, node, measuredRowsPath);

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && targetsMeasuredRows(statement.moduleSpecifier)) {
      const clause = statement.importClause, bindings = clause?.namedBindings;
      if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings)) add('broad import');
      else for (const element of bindings.elements) {
        const name = element.propertyName?.text ?? element.name.text;
        if (name !== 'reflow' || clause.isTypeOnly || element.isTypeOnly) add(name);
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && targetsMeasuredRows(statement.moduleSpecifier)) {
      add('re-export');
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
      && targetsMeasuredRows(statement.moduleReference.expression)) {
      add('import-equals');
    }
  }

  const visit = node => {
    if (ts.isImportTypeNode(node) && targetsMeasuredRows(node.argument.literal)) add('import type');
    if (ts.isCallExpression(node) && node.arguments.length > 0 && targetsMeasuredRows(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add('dynamic import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add('require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (violations.length) {
    throw new Error(`extension entry may use measured rows only through named reflow; found ${violations.join(', ')}`);
  }
}

function assertPresentationDependency(edge) {
  if (!isPresentationModule(edge.source)) return;
  const cacheKernel = edge.target === 'src/render-cache.ts' &&
    (edge.source === 'src/presentation/cache-owner.ts' || edge.kind === 'type-only' &&
      ['src/presentation/tool-sessions.ts', 'src/presentation/user-presenter.ts', 'src/presentation/queued-presenter.ts',
        'src/presentation/file-detail-presenter.ts', 'src/presentation/prepared-layout-presenter.ts',
        'src/presentation/tool-summary-presenter.ts'].includes(edge.source));
  const productRowBuilder = edge.source === 'src/presentation/user-presenter.ts' && edge.target === 'src/user-card.ts'
    || edge.source === 'src/presentation/queued-presenter.ts' && edge.target === 'src/queued-card.ts';
  const displayThemeType = ['src/presentation/user-presenter.ts', 'src/presentation/queued-presenter.ts',
    'src/presentation/tool-summary-presenter.ts', 'src/presentation/file-detail-presenter.ts',
    'src/presentation/tool-view-presenter.ts'].includes(edge.source)
    && edge.target === 'src/card-theme.ts' && edge.kind === 'type-only';
  const summaryPresentationDependencies = edge.source === 'src/presentation/tool-summary-presenter.ts'
    && ['src/summary-args.ts', 'src/text-wrap.ts'].includes(edge.target);
  const summaryFramePresentation = edge.source === 'src/presentation/tool-summary-presenter.ts'
    && ['src/card-frame.ts', 'src/card-theme.ts'].includes(edge.target)
    || edge.source === 'src/presentation/tool-view-presenter.ts' && edge.target === 'src/card-frame.ts';
  const diagnosticSink = ['src/presentation/user-presenter.ts', 'src/presentation/queued-presenter.ts', 'src/presentation/spinner.ts'].includes(edge.source)
    && edge.target === 'src/diagnostics.ts';
  const producerInterpretation = edge.source === 'src/presentation/tool-producers.ts'
    && ['src/tool-adapters/registry.ts', 'src/tool-adapters/contracts.ts'].includes(edge.target);
  const presentationAdapterContracts = ['src/presentation/tool-policy.ts', 'src/presentation/tool-sessions.ts'].includes(edge.source)
    && edge.target === 'src/tool-adapters/contracts.ts' && edge.kind === 'type-only';
  const allowed = isPresentationModule(edge.target) || edge.target.startsWith('src/rendering/')
    || edge.target.startsWith('src/resources/') || edge.target.startsWith('src/appearance/')
    || presentationCardModules.has(edge.target) || cacheKernel || productRowBuilder || displayThemeType || diagnosticSink
    || producerInterpretation || presentationAdapterContracts || summaryPresentationDependencies || summaryFramePresentation
    || edge.target === 'src/cards/display-input.ts' && edge.kind === 'type-only'
    || edge.target === presentationModePath && edge.kind === 'type-only';
  if (!allowed) throw new Error(`presentation imports outside its display capabilities: ${edgeKey(edge)}`);
}

const piHostShapeDependencies = new Set([
  'src/presentation/tool-view-presenter.ts', 'src/presentation/tool-producers.ts',
  'src/presentation/user-presenter.ts', 'src/presentation/queued-presenter.ts',
  'src/card-theme.ts', 'src/diagnostics.ts', 'src/syntax/work.ts',
]);

function assertPiHostDependency(edge) {
  if (edge.target.startsWith('src/host/pi/') && !edge.source.startsWith('src/host/pi/')
    && edge.source !== entryPath && !edge.source.startsWith('src/application/')) {
    throw new Error(`lower layer back-imports native host ownership: ${edgeKey(edge)}`);
  }
  if (!edge.source.startsWith('src/host/pi/')) return;
  const allowed = edge.target.startsWith('src/host/pi/') || edge.target === 'src/editor-card.ts'
    || edge.target === 'src/editor-status.ts' || edge.kind === 'type-only' && piHostShapeDependencies.has(edge.target);
  if (!allowed) throw new Error(`native host binding imports application or presentation implementation: ${edgeKey(edge)}`);
}

function assertEdgePolicy(edge) {
  assertPresentationDependency(edge);
  assertRenderingDependency(edge);
  assertCardDependency(edge);
  assertRegistryDependency(edge);
  assertStorageDependency(edge);
  assertNativeDependency(edge);
  assertHighlightingDependency(edge);
  assertPublicationDependency(edge);
  if (edge.source.startsWith('src/resources/')) {
    const target = edge.target;
    const nativeOrPayload = target.startsWith('src/occipital/') && target !== genericStyleTypesPath
      || target.startsWith('src/highlighting/') || target.startsWith('src/application/')
      || target.startsWith('src/syntax/') || target.startsWith('src/themes/') || target.startsWith('src/tool-adapters/')
      || target.startsWith('src/cards/') || target.startsWith('src/rendering/')
      || isPresentationModule(target) || presentationAndPayloadFiles.has(target);
    if (nativeOrPayload) throw new Error(`resource module imports native, UI or payload implementation: ${edgeKey(edge)}`);
    if (target === genericStyleTypesPath && edge.kind !== 'type-only') {
      throw new Error(`resource module imports native style types as values: ${edgeKey(edge)}`);
    }
  }
  if (edge.source.startsWith('src/appearance/') && isPresentationModule(edge.target)) {
    throw new Error(`appearance imports presentation ownership: ${edgeKey(edge)}`);
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
  assertPiHostDependency(edge);
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
  const references = moduleReferences(source, { includeComputed: true });
  assert.equal(references.length, 0, `${path} must remain import-free; found ${references.map(reference => reference.specifier).join(', ')}`);
}

function assertPureMigratedModules(readSource = parseSource) {
  for (const path of pureModules) assertImportFree(path, readSource(path));
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

test('extension entry composes presenters without owning latest layouts or constructing their rows', () => {
  assertEntryPresentationOwnership(entryPath, parseSource(entryPath));
});

test('entry presentation ownership guard resolves aliases, mixed imports and runtime load routes', () => {
  assert.doesNotThrow(() => assertEntryPresentationOwnership(entryPath,
    parseSource(entryPath, "import type { CacheStats } from './render-cache.ts';")));
  for (const specifier of ['./render-cache.ts', './rendering/card-layout.ts', './user-card.ts', './queued-card.ts']) {
    const forbidden = [
      `import { implementation as alias } from '${specifier}';`,
      `import { type Model, implementation } from '${specifier}';`,
      `import * as implementation from '${specifier}';`,
      `export { implementation } from '${specifier}';`,
      `export * from '${specifier}';`,
      `const implementation = import('${specifier}');`,
      `const implementation = require('${specifier}');`,
      `import implementation = require('${specifier}');`,
    ];
    for (const text of forbidden) {
      assert.throws(() => assertEntryPresentationOwnership(entryPath, parseSource(entryPath, text)),
        /entry imports layout ownership or row construction/);
    }
  }
});

test('extension entry keeps detail measurement authority out while heading reflow remains', () => {
  assertEntryMeasuredRowsCapability(entryPath, parseSource(entryPath));
});

test('entry measurement imports accept heading reflow and reject detail capability routes', () => {
  const safe = parseSource(entryPath, "import { reflow as headingReflow } from './rendering/measured-rows.ts';");
  assert.doesNotThrow(() => assertEntryMeasuredRowsCapability(entryPath, safe));
  const forbidden = [
    "import { measure as detailMeasure } from './rendering/measured-rows.ts';",
    "import type { MeasuredText as DetailText } from './rendering/measured-rows.ts';",
    "import { SpanKind as DetailSpans } from './rendering/measured-rows.ts';",
    "import * as measuredRows from './rendering/measured-rows.ts';",
    "type DetailText = import('./rendering/measured-rows.ts').MeasuredText;",
    "export { measure as detailMeasure } from './rendering/measured-rows.ts';",
    "export * from './rendering/measured-rows.ts';",
    "const measuredRows = import('./rendering/measured-rows.ts');",
    "const measuredRows = require('./rendering/measured-rows.ts');",
  ];
  for (const text of forbidden) {
    assert.throws(() => assertEntryMeasuredRowsCapability(entryPath, parseSource(entryPath, text)),
      /only through named reflow/);
  }
});

test('presentation dependencies stay within display capabilities and do not flow back from lower owners', () => {
  const presentation = 'src/presentation/detail-owner.ts';
  const allowed = [
    ['src/presentation/detail-view.ts', 'value'],
    ['src/cards/file-display.ts', 'value'],
    ['src/cards/file-model.ts', 'type-only'],
    ['src/rendering/measured-rows.ts', 'value'],
    ['src/resources/data-budget.ts', 'type-only'],
    ['src/appearance/card-roles.ts', 'value'],
    [presentationModePath, 'type-only'],
  ];
  for (const [target, kind] of allowed) assert.doesNotThrow(() => assertPresentationDependency({ source: presentation, target, kind }));
  const preparedLayout = 'src/presentation/prepared-layout-presenter.ts';
  assert.doesNotThrow(() => assertPresentationDependency({ source: preparedLayout, target: 'src/render-cache.ts', kind: 'type-only' }));
  assert.throws(() => assertPresentationDependency({ source: preparedLayout, target: 'src/render-cache.ts', kind: 'value' }));
  const summaryPresenter = 'src/presentation/tool-summary-presenter.ts';
  assert.doesNotThrow(() => assertPresentationDependency({ source: summaryPresenter, target: 'src/render-cache.ts', kind: 'type-only' }));
  assert.throws(() => assertPresentationDependency({ source: summaryPresenter, target: 'src/render-cache.ts', kind: 'value' }));
  const sessions = 'src/presentation/tool-sessions.ts';
  assert.doesNotThrow(() => assertPresentationDependency({ source: sessions, target: 'src/tool-adapters/contracts.ts', kind: 'type-only' }));
  assert.throws(() => assertPresentationDependency({ source: sessions, target: 'src/tool-adapters/contracts.ts', kind: 'value' }));
  const source = parseSource(presentation, `
    import { cleanFileDisplayText } from '../cards/file-display.ts';
    import type { FileCardInput } from '../cards/file-model.ts';
    import { measure } from '../rendering/measured-rows.ts';
    import { DataBudget } from '../resources/data-budget.ts';
    import { CARD_ROLES } from '../appearance/card-roles.ts';
    import type { FilePreviewMode as Mode } from '../cards/file-preview-mode.ts';
    import { visibleWidth } from '@earendil-works/pi-tui';
  `);
  assertPresentationImports(presentation, source);
  for (const reference of moduleReferences(source)) {
    assertPresentationReference(presentation, reference);
    if (reference.specifier.startsWith('.')) assert.doesNotThrow(() => assertEdgePolicy({
      source: presentation, target: resolveRelativeImport(presentation, reference.specifier), kind: reference.kind,
    }));
  }
  const importTypeMode = parseSource(presentation, "type Mode = import('../cards/file-preview-mode.ts').FilePreviewMode;");
  assert.doesNotThrow(() => assertPresentationImports(presentation, importTypeMode));

  const forbiddenRoutes = [
    "import type { SyntaxRuntime as Runtime } from '../application/syntax-runtime.ts';",
    "import * as provider from '../occipital/provider.ts';",
    "type Limits = import('../highlighting/limits.ts').Limits;",
    "export { prepareFileCard as prepare } from '../cards/file-input.ts';",
    "const producers = import('../cards/file-sources.ts');",
    "import type { ExtensionContext as HostContext } from '@earendil-works/pi-coding-agent';",
    "import type { Component as HostComponent } from '@earendil-works/pi-tui';",
    "import * as tui from '@earendil-works/pi-tui';",
    "type HostComponent = import('@earendil-works/pi-tui').Component;",
    "export type { Component as HostComponent } from '@earendil-works/pi-tui';",
    "const tui = import('@earendil-works/pi-tui');",
    "import { FilePreviewMode } from '../cards/file-preview-mode.ts';",
  ];
  for (const text of forbiddenRoutes) {
    const candidate = parseSource(presentation, text);
    assert.throws(() => {
      assertPresentationImports(presentation, candidate);
      for (const reference of moduleReferences(candidate)) {
        assertPresentationReference(presentation, reference);
        if (reference.specifier.startsWith('.')) assertEdgePolicy({
          source: presentation, target: resolveRelativeImport(presentation, reference.specifier), kind: reference.kind,
        });
      }
    });
  }
  for (const sourceOwner of ['src/resources/data-budget.ts', 'src/occipital/provider.ts',
    'src/highlighting/source-execution.ts', 'src/rendering/measured-rows.ts', 'src/cards/file-model.ts', 'src/appearance/style-ansi.ts']) {
    for (const kind of ['type-only', 'value', 'mixed']) assert.throws(() => assertEdgePolicy({
      source: sourceOwner, target: presentation, kind,
    }), /imports|ownership/);
  }
});

test('presentation accepts explicit display utilities rather than unclassified UI shapes', () => {
  const path = 'src/presentation/detail-owner.ts';
  for (const text of [
    "import { Input as NativeInput } from '@earendil-works/pi-tui';",
    "import type { Terminal as NativeTerminal } from '@earendil-works/pi-tui';",
  ]) assert.throws(() => assertPresentationImports(path, parseSource(path, text)), /component/);
});

test('presentation follows literal require edges rather than hiding higher-level ownership', () => {
  const path = 'src/presentation/detail-owner.ts';
  const references = moduleReferences(parseSource(path, "const runtime = require('../application/syntax-runtime.ts');"));
  assert.equal(references.length, 1);
  const reference = references[0];
  assert.throws(() => assertEdgePolicy({ source: path,
    target: resolveRelativeImport(path, reference.specifier), kind: reference.kind,
  }), /display capabilities/);
});

test('logical file models belong to cards without legacy type forwarding or host SDK imports', () => {
  const path = 'src/cards/file-model.ts', model = declarationExportNames(parseSource(path));
  const legacy = declarationExportNames(parseSource('src/file-card.ts'));
  const forwarded = reexportedSourceNames('src/file-card.ts', path);
  for (const name of ['FileCardInput', 'FileSource', 'PreparedFileCard']) {
    assert.ok(model.has(name), `cards owns logical file ${name}`);
    assert.ok(!legacy.has(name) && !forwarded.has(name) && !forwarded.has('*'), `file-card must not forward logical ${name}`);
  }
  for (const file of productionFiles().filter(file => file.startsWith('src/cards/') && sourceExtensions.has(extname(file)))) {
    for (const reference of moduleReferences(parseSource(file))) assertCardReference(file, reference);
  }
});

test('native modules are independent of application, highlighting, presentation and Pi host SDK', () => {
  for (const path of productionFiles().filter(path => path.startsWith('src/occipital/') && sourceExtensions.has(extname(path)))) {
    for (const reference of moduleReferences(parseSource(path))) assertNativeReference(path, reference);
  }
});

test('import-free leaves reject computed dynamic import expressions', () => {
  const violations = [
    "const path = 'node:path'; void import(path);",
    "const prefix = 'node:'; void import(prefix + 'path');",
    "const segment = 'path'; void import(`node:${segment}`);",
    "void import(('node:path'));",
  ];
  for (const text of violations) {
    const source = parseSource('synthetic.ts', text);
    assert.equal(source.parseDiagnostics.length, 0, text);
    assert.throws(() => assertImportFree('synthetic.ts', source), /must remain import-free/, text);
  }
});

test('import-free leaves reject computed direct require expressions', () => {
  const violations = [
    "const path = 'node:path'; require(path);",
    "const prefix = 'node:'; require(prefix + 'path');",
    "const segment = 'path'; require(`node:${segment}`);",
    "require(('node:path'));",
  ];
  for (const text of violations) {
    const source = parseSource('synthetic.ts', text);
    assert.equal(source.parseDiagnostics.length, 0, text);
    assert.throws(() => assertImportFree('synthetic.ts', source), /must remain import-free/, text);
  }
});

test('import-free leaves accept ordinary text and non-loader member calls', () => {
  for (const text of [
    "export const note = \"import('node:path') and require('node:path')\";",
    "// import('node:path'); require('node:path');\nexport type Choice = 'dark' | 'light';",
    "const local = { require(value: string) { return value; } }; export const text = local.require('data');",
  ]) {
    const source = parseSource('synthetic.ts', text);
    assert.equal(source.parseDiagnostics.length, 0, text);
    assert.doesNotThrow(() => assertImportFree('synthetic.ts', source));
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

test('chronological registry rejects domain ownership through type and value dependencies', () => {
  const source = 'src/highlighting/work-registry.ts';
  const forbidden = ['src/resources/data-budget.ts', 'src/appearance/card-roles.ts',
    'src/occipital/provider.ts', 'src/application/syntax-client.ts', 'src/syntax/cards.ts',
    'src/highlighting/storage/semantic-retention.ts', 'src/highlighting/source-execution.ts',
    'src/highlighting/source-ports.ts', 'src/highlighting/controller-styles.ts',
    'src/highlighting/style-preparation.ts', 'src/highlighting/pi-fallback.ts',
    'src/highlighting/pi-flat.ts', 'src/highlighting/card-publication.ts',
    'src/highlighting/controller-limits.ts', 'src/highlighting/limits.ts'];
  for (const target of forbidden) {
    for (const kind of ['type-only', 'value', 'mixed']) {
      assert.throws(() => assertEdgePolicy({ source, target, kind }), /chronological registry imports/);
    }
  }
  assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/highlighting/source-execution.ts',
    target: 'src/resources/data-budget.ts', kind: 'value' }));
});


test('card preparation uses narrow lower-level capabilities, never application or host ownership', () => {
  for (const kind of ['type-only', 'value', 'mixed']) {
    for (const target of ['src/application/syntax-client.ts', 'src/host/pi/tool.ts', 'src/presentation/tool.ts',
      'src/settings.ts', 'src/highlighting/source-execution.ts']) {
      assert.throws(() => assertEdgePolicy({ source: 'src/cards/new-owner.ts', target, kind }), /card preparation imports/);
    }
    for (const target of ['src/cards/file-model.ts', 'src/cards/file-sources.ts', 'src/rendering/prepared-card.ts']) {
      for (const source of ['src/occipital/provider.ts', 'src/highlighting/source-execution.ts', 'src/resources/data-budget.ts']) {
        assert.throws(() => assertEdgePolicy({ source, target, kind }), /imports/);
      }
      assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/work-registry.ts', target, kind }), /chronological registry imports/);
    }
    for (const target of ['src/resources/data-budget.ts', 'src/highlighting/source-ports.ts', 'src/rendering/prepared-card.ts']) {
      assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/cards/new-owner.ts', target, kind }));
    }
    for (const specifier of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/host']) {
      assert.throws(() => assertCardReference('src/cards/new-owner.ts', { specifier, kind }), /card preparation imports the Pi host SDK/);
    }
    assert.doesNotThrow(() => assertCardReference('src/cards/new-owner.ts', { specifier: '@earendil-works/pi-tui', kind }));
  }
  assert.throws(() => assertKnownGovernedModule('src/cards/unclassified.ts'), /unclassified governed source module/);
});


test('card preparation rejects provider acquisition and private highlighting implementations', () => {
  const source = 'src/cards/file-sources.ts';
  for (const kind of ['type-only', 'value', 'mixed']) {
    for (const target of ['src/occipital/provider.ts', 'src/occipital/acquisition.ts', 'src/occipital/discovery.ts',
      'src/occipital/factories.ts', 'src/occipital/stdio.ts', 'src/occipital/shared.ts',
      'src/occipital/semantic-codec.ts', 'src/highlighting/pi-fallback.ts', 'src/highlighting/card-publication.ts',
      'src/highlighting/work-registry.ts', 'src/highlighting/style-preparation.ts', 'src/highlighting/storage/pi-projection.ts']) {
      assert.throws(() => assertEdgePolicy({ source, target, kind }), /card preparation imports/);
    }
    assert.doesNotThrow(() => assertEdgePolicy({ source, target: 'src/highlighting/source-ports.ts', kind }));
  }
});


test('card preparation accepts only its own models, rendering, numeric funding and narrow source ports', () => {
  const source = 'src/cards/new-owner.ts';
  for (const kind of ['type-only', 'value', 'mixed']) {
    for (const target of ['src/syntax/work.ts', 'src/syntax/cards.ts', 'src/syntax/pi-input.ts',
      'src/tool-adapters/contracts.ts', 'src/tool-adapters/aft/file.ts', 'src/themes/selection.ts',
      'src/unclassified-owner.ts', ...presentationAndPayloadFiles]) {
      assert.throws(() => assertEdgePolicy({ source, target, kind }), /card preparation imports/);
    }
    for (const target of ['src/cards/file-model.ts', 'src/cards/file-sources.ts',
      'src/rendering/prepared-card.ts', 'src/resources/data-budget.ts', 'src/highlighting/source-ports.ts']) {
      assert.doesNotThrow(() => assertEdgePolicy({ source, target, kind }));
    }
  }
});


test('rendering accepts concrete style and numeric data, never preparation or source-work owners', () => {
  for (const source of ['src/rendering/new-owner.ts', 'src/rendering/card-layout.ts', 'src/rendering/measured-rows.ts',
    'src/rendering/scene-model.ts', 'src/rendering/bash-scene.ts', 'src/rendering/file-scene.ts']) {
    for (const kind of ['type-only', 'value', 'mixed']) {
      for (const target of ['src/cards/file-model.ts', 'src/cards/file-sources.ts', 'src/syntax/cards.ts',
        'src/syntax/work.ts', 'src/highlighting/source-ports.ts', 'src/highlighting/source-execution.ts',
        'src/highlighting/storage/semantic-retention.ts', 'src/occipital/style-types.ts', 'src/occipital/provider.ts',
        'src/tool-adapters/contracts.ts', 'src/application/syntax-client.ts', 'src/host/pi/tool.ts',
        'src/presentation/tool.ts', 'src/themes/selection.ts', 'src/appearance/theme-preference.ts', 'src/text-wrap.ts', 'src/unclassified-owner.ts', ...presentationAndPayloadFiles]) {
        if (source === 'src/rendering/card-layout.ts' && target === 'src/card-frame.ts'
          || source === 'src/rendering/scene-model.ts' && target === 'src/card-frame.ts' && kind === 'type-only'
          || source === 'src/rendering/measured-rows.ts' && target === 'src/text-wrap.ts') continue;
        assert.throws(() => assertEdgePolicy({ source, target, kind }), /rendering imports/);
      }
      for (const target of ['src/rendering/card-values.ts', 'src/rendering/card-styles.ts', 'src/resources/data-budget.ts',
        'src/appearance/card-roles.ts', 'src/appearance/style-materialization.ts', 'src/appearance/style-ansi.ts']) {
        assert.doesNotThrow(() => assertEdgePolicy({ source, target, kind }));
      }
      for (const specifier of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-coding-agent/host']) {
        assert.throws(() => assertRenderingReference(source, { specifier, kind }), /rendering imports the Pi host SDK/);
      }
      assert.doesNotThrow(() => assertRenderingReference(source, { specifier: '@earendil-works/pi-tui', kind }));
    }
  }
  for (const kind of ['type-only', 'value', 'mixed']) {
    assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/rendering/card-layout.ts', target: 'src/card-frame.ts', kind }));
    assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/rendering/measured-rows.ts', target: 'src/text-wrap.ts', kind }));
  }
  assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/rendering/scene-model.ts', target: 'src/card-frame.ts', kind: 'type-only' }));
  assert.throws(() => assertKnownGovernedModule('src/rendering/unclassified.ts'), /unclassified governed source module/);
});

test('render-facing card declarations belong to rendering, not preparation or logical normalization', () => {
  const path = 'src/rendering/card-values.ts';
  const moved = new Map([
    ['src/syntax/cards.ts', ['PreparedRegion', 'PreparedBashRegions', 'FileRowDescriptor', 'PreparedCard', 'ReadyCardPaint']],
    ['src/bash-card.ts', ['BashService', 'BashServiceInput']],
    ['src/rendering/flat-paint.ts', ['FlatRangeReader']],
  ]);
  for (const [legacyPath, names] of moved) {
    const legacy = declarationExportNames(parseSource(legacyPath));
    for (const name of names) assert.equal(legacy.has(name), false, `${legacyPath} must not own render-facing ${name}`);
  }
  const values = declarationExportNames(parseSource(path));
  for (const [legacyPath, names] of moved) {
    const forwarded = reexportedSourceNames(legacyPath, path);
    assert.equal(forwarded.has('*'), false, `${legacyPath} must not forward rendering values`);
    for (const name of names) {
      assert.equal(values.has(name), true, `rendering owns ${name}`);
      assert.equal(forwarded.has(name), false, `${legacyPath} must not forward ${name}`);
    }
  }
});


test('numeric measurement, reflow, scenes and flat painting have one renderer-owned declaration', () => {
  const legacy = new Set(['src/syntax/measured-rows.ts', 'src/syntax/card-layout.ts', 'src/syntax/flat-paint.ts']);
  for (const path of legacy) assert.equal(existsSync(resolve(projectRoot, path)), false, `superseded renderer seam must not forward: ${path}`);
  const sources = productionFiles().filter(path => sourceExtensions.has(extname(path))
    && (path.startsWith('src/rendering/') || legacy.has(path)))
    .map(path => ({ path, names: declarationExportNames(parseSource(path)) }));
  for (const name of ['MeasuredText', 'MeasuredRowLayout', 'GeometryRead', 'GeometryPolicy',
    'measure', 'reflow', 'prepareMeasuredAppend', 'CardLayout', 'CardRows', 'layoutCard', 'FlatText', 'FlatPaintRows', 'paintFlat']) {
    const owners = sources.filter(source => source.names.has(name)).map(source => source.path);
    assert.equal(owners.length, 1, `${name} requires one declaration owner`);
    assert.ok(owners[0].startsWith('src/rendering/'), `${name} belongs to rendering, not ${owners[0]}`);
  }
});

test('rendering rejects syntax implementation dependencies even through opaque type-only contracts', () => {
  for (const source of ['src/rendering/card-values.ts', 'src/rendering/new-owner.ts']) {
    for (const target of ['src/syntax/measured-rows.ts', 'src/syntax/card-layout.ts', 'src/syntax/flat-paint.ts']) {
      for (const kind of ['type-only', 'value', 'mixed']) {
        assert.throws(() => assertRenderingDependency({ source, target, kind }), /rendering imports/);
      }
    }
  }
});

test('saved file decoding and bounded logical preparation belong to cards, not heading or spacing helpers', () => {
  const legacy = new Set(['src/file-card.ts', 'src/syntax/shebang-language.ts']);
  assert.equal(existsSync(resolve(projectRoot, 'src/syntax/shebang-language.ts')), false, 'superseded shebang seam must not forward');
  assert.equal(reexportedSourceNames('src/file-card.ts', 'src/cards/file-input.ts').size, 0, 'heading/spacing helper must not forward logical preparation');
  const sources = productionFiles().filter(path => sourceExtensions.has(extname(path))
    && (path.startsWith('src/cards/') || legacy.has(path)))
    .map(path => ({ path, names: declarationExportNames(parseSource(path)) }));
  for (const name of ['sourceRows', 'filePreviewSource', 'filePreviewText', 'prepareFileCard', 'shebangLanguage']) {
    const owners = sources.filter(source => source.names.has(name)).map(source => source.path);
    assert.equal(owners.length, 1, `${name} requires one declaration owner`);
    assert.ok(owners[0].startsWith('src/cards/'), `${name} belongs to logical cards, not ${owners[0]}`);
  }
});


test('card preparation requests have one canonical card-domain model', () => {
  const implementation = parseSource('src/syntax/cards.ts');
  const names = ['CardSourceInput', 'CardDisplayInput'];
  for (const name of names) assert.equal(declarationExportNames(implementation).has(name), false,
    `preparation implementation must not own the shared ${name} model`);
  const model = parseSource('src/cards/display-input.ts');
  for (const name of names) assert.ok(declarationExportNames(model).has(name), `missing canonical ${name}`);
  assert.equal(reexportedSourceNames('src/syntax/cards.ts', 'src/cards/display-input.ts', implementation).size, 0,
    'preparation implementation must not forward the moved input models');
  for (const path of productionFiles().filter(path => sourceExtensions.has(extname(path)))) {
    if (path === 'src/cards/display-input.ts') continue;
    const declarations = declarationExportNames(parseSource(path));
    for (const name of names) assert.equal(declarations.has(name), false, `${path} duplicates the shared ${name} model`);
  }
  assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/cards/display-input.ts', target: 'src/tool-adapters/contracts.ts', kind: 'type-only' }));
  for (const kind of ['value', 'mixed']) assert.throws(() => assertEdgePolicy({
    source: 'src/cards/display-input.ts', target: 'src/tool-adapters/contracts.ts', kind,
  }), /card preparation imports/);
  assert.throws(() => assertEdgePolicy({ source: 'src/cards/file-preparation.ts',
    target: 'src/tool-adapters/contracts.ts', kind: 'type-only' }), /card preparation imports/);
});


test('entry and application composition leave concrete native UI and classification bindings in the host adapter', () => {
  for (const path of productionFiles().filter(path => path === entryPath || path.startsWith('src/application/')))
    assertApplicationHostImports(path, parseSource(path));
  for (const path of productionFiles().filter(path => path.startsWith('src/host/pi/')))
    assert.equal(reexportedSourceNames(entryPath, path).size, 0, `extension entry forwards native host bindings from ${path}`);
});

test('host import guard preserves public application capabilities without broad native access', () => {
  for (const path of [entryPath, 'src/application/presentation-runtime.ts']) {
    for (const text of [
      "import { VERSION, getAgentDir, type ExtensionContext as Context } from '@earendil-works/pi-coding-agent';",
      "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
      "type Context = import('@earendil-works/pi-coding-agent').ExtensionContext;",
      "type AgentDirectory = typeof import('@earendil-works/pi-coding-agent').getAgentDir;",
      "import { visibleWidth, backgroundAnsi, type TuiMouseEvent } from '@earendil-works/pi-tui';",
    ]) assert.doesNotThrow(() => assertApplicationHostImports(path, parseSource(path, text)), text);
    for (const text of [
      "import { Container as NativeTree } from '@earendil-works/pi-tui';",
      "import type { Component } from '@earendil-works/pi-tui';",
      "export type { Editor } from '@earendil-works/pi-tui';",
      "const native = require('@earendil-works/pi-tui');",
      "import { CustomEditor as Input } from '@earendil-works/pi-coding-agent';",
      "import { highlightCode } from '@earendil-works/pi-coding-agent';",
      "import { getAgentDir, type CustomEditor } from '@earendil-works/pi-coding-agent';",
      "import type * as NativeHost from '@earendil-works/pi-coding-agent';",
      "export * from '@earendil-works/pi-coding-agent';",
      "const native = import('@earendil-works/pi-coding-agent');",
      "const native = require('@earendil-works/pi-coding-agent');",
      "import NativeHost = require('@earendil-works/pi-coding-agent');",
      "type Input = import('@earendil-works/pi-coding-agent').CustomEditor;",
      "import { CustomEditor } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';",
      "import { CustomEditor } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js';",
    ]) assert.throws(() => assertApplicationHostImports(path, parseSource(path, text)), /Pi|component/u, text);
  }
});


test('Pi native binding leaves application, source and presentation implementations outside its ownership', () => {
  const source = 'src/host/pi/new-binding.ts';
  for (const target of ['src/application/syntax-runtime.ts', 'src/highlighting/source-execution.ts',
    'src/resources/data-budget.ts', 'src/cards/preparation.ts', 'src/presentation/tool-view-presenter.ts',
    'src/presentation/user-presenter.ts', 'src/render-cache.ts']) {
    assert.throws(() => assertEdgePolicy({ source, target, kind: 'value', syntax: 'import' }),
      /native host binding imports application or presentation implementation/u, target);
  }
  for (const target of ['src/application/syntax-runtime.ts', 'src/highlighting/source-execution.ts', 'src/resources/data-budget.ts']) {
    assert.throws(() => assertEdgePolicy({ source, target, kind: 'type-only', syntax: 'import-type' }),
      /native host binding imports application or presentation implementation/u, target);
  }
  for (const target of ['src/presentation/tool-view-presenter.ts', 'src/presentation/tool-producers.ts',
    'src/presentation/user-presenter.ts', 'src/presentation/queued-presenter.ts',
    'src/card-theme.ts', 'src/diagnostics.ts', 'src/syntax/work.ts']) {
    assert.doesNotThrow(() => assertEdgePolicy({ source, target, kind: 'type-only', syntax: 'import' }), target);
  }
  for (const target of ['src/host/pi/other-binding.ts', 'src/editor-card.ts', 'src/editor-status.ts']) {
    assert.doesNotThrow(() => assertEdgePolicy({ source, target, kind: 'value', syntax: 'import' }), target);
  }
});


test('application host guard rejects private TUI component access through relative paths', () => {
  for (const path of [entryPath, 'src/application/presentation-runtime.ts']) {
    for (const text of [
      "import { Container } from '../../node_modules/@earendil-works/pi-tui/dist/tui.js';",
      "import type { Component } from '../../node_modules/@earendil-works/pi-tui/dist/tui.js';",
      "export { Container } from '../../node_modules/@earendil-works/pi-tui/dist/tui.js';",
      "const native = require('../../node_modules/@earendil-works/pi-tui/dist/tui.js');",
      "const native = import('../../node_modules/@earendil-works/pi-tui/dist/tui.js');",
      "import Native = require('../../node_modules/@earendil-works/pi-tui/dist/tui.js');",
      "type Native = import('../../node_modules/@earendil-works/pi-tui/dist/tui.js').Container;",
    ]) assert.throws(() => assertApplicationHostImports(path, parseSource(path, text)), /Pi|component/u, text);
    assert.doesNotThrow(() => assertApplicationHostImports(path, parseSource(path,
      "import { visibleWidth } from '../../node_modules/@earendil-works/pi-tui/dist/utils.js';")));
  }
});

test('lower layers cannot back-import native host bindings for values or types', () => {
  for (const source of ['src/highlighting/source-execution.ts', 'src/occipital/client.ts',
    'src/resources/data-budget.ts', 'src/appearance/style-ansi.ts', 'src/cards/file-model.ts',
    'src/rendering/card-layout.ts', 'src/presentation/tool-view-presenter.ts',
    'src/syntax/cards.ts', 'src/themes/selection.ts', 'src/tool-adapters/pi/file.ts']) {
    for (const kind of ['type-only', 'value', 'mixed']) assert.throws(() => assertEdgePolicy({
      source, target: 'src/host/pi/native-bindings.ts', kind, syntax: 'import',
    }), /host/u, `${source} [${kind}]`);
  }
  assert.doesNotThrow(() => assertEdgePolicy({ source: entryPath,
    target: 'src/host/pi/native-bindings.ts', kind: 'value', syntax: 'import' }));
  assert.doesNotThrow(() => assertEdgePolicy({ source: 'src/application/session.ts',
    target: 'src/host/pi/native-session.ts', kind: 'value', syntax: 'import' }));
});


test('syntax composition consumes choices and provider facts without settings publication dependencies', () => {
  const violations = [];
  for (const path of syntaxApplicationModules) {
    try { assertSyntaxChoiceImports(path, parseSource(path)); }
    catch (error) { violations.push(`${path}: ${error.message}`); }
  }
  assert.deepEqual(violations, []);
});

test('syntax choice boundary permits domain inputs and rejects persistence and application ownership routes', () => {
  const path = 'src/application/syntax-runtime.ts';
  for (const specifier of ['../appearance/theme-preference.ts', '../diagnostics.ts', './syntax-client.ts',
    '../highlighting/source-ports.ts', '../occipital/provider.ts', '../syntax/pi-input-owner.ts']) {
    assert.doesNotThrow(() => assertSyntaxChoiceImports(path,
      parseSource(path, `import { type Model, implementation as alias } from '${specifier}';`)));
  }
  for (const specifier of ['../settings.ts', './preferences.ts', '../index.ts', '../tidy-menu.ts', 'node:fs', 'fs/promises',
    '@earendil-works/pi-coding-agent/dist/bundle/cli.js']) {
    const forbidden = [
      `import { implementation as alias } from '${specifier}';`,
      `import { type Model, implementation } from '${specifier}';`,
      `import type { Model } from '${specifier}';`,
      `import * as implementation from '${specifier}';`,
      `import '${specifier}';`,
      `export { implementation } from '${specifier}';`,
      `export type { Model } from '${specifier}';`,
      `export * from '${specifier}';`,
      `type Model = import('${specifier}').Model;`,
      `const implementation = import('${specifier}');`,
      `const implementation = require('${specifier}');`,
      `import implementation = require('${specifier}');`,
    ];
    for (const text of forbidden) {
      assert.throws(() => assertSyntaxChoiceImports(path, parseSource(path, text)), /exceeds choice\/provider capabilities/);
    }
  }
});


test('preference authority imports data and persistence without native or application implementation back-links', () => {
  const violations = [];
  for (const path of preferenceApplicationModules) {
    try { assertPreferenceImports(path, parseSource(path)); }
    catch (error) { violations.push(`${path}: ${error.message}`); }
  }
  assert.deepEqual(violations, []);
});

test('preference import policy accepts its actual data ports and rejects every native implementation route', () => {
  const path = 'src/application/preferences.ts';
  for (const specifier of ['../settings.ts', '../diagnostics.ts', '../appearance/theme-preference.ts', './syntax-menu.ts'])
    assert.doesNotThrow(() => assertPreferenceImports(path, parseSource(path, `import { type Model, implementation as alias } from '${specifier}';`)));
  for (const specifier of ['./syntax-client.ts', './syntax-runtime.ts', '../highlighting/source-execution.ts',
    '../occipital/provider.ts', '../index.ts', '../host/pi/native-session.ts', '../tidy-menu.ts', 'node:fs', '@earendil-works/pi-coding-agent']) {
    for (const text of [
      `import { implementation as alias } from '${specifier}';`,
      `import { type Model, implementation } from '${specifier}';`,
      `import type { Model } from '${specifier}';`,
      `import * as implementation from '${specifier}';`,
      `import '${specifier}';`,
      `export { implementation } from '${specifier}';`,
      `export type { Model } from '${specifier}';`,
      `export * from '${specifier}';`,
      `type Model = import('${specifier}').Model;`,
      `const implementation = import('${specifier}');`,
      `const implementation = require('${specifier}');`,
      `import implementation = require('${specifier}');`,
    ]) assert.throws(() => assertPreferenceImports(path, parseSource(path, text)), /preference policy imports an implementation owner/);
  }
});


test('fixed menu contracts have one application data owner without overlay forwarding', () => {
  const overlayPath = 'src/tidy-menu.ts', contractPath = 'src/application/menu-contract.ts';
  const names = ['TidyMenuAction', 'TidyMenuSnapshot', 'TidyMenuOwner'];
  const overlay = parseSource(overlayPath);
  for (const name of names) assert.equal(declarationExportNames(overlay).has(name), false,
    `overlay implementation must not own the shared ${name} contract`);
  const contract = parseSource(contractPath);
  for (const name of names) assert.ok(declarationExportNames(contract).has(name), `missing canonical ${name}`);
  assert.equal(reexportedSourceNames(overlayPath, contractPath, overlay).size, 0,
    'overlay implementation must not forward the moved menu contracts');
  for (const path of productionFiles().filter(path => sourceExtensions.has(extname(path)) && path !== contractPath)) {
    const declarations = declarationExportNames(parseSource(path));
    for (const name of names) assert.equal(declarations.has(name), false, `${path} duplicates the shared ${name} contract`);
  }
});

test('fixed menu models depend only on canonical data and named pure display helpers', () => {
  for (const path of menuDataModules) assertMenuDataImports(path, parseSource(path));
});

test('menu data boundary accepts narrow data and helpers without granting their implementation owners', () => {
  const contract = 'src/application/menu-contract.ts', model = 'src/application/menu-model.ts';
  for (const text of [
    "import type { ThemePreference as Choice } from '../appearance/theme-preference.ts';",
    "import type { Switches } from '../settings.ts';",
    "type Snapshot = import('./syntax-menu.ts').SyntaxMenuSnapshot;",
  ]) assert.doesNotThrow(() => assertMenuDataImports(contract, parseSource(contract, text)), text);
  for (const text of [
    "import { readableDiagnosticText as safe } from '../debug-log.ts';",
    "import { THEME_FAMILIES, themeFamilyEntry as family } from '../themes/catalogue.ts';",
    "import type { CacheStats as Statistics } from '../render-cache.ts';",
  ]) assert.doesNotThrow(() => assertMenuDataImports(model, parseSource(model, text)), text);
  for (const path of [contract, model]) {
    for (const specifier of ['../tidy-menu.ts', '../index.ts', './preferences.ts', './syntax-runtime.ts',
      '../host/pi/native-bindings.ts', '../highlighting/source-execution.ts', '@earendil-works/pi-tui']) {
      for (const text of [
        `import { implementation as alias } from '${specifier}';`,
        `import type { Shape } from '${specifier}';`,
        `import { type Shape, implementation } from '${specifier}';`,
        `export type { Shape } from '${specifier}';`,
        `type Shape = import('${specifier}').Shape;`,
        `const implementation = import('${specifier}');`,
        `const implementation = require('${specifier}');`,
        `import implementation = require('${specifier}');`,
      ]) assert.throws(() => assertMenuDataImports(path, parseSource(path, text)), /menu data imports/);
    }
  }
  for (const [path, text] of [
    [contract, "import { ExtensionSettings } from '../settings.ts';"],
    [contract, "import type { ExtensionSettings } from '../settings.ts';"],
    [model, "import { readableDiagnosticText, TextJournal } from '../debug-log.ts';"],
    [model, "import * as journal from '../debug-log.ts';"],
    [model, "type Logger = typeof import('../debug-log.ts').TextJournal;"],
  ]) assert.throws(() => assertMenuDataImports(path, parseSource(path, text)), /menu data (imports|requires)/);
});


test('menu action policy depends on scoped application capabilities rather than concrete runtime owners', () => {
  for (const path of menuActionModules) assertMenuActionImports(path, parseSource(path));
});

test('menu action dependency boundary accepts named policy data but rejects service and UI authority', () => {
  const path = menuActionModules[0];
  for (const text of [
    "import type { TidyMenuAction as Action, TidyMenuOwner } from './menu-contract.ts';",
    "import type { ApplicationPreferences, PreferenceScope, SwitchApplication } from './preferences.ts';",
    "import { RETIRED_SETTINGS_ACTION as closed, type SyntaxMenuOutcome } from './syntax-menu.ts';",
    "import { diagnose as record, type DiagnosticSink as Sink } from '../diagnostics.ts';",
    "import type { ThemePreference } from '../appearance/theme-preference.ts';",
    "type Scope = import('./preferences.ts').PreferenceScope;",
  ]) assertMenuActionImports(path, parseSource(path, text));
  for (const text of [
    "import { ApplicationPreferences } from './preferences.ts';",
    "import type { PreferenceStore } from './preferences.ts';",
    "import { diagnose, reportRuntime } from '../diagnostics.ts';",
    "import * as diagnostics from '../diagnostics.ts';",
    "import type * as preferences from './preferences.ts';",
    "import preferences from './preferences.ts';",
    "import './syntax-menu.ts';",
    "export { RETIRED_SETTINGS_ACTION } from './syntax-menu.ts';",
    "export type { PreferenceScope } from './preferences.ts';",
    "const preferences = await import('./preferences.ts');",
    "const preferences = require('./preferences.ts');",
    "import preferences = require('./preferences.ts');",
    "type Preferences = typeof import('./preferences.ts').ApplicationPreferences;",
    "type Logger = import('../session-logging.ts').SessionLogging;",
    "import { SessionLogging as Writer } from '../session-logging.ts';",
    "import type { SessionLogging } from '../session-logging.ts';",
    "import { SyntaxRuntime } from './syntax-runtime.ts';",
    "import { ExtensionSettings } from '../settings.ts';",
    "import type { SourceExecution } from '../highlighting/source-execution.ts';",
    "import type { PresentationCacheOwner } from '../presentation/cache-owner.ts';",
    "import { RenderCache } from '../render-cache.ts';",
    "import { OccipitalProvider } from '../occipital/provider.ts';",
    "import { NativeSession } from '../host/pi/native-session.ts';",
    "import { TidyMenu } from '../tidy-menu.ts';",
    "import { menuSnapshot } from './menu-model.ts';",
    "import type { ExtensionContext } from '@earendil-works/pi-coding-agent';",
    "import type { Container } from '@earendil-works/pi-tui';",
    "import { installTidyUi } from '../index.ts';",
  ]) assert.throws(() => assertMenuActionImports(path, parseSource(path, text)), /menu action policy (imports|requires)/);
});


test('session diagnostic binding owns only health and journal observation dependencies', () => {
  for (const path of diagnosticSessionModules) assertDiagnosticSessionImports(path, parseSource(path));
});

test('entry assembles diagnostic binding without owning health, journals or debug forwarding', () => {
  assertEntryDiagnosticOwnership(entryPath, parseSource(entryPath));
});

test('diagnostic binding import boundary permits explicit observers but rejects operational ownership', () => {
  const path = diagnosticSessionModules[0];
  for (const text of [
    "import { VERSION, type ExtensionContext } from '@earendil-works/pi-coding-agent';",
    "import { createRequire } from 'node:module';",
    "import { SessionLogging as Journal } from '../session-logging.ts';",
    "import { RuntimeHealth } from '../runtime-health.ts';",
    "import type { DiagnosticSink as Sink } from '../diagnostics.ts';",
    "type Context = import('@earendil-works/pi-coding-agent').ExtensionContext;",
    "import type { JournalOptions } from '../debug-log.ts';",
    "import { notify } from '../notifications.ts';",
  ]) assertDiagnosticSessionImports(path, parseSource(path, text));
  for (const text of [
    "import { diagnose } from '../diagnostics.ts';",
    "import * as health from '../runtime-health.ts';",
    "import { RuntimeHealth as Health, type RuntimeIssue } from '../runtime-health.ts';",
    "type Health = typeof import('../runtime-health.ts').RuntimeHealth;",
    "import { TextJournal } from '../debug-log.ts';",
    "import '../session-logging.ts';",
    "export { SessionLogging } from '../session-logging.ts';",
    "const health = import('../runtime-health.ts');",
    "const health = require('../runtime-health.ts');",
    "import health = require('../runtime-health.ts');",
    "import { SyntaxRuntime } from './syntax-runtime.ts';",
    "import { ApplicationPreferences } from './preferences.ts';",
    "import { ExtensionSettings } from '../settings.ts';",
    "import type { TidyMenuOwner } from './menu-contract.ts';",
    "import type { SourceExecution } from '../highlighting/source-execution.ts';",
    "import type { TidyUiController } from '../index.ts';",
    "import { NativeSession } from '../host/pi/native-session.ts';",
    "import type { FooterView } from '../footer.ts';",
    "import { TerminalColors } from '../terminal-colors.ts';",
    "import type { Container } from '@earendil-works/pi-tui';",
    "import { ToolExecutionComponent } from '@earendil-works/pi-coding-agent';",
    "import * as fs from 'node:fs/promises';",
  ]) assert.throws(() => assertDiagnosticSessionImports(path, parseSource(path, text)), /session diagnostic binding (imports|requires)/);
});

test('entry diagnostic ownership boundary accepts composition and rejects implementation loads and forwarders', () => {
  for (const text of [
    "import { SessionDiagnostics as Observations } from './application/diagnostic-session.ts';",
    "import type { RuntimeHealth } from './runtime-health.ts';",
    "import type { SessionLogging } from './session-logging.ts';",
  ]) assertEntryDiagnosticOwnership(entryPath, parseSource(entryPath, text));
  for (const text of [
    "import { RuntimeHealth as Health } from './runtime-health.ts';",
    "import { RuntimeHealth } from './runtime-health.js';",
    "const journal = require('./session-logging');",
    "import * as logging from './session-logging.ts';",
    "import { type RuntimeIssue, RuntimeHealth } from './runtime-health.ts';",
    "export { SessionLogging } from './session-logging.ts';",
    "const logging = import('./session-logging.ts');",
    "const logging = require('./session-logging.ts');",
    "import logging = require('./session-logging.ts');",
    "export { debugLoggingDiagnostics as status } from './application/diagnostic-session.ts';",
    "export { debugLoggingDiagnostics } from './application/../application/diagnostic-session.ts';",
    "export type { SessionDiagnostics } from './application/diagnostic-session.ts';",
    "export function debugLoggingDiagnostics() {}",
  ]) assert.throws(() => assertEntryDiagnosticOwnership(entryPath, parseSource(entryPath, text)), /entry (owns|forwards) session diagnostic/);
});


test('application footer and terminal bindings import only their named observation and lifecycle capabilities', () => {
  for (const path of presentationBindingModules) assertPresentationBindingImports(path, parseSource(path));
});

test('entry delegates footer and terminal lifetimes without implementing or forwarding their observations', () => {
  assertEntryPresentationBindingOwnership(entryPath, parseSource(entryPath));
});

test('presentation binding capability controls reject owner bags and retain exact native fact exceptions', () => {
  for (const [path, dependencies] of presentationBindingDependencies) {
    for (const [target, bindings] of dependencies) {
      const specifier = target.startsWith('src/') ? `../${target.slice(4)}` : target;
      for (const name of bindings.values ?? []) assert.doesNotThrow(() => assertPresentationBindingImports(path,
        parseSource(path, `import { ${name} as allowed } from '${specifier}';`)));
      for (const name of bindings.types ?? []) assert.doesNotThrow(() => assertPresentationBindingImports(path,
        parseSource(path, `import type { ${name} as Allowed } from '${specifier}';`)));
    }
    for (const specifier of ['./preferences.ts', './syntax-runtime.ts', '../index.ts', '../highlighting/source-execution.ts',
      '../settings.ts', '../render-cache.ts', '../tidy-menu.ts', './menu-contract.ts', '../host/pi/native-session.ts']) {
      for (const snippet of [`import { Owner as alias } from '${specifier}';`, `import type { Owner } from '${specifier}';`,
        `import { type Model, Owner } from '${specifier}';`, `export * from '${specifier}';`,
        `const owner = import('${specifier}');`, `const owner = require('${specifier}');`,
        `type Owner = import('${specifier}').Owner;`]) {
        assert.throws(() => assertPresentationBindingImports(path, parseSource(path, snippet)), /application presentation binding/);
      }
    }
    assert.throws(() => assertPresentationBindingImports(path,
      parseSource(path, "import { observeFooterSlot } from '../host/pi/native-bindings.ts';")), /application presentation binding/);
  }
  assert.throws(() => assertPresentationBindingImports(presentationBindingModules[0],
    parseSource(presentationBindingModules[0], "import { terminalAppearanceTracking } from '../host/pi/native-bindings.ts';")), /application presentation binding/);
});

test('entry binding controls cover alternate paths, mixed imports and renamed debug forwarding', () => {
  assert.doesNotThrow(() => assertEntryPresentationBindingOwnership(entryPath,
    parseSource(entryPath, "import type { DefaultColors } from './terminal-colors.ts';")));
  for (const suffix of ['.ts', '.js', '']) {
    for (const [name, file] of [['FooterSession', 'footer-session'], ['TerminalColorSession', 'terminal-color-session']]) {
      const specifier = `./application/../application/${file}${suffix}`;
      assert.doesNotThrow(() => assertEntryPresentationBindingOwnership(entryPath,
        parseSource(entryPath, `import { ${name} as Binding } from '${specifier}';`)));
      for (const snippet of [`import { terminalColorDiagnostics as renamed } from '${specifier}'; export { renamed as probe };`,
        `import { ${name}, terminalColorDiagnostics } from '${specifier}';`, `import * as Binding from '${specifier}';`,
        `export { ${name} } from '${specifier}';`, `const Binding = require('${specifier}');`,
        `const Binding = import('${specifier}');`]) {
        assert.throws(() => assertEntryPresentationBindingOwnership(entryPath, parseSource(entryPath, snippet)), /entry/);
      }
    }
  }
  for (const specifier of ['./footer.ts', './terminal-colors.ts', './terminal-lifecycle.ts']) {
    for (const snippet of [`import { Implementation as alias } from '${specifier}';`,
      `import { type Model, Implementation } from '${specifier}';`, `export * from '${specifier}';`,
      `const implementation = require('${specifier}');`, `const implementation = import('${specifier}');`]) {
      assert.throws(() => assertEntryPresentationBindingOwnership(entryPath, parseSource(entryPath, snippet)), /entry owns/);
    }
  }
  assert.throws(() => assertEntryPresentationBindingOwnership(entryPath,
    parseSource(entryPath, 'export function terminalColorDiagnostics() {}')), /entry forwards/);
});


test('application currentness scope consumes only the existing preference-scope type', () => {
  for (const path of currentnessModules) assertCurrentnessImports(path, parseSource(path));
});

test('entry borrows currentness without another abort owner or factory-level numeric generation', () => {
  assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath));
});

test('currentness boundary controls reject service and abort authorities without banning immutable captured tokens', () => {
  const path = currentnessModules[0];
  assert.doesNotThrow(() => assertCurrentnessImports(path, parseSource(path, "import type { PreferenceScope as Scope } from './preferences.ts';")));
  for (const snippet of ["import { ApplicationPreferences } from './preferences.ts';", "import * as Preferences from './preferences.ts';",
    "import { type PreferenceScope, ApplicationPreferences } from './preferences.ts';", "import { notify } from '../notifications.ts';",
    "import type { ExtensionContext } from '@earendil-works/pi-coding-agent';", "import type { NativeSession } from '../host/pi/native-session.ts';",
    "import { RuntimeHealth } from '../runtime-health.ts';", "import type { SourceExecution } from '../highlighting/source-execution.ts';",
    "export * from './preferences.ts';", "const preferences = require('./preferences.ts');", "const preferences = import('./preferences.ts');",
    "type Owner = import('./preferences.ts').ApplicationPreferences;"]) {
    assert.throws(() => assertCurrentnessImports(path, parseSource(path, snippet)), /application currentness scope/);
  }
  assert.doesNotThrow(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath,
    'export default function tidyUi() { const captured = 0; let label = ""; return captured; }')));
  assert.doesNotThrow(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath,
    'export function installTidyUi() { let instrumentation = 0; }')));
  for (const snippet of ['export default function tidyUi() { let generation = 0; }',
    'const Controller = AbortController;', 'const Controller = globalThis["AbortController"];']) {
    assert.throws(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath, snippet)), /entry owns/);
  }
  for (const suffix of ['.ts', '.js', '']) {
    const specifier = `./application/../application/scope${suffix}`;
    assert.doesNotThrow(() => assertEntryCurrentnessOwnership(entryPath,
      parseSource(entryPath, `import { ApplicationScope as Scope } from '${specifier}';`)));
    for (const snippet of [`export * from '${specifier}';`, `export { ApplicationScope as Scope } from '${specifier}';`,
      `const Scope = require('${specifier}');`, `const Scope = import('${specifier}');`]) {
      assert.throws(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath, snippet)), /entry forwards/);
    }
  }
});

for (const [form, snippet] of [
  ['renamed declaration', 'export default function entry() { let generation = 0; }'],
  ['anonymous declaration', 'export default function () { let generation = 0; }'],
  ['arrow expression', 'export default () => { let generation = 0; };'],
  ['referenced callable', 'const entry = () => { let generation = 0; }; export default entry;'],
  ['local function export list', 'function tidyUi() { let generation = 0; } export { tidyUi as default };'],
  ['local arrow export list', 'const entry = () => { let generation = 0; }; export { entry as default };'],
  ['string-named export list', "const entry = () => { let generation = 0; }; export { entry as 'default' };"],
  ['parenthesized assertion', 'export default ((() => { let generation = 0; }) as (() => void));'],
  ['type assertion', 'export default <(() => void)>(() => { let generation = 0; });'],
  ['satisfies expression', 'export default (() => { let generation = 0; }) satisfies (() => void);'],
  ['nonnull expression', 'export default (() => { let generation = 0; })!;'],
  ['local alias chain', 'const core = () => { let generation = 0; }; const entry = core; export default entry;'],
  ['local function expression', 'const entry = function () { let generation = 0; }; export default entry;'],
]) {
  test(`entry currentness rejects a second generation in the ${form} default export`, () => {
    assert.throws(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath, snippet)),
      /entry owns a mutable application numeric generation slot/);
  });
}

test('entry currentness does not confuse an unrelated named helper with the actual default entry', () => {
  assert.doesNotThrow(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath,
    'function tidyUi() { let instrumentation = 0; } export default function entry() { const captured = 0; return captured; }')));
});


test('entry currentness resolves a local default export list without taking ownership of an unrelated helper', () => {
  assert.doesNotThrow(() => assertEntryCurrentnessOwnership(entryPath, parseSource(entryPath,
    'function tidyUi() { let instrumentation = 0; } const entry = () => { const captured = 0; return captured; }; export { entry as default };')));
});


for (const model of sourceDecisionModules) test(`pure work decision governance rejects module loading from ${model}`, () => {
  const source = text => path => parseSource(path, path === model ? text : undefined);
  assert.doesNotThrow(() => assertPureMigratedModules(source("export const next = (ready: boolean) => ready ? 'run' : 'wait';")));
  for (const text of [
    "import { setTimeout } from 'node:timers';",
    "import type { SourceExecution } from './source-execution.ts';",
    "export { SourceExecution } from './source-execution.ts';",
    "export * from './source-execution.ts';",
    "type Owner = import('./source-execution.ts').SourceExecution;",
    "const dependency = import('node:timers');",
    "const dependency = require('node:timers');",
    "import dependency = require('node:timers');",
    'const dependency = import(selectedModule);',
    'const dependency = require(selectedModule);',
  ]) {
    assert.throws(() => assertPureMigratedModules(source(text)), /must remain import-free/, text);
  }
});

test('chronological registry cannot depend on SOURCE or STYLE decision models', () => {
  for (const target of sourceDecisionModules) for (const kind of ['type-only', 'value', 'mixed']) {
    assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/work-registry.ts', target, kind }),
      /chronological registry imports/);
  }
});


test('STYLE publication is private to execution while its reverse dependency is type-only', () => {
  const execution = 'src/highlighting/source-execution.ts', publication = 'src/highlighting/style-publication.ts';
  for (const kind of ['type-only', 'value', 'mixed']) {
    assert.doesNotThrow(() => assertEdgePolicy({ source: execution, target: publication, kind }));
    assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/pi-fallback.ts', target: publication, kind }), /private style publication/);
  }
  assert.doesNotThrow(() => assertEdgePolicy({ source: publication, target: execution, kind: 'type-only' }));
  for (const kind of ['value', 'mixed']) {
    assert.throws(() => assertEdgePolicy({ source: publication, target: execution, kind }), /style publication imports/);
    for (const target of ['src/occipital/provider.ts', 'src/highlighting/work-registry.ts']) {
      assert.throws(() => assertEdgePolicy({ source: publication, target, kind }), /style publication imports/);
    }
  }
  for (const target of ['src/occipital/stdio.ts', 'src/occipital/shared.ts', 'src/highlighting/pi-fallback.ts']) {
    for (const kind of ['type-only', 'value', 'mixed']) {
      assert.throws(() => assertEdgePolicy({ source: publication, target, kind }), /style publication imports/);
    }
  }
});

test('flat execution records cannot become a runtime or external source capability', () => {
  const records = 'src/highlighting/execution-records.ts';
  for (const source of ['src/highlighting/source-execution.ts', 'src/highlighting/style-publication.ts']) {
    assert.doesNotThrow(() => assertEdgePolicy({ source, target: records, kind: 'type-only' }));
    for (const kind of ['value', 'mixed']) {
      assert.throws(() => assertEdgePolicy({ source, target: records, kind }), /execution records/);
    }
  }
  assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/pi-fallback.ts', target: records, kind: 'type-only' }), /execution records/);
  for (const target of ['src/highlighting/style-publication.ts', records]) {
    for (const kind of ['type-only', 'value', 'mixed']) {
      assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/work-registry.ts', target, kind }), /chronological registry imports/);
      assert.throws(() => assertEdgePolicy({ source: 'src/highlighting/storage/semantic-retention.ts', target, kind }), /storage module imports/);
    }
  }
});


test('publication type dependencies require complete erasure across aliases and reexports', () => {
  const path = 'src/highlighting/style-publication.ts';
  const erased = [
    "import type { SourceExecution as Execution } from './source-execution.ts';",
    "export type { SourceExecution } from './source-execution.js';",
    "type Execution = import('./source-execution.ts').SourceExecution;",
    "import type { SourceWorkGroup } from './work-registry.ts';",
  ];
  for (const text of erased) assert.doesNotThrow(() => assertPublicationModule(path, parseSource(path, text)));
  for (const text of [
    "import { SourceExecution as Execution } from './source-execution.ts';",
    "import { type SourceExecution } from './source-execution.ts';",
    "import { type SourceExecution, SourceExecution as Execution } from './source-execution.ts';",
    "export { type SourceExecution } from './source-execution.ts';",
    "export * from './source-execution.ts';",
    "import './source-execution.ts';",
  ]) {
    assert.throws(() => assertPublicationModule(path, parseSource(path, text)), /whole-declaration erasure/);
  }
  for (const text of [
    "import('./source-execution.ts');",
    "const execution = require('./source-execution.ts');",
    "import Execution = require('./source-execution.ts');",
  ]) {
    const references = moduleReferences(parseSource(path, text));
    assert.equal(references.length, 1);
    assert.throws(() => assertEdgePolicy({ source: path, target: 'src/highlighting/source-execution.ts', kind: references[0].kind }), /style publication imports/);
  }
});

test('execution record declarations erase without initialization, values or phantom runtime exports', () => {
  const path = 'src/highlighting/execution-records.ts';
  for (const text of [
    'export interface Record { version: number } export type Version = Record["version"];',
    "import type { DataCharge as Charge } from '../resources/data-budget.ts'; export type Record = { charge: Charge };",
    "export type { ContextRef } from './storage/context-arena.ts';",
    "export type * from './source-state.ts';",
    "type Provider = typeof import('../occipital/provider.ts');",
  ]) assert.doesNotThrow(() => assertPublicationModule(path, parseSource(path, text)));
  for (const text of [
    "import { type ContextRef } from './storage/context-arena.ts';",
    "export { type ContextRef } from './storage/context-arena.ts';",
    "import './source-state.ts';",
    "export { nextSource } from './source-state.ts';",
    'export const runtimeValue = 1;',
    'export class RuntimeRecord {}',
    'function initialize() {}',
    "const loaded = import('./source-state.ts');",
    'declare const phantom: unknown;',
    'export namespace RuntimeRecords { export const value = 1; }',
    'export type Record = {}; (() => 0)();',
  ]) assert.throws(() => assertPublicationModule(path, parseSource(path, text)), /only erased type declarations/);
});
