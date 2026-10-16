import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const featureNames = Object.freeze(['summaries', 'bash', 'edit', 'write', 'user', 'queued', 'editor', 'footer', 'layout', 'lifecycle', 'activity', 'settings', 'terminal-colors', 'logging', 'syntax', 'native', 'shared', 'profile', 'harness', 'delivery']);
const entries = [];
function add(owner, files, { layer = 'node', requirements = [], product = false, suites = [], platforms, also = [] } = {}) {
  for (const file of files.split(' ')) entries.push(Object.freeze({ file, owner, also: Object.freeze([...also]), layer, requirements: Object.freeze([...requirements]), product, suites: Object.freeze([...suites]), ...(platforms ? { platforms: Object.freeze(platforms) } : {}) }));
}
for (const owner of ['summaries','bash','edit','write','user','editor','footer','layout','lifecycle','activity','terminal-colors']) add(owner, `${owner}.sdk.test.ts`, { product: true });
add('layout', 'component-layouts.test.ts', { product: true });
add('queued', 'queued-cards.test.ts', { product: true });
add('activity', 'spinner-scheduler.test.ts', { product: true });
add('footer', 'footer-session-name.test.ts footer-session-title.test.ts', { product: true });
add('settings', 'settings.test.ts tidy-menu.test.ts', { product: true });
add('logging', 'session-logging.test.ts debug-log.test.ts', { product: true });
add('lifecycle', 'naming.test.ts', { product: true });
add('syntax', 'occipital-bootstrap.test.ts occipital-client.test.ts occipital-controller.test.ts occipital-discovery.test.ts occipital-native-delivery.test.ts occipital-pi-bridge.test.ts occipital-profiles.test.ts occipital-protocol.test.ts occipital-provider.test.ts occipital-ranges.test.ts occipital-retention.test.ts occipital-shared.test.ts occipital-stdio.test.ts shared-fixture-ownership.test.ts syntax-card-display.test.ts syntax-card-lifecycle.test.ts syntax-cards.test.ts syntax-entry.test.ts syntax-host.test.ts syntax-paint.test.ts syntax-pi.test.ts syntax-runtime.test.ts syntax-sources.test.ts syntax-work.test.ts', { product: true });
add('syntax', 'occipital-factories.test.ts', { product: true, suites: ['native'] });
add('syntax', 'occipital-factories.posix.test.ts', { product: true, suites: ['native'], platforms: ['linux', 'darwin'] });
add('native', 'occipital-native.test.ts occipital-controller.native.test.ts occipital-factories.native.test.ts', { requirements: ['native'], suites: ['native'] });
add('profile', 'integration-profile.compat.test.mjs', { requirements: ['integration'] });
add('harness', 'integration-profile.test.mjs menu-driver.test.ts pty-bridge.test.mjs syntax-observation.test.mjs syntax-stock-reference.test.mjs terminal-cleanup.test.mjs terminal-code-cache.test.mjs terminal-harness.test.mjs terminal-helper.test.mjs terminal-observer.test.mjs terminal-output.test.mjs terminal-progress.test.mjs terminal-rows.test.mjs test-filtering.test.ts test-fixtures.test.ts test-harness.test.mjs test-catalog.test.mjs test-feature.test.mjs ci-scope.test.mjs');
add('delivery', 'consumer-preparation.test.mjs installed-consumer.test.mjs local-registry.test.mjs npm-preparation.test.ts');
add('delivery', 'native-release.test.mjs release-ci.test.mjs release-version.test.mjs npm-release.test.mjs extension-release.test.mjs makefile.test.ts', { suites: ['native-release'] });
add('delivery', 'native-preparation.test.mjs consumer-diagnostics.test.mjs', { suites: ['native-release'], also: ['harness'] });
add('harness', 'rust-harness.test.mjs', { requirements: ['rust'], suites: ['rust-harness'] });
add('lifecycle', 'smoke.cli.test.mjs', { layer: 'cli', suites: ['terminal', 'smoke'] });
for (const owner of ['harness','summaries','bash','edit','write','user','queued','editor','footer','layout','activity','settings','terminal-colors']) add(owner, `${owner}.cli.test.mjs`, { layer: 'cli', suites: ['terminal'] });
add('summaries', 'argument-previews.cli.test.mjs', { layer: 'cli', also: ['edit'], suites: ['terminal'] });
add('profile', 'profile.cli.test.mjs', { layer: 'cli', requirements: ['integration'], suites: ['terminal'] });
add('syntax', 'syntax-owned.cli.test.mjs syntax-menu.cli.test.mjs logging-native.cli.test.mjs', { layer: 'cli', requirements: ['native'], suites: ['syntax-terminal'] });
add('shared', 'syntax-shared.cli.test.mjs', { layer: 'cli', requirements: ['native','shared'], suites: ['syntax-terminal'] });
add('logging', 'logging-fallback.cli.test.mjs', { layer: 'cli', suites: ['syntax-terminal'] });
add('delivery', 'fixtures/installed-occipital.mjs', { layer: 'script', requirements: ['native','registry'], suites: ['consumer'] });
add('delivery', 'fixtures/published-occipital.mjs', { layer: 'script', suites: ['published-consumer'] });
export const testEntries = Object.freeze(entries);
const byFile = new Map(entries.map(entry => [entry.file, entry]));
if (byFile.size !== entries.length) throw new Error('Duplicate catalogue ownership');
const union = values => [...new Set(values)].sort();
export function selectionRequirements(files) {
  return union(files.flatMap(file => {
    const entry = byFile.get(file);
    if (!entry) throw new Error('Unknown test ownership: ' + file);
    return entry.requirements;
  }));
}
export function validateCatalogue(root) {
  const actual = readdirSync(join(root, 'tests')).filter(file => /\.test\.(?:ts|mjs)$/.test(file));
  for (const file of actual) if (!byFile.has(file)) throw new Error('Unknown test ownership: ' + file);
  for (const entry of entries) if (!existsSync(join(root, 'tests', entry.file))) throw new Error('Missing catalogued test: ' + entry.file);
  return true;
}
function featureFiles(features, baseline) {
  if (!Array.isArray(features) || features.some(name => !featureNames.includes(name))) throw new Error('Unknown feature group');
  return entries.filter(entry => (baseline && (entry.product || entry.suites.includes('smoke'))) || features.includes(entry.owner) || entry.also.some(name => features.includes(name)));
}
export function featurePlan(features, { baseline = true, platform = process.platform } = {}) {
  const selected = featureFiles(features, baseline).filter(entry => entry.layer !== 'script' && !entry.suites.includes('rust-harness') && (!entry.platforms || entry.platforms.includes(platform)));
  const files = union(selected.map(entry => entry.file));
  return { features: union(features), node: files.filter(file => byFile.get(file).layer === 'node'), cli: files.filter(file => byFile.get(file).layer === 'cli'), requirements: selectionRequirements(files) };
}
export function resolveSelection(root, { suite = 'unit', groups, files, layer, platform = process.platform } = {}) {
  validateCatalogue(root);
  const suites = new Set(['unit','product','groups','harness','check','rust','rust-check','rust-allocator', ...entries.flatMap(entry => entry.suites)]);
  if (!suites.has(suite)) throw new Error('Unknown test suite: ' + suite);
  if (layer && !['node','cli'].includes(layer)) throw new Error('Unknown test layer');
  if (groups !== undefined && files !== undefined) throw new Error('Use groups or files, not both');
  if (['check','rust','rust-check','rust-allocator','consumer','published-consumer'].includes(suite) && [groups,files,layer].some(value => value !== undefined)) throw new Error('This suite has a fixed entry, not a file/group selection');
  let selected;
  if (files !== undefined) {
    selected = files.split(',');
    if (!selected.length || selected.some(file => !byFile.has(file))) throw new Error('Unknown selected test ownership');
  } else if (groups !== undefined) {
    const names = groups.split(',');
    if (names.some(name => !featureNames.includes(name))) throw new Error('Unknown feature group');
    selected = featureFiles(names, false).filter(entry => entry.layer !== 'script' && !entry.suites.includes('rust-harness')).map(entry => entry.file);
  } else if (suite === 'product') selected = entries.filter(entry => entry.product).map(entry => entry.file);
  else if (suite === 'unit') selected = entries.filter(entry => entry.layer === 'node' && !entry.suites.includes('native-release') && !entry.suites.includes('rust-harness')).map(entry => entry.file);
  else if (['check','rust','rust-check','rust-allocator'].includes(suite)) selected = [];
  else if (suite === 'harness') selected = entries.filter(entry => entry.owner === 'harness' && entry.layer === 'node' && !entry.suites.includes('rust-harness')).map(entry => entry.file);
  else if (suite === 'groups') throw new Error('groups suite requires explicit groups or files');
  else {
    selected = entries.filter(entry => entry.suites.includes(suite)).map(entry => entry.file);
    if (!selected.length) throw new Error('Unknown test suite: ' + suite);
  }
  const excluded = [];
  selected = union(selected).filter(file => {
    const entry = byFile.get(file);
    if (layer && entry.layer !== layer) return false;
    if (entry.platforms && !entry.platforms.includes(platform)) {
      if (files !== undefined) throw new Error('Selected test is outside its declared platform scope: ' + file);
      excluded.push({ file, reason: 'platform', supported: entry.platforms }); return false;
    }
    if (!existsSync(join(root, 'tests', file))) throw new Error('Missing catalogued test: ' + file);
    return true;
  });
  if (!selected.length && !['check','rust','rust-check','rust-allocator'].includes(suite)) throw new Error('Empty test selection');
  const layers = union(selected.map(file => byFile.get(file).layer));
  if (layers.includes('script') && (selected.length !== 1 || !['consumer','published-consumer'].includes(suite))) throw new Error('Consumer scripts require their explicit authorized suite');
  const stageRequirements = ['rust','rust-check','rust-allocator'].includes(suite) ? ['rust'] : [];
  return { files: selected, requirements: union([...selectionRequirements(selected), ...stageRequirements]), layers, excluded };
}
export function selectSuite(inputs, suite) { return resolveSelection(inputs.pi.root, { suite }).files; }
