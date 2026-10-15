import './fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionCandidates } from '../src/occipital/discovery.ts';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('explicit and nonempty environment endpoints are exclusive, including a bad explicit path', () => {
  const options = { env: { SUBC_CONNECTION_FILE: '/named', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/u' }, tempDir: '/tmp', uid: 42, platform: 'linux' as const };
  assert.deepEqual(connectionCandidates({ ...options, explicit: '/chosen' }), ['/chosen']);
  assert.deepEqual(connectionCandidates({ ...options, explicit: '' }), ['']);
  assert.deepEqual(connectionCandidates(options), ['/named']);
});
test('public Unix order is runtime, HOME local-share, real UID temp; blank environment is absent', () => {
  assert.deepEqual(connectionCandidates({ env: { SUBC_CONNECTION_FILE: '', HOME: '/home/u', XDG_RUNTIME_DIR: '/run/u' }, tempDir: '/tmp', uid: 42, platform: 'linux' }), [
    '/run/u/subc-connection.json', '/home/u/.local/share/cortexkit/run/subc-connection.json', '/tmp/subc-42.connection.json',
  ]);
  assert.deepEqual(connectionCandidates({ env: { HOME: '', XDG_RUNTIME_DIR: '' }, tempDir: '/tmp', uid: 0, platform: 'darwin' }), ['/tmp/subc-0.connection.json']);
});
test('candidate duplicates are removed without a global filesystem scan or fallback home guess', () => {
  assert.deepEqual(connectionCandidates({ env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/home/u/.local/share/cortexkit/run' }, tempDir: '/tmp', uid: 9, platform: 'linux' }), [
    '/home/u/.local/share/cortexkit/run/subc-connection.json', '/tmp/subc-9.connection.json',
  ]);
});
test('non-Unix temporary token follows public scalar-character sanitization and environment order', () => {
  assert.deepEqual(connectionCandidates({ env: { USER: 'A😀/中', USERNAME: 'ignored' }, tempDir: 'C:\\tmp', platform: 'win32' }), ['C:\\tmp\\subc-A___.connection.json']);
  assert.deepEqual(connectionCandidates({ env: { USER: '', USERNAME: 'u-1', HOME: 'ignored' }, tempDir: 'C:\\tmp', platform: 'win32' }).at(-1), 'C:\\tmp\\subc-u-1.connection.json');
  assert.deepEqual(connectionCandidates({ env: {}, tempDir: 'C:\\tmp', platform: 'win32' }), ['C:\\tmp\\subc-unknown.connection.json']);
});

test('default directory suffix preserves parent traversal through an actual symlink', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'occipital-discovery-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'user', 'state'), { recursive: true });
  await mkdir(join(root, 'user', 'run'));
  await mkdir(join(root, 'run'));
  await symlink(join(root, 'user', 'state'), join(root, 'alias'), 'dir');
  await writeFile(join(root, 'user', 'run', 'subc-connection.json'), 'intended');
  await writeFile(join(root, 'run', 'subc-connection.json'), 'wrong');
  const directory = `${root}/alias/../run`;
  const candidates = connectionCandidates({ env: { XDG_RUNTIME_DIR: directory, HOME: directory }, tempDir: directory, uid: 42, platform: 'linux' });
  // The OS resolves alias first, then '..'; lexical normalization changes the host.
  assert.equal(await readFile(candidates[0], 'utf8'), 'intended');
  assert.deepEqual(candidates, [`${directory}/subc-connection.json`, `${directory}/.local/share/cortexkit/run/subc-connection.json`, `${directory}/subc-42.connection.json`]);
});

test('directory suffix preserves Windows-shaped parents, trailing separators and relative drive prefix', () => {
  assert.deepEqual(connectionCandidates({ env: { USER: 'u', XDG_RUNTIME_DIR: 'C:\\alias\\..\\run\\', HOME: 'C:\\alias\\..\\home' }, tempDir: 'C:', platform: 'win32' }), [
    'C:\\alias\\..\\run\\subc-connection.json', 'C:\\alias\\..\\home\\.local\\share\\cortexkit\\run\\subc-connection.json', 'C:subc-u.connection.json',
  ]);
});
