import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyntaxOptions, nativePackageName, nativeTarget } from '../src/occipital/bootstrap.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { NATIVE_RELEASE, type NativeReleaseDeclaration } from '../src/occipital/release.ts';
import { StdioTransport } from '../src/occipital/stdio.ts';

const ctx = { cwd: '/project', sessionManager: { getSessionId: () => 'session' } } as ExtensionContext;

test('bootstrap maps only actual candidate ABI tuples, never musl to GNU', () => {
  assert.equal(nativeTarget('linux', 'x64', true), 'linux-x64-gnu');
  assert.equal(nativeTarget('linux', 'arm64', true), 'linux-arm64-gnu');
  assert.equal(nativeTarget('linux', 'x64', false), undefined);
  assert.equal(nativeTarget('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(nativeTarget('win32', 'x64', false), 'windows-x64-msvc');
  assert.equal(nativeTarget('linux', 'riscv64', true), undefined);
  assert.equal(nativePackageName('linux-x64-gnu'), '@kchpock/occipital-linux-x64-gnu');
});

test('bootstrap defaults to the verified independent Occipital release and aborted acquisition does no network work', async () => {
  const published = JSON.parse(await readFile(new URL('./fixtures/occipital-release-0.1.3.json', import.meta.url), 'utf8'));
  assert.deepEqual(NATIVE_RELEASE, published);
  const options = createSyntaxOptions(ctx);
  assert.equal(options.standaloneVersion, '0.1.3');
  const fetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async () => { downloads++; throw Error('An aborted acquisition must not download'); };
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(options.provider.acquireOwned(abort.signal), hostTarget ? /acquisition was cancelled/ : /platform\/ABI/);
    assert.equal(downloads, 0);
  } finally { globalThis.fetch = fetch; }
});

test('bootstrap constructs without source, preferences, SDK import or provider work', () => {
  let reads = 0;
  const options = createSyntaxOptions({ cwd: '/project', sessionManager: { getSessionId() { reads++; return 'session'; } } } as ExtensionContext);
  assert.equal(reads, 1);
  assert.equal(typeof options.provider.tryShared, 'function');
  assert.equal(typeof options.provider.acquireOwned, 'function');
});

const hostTarget = nativeTarget(process.platform, process.arch,
  process.platform === 'linux' && typeof (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime === 'string');

test('bootstrap exact installed metadata hands verified payload to owned factory; invalid metadata never starts it',
  { skip: !hostTarget || process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'occipital-bootstrap-'));
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const name = nativePackageName(hostTarget!), packageDirectory = join(root, 'node_modules', name);
    const metadata = join(packageDirectory, 'package.json'), executable = join(packageDirectory, 'occipital');
    const body = `#!${process.execPath}\nsetInterval(() => {}, 1000000);\n`;
    const version = '0.1.0', url = 'https://example.invalid/controlled-fixture';
    const release: NativeReleaseDeclaration = { version, artifacts: [{ target: hostTarget!, url,
      sha256: createHash('sha256').update(body).digest('hex'), maxBytes: Buffer.byteLength(body) }] };
    const oldAgent = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch;
    let created = false, downloads = 0;
    process.env.PI_CODING_AGENT_DIR = directory;
    globalThis.fetch = async input => { assert.equal(String(input), url); downloads++; throw new Error('No downloads in installed-payload fixture'); };
    try {
      await mkdir(dirname(packageDirectory), { recursive: true });
      await mkdir(packageDirectory); created = true; // Never overwrite an existing real payload.
      const valid = { name, version, exports: { './package.json': './package.json' } };
      await writeFile(metadata, JSON.stringify(valid)); await writeFile(executable, body); await chmod(executable, 0o755);
      const options = createSyntaxOptions({ ...ctx, cwd: directory } as ExtensionContext, release), transport = await options.provider.acquireOwned(new AbortController().signal);
      assert.ok(transport instanceof StdioTransport);
      const pid = transport.stats().pid;
      try { assert.equal(downloads, 0); assert.ok(typeof pid === 'number' && pid > 0); }
      finally { await transport.close(); }
      assert.throws(() => process.kill(pid as number, 0), { code: 'ESRCH' });
      for (const text of [JSON.stringify({ ...valid, name: '@kchpock/other' }), JSON.stringify({ ...valid, version: '0.0.0' }), '[]', '{']) {
        await writeFile(metadata, text);
        const before: number = downloads;
        await assert.rejects(async () => { const unexpected = await options.provider.acquireOwned(new AbortController().signal); await unexpected.close(); });
        assert.equal(downloads, before + 1, 'invalid metadata selects exact delivery instead of executing installed bytes');
      }
      await writeFile(metadata, JSON.stringify(valid) + ' '.repeat(64 * 1024)); // Valid oversized metadata, not a source.
      const before: number = downloads;
      await assert.rejects(async () => { const unexpected = await options.provider.acquireOwned(new AbortController().signal); await unexpected.close(); });
      assert.equal(downloads, before + 1);
    } finally {
      globalThis.fetch = oldFetch;
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
      if (created) await rm(packageDirectory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });
