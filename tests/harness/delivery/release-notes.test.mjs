import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publishGitHubRelease as publishProductRelease } from '../../../scripts/release/github-release.mjs';
import { releaseNotes } from '../../../scripts/release/changelog.mjs';
import { checkChangelogs, releasedEntry } from '../../../scripts/release/release-notes.mjs';

const run = promisify(execFile);
import { publishGitHubRelease } from '../../../scripts/release/native-ci.mjs';

const repository = 'chpock/pi-tidy-ui', commit = 'b'.repeat(40);
const nativeNotes = '## [0.3.0] - 2026-11-03\n\n### Breaking changes\n\n- Use protocol v4.\n';

async function nativeFixture(t) {
  const root = await mkdtemp(join(process.env.TIDY_TEST_ROOT, 'changelog-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'admitted');
  await mkdir(directory);
  await mkdir(join(root, 'docs/occipital'), { recursive: true });
  await writeFile(join(root, 'docs/occipital/CHANGELOG.md'), '# Occipital changelog\n\n## [Unreleased]\n\n' + nativeNotes);
  for (const name of ['native-release.json', 'NOTICE', 'LICENSE', 'SHA256SUMS']) await writeFile(join(directory, name), 'Admitted fixture bytes\n');
  const tag = 'occipital-v0.3.0';
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/' + tag,
    GITHUB_REPOSITORY: repository, GITHUB_SHA: commit, GH_TOKEN: 'fixture-token' };
  return { root, directory, tag, env, repository, commit };
}

test('native GitHub publication uses exactly its authored version notes, not generic asset text', async t => {
  const f = await nativeFixture(t), mutations = [];
  const execute = async (command, args) => {
    if (command === 'git') return { stdout: commit + '\n' };
    assert.equal(command, 'gh');
    if (args[0] === 'api') throw Object.assign(new Error('Fixture absence'), { stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{}' });
    mutations.push(args);
    return { stdout: '' };
  };
  const result = await publishGitHubRelease({ ...f, execute });
  assert.equal(result.status, 'published');
  const create = mutations.find(args => args[0] === 'release' && args[1] === 'create');
  assert.ok(create);
  const inline = create.indexOf('--notes'), file = create.indexOf('--notes-file');
  const actual = file >= 0 ? await readFile(create[file + 1], 'utf8') : create[inline + 1];
  assert.equal(actual, nativeNotes);
  assert.deepEqual(mutations.map(args => args[1]), ['create', 'edit']);
});

test('native publication refuses a missing version entry before remote release lookup', async t => {
  const f = await nativeFixture(t);
  await writeFile(join(f.root, 'docs/occipital/CHANGELOG.md'), '# Occipital changelog\n\n## [Unreleased]\n\n- Not released.\n');
  let lookups = 0;
  await assert.rejects(publishGitHubRelease({ ...f, execute: async (command) => {
    if (command === 'git') return { stdout: commit + '\n' };
    lookups++;
    throw new Error('A remote lookup must not precede local changelog admission');
  } }), /changelog|version|entry|Unreleased/i);
  assert.equal(lookups, 0);
});


async function extensionFixture(t, version = '0.4.0') {
  const { directory, ...f } = await nativeFixture(t);
  const history = `# pi-tidy-ui\n\n## [Unreleased]\n\n## [${version}] - 2026-11-03\n\n- Extension-only change.\n`;
  await writeFile(join(f.root, 'CHANGELOG.md'), history);
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ version: '0.0.0', files: ['CHANGELOG.md'], pi: { changelogPath: '' } }));
  const git = args => run('git', args, { cwd: f.root, timeout: 10000 });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['add', '.']); await git(['commit', '-qm', 'test: inert changelog publication']);
  await git(['tag', 'occipital-v0.3.0']); await git(['tag', 'pi-tidy-ui-v' + version]);
  const actual = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  return { ...f, tag: 'pi-tidy-ui-v' + version, commit: actual,
    env: { ...f.env, GITHUB_REF: 'refs/tags/pi-tidy-ui-v' + version, GITHUB_SHA: actual },
    notes: releaseNotes(history, version, '0.3.0') };
}

for (const version of ['0.4.0', '0.4.0-rc.1']) test(`extension ${version} GitHub notes use the selected native dependency without replacing the Latest badge`, async t => {
  const f = await extensionFixture(t, version), calls = [];
  const execute = async (command, args, options) => {
    if (command === 'git') return run(command, args, options);
    if (args[0] === 'api') return { stdout: 'HTTP/2.0 404 Not Found\n\n{}' };
    calls.push(args); return { stdout: '' };
  };
  assert.deepEqual(await publishProductRelease({ ...f, execute }), { status: 'published', assets: 0 });
  const [create, edit] = calls;
  assert.deepEqual(create.slice(0, 4), ['release', 'create', f.tag, '--repo']);
  assert.equal(create[create.indexOf('--notes') + 1], f.notes);
  assert.ok(create.includes('--latest=false'));
  assert.equal(create.includes('--prerelease'), version.includes('-'));
  assert.deepEqual(edit, ['release', 'edit', f.tag, '--repo', repository, '--draft=false', '--latest=false']);
});

test('existing extension releases are verified without mutation and changed notes, assets or lookup failures stop', async t => {
  const f = await extensionFixture(t), base = { tag_name: f.tag, name: 'pi-tidy-ui 0.4.0', body: f.notes,
    draft: false, prerelease: false, assets: [] };
  for (const patch of [{}, { body: f.notes.replaceAll('\n', '\r\n') }, { body: 'Changed notes' }, { body: f.notes.replace(/\n$/, '  \n') }, { draft: true },
    { prerelease: true }, { name: 'Other release' }, { assets: [{ name: 'unexpected.tgz', id: 1, size: 1 }] }, { lookupError: true }]) {
    let mutations = 0;
    const execute = async (command, args, options) => {
      if (command === 'git') return run(command, args, options);
      if (args[0] === 'api') {
        if (patch.lookupError) throw new Error('Fixture lookup failure');
        return { stdout: 'HTTP/2.0 200 OK\n\n' + JSON.stringify({ ...base, ...patch }) };
      }
      mutations++; throw new Error('Existing publication must never be changed');
    };
    if (!Object.keys(patch).length || patch.body === f.notes.replaceAll('\n', '\r\n')) {
      assert.deepEqual(await publishProductRelease({ ...f, execute }), { status: 'already-published', assets: 0 });
    } else await assert.rejects(publishProductRelease({ ...f, execute }));
    assert.equal(mutations, 0);
  }
});

test('both histories and development tracking metadata are checked, but a release requires only its own empty pending section', async t => {
  const f = await extensionFixture(t), ref = 'refs/tags/pi-tidy-ui-v0.4.0';
  await writeFile(join(f.root, 'docs/occipital/CHANGELOG.md'), '# Native\n\n## [Unreleased]\n\n- Independent pending native work.\n');
  assert.deepEqual(await checkChangelogs(f.root, ref), { products: ['pi-tidy-ui', 'occipital'], release: 'pi-tidy-ui' });
  await assert.rejects(checkChangelogs(f.root, 'refs/tags/occipital-v0.3.0'), /Unreleased/);
  await assert.rejects(checkChangelogs(f.root, 'pi-tidy-ui-v0.4.0'), /full CI ref/);
  for (const manifest of [null,
    { version: '0.0.0', files: 'CHANGELOG.md', pi: { changelogPath: '' } },
    { version: '0.0.0', files: ['CHANGELOG.md'], pi: { changelogPath: './CHANGELOG.md' } }]) {
    await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(checkChangelogs(f.root), /Development/);
  }
});

test('release entry admission rejects pending, absent and empty released content without consuming Unreleased', () => {
  assert.throws(() => releasedEntry('## [Unreleased]\n\n- Pending.\n\n## [0.4.0] - 2026-11-03\n\n- Released.\n', '0.4.0'), /Unreleased/);
  assert.throws(() => releasedEntry('## [Unreleased]\n\n## [0.4.0] - 2026-11-03\n', '0.4.0'), /Empty/);
  assert.throws(() => releasedEntry('## [Unreleased]\n', '0.4.0'), /entry/);
});
