import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const featureNames = Object.freeze(['summaries', 'bash', 'edit', 'write', 'user', 'queued', 'editor', 'footer', 'layout', 'lifecycle', 'activity', 'settings', 'terminal-colors', 'logging', 'syntax', 'native', 'shared', 'profile', 'harness', 'delivery']);
const defaultRoot = resolve(import.meta.dirname, '../..');
const union = values => [...new Set(values)].sort();
const supportDirectories = new Set(['fixtures', 'helpers', 'support']);
// Categories declare execution environments; feature subdirectories only select local work.
const categories = Object.freeze({
  product: { layer: 'node', requirements: [], product: true },
  integration: { layer: 'node', requirements: [] },
  harness: { layer: 'node', requirements: [] },
  'native-build': { layer: 'node', requirements: ['rust'] },
  cli: { layer: 'cli', requirements: [] },
});
const fixedEntries = Object.freeze([
  { file: 'fixtures/installed-occipital.mjs', owner: 'delivery', also: [], layer: 'script', requirements: ['native', 'registry'], suites: ['consumer'] },
  { file: 'fixtures/published-occipital.mjs', owner: 'delivery', also: [], layer: 'script', requirements: [], suites: ['published-consumer'] },
]);
function entryFor(file) {
  const parts = file.split('/'), category = parts.shift(), rule = categories[category];
  if (!rule) throw new Error('Unknown test category: ' + file);
  parts.pop();
  if (category === 'integration' && !['native', 'profile'].includes(parts[0])) throw new Error('Unknown integration prerequisite: ' + file);
  const requirements = category === 'integration'
    ? parts[0] === 'native' ? ['native'] : ['integration']
    : category === 'cli' && parts[0] === 'shared' ? ['native', 'shared']
    : category === 'cli' && parts[0] === 'native' ? ['native']
    : category === 'cli' && parts[0] === 'profile' ? ['integration'] : rule.requirements;
  const nativeContract = category === 'product' && parts[0] === 'native';
  const nativeRuntime = category === 'integration' && parts[0] === 'native';
  const features = union([...(category === 'harness' ? ['harness'] : []), ...(category === 'harness' && parts.includes('packaging') ? ['delivery'] : []), ...parts.filter(part => featureNames.includes(part))]);
  const delivery = category === 'harness' && parts[0] === 'delivery';
  const nativeCLI = rule.layer === 'cli' && requirements.includes('native');
  const suites = [
    ...(delivery ? ['native-release'] : []),
    ...(nativeContract || nativeRuntime ? ['native'] : []),
    ...(category === 'native-build' ? ['rust-harness'] : []),
    ...(rule.layer === 'cli' && (nativeCLI || parts.includes('syntax')) ? ['syntax-terminal'] : []),
    ...(rule.layer === 'cli' && !nativeCLI && !parts.includes('syntax') ? ['terminal'] : []),
    ...(rule.layer === 'cli' && parts.includes('smoke') ? ['smoke'] : []),
  ];
  return Object.freeze({ file, category, owner: features[0] ?? category, also: Object.freeze(features.slice(1)), features: Object.freeze(features), layer: rule.layer,
    requirements: Object.freeze([...requirements]), product: Boolean(rule.product), delivery, suites: Object.freeze(suites),
    ...(parts.includes('linux') ? { platforms: Object.freeze(['linux']) }
      : parts.includes('posix') ? { platforms: Object.freeze(['linux', 'darwin']) } : {}) });
}
function walk(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = prefix + entry.name;
    if (entry.isDirectory()) return supportDirectories.has(entry.name) ? [] : walk(join(directory, entry.name), file + '/');
    if (/\.test\.(?:ts|mjs)$/.test(entry.name)) {
      if (!entry.isFile()) throw new Error('Executable test must be a regular file: ' + file);
      return [file];
    }
    return [];
  }).sort();
}
export function discoverEntries(root = defaultRoot) {
  const entries = walk(join(root, 'tests')).map(entryFor);
  for (const entry of fixedEntries) if (existsSync(join(root, 'tests', entry.file))) entries.push(entry);
  return entries.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
// Snapshot for existing metadata consumers; execution always rediscovers the admitted source tree.
export const testEntries = Object.freeze(discoverEntries());
export function selectionRequirements(files, root = defaultRoot) {
  const byFile = new Map(discoverEntries(root).map(entry => [entry.file, entry]));
  return requirementsFor(files, byFile);
}
function requirementsFor(files, byFile) {
  return union(files.flatMap(file => {
    const entry = byFile.get(file);
    if (!entry) throw new Error('Unknown selected test: ' + file);
    return entry.requirements;
  }));
}
export function validateCatalogue(root) { discoverEntries(root); return true; }
function featureFiles(entries, features, baseline) {
  if (!Array.isArray(features) || features.some(name => !featureNames.includes(name))) throw new Error('Unknown feature group');
  return entries.filter(entry => (baseline && (entry.product || entry.suites.includes('smoke'))) || entry.features?.some(name => features.includes(name)));
}
export function featurePlan(features, { root = defaultRoot, baseline = true, platform = process.platform } = {}) {
  const entries = discoverEntries(root), byFile = new Map(entries.map(entry => [entry.file, entry]));
  const excluded = [];
  const selected = featureFiles(entries, features, baseline).filter(entry => {
    if (entry.layer === 'script' || entry.category === 'native-build') return false;
    if (entry.platforms && !entry.platforms.includes(platform)) {
      excluded.push({ file: entry.file, reason: 'platform', supported: entry.platforms }); return false;
    }
    return true;
  });
  const files = union(selected.map(entry => entry.file));
  return { features: union(features), node: files.filter(file => byFile.get(file).layer === 'node'), cli: files.filter(file => byFile.get(file).layer === 'cli'), requirements: requirementsFor(files, byFile), excluded };
}
export function resolveSelection(root, { suite = 'unit', groups, files, layer, platform = process.platform, shard, pattern, skip } = {}) {
  const entries = discoverEntries(root), byFile = new Map(entries.map(entry => [entry.file, entry]));
  const fixedSuites = ['check', 'rust', 'rust-check', 'rust-allocator', 'consumer', 'published-consumer'];
  const suites = new Set(['unit', 'product', 'compatibility', 'cli', 'cli-compatibility', 'groups', 'harness', 'native', 'native-release', 'daemon-regression', 'terminal', 'syntax-terminal', 'smoke', 'rust-harness', ...fixedSuites]);
  if (!suites.has(suite)) throw new Error('Unknown test suite: ' + suite);
  if (layer !== undefined && !['node', 'cli'].includes(layer)) throw new Error('Unknown test layer');
  if (suite === 'cli-compatibility' && [files, groups, layer, pattern, skip, shard].some(value => value !== undefined)) throw new Error('Physical compatibility requires its fixed complete selection without filters or shards');
  if (groups !== undefined && files !== undefined) throw new Error('Use groups or files, not both');
  if (fixedSuites.includes(suite) && [groups, files, layer].some(value => value !== undefined)) throw new Error('This suite has a fixed entry, not a file/group selection');
  let partition = null;
  if (shard !== undefined) {
    if (suite !== 'cli' || [groups, files, layer, pattern, skip].some(value => value !== undefined)) throw new Error('Sharding requires the complete CLI suite without files, groups, layer, pattern or skip');
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
    if (!match || !Number.isSafeInteger(+match[1]) || !Number.isSafeInteger(+match[2]) || +match[1] > +match[2]) throw new Error('Invalid shard: expected INDEX/TOTAL within range');
    partition = { index: +match[1], total: +match[2] };
  }
  let selected;
  if (files !== undefined) {
    selected = files.split(',').map(file => {
      if (!file || file.includes('\\') || file.split('/').some(part => part === '.' || part === '..' || !part)) throw new Error('Unknown selected test: ' + file);
      if (byFile.has(file)) return file;
      if (file.includes('/')) throw new Error('Unknown selected test: ' + file);
      const matches = entries.filter(entry => basename(entry.file) === file);
      if (matches.length !== 1) throw new Error((matches.length ? 'Ambiguous' : 'Unknown') + ' selected test: ' + file);
      return matches[0].file;
    });
    if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected test');
  } else if (groups !== undefined) selected = featureFiles(entries, groups.split(','), false).filter(entry => entry.layer !== 'script' && entry.category !== 'native-build').map(entry => entry.file);
  else if (suite === 'product') selected = entries.filter(entry => entry.product).map(entry => entry.file);
  else if (suite === 'unit') selected = entries.filter(entry => entry.layer === 'node' && !entry.delivery && entry.category !== 'native-build').map(entry => entry.file);
  else if (suite === 'compatibility') selected = entries.filter(entry => ['product', 'integration'].includes(entry.category) || entry.category === 'harness' && entry.file.split('/').includes('packaging')).map(entry => entry.file);
  else if (suite === 'daemon-regression') selected = entries.filter(entry => entry.category === 'integration' && entry.file.split('/')[1] === 'native' || entry.category === 'harness' && entry.file.split('/').includes('packaging')).map(entry => entry.file);
  else if (suite === 'cli-compatibility') selected = entries.filter(entry => entry.layer === 'cli' && (entry.file.startsWith('cli/editor/') || entry.file.startsWith('cli/lifecycle/smoke/'))).map(entry => entry.file);
  else if (suite === 'cli') selected = entries.filter(entry => entry.layer === 'cli').map(entry => entry.file);
  else if (['check', 'rust', 'rust-check', 'rust-allocator'].includes(suite)) selected = [];
  else if (suite === 'harness') selected = entries.filter(entry => entry.category === 'harness').map(entry => entry.file);
  else if (suite === 'groups') throw new Error('groups suite requires explicit groups or files');
  else selected = entries.filter(entry => entry.suites.includes(suite)).map(entry => entry.file);
  const excluded = [];
  selected = union(selected).filter(file => {
    const entry = byFile.get(file);
    if (layer && entry.layer !== layer) return false;
    if (entry.platforms && !entry.platforms.includes(platform)) {
      if (files !== undefined) throw new Error('Selected test is outside its declared platform scope: ' + file);
      excluded.push({ file, reason: 'platform', supported: entry.platforms }); return false;
    }
    return true;
  });
  if (!selected.length && !['check', 'rust', 'rust-check', 'rust-allocator'].includes(suite)) throw new Error('Empty test selection');
  if (selected.some(file => byFile.get(file).layer === 'script') && (selected.length !== 1 || !['consumer', 'published-consumer'].includes(suite))) throw new Error('Consumer scripts require their explicit authorized suite');
  const completeSelection = suite === 'cli-compatibility'
    ? entries.filter(entry => entry.layer === 'cli' && (!entry.platforms || entry.platforms.includes(platform))).map(entry => entry.file)
    : [...selected];
  if (partition) {
    selected = selected.filter((_, index) => index % partition.total === partition.index - 1);
    if (!selected.length) throw new Error('Empty CLI shard');
  }
  const stageRequirements = ['rust', 'rust-check', 'rust-allocator'].includes(suite) ? ['rust'] : [];
  return { files: selected, requirements: union([...requirementsFor(selected, byFile), ...stageRequirements]), layers: union(selected.map(file => byFile.get(file).layer)), excluded,
    ...(suite === 'cli-compatibility' ? { coverage: 'compatibility', completeSelection } : {}),
    ...(partition ? { completeSelection, shard: partition } : {}) };
}
export function selectSuite(inputs, suite) { return resolveSelection(inputs.pi.root, { suite }).files; }
