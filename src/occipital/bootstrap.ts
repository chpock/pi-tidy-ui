import { diagnose, type DiagnosticSink } from '../diagnostics.ts';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionSettings } from '../settings.ts';
import type { SyntaxRuntimeOptions } from '../syntax/runtime.ts';
import { createLocalOwnedFactory, createOwnedFactory, createSharedFactory } from './factories.ts';
import { OCCIPITAL_LIMITS } from './limits.ts';
import { ExpectedOwnedUnavailable } from './owned-startup.ts';
import { NATIVE_RELEASE, type NativeReleaseDeclaration, type NativeTarget } from './release.ts';

const require = createRequire(import.meta.url);
const extensionRoot = fileURLToPath(new URL('../../', import.meta.url));
const development = (require(join(extensionRoot, 'package.json')) as { version: string }).version === '0.0.0';
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

/** Native filesystem/network work starts only after eligible presentation attachment. */
export function createSyntaxOptions(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager' | 'ui'>,
  release: NativeReleaseDeclaration | undefined = NATIVE_RELEASE, diagnostic?: DiagnosticSink): SyntaxRuntimeOptions {
  const agentDir = getAgentDir(), cwd = ctx.cwd;
  const identity = { harness: 'pi', session: ctx.sessionManager.getSessionId(), project_root: cwd };
  // Local runs must never silently select a shared or published engine instead of the build under development.
  const local = development ? createLocalOwnedFactory({ command: join(extensionRoot, process.platform === 'win32' ? 'occipital.exe' : 'occipital'),
    diagnostic, onMissing: missingLocalWarning(new WeakRef(ctx.ui)), requestDeadlineMs: OCCIPITAL_LIMITS.dataDeadlineMs, terminateGraceMs: 1000, cwd }) : undefined;
  diagnose(diagnostic, 'INFO', 'occipital', development ? 'Local development: colocated binary only; no shared service, download or build'
    : 'Published extension: shared-first, then exact declared native delivery', { version: release?.version ?? 'not declared' });
  return {
    diagnostic,
    standaloneVersion: development ? 'local development' : release?.version ?? 'not declared',
    settings: new ExtensionSettings({ agentDir }),
    provider: {
      tryShared: development ? async () => undefined : createSharedFactory({ identity, diagnostic, requestDeadlineMs: OCCIPITAL_LIMITS.dataDeadlineMs }),
      async acquireOwned(signal) {
        if (local) return local(signal);
        const target = runtimeTarget();
        if (!target) throw new ExpectedOwnedUnavailable();
        if (!release) throw new Error('Standalone Occipital release is not declared in this build.');
        const artifact = release.artifacts.find(item => item.target === target);
        if (!artifact) throw new Error('The declared Occipital release has no artifact for this platform/ABI.');
        const installedPath = await installedPayload(target, release.version);
        if (signal.aborted) throw new Error('Occipital acquisition was cancelled.');
        return createOwnedFactory({ diagnostic, release: { version: release.version, ...artifact }, cacheDir: join(agentDir, 'extensions', 'pi-tidy-ui', 'occipital'), installedPath,
          requestDeadlineMs: OCCIPITAL_LIMITS.dataDeadlineMs, terminateGraceMs: 1000, cwd })(signal);
      },
    },
  };
}

function missingLocalWarning(ui: WeakRef<ExtensionContext['ui']>): () => void {
  let warned = false;
  return () => {
    if (warned) return;
    const current = ui.deref();
    if (!current) return;
    warned = true;
    current.notify('[pi-tidy-ui] Local Occipital build not found next to this extension; using fallback highlighting without Occipital.', 'warning');
  };
}
