import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readInputs, childEnv } from '../../../scripts/test/context.mjs';
import { getInstalledIntegrationProfile } from '../../fixtures/integration-profile.mjs';

const inputs = readInputs();
const audited = JSON.parse(readFileSync(new URL('../../fixtures/integration-profile/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../../fixtures/integration-profile/package-lock.json', import.meta.url), 'utf8'));
const builder = new URL('../../fixtures/integration-profile.mjs', import.meta.url).href;
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


test('integration profile requires all real prepared packages and retains safe exclusions', t => {
  const root = sandbox(t);
  const profile = getInstalledIntegrationProfile(options(root));
  assert.deepEqual(profile.inventory.map(({ name, version }) => [name, version]), Object.entries(audited.dependencies));
  assert.deepEqual(profile.packages.map(({ source }) => source),
    Object.keys(audited.dependencies).map(name => join(inputs.integration.root, 'node_modules', name)));
  assert.deepEqual(profile.exclusions.map(({ name }) => name), ['@cortexkit/aft-pi', '@pedro_klein/pi-caffeinate']);
  assert.ok(profile.exclusions.every(({ reason }) => reason.length > 0));
  assert.equal(profile.env.PATH, undefined, 'PATH belongs to the common declared-tool environment');
  assert.equal(profile.env.PI_TASKS, 'off', 'local task storage stays in memory');
  assert.ok(profile.configFiles.every(({ path }) => path.startsWith(root + '/')));
});

test('integration profile ignores ambient installed inventory and settings', t => {
  const root = sandbox(t), poison = join(root, 'ambient-agent');
  mkdirSync(poison);
  writeFileSync(join(poison, 'settings.json'), 'not valid settings JSON');
  const result = runBuilder(root, inputs.integration, { TIDY_UI_SOURCE_AGENT_DIR: poison, HOME: poison, PATH: join(root, 'empty-bin') });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).inventory.map(({ name, version }) => [name, version]), Object.entries(audited.dependencies));
  assert.equal(readFileSync(join(poison, 'settings.json'), 'utf8'), 'not valid settings JSON');
});
