import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ExtensionSettings } from '../settings.ts';
import type { SyntaxRuntimeOptions } from '../syntax/runtime.ts';
import { createOwnedFactory, createSharedFactory } from './factories.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';
import { NATIVE_RELEASE, type NativeReleaseDeclaration, type NativeTarget } from './release.ts';

const require = createRequire(import.meta.url);
const PACKAGE_METADATA_BYTES = 64 * 1024;

export function nativePackageName(target: NativeTarget): string { return `@kchpock/occipital-${target}`; }
export function nativeTarget(platform: NodeJS.Platform, arch: string, glibc: boolean): NativeTarget | undefined {
  if (arch !== 'x64' && arch !== 'arm64') return undefined;
  if (platform === 'linux' && glibc) return `linux-${arch}-gnu`;
  if (platform === 'darwin') return `darwin-${arch}`;
  if (platform === 'win32') return `windows-${arch}-msvc`;
  return undefined;
}
function runtimeTarget(): NativeTarget | undefined {
  const glibc = process.platform === 'linux' && typeof (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime === 'string';
  return nativeTarget(process.platform, process.arch, glibc);
}
async function installedPayload(target: NativeTarget, version: string): Promise<string | undefined> {
  let handle;
  try {
    const name = nativePackageName(target), file = require.resolve(`${name}/package.json`);
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PACKAGE_METADATA_BYTES) return undefined;
    const bytes = Buffer.alloc(PACKAGE_METADATA_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > PACKAGE_METADATA_BYTES) return undefined;
    const text = bytes.subarray(0, length).toString('utf8');
    if (Buffer.byteLength(text) !== length || !Buffer.from(text).equals(bytes.subarray(0, length))) return undefined;
    const pkg: unknown = JSON.parse(text);
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) ||
      (pkg as { name?: unknown }).name !== name || (pkg as { version?: unknown }).version !== version) return undefined;
    return join(dirname(file), target.startsWith('windows-') ? 'occipital.exe' : 'occipital');
  } catch {
    // A missing/replaced/invalid optional payload is not a trusted cache hit.
    return undefined;
  } finally { await handle?.close(); }
}

/** Bind the existing bounded factories. No imports, file reads, downloads or helper
 * startup here; the broker invokes them asynchronously after eligible attachment. */
export function createSyntaxOptions(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  release: NativeReleaseDeclaration | undefined = NATIVE_RELEASE): SyntaxRuntimeOptions {
  const agentDir = getAgentDir(), cwd = ctx.cwd;
  const identity = { harness: 'pi', session: ctx.sessionManager.getSessionId(), project_root: cwd };
  return {
    standaloneVersion: release?.version ?? 'not declared',
    settings: new ExtensionSettings({ agentDir }),
    provider: {
      tryShared: createSharedFactory({ identity, requestDeadlineMs: OCCIPITAL_LIMITS.dataDeadlineMs }),
      async acquireOwned(signal) {
        if (!release) throw new Error('Standalone Occipital release is not declared in this build.');
        const target = runtimeTarget(), artifact = release.artifacts.find(item => item.target === target);
        if (!target || !artifact) throw new Error('The declared Occipital release has no artifact for this platform/ABI.');
        const installedPath = await installedPayload(target, release.version);
        if (signal.aborted) throw new Error('Occipital acquisition was cancelled.');
        return createOwnedFactory({ release: { version: release.version, ...artifact }, cacheDir: join(agentDir, 'cache', 'occipital'), installedPath,
          requestDeadlineMs: OCCIPITAL_LIMITS.dataDeadlineMs, terminateGraceMs: 1000, cwd })(signal);
      },
    },
  };
}
