import '../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readInputs, childEnv } from '../../scripts/test/context.mjs';
import { getInstalledIntegrationProfile } from '../fixtures/integration-profile.mjs';

const inputs = readInputs();
const profileFixture = root => ({ root, manifest: fileURLToPath(new URL('../fixtures/integration-profile/package.json', import.meta.url)) });
const audited = JSON.parse(readFileSync(new URL('../fixtures/integration-profile/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../fixtures/integration-profile/package-lock.json', import.meta.url), 'utf8'));
const builder = new URL('../fixtures/integration-profile.mjs', import.meta.url).href;
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-profile-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function options(root) {
  return { homeDir: root, agentDir: join(root, 'agent'), workDir: join(root, 'work') };
}
function runBuilder(root, integration, extraEnv = {}) {
  const path = join(root, 'inputs.json');
  writeFileSync(path, JSON.stringify({ ...inputs, integration }));
  return spawnSync(inputs.node.path, ['--input-type=module', '-e',
    `import { getInstalledIntegrationProfile } from ${JSON.stringify(builder)};
     console.log(JSON.stringify(getInstalledIntegrationProfile(${JSON.stringify(options(join(root, 'consumer')))})));`],
  { cwd: inputs.pi.root, env: childEnv(root, { ...extraEnv, TIDY_TEST_INPUTS: path }), encoding: 'utf8', timeout: 15000 });
}

test('integration profile locks every safe audited package and transitive registry input', () => {
  assert.deepEqual(lock.packages[''].dependencies, audited.dependencies);
  assert.equal(Object.keys(audited.dependencies).length, 11, 'retain all eleven previously audited safe integrations');
  assert.equal(audited.dependencies['@tintinweb/pi-tasks'], '0.9.0', 'real local task coverage retains its audited version');
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.version, /^\d+\./, `exact resolved version for ${path}`);
    assert.match(entry.integrity, /^sha512-/, `locked registry integrity for ${path}`);
  }
});



test('integration profile missing input or package fails instead of dropping coverage', t => {
  const root = sandbox(t);
  const absent = runBuilder(root, undefined);
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /Required locked integration profile is missing/);
  const missing = runBuilder(root, profileFixture(join(root, 'missing-packages')));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Required integration package is missing/);
});

test('integration profile rejects changed manifests and package identities', t => {
  const root = sandbox(t), manifest = join(root, 'profile.json');
  writeFileSync(manifest, JSON.stringify({ ...audited, dependencies: { ...audited.dependencies, '@tintinweb/pi-tasks': '0.0.0' } }));
  const changed = runBuilder(root, { ...profileFixture(join(root, 'packages')), manifest });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /does not match the audited locked profile/);
  const prepared = join(root, 'wrong-package'), firstName = Object.keys(audited.dependencies)[0];
  const directory = join(prepared, 'node_modules', firstName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: firstName, version: '0.0.0' }));
  const mismatch = runBuilder(root, profileFixture(prepared));
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match audited identity/);
});
