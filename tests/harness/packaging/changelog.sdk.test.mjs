import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { parseChangelog as parsePiChangelog, getNewEntries } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/changelog.js';
import { stageExtensionPackage } from '../../../scripts/release/extension-release.mjs';
import { extensionChangelog } from '../../../scripts/release/changelog.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const history = '# Changes\n\n## [Unreleased]\n\n' +
  '## [0.2.0] - 2026-11-03\n\n### Added\n\n- NEW_RELEASE_TAIL.\n\n' +
  '## [0.2.0-rc.1] - 2026-11-02\n\n- PRERELEASE_ONLY.\n\n' +
  '## [0.1.1] - 2026-10-26\n\n- OLD_STABLE.\n';

test('actual Pi package discovery and changelog reader consume the staged stable history and disabled modes', async t => {
  const root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'package-changelog-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'src/occipital'), { recursive: true });
  const manifest = { name: 'pi-tidy-ui', version: '0.0.0', type: 'module', files: ['src', 'CHANGELOG.md'],
    pi: { extensions: ['./src/fixture.ts'], changelogPath: '' } };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'CHANGELOG.md'), history);
  await writeFile(join(source, 'src/fixture.ts'), 'export default function () {}\n');
  await writeFile(join(source, 'src/occipital/release.ts'), await readFile(join(repo, 'src/occipital/release.ts')));
  const release = JSON.parse(await readFile(join(repo, 'tests/fixtures/occipital-release-0.1.4.json'), 'utf8'));
  for (const mode of ['stable', 'prerelease', 'development']) {
    const version = mode === 'prerelease' ? '0.2.0-rc.1' : '0.2.0', packageRoot = join(root, mode);
    const changelog = mode === 'development' ? undefined : extensionChangelog(history, version, release.version);
    await stageExtensionPackage({ root: source, output: packageRoot, version, release, changelog });
    const cwd = join(root, mode + '-cwd'), agentDir = join(root, mode + '-agent');
    await mkdir(cwd); await mkdir(agentDir);
    const settings = SettingsManager.create(cwd, agentDir);
    settings.setPackages([packageRoot]);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
    const extensions = loaded.extensions.filter(extension => extension.path === join(packageRoot, 'src/fixture.ts'));
    assert.equal(extensions.length, 1, 'the real package loader must discover its declared extension');
    if (typeof settings.getExtensionChangelogVersion === 'function') {
      assert.equal(extensions[0].sourceInfo.origin, 'package');
      assert.equal(extensions[0].sourceInfo.changelogPath, mode === 'stable' ? join(packageRoot, 'CHANGELOG.md') : undefined);
    }
    const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(installed.pi.changelogPath, mode === 'stable' ? './CHANGELOG.md' : '');
    if (mode === 'stable') {
      const entries = parsePiChangelog(join(packageRoot, 'CHANGELOG.md'));
      assert.deepEqual(entries.map(entry => `${entry.major}.${entry.minor}.${entry.patch}`), ['0.2.0', '0.1.1']);
      const updates = getNewEntries(entries, '0.1.1');
      assert.equal(updates.length, 1);
      assert.ok(updates[0].content.includes('NEW_RELEASE_TAIL'));
      assert.ok(updates[0].content.includes('Occipital [0.1.4]'));
      assert.ok(!updates[0].content.includes('PRERELEASE_ONLY'));
      assert.equal(getNewEntries(entries, '0.2.0').length, 0);
    }
  }
});
