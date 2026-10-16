import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { discoverEntries, featurePlan, resolveSelection } from '../../scripts/test/catalog.mjs';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';
import { execute } from '../../scripts/test/run.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (file, body = '') => {
    const path = join(root, 'tests', file);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body);
  };
  return { root, add };
}

test('new structural Node and CLI cases execute without registration and propagate failure', t => {
  const { root, add } = fixture(t), inputs = readInputs();
  const guard = pathToFileURL(join(inputs.pi.root, 'tests/fixtures/test-guard.mjs')).href;
  for (const [file, name] of [['product/bash/new.test.mjs', 'new-node'], ['cli/bash/new.cli.test.mjs', 'new-cli']]) {
    add(file, `import ${JSON.stringify(guard)}; import test from 'node:test'; test(${JSON.stringify(name)}, () => { throw new Error('AUTO_DISCOVERED_FAILURE'); });`);
    const selection = resolveSelection(root, { suite: file.startsWith('cli/') ? 'cli' : 'product' });
    assert.deepEqual(selection.files, [file]);
    const result = spawnSync(inputs.node.path, ['--import', pathToFileURL(join(inputs.pi.root, 'scripts/test/bootstrap.mjs')).href, '--expose-gc', '--test', '--test-reporter=tap', ...selection.files.map(name => join(root, 'tests', name))], {
      cwd: inputs.pi.root, env: childEnv(join(root, name), { TIDY_TEST_INPUTS: inputs.inputsPath, TIDY_TEST_CONTEXT_READY: '1' }, inputs), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp('not ok \\d+ - ' + name));
    assert.match(result.stdout, /AUTO_DISCOVERED_FAILURE/);
  }
});

test('directory roles exclude support and share factory contracts without a per-file registry', t => {
  const { root, add } = fixture(t);
  for (const file of ['product/bash/new.test.ts', 'product/native/syntax/factory.test.mjs', 'integration/native/helper.test.ts', 'integration/profile/profile.test.mjs', 'harness/check.test.mjs', 'harness/delivery/staging.test.mjs', 'harness/delivery/package.test.mjs', 'native-build/cargo.test.mjs', 'fixtures/not-executable.test.mjs', 'helpers/support.test.ts', 'support/unused.test.mjs', 'product/bash/fixtures/nested.test.ts']) add(file);
  const entries = discoverEntries(root);
  assert.equal(entries.some(entry => /support|unused|not-executable|nested/.test(entry.file)), false);
  assert.deepEqual(resolveSelection(root, { suite: 'product' }).files, ['product/bash/new.test.ts', 'product/native/syntax/factory.test.mjs']);
  assert.deepEqual(resolveSelection(root, { suite: 'native' }).requirements, ['native']);
  assert.deepEqual(resolveSelection(root, { suite: 'compatibility' }).files, ['integration/native/helper.test.ts', 'integration/profile/profile.test.mjs', 'product/bash/new.test.ts', 'product/native/syntax/factory.test.mjs']);
  assert.deepEqual(resolveSelection(root, { suite: 'native-release' }).files, ['harness/delivery/package.test.mjs', 'harness/delivery/staging.test.mjs']);
  assert.equal(resolveSelection(root, { suite: 'unit' }).files.some(file => /^(?:delivery|native-build)\/|^harness\/delivery\//.test(file)), false);
  add('product/bash/another.test.mjs');
  assert.ok(featurePlan(['bash'], { root, baseline: false }).node.includes('product/bash/another.test.mjs'));
});

test('local files accept relative paths and unique basenames but reject ambiguity duplicates and unknowns', t => {
  const { root, add } = fixture(t);
  add('product/bash/unique.test.ts'); add('product/bash/same.test.mjs'); add('harness/same.test.mjs');
  assert.deepEqual(resolveSelection(root, { files: 'unique.test.ts' }).files, ['product/bash/unique.test.ts']);
  assert.deepEqual(resolveSelection(root, { files: 'harness/same.test.mjs' }).files, ['harness/same.test.mjs']);
  for (const files of ['same.test.mjs', 'missing.test.ts', '../unique.test.ts', 'unique.test.ts,product/bash/unique.test.ts']) assert.throws(() => resolveSelection(root, { files }));
});

test('four CLI shards are deterministic exhaustive disjoint and automatically include additions', t => {
  const { root, add } = fixture(t);
  const files = ['cli/bash/a.test.mjs', 'cli/footer/b.test.ts', 'cli/native/syntax/c.test.mjs', 'cli/shared/d.test.ts', 'cli/profile/e.test.mjs', 'cli/editor/f.test.mjs'];
  files.toReversed().forEach(file => add(file));
  const partitions = () => [1, 2, 3, 4].map(index => resolveSelection(root, { suite: 'cli', shard: index + '/4' }));
  const assertPartitions = () => {
    const full = resolveSelection(root, { suite: 'cli' }).files, plans = partitions();
    assert.deepEqual(plans.flatMap(plan => plan.files).sort(), full);
    assert.equal(new Set(plans.flatMap(plan => plan.files)).size, full.length);
    plans.forEach((plan, index) => {
      assert.deepEqual(plan.files, full.filter((_, position) => position % 4 === index));
      assert.deepEqual(plan.completeSelection, full);
      assert.deepEqual(plan.shard, { index: index + 1, total: 4 });
    });
  };
  assertPartitions(); add('cli/bash/newly-added.test.mjs'); assertPartitions();
});

test('sharding refuses narrowed non-CLI invalid and empty selections', t => {
  const { root, add } = fixture(t); add('cli/bash/a.test.mjs'); add('product/bash/a.test.ts');
  for (const shard of ['', '0/4', '5/4', '1/0', '-1/4', '1.5/4', '1', '01/4', '2/4']) assert.throws(() => resolveSelection(root, { suite: 'cli', shard }));
  for (const options of [{ suite: 'unit' }, { suite: 'terminal' }, { files: 'a.test.mjs' }, { groups: 'bash' }, { layer: 'cli' }, { pattern: '' }, { skip: '' }]) assert.throws(() => resolveSelection(root, { suite: 'cli', ...options, shard: '1/1' }));
});

test('generic runner records the full CLI selection and assigned shard before required-input failure', async t => {
  const { root } = fixture(t), original = readInputs();
  const inputs = join(root, 'inputs.json'), output = join(root, 'report.json');
  writeFileSync(inputs, JSON.stringify({ ...original, native: undefined }));
  const shard = [1, 2, 3, 4].map(index => index + '/4').find(shard => resolveSelection(original.pi.root, { suite: 'cli', shard }).requirements.includes('native'));
  assert.ok(shard, 'complete CLI selection retains real native controls');
  const selection = resolveSelection(original.pi.root, { suite: 'cli', shard });
  await assert.rejects(execute({ inputs, suite: 'cli', shard, output }), /Missing required same-source Occipital build/);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.status, 'setup-failed');
  assert.deepEqual(report.completeSelection, selection.completeSelection);
  assert.deepEqual(report.selected, selection.files);
  assert.deepEqual(report.shard, { ...selection.shard, selected: selection.files });
  assert.equal(report.selection.shard, shard);
  assert.deepEqual(report.cases, []);
});

test('generic runner rejects native-build metadata selections before spawning a Pi child', async t => {
  const { root } = fixture(t), inputs = readInputs(), output = join(root, 'report.json');
  const files = resolveSelection(inputs.pi.root, { suite: 'rust-harness' }).files;
  assert.ok(files.length > 0);
  const spawn = childProcess.spawn; let spawned = 0;
  childProcess.spawn = () => { spawned++; throw new Error('Unexpected Pi child'); }; syncBuiltinESMExports();
  try {
    for (const options of [{ suite: 'rust-harness' }, { files: files[0] }]) {
      await assert.rejects(execute({ inputs: inputs.inputsPath, output, ...options }), /Native-build controls require scripts\/test\/native-harness\.mjs/);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(report.status, 'setup-failed'); assert.deepEqual(report.cases, []);
      assert.ok(report.selected.every(file => file.startsWith('native-build/')));
    }
    assert.equal(spawned, 0);
    assert.deepEqual(resolveSelection(inputs.pi.root, { files: 'footer.sdk.test.ts' }).requirements, []);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
});

test('tests outside structural categories fail instead of silently disappearing', t => {
  const { root, add } = fixture(t);
  add('unclassified/new.test.mjs');
  assert.throws(() => discoverEntries(root), /Unknown test category/);
});
