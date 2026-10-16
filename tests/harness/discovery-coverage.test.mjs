import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { featurePlan, resolveSelection } from '../../scripts/test/catalog.mjs';
import { readInputs } from '../../scripts/test/context.mjs';

// These expectations preserve the baseline cadence; they do not select executable tests.
test('baseline Pi-sensitive packaging controls remain in unit and outside once-per-Node delivery', () => {
  const root = readInputs().pi.root;
  const unit = new Set(resolveSelection(root, { suite: 'unit' }).files);
  const release = new Set(resolveSelection(root, { suite: 'native-release' }).files);
  const deliveryFeature = new Set(featurePlan(['delivery'], { root, baseline: false }).node);
  for (const basename of ['consumer-preparation.test.mjs', 'installed-consumer.test.mjs', 'local-registry.test.mjs', 'npm-preparation.test.ts']) {
    const [file] = resolveSelection(root, { files: basename }).files;
    assert.ok(unit.has(file), basename + ' must execute for every ordinary Node/Pi profile');
    assert.ok(!release.has(file), basename + ' must not move to the minimum-Pi-only delivery lane');
    assert.ok(deliveryFeature.has(file), basename + ' retains its local delivery feature');
  }
  const baselineRelease = ['native-release.test.mjs', 'release-ci.test.mjs', 'release-version.test.mjs', 'npm-release.test.mjs', 'extension-release.test.mjs', 'makefile.test.ts', 'native-preparation.test.mjs', 'consumer-diagnostics.test.mjs'];
  const selectedBaselineRelease = baselineRelease.flatMap(basename => resolveSelection(root, { files: basename }).files);
  assert.equal(selectedBaselineRelease.length, 8);
  for (const file of selectedBaselineRelease) {
    assert.ok(release.has(file), file + ' retains its separate baseline delivery cadence');
    assert.ok(!unit.has(file), file + ' must not duplicate its separate delivery execution');
  }
});

test('new packaging files automatically join unit and the delivery feature without joining native-release', t => {
  const root = mkdtempSync(join(tmpdir(), 'packaging-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = file => { const path = join(root, 'tests', file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); };
  add('harness/packaging/new.test.mjs'); add('harness/delivery/inert.test.mjs'); add('harness/delivery/preparation.test.mjs');
  assert.deepEqual(resolveSelection(root, { suite: 'unit' }).files, ['harness/packaging/new.test.mjs']);
  assert.deepEqual(resolveSelection(root, { suite: 'native-release' }).files, ['harness/delivery/inert.test.mjs', 'harness/delivery/preparation.test.mjs']);
  assert.deepEqual(featurePlan(['delivery'], { root, baseline: false }).node, ['harness/delivery/inert.test.mjs', 'harness/delivery/preparation.test.mjs', 'harness/packaging/new.test.mjs']);
  add('harness/packaging/newer.test.ts');
  assert.ok(resolveSelection(root, { suite: 'unit' }).files.includes('harness/packaging/newer.test.ts'));
  assert.ok(featurePlan(['delivery'], { root, baseline: false }).node.includes('harness/packaging/newer.test.ts'));
  assert.ok(!resolveSelection(root, { suite: 'native-release' }).files.includes('harness/packaging/newer.test.ts'));
});
