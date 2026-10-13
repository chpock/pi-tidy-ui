import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyntaxOptions, nativePackageName, nativeTarget } from '../src/occipital/bootstrap.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { NATIVE_RELEASE, type NativeReleaseDeclaration } from '../src/occipital/release.ts';

async function isolatedDevelopment(t: import('node:test').TestContext) {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  await mkdir(join(repo, '.test-artifacts'), { recursive: true });
  const root = await mkdtemp(join(repo, '.test-artifacts/bootstrap-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repo, 'src'), join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"version":"0.0.0","type":"module"}');
  const { pathToFileURL } = await import('node:url');
  return { root, bootstrap: await import(pathToFileURL(join(root, 'src/occipital/bootstrap.ts')).href) };
}

const warnings: { message: string; level?: string }[] = [];
const ctx = { cwd: '/project', sessionManager: { getSessionId: () => 'session' },
  ui: { notify(message: string, level?: string) { warnings.push({ message, level }); } } } as ExtensionContext;

test('bootstrap maps only actual candidate ABI tuples, never musl to GNU', () => {
  assert.equal(nativeTarget('linux', 'x64', true), 'linux-x64-gnu');
  assert.equal(nativeTarget('linux', 'arm64', true), 'linux-arm64-gnu');
  assert.equal(nativeTarget('linux', 'x64', false), undefined);
  assert.equal(nativeTarget('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(nativeTarget('win32', 'x64', false), 'windows-x64-msvc');
  assert.equal(nativeTarget('linux', 'riscv64', true), undefined);
  assert.equal(nativePackageName('linux-x64-gnu'), '@kchpock/occipital-linux-x64-gnu');
});

test('bootstrap development version uses only the colocated helper and aborted acquisition does no network work', async () => {
  assert.equal(NATIVE_RELEASE, undefined, 'source checkout must not commit a production native pin');
  const options = createSyntaxOptions(ctx);
  assert.equal(options.standaloneVersion, 'local development');
  const fetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async () => { downloads++; throw Error('An aborted acquisition must not download'); };
  try {
    const abort = new AbortController(); abort.abort();
    await assert.rejects(options.provider.acquireOwned(abort.signal), /owned factory unavailable/);
    assert.equal(downloads, 0);
    assert.equal(warnings.length, 0, 'aborted startup must not warn');
  } finally { globalThis.fetch = fetch; }
});

test('development without local build warns once, never selects shared/release delivery, and keeps fallback available', async t => {
  const { root, bootstrap } = await isolatedDevelopment(t);
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, process.platform === 'win32' ? 'occipital.exe' : 'occipital'), 'not the extension build');
  const options = bootstrap.createSyntaxOptions({ ...ctx, cwd: project }), before = warnings.length, fetch = globalThis.fetch;
  let downloads = 0, negotiations = 0;
  globalThis.fetch = async () => { downloads++; throw Error('Development must not download'); };
  try {
    assert.equal(await options.provider.tryShared(new AbortController().signal, async () => { negotiations++; return true; }), undefined);
    for (let i = 0; i < 2; i++) await assert.rejects(options.provider.acquireOwned(new AbortController().signal));
    assert.equal(downloads, 0); assert.equal(negotiations, 0);
    assert.equal(warnings.length, before + 1);
    assert.equal(warnings.at(-1)?.level, 'warning');
    assert.equal(warnings.at(-1)?.message, '[pi-tidy-ui] Local Occipital build not found next to this extension; using fallback highlighting without Occipital.');
  } finally { globalThis.fetch = fetch; }
});

test('development resolves the executable beside the extension, not cwd, and reaps it', { skip: process.platform === 'win32' }, async t => {
  const { root, bootstrap } = await isolatedDevelopment(t), command = join(root, 'occipital'), project = join(root, 'project');
  await mkdir(project);
  await writeFile(command, `#!${process.execPath}\nsetInterval(() => {}, 1000000);\n`); await chmod(command, 0o755);
  const options = bootstrap.createSyntaxOptions({ ...ctx, cwd: project });
  const transport = await options.provider.acquireOwned(new AbortController().signal); t.after(() => transport.close());
  assert.equal(transport.stats().childState, 'running'); const pid = transport.stats().pid; assert.ok(pid);
  await transport.close(); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

function weakUIOptions(bootstrap: { createSyntaxOptions: typeof createSyntaxOptions }) {
  const ui = { notify() {} } as unknown as ExtensionContext['ui'];
  return { owner: new WeakRef(ui), options: bootstrap.createSyntaxOptions({ cwd: '/project', sessionManager: ctx.sessionManager, ui }) };
}
test('active development bootstrap does not retain the warning UI owner', { skip: !global.gc }, async t => {
  const { bootstrap } = await isolatedDevelopment(t), held = weakUIOptions(bootstrap);
  for (let i = 0; i < 40; i++) {
    await new Promise<void>(resolve => setImmediate(resolve)); global.gc!();
    await new Promise<void>(resolve => setImmediate(resolve)); if (!held.owner.deref()) break;
  }
  assert.equal(held.owner.deref(), undefined);
  await assert.rejects(held.options.provider.acquireOwned(new AbortController().signal), /owned factory unavailable/);
});

test('bootstrap constructs without source, preferences, SDK import or provider work', () => {
  let reads = 0;
  const options = createSyntaxOptions({ cwd: '/project', sessionManager: { getSessionId() { reads++; return 'session'; } }, ui: ctx.ui } as ExtensionContext);
  assert.equal(reads, 1);
  assert.equal(typeof options.provider.tryShared, 'function');
  assert.equal(typeof options.provider.acquireOwned, 'function');
});

const hostTarget = nativeTarget(process.platform, process.arch,
  process.platform === 'linux' && typeof (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime === 'string');

test('published bootstrap exact installed metadata hands verified payload to owned factory; invalid metadata never starts it',
  { skip: !hostTarget || process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'occipital-bootstrap-'));
    const repo = dirname(dirname(fileURLToPath(import.meta.url)));
    const root = join(directory, 'extension'); await mkdir(root);
    await cp(join(repo, 'src'), join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pi-toolview', version: '0.2.0', type: 'module' }));
    await mkdir(join(root, 'node_modules'));
    const { symlink } = await import('node:fs/promises');
    for (const scope of ['@earendil-works', '@cortexkit']) await symlink(join(repo, 'node_modules', scope), join(root, 'node_modules', scope), 'dir');
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
      await writeFile(join(root, 'src/occipital/release.ts'), `export const NATIVE_RELEASE = ${JSON.stringify(release)};`);
      const { createSyntaxOptions: publishedOptions } = await import((await import('node:url')).pathToFileURL(join(root, 'src/occipital/bootstrap.ts')).href);
      const options = publishedOptions({ ...ctx, cwd: directory } as ExtensionContext), transport = await options.provider.acquireOwned(new AbortController().signal);
       const { StdioTransport } = await import((await import('node:url')).pathToFileURL(join(root, 'src/occipital/stdio.ts')).href);
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
