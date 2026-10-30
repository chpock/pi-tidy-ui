import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { childEnv, readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { acquireNative } from '../../../src/occipital/native.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { decodeSemanticDescription, decodeSemanticSourceReply, SEMANTIC_PROTOCOL_VERSION as VERSION } from '../../../src/occipital/semantic-protocol.ts';

test('actual running helper survives obsolete-download pruning and warm cleanup retries after exit', async t => {
  const native = validateNative(readInputs()), bytes = await readFile(native.path);
  const root = await mkdtemp(join(tmpdir(), 'occipital-retention-')), cacheDir = join(root, 'downloads');
  let transport: StdioTransport | undefined, downloads = 0;
  t.after(async () => { await transport?.close(); await rm(root, { recursive: true, force: true }); });
  const release = { version: '0.0.1-retention', target: native.target, sha256: native.sha256,
    maxBytes: native.bytes, url: 'https://fixture.invalid/occipital-retention' };
  const fetcher = async () => { downloads++; return new Response(bytes); };
  const old = await acquireNative({ cacheDir, release, fetcher });
  transport = new StdioTransport({ command: old.path, args: ['--stdio'],
    env: childEnv(root), cwd: root, requestDeadlineMs: 10_000, terminateGraceMs: 100 });
  const raw = await transport.request({ v: VERSION, op: 'describe', ticket: 'before-prune' });
  const descriptor = decodeSemanticDescription(raw, 'before-prune');
  const options = { cacheDir, release: { ...release, version: '0.0.2-retention' }, fetcher };
  const current = await acquireNative(options);
  let oldNameExists = true;
  try { await stat(old.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    oldNameExists = false;
  }
  if (process.platform !== 'win32') assert.equal(oldNameExists, false);
  const text = 'echo "still running"\n';
  const reply = await transport.request({ v: VERSION, op: 'highlight', ticket: 'after-prune', instance: descriptor.instance,
    admission: 'bounded_queue', queue_wait_ms: 1000,
    sources: [{ key: 'after-prune', generation: 1, source_version: 1, hint: { language: 'bash' }, text }] });
  const parsed = decodeSemanticSourceReply(reply, 'after-prune', descriptor, [{ key: 'after-prune', generation: 1, source_version: 1,
    revision: 1, source_bytes: Buffer.byteLength(text), replace_from: 0, complete: true, replacementText: text }], 64 << 20).sources[0]!;
  assert.equal(parsed.source_bytes, Buffer.byteLength(text)); assert.equal(parsed.complete, true);
  assert.equal(parsed.counters.committed_line_calls, 1); assert.equal(transport.stats().spawnCount, 1);
  await transport.close();
  assert.equal(transport.stats().childState, 'exited');
  assert.equal((await acquireNative(options)).downloaded, false);
  assert.equal(downloads, 2);
  await assert.rejects(stat(dirname(dirname(old.path))), { code: 'ENOENT' });
  assert.deepEqual(await readFile(current.path), bytes);
  console.log(JSON.stringify({ retention: { downloads, warmDownloads: 0, oldNameExistsWhileRunning: oldNameExists,
    survivingSpawnCount: transport.stats().spawnCount, committedLineCallsAfterPrune: parsed.counters.committed_line_calls } }));
});
