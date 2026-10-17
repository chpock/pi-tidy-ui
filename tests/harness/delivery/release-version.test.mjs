import "../../fixtures/test-guard.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as versions from "../../../scripts/release/version.mjs";

async function history(t) {
  const root = await mkdtemp(join(tmpdir(), 'occipital-tag-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  } }).trim();
  git('init', '--quiet');
  const commit = async text => {
    await writeFile(join(root, 'input'), text);
    git('add', 'input'); git('commit', '--quiet', '-m', text);
    return git('rev-parse', 'HEAD');
  };
  return { root, git, commit };
}

test('CI daemon version follows nearest ancestor, not largest version, later tag or unrelated branch', async t => {
  assert.equal(typeof versions.nearestDaemonTag, 'function');
  const h = await history(t);
  await h.commit('first'); h.git('tag', 'occipital-v9.0.0');
  await h.commit('second'); h.git('tag', 'occipital-v0.1.4');
  const extension = await h.commit('extension'); h.git('tag', 'pi-tidy-ui-v0.2.0');
  await h.commit('later'); h.git('tag', 'occipital-v0.1.5');
  assert.deepEqual(await versions.nearestDaemonTag(h.root, extension), { tag: 'occipital-v0.1.4', version: '0.1.4' });
  assert.deepEqual(await versions.nearestDaemonTag(h.root), { tag: 'occipital-v0.1.5', version: '0.1.5' });
  h.git('checkout', '--quiet', '--detach', extension);
  await h.commit('unrelated'); h.git('tag', 'occipital-v99.0.0');
  assert.deepEqual(await versions.nearestDaemonTag(h.root, extension), { tag: 'occipital-v0.1.4', version: '0.1.4' });
});

test('CI resolves daemon and extension versions independently; daemon release uses its own tag', async t => {
  assert.equal(typeof versions.resolveCI, 'function');
  const h = await history(t);
  await h.commit('native'); h.git('tag', 'occipital-v0.1.4');
  for (const ref of ['refs/heads/main', 'refs/pull/7/merge']) {
    const result = await versions.resolveCI(h.root, ref);
    assert.equal(result.product, undefined); assert.equal(result.version, '0.0.0');
    assert.equal(result.daemonVersion, '0.1.4'); assert.equal(result.daemonTag, 'occipital-v0.1.4');
  }
  const extension = await versions.resolveCI(h.root, 'refs/tags/pi-tidy-ui-v0.2.0');
  assert.equal(extension.version, '0.2.0'); assert.equal(extension.daemonVersion, '0.1.4');
  const native = await versions.resolveCI(h.root, 'refs/tags/occipital-v0.1.5');
  assert.equal(native.daemonVersion, '0.1.5'); assert.equal(native.daemonTag, 'occipital-v0.1.5');
});

test('no native ancestor, invalid nearest tag and shallow history fail rather than inventing a version', async t => {
  assert.equal(typeof versions.nearestDaemonTag, 'function');
  const h = await history(t);
  await h.commit('untagged');
  await assert.rejects(versions.nearestDaemonTag(h.root));
  h.git('tag', 'occipital-v0.1.4');
  await h.commit('malformed'); h.git('tag', 'occipital-v1.2');
  await assert.rejects(versions.nearestDaemonTag(h.root), /SemVer/i);
  h.git('tag', '--delete', 'occipital-v1.2');
  await writeFile(join(h.root, '.git/shallow'), h.git('rev-parse', 'HEAD') + '\n');
  await assert.rejects(versions.nearestDaemonTag(h.root), /shallow|complete history/i);
});

test('explicit CI daemon stamp changes only its package/lock version and rejects invalid or mismatched input atomically', async t => {
  assert.equal(typeof versions.stampDaemonVersion, 'function');
  const h = await history(t);
  await mkdir(join(h.root, 'crates/occipital'), { recursive: true });
  const cargo = join(h.root, 'crates/occipital/Cargo.toml'), lock = join(h.root, 'Cargo.lock');
  await writeFile(cargo, '[package]\nname = "occipital"\nversion = "0.0.0"\n');
  await writeFile(lock, '[[package]]\nname = "occipital"\nversion = "0.0.0"\n\n[[package]]\nname = "dependency"\nversion = "0.0.0"\n');
  await writeFile(join(h.root, 'package.json'), '{"version":"0.0.0"}');
  await versions.stampDaemonVersion(h.root, '0.1.4');
  assert.match(await readFile(cargo, 'utf8'), /version = "0.1.4"/);
  assert.match(await readFile(lock, 'utf8'), /name = "dependency"\nversion = "0.0.0"/);
  assert.equal(await readFile(join(h.root, 'package.json'), 'utf8'), '{"version":"0.0.0"}');
  const before = await readFile(cargo);
  await assert.rejects(versions.stampDaemonVersion(h.root, '1.2'));
  await writeFile(lock, '[[package]]\nname = "occipital"\nversion = "9.0.0"\n');
  await assert.rejects(versions.stampDaemonVersion(h.root, '0.1.5'), /do not match/);
  assert.deepEqual(await readFile(cargo), before);
});

test('CI fetches tag history, pins Rust from one file and consumes the resolved native version everywhere', async () => {
  const root = new URL("../../../", import.meta.url);
  const ci = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
  const native = await readFile(new URL('.github/workflows/occipital.yml', root), 'utf8');
  const toolchain = await readFile(new URL('rust-toolchain.toml', root), 'utf8');
  assert.match(toolchain, /channel = "1\.99\.0"/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(native, /dtolnay\/rust-toolchain@master/);
  assert.doesNotMatch(native, /rust-toolchain@stable/);
  assert.match(native, /toolchain: \$\{\{ steps\.toolchain\.outputs\.version \}\}/);
  assert.match(native, /stampDaemonVersion\(process\.env\.NATIVE_SOURCE, process\.env\.DAEMON_VERSION\)/);
  assert.doesNotMatch(native, /version\.mjs --daemon-version/);
  assert.doesNotMatch(ci, /occipital-v0\.0\.0-linux-x64-gnu/);
  const checks = await readFile(new URL('.github/workflows/ci-checks.yml', root), 'utf8');
  assert.match(checks, /name: occipital-v\$\{\{ inputs\.daemon-version \}\}-linux-x64-gnu/);
  assert.match(checks, /--native-artifact "\$GITHUB_WORKSPACE\/\.test-artifacts\/ci-native"/);
  assert.match(ci, /clean-native-build:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(ci, /clean-build: \$\{\{ inputs\.clean-native-build \|\| false \}\}/);
  const cache=native.split(/^      - /m).find(step=>/^uses: actions\/cache@v\d+(?:\.\d+){0,2}\n/.test(step)&&/^        id: native-cache$/m.test(step));
  assert.ok(cache);assert.match(cache,/^        if: \$\{\{ !inputs\.clean-build \}\}$/m);
  assert.match(native, /\$\{\{ env\.CARGO_HOME \}\}\/registry/);
  assert.match(native, /\$\{\{ env\.CARGO_HOME \}\}\/git/);
  assert.doesNotMatch(native, /\$\{\{ runner\.temp \}\}\/occipital-cargo/);
});
