import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
export const bytes = Buffer.from('tiny non-executable delivery fixture');
export const release = Object.freeze({ version: '0.1.0-fixture', target: 'linux-x64-gnu', sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://fixture.invalid/exact', maxBytes: 1024 });
export async function setup(t: any) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'occipital-factories-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const calls: Parameters<typeof childProcess.spawn>[] = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { calls.push(args); return spawn(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { cacheDir, spawns: () => calls.length, calls };
}
