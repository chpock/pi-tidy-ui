import { tmpdir } from 'node:os';

function appendDirectory(base: string, suffix: string, windows: boolean): string {
  // The OS must resolve parent components after symlinks; path.join collapses them.
  const separated = base.endsWith('/') || (windows && base.endsWith('\\'));
  const driveRelative = windows && /^[a-zA-Z]:$/.test(base);
  return base + (base === '' || separated || driveRelative ? '' : windows ? '\\' : '/') + suffix;
}

/**
 * Narrow bridge for the public subc-transport discovery_candidates contract
 * (ce24cc4, connection_file.rs:415–483,528–564). No filesystem/port/process scan.
 * These are candidates, not evidence of a usable service. The public Node SDK
 * validates each connection file and authenticates; protocol negotiation follows.
 * Explicit/env selection is exclusive, so failure cannot silently use another host.
 */
export function connectionCandidates(options: { explicit?: string; env?: NodeJS.ProcessEnv; tempDir?: string; uid?: number; platform?: NodeJS.Platform } = {}): string[] {
  const env = options.env ?? process.env;
  if (options.explicit !== undefined) return [options.explicit];
  if (env.SUBC_CONNECTION_FILE) return [env.SUBC_CONNECTION_FILE];
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  let token: string;
  if (platform === 'win32') {
    const raw = [env.USER, env.USERNAME, env.HOME, env.USERPROFILE].find(value => !!value);
    // Rust iterates scalar characters; a UTF16 regex would turn one emoji into two '_'.
    token = raw ? Array.from(raw, char => /^[a-zA-Z0-9_-]$/.test(char) ? char : '_').join('') : 'unknown';
  } else {
    const uid = options.uid ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid! < 0) throw new Error('Subconscious user identity is unavailable.');
    token = String(uid);
  }
  const candidates: string[] = [];
  if (env.XDG_RUNTIME_DIR) candidates.push(appendDirectory(env.XDG_RUNTIME_DIR, 'subc-connection.json', windows));
  if (env.HOME) candidates.push(appendDirectory(env.HOME, windows ? '.local\\share\\cortexkit\\run\\subc-connection.json' : '.local/share/cortexkit/run/subc-connection.json', windows));
  candidates.push(appendDirectory(options.tempDir ?? tmpdir(), `subc-${token}.connection.json`, windows));
  return [...new Set(candidates)];
}
