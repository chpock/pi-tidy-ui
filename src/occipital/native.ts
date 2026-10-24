import { createHash, randomUUID } from 'node:crypto';
import { access, open, mkdir, chmod, link, rename, unlink, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, parse, resolve, sep } from 'node:path';

import { parseVersion } from './version.ts';


export type NativeRelease = Readonly<{ version: string; target: string; sha256: string; url: string; maxBytes: number }>;
export type NativeAcquisition = Readonly<{ path: string; downloaded: boolean }>;
export class NativeDeliveryError extends Error {
  constructor(message = 'Could not acquire the declared occipital artifact.') { super(message); this.name = 'NativeDeliveryError'; }
}
const MAX_BYTES = 64 * 1024 * 1024;
const DEADLINE_MS = 15_000;
const CHUNK_BYTES = 64 * 1024;

function checkedRelease(input: NativeRelease): NativeRelease {
  if (!input || typeof input.version !== 'string' || input.version.length > 64 ||
    !parseVersion(input.version) ||
    typeof input.target !== 'string' || input.target.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.target) ||
    typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_BYTES) throw new NativeDeliveryError('Invalid declared occipital artifact.');
  let url: URL;
  try { url = new URL(input.url); } catch { throw new NativeDeliveryError('Invalid declared occipital origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new NativeDeliveryError('Invalid declared occipital origin.');
  return { version: input.version, target: input.target, sha256: input.sha256, url: url.href, maxBytes: input.maxBytes };
}

function appendPath(base: string, suffix: string): string {
  return base + (base.endsWith('/') || (process.platform === 'win32' && base.endsWith('\\')) ? '' : sep) + suffix;
}

/** Anchor before any await; resolve ONLY a drive/root, never caller components.
 * Collapsing symlink/.. would verify a different location than the OS executes. */
function absolutePath(path: string): string {
  const root = parse(path).root;
  if (isAbsolute(path) && (process.platform !== 'win32' || root.length > 1)) return path;
  return appendPath(root ? resolve(root) : process.cwd(), path.slice(root.length));
}

async function exact(path: string, release: NativeRelease, signal: AbortSignal): Promise<boolean> {
  let file;
  try {
    signal.throwIfAborted();
    try { file = await open(path, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > release.maxBytes) return false;
    const bytes = Buffer.allocUnsafe(CHUNK_BYTES), hash = createHash('sha256');
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > release.maxBytes) return false;
      hash.update(bytes.subarray(0, bytesRead));
    }
    return total > 0 && hash.digest('hex') === release.sha256;
  } finally { await file?.close(); }
}

async function responseFor(release: NativeRelease, fetcher: typeof fetch, signal: AbortSignal): Promise<Response> {
  let url = new URL(release.url);
  const origin = url.origin;
  const github = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await fetcher(url.href, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new NativeDeliveryError('Occipital artifact redirect limit.');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.hash ||
      (next.origin !== origin && !(github.has(url.hostname) && github.has(next.hostname)))) throw new NativeDeliveryError('Invalid occipital artifact redirect.');
    url = next;
  }
  throw new NativeDeliveryError('Occipital artifact redirect limit.');
}

async function pruneVersions(cacheDir: string, keep: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (signal.aborted) return;
    if (!entry.isDirectory() || entry.name === keep || entry.name.length > 64 || !parseVersion(entry.name)) continue;
    const directory = appendPath(cacheDir, entry.name);
    if (entry.name.toLowerCase() === keep.toLowerCase()) {
      // Case-preserving filesystems can enumerate another spelling of the selected directory.
      const selected = await stat(appendPath(cacheDir, keep), { bigint: true }).catch(() => undefined);
      const candidate = await stat(directory, { bigint: true }).catch(() => undefined);
      if (!selected || !candidate || (selected.dev === candidate.dev && selected.ino === candidate.ino)) continue;
    }
    if (signal.aborted) return;
    // Disposable storage: locked or inaccessible versions are retried on the next acquisition.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Resolve exactly one caller-declared release; no discovery/latest lookup or process launch.
 * Cache publication is complete-file only. Concurrent cold clients may independently
 * download the same immutable artifact; no shared lock or stale-lock service is needed.
 * Successful acquisition best-effort prunes other downloaded versions, without tracking users.
 * The caller supplies trusted release metadata, not a user-selected download override.
 */
export async function acquireNative(options: { cacheDir: string; release: NativeRelease; installedPath?: string; signal?: AbortSignal; fetcher?: typeof fetch }): Promise<NativeAcquisition> {
  let temporary: string | undefined, file, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const release = checkedRelease(options.release);
    const signal = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    const cacheDir = absolutePath(options.cacheDir);
    const installedPath = options.installedPath === undefined ? undefined : absolutePath(options.installedPath);
    // Only a caller-supplied trusted installed payload is eligible; never PATH/latest.
    // Reuse the bounded streaming verifier without rewriting the installed package.
    if (installedPath !== undefined) {
      let installed = false;
      try {
        await access(installedPath, constants.X_OK); signal.throwIfAborted();
        installed = await exact(installedPath, release, signal);
      }
      catch { signal.throwIfAborted(); /* An unusable payload may use exact delivery. */ }
      signal.throwIfAborted();
      if (installed) {
        await pruneVersions(cacheDir, release.version, signal);
        return { path: installedPath, downloaded: false };
      }
    }
    const directory = appendPath(appendPath(cacheDir, release.version), release.target);
    const path = appendPath(directory, release.target.startsWith('windows-') ? 'occipital.exe' : 'occipital');
    if (await exact(path, release, signal)) {
      await chmod(path, 0o700); signal.throwIfAborted();
      await pruneVersions(cacheDir, release.version, signal);
      return { path, downloaded: false };
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const response = await responseFor(release, options.fetcher ?? fetch, signal);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new NativeDeliveryError('Occipital artifact download failed.'); }
    reader = response.body.getReader();
    const header = response.headers.get('content-length');
    if (header !== null && (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)) || Number(header) > release.maxBytes)) throw new NativeDeliveryError('Occipital artifact size limit.');
    signal.throwIfAborted();
    temporary = appendPath(directory, `.occipital-${randomUUID()}.tmp`);
    file = await open(temporary, 'wx', 0o600);
    let total = 0;
    const hash = createHash('sha256');
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > release.maxBytes) throw new NativeDeliveryError('Occipital artifact size limit.');
      hash.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        signal.throwIfAborted();
        const result = await file.write(part.value, offset, Math.min(CHUNK_BYTES, part.value.byteLength - offset), null);
        if (!result.bytesWritten) throw new NativeDeliveryError();
        offset += result.bytesWritten;
      }
    }
    if (!total || (header !== null && total !== Number(header)) || hash.digest('hex') !== release.sha256) throw new NativeDeliveryError('Occipital artifact checksum or size mismatch.');
    await file.close(); file = undefined;
    await chmod(temporary, 0o700); signal.throwIfAborted();
    // Do not replace an already valid published executable, including one in use.
    if (!await exact(path, release, signal)) {
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A competing complete publication wins. Only a corrupt exact path needs repair.
        if (!await exact(path, release, signal)) await rename(temporary, path);
      }
    }
    await pruneVersions(cacheDir, release.version, signal);
    return { path, downloaded: true };
  } catch (error) {
    // Do not forward filesystem/URL/body strings into Pi diagnostics.
    throw error instanceof NativeDeliveryError ? error : new NativeDeliveryError();
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await file?.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
