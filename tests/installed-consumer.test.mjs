import './fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { childEnv, readInputs } from '../scripts/test/context.mjs';

const run = promisify(execFile);

test('installed consumer rejects missing, unstamped and mismatched same-source inputs before npm/helper work', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'never-executed-native'), bytes = Buffer.from('input validation only');
  await writeFile(path, bytes);
  const source = { ...prepared.source, commit: 'a'.repeat(40), nativeTree: 'b'.repeat(64) };
  const native = { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: '1.0.0',
    target: process.platform === 'linux' ? `linux-${process.arch}-gnu` : process.platform === 'darwin' ? `darwin-${process.arch}` : `windows-${process.arch}-msvc`,
    commit: source.commit, nativeTree: source.nativeTree };
  const base = { ...prepared, source, native, registry: { packages: [{ name: 'never-read-archive' }] } };
  const fixture = resolve(import.meta.dirname, 'fixtures/installed-occipital.mjs');
  for (const [patch, expected] of [[{ native: undefined }, /same-source native/], [{ registry: undefined }, /prepared registry archives/],
    [{ native: { ...native, version: '0.0.0' } }, /version-stamped same-source helper/],
    [{ native: { ...native, commit: 'c'.repeat(40) } }, /Native commit must match/],
    [{ native: { ...native, nativeTree: 'd'.repeat(64) } }, /Native tree must match/],
    [{ native: { ...native, sha256: '0'.repeat(64) } }, /AssertionError/]]) {
    const inputsPath = join(root, 'inputs.json'); await writeFile(inputsPath, JSON.stringify({ ...base, ...patch }));
    await assert.rejects(run(prepared.node.path, [fixture], { env: childEnv(root, { TIDY_TEST_INPUTS: inputsPath }, prepared), timeout: 10000 }), error => {
      assert.match(error.stderr, expected);
      assert.equal(error.stdout, '');
      return true;
    });
    assert.deepEqual(await readFile(path), bytes);
  }
});


test('published consumer rejects ordinary/native refs before any public lookup', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-published-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = pathToFileURL(resolve(import.meta.dirname, 'fixtures/published-occipital.mjs')).href;
  for (const ref of [undefined, 'refs/tags/occipital-v0.1.5']) {
    const code = `let fetches=0;globalThis.fetch=()=>{fetches++;throw Error('network must not run')};
      const error=await import(${JSON.stringify(fixture)}).then(()=>undefined,error=>error);
      console.log(JSON.stringify({message:error?.message,fetches}));`;
    const result = await run(prepared.node.path, ['--input-type=module', '-e', code], {
      env: childEnv(root, { TIDY_TEST_RELEASE_REF: ref }, prepared), timeout: 10000 });
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.fetches, 0);
    assert.match(packet.message, ref ? /restricted to pi-tidy-ui releases/ : /explicit pi-tidy-ui release authorization/);
  }
});


test('consumer test files require bootstrap even when an explicit descriptor is supplied', async t => {
  const prepared = readInputs(), root = await mkdtemp(join(tmpdir(), 'tidy-consumer-test-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['consumer-preparation', 'local-registry', 'installed-consumer']) {
    await assert.rejects(run(prepared.node.path, [join(import.meta.dirname, `${name}.test.mjs`)], {
      env: childEnv(root, { TIDY_TEST_CONTEXT_READY: undefined, TIDY_TEST_INPUTS: process.env.TIDY_TEST_INPUTS }, prepared), timeout: 10000,
    }), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      assert.match(error.stderr, /Tests require a fresh isolated process/); return true;
    });
  }
});
