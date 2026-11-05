import nativePath, { posix, win32 } from 'node:path';

/** Display-only: replace a parent ladder reaching the filesystem root, never a nearby relative path. */
export function displayPath(path: string, cwd = ''): string {
  const windows = win32.isAbsolute(cwd) && !posix.isAbsolute(cwd);
  const paths = windows ? win32 : nativePath;
  if (!paths.isAbsolute(cwd) || path.startsWith('~')) return path;
  const normalized = paths.normalize(path);
  const parents = (paths === win32 ? /^(?:\.\.(?:[\\/]+|$))+/u : /^(?:\.\.(?:\/+|$))+/u).exec(normalized)?.[0];
  if (!parents) return path;
  const parent = paths.resolve(cwd, parents);
  return parent === paths.parse(parent).root ? paths.resolve(cwd, path) : path;
}
