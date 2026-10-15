import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cache;

export function terminalCodeCache(home) {
  if (!cache) {
    // TMPDIR belongs to the runner, not a test-file process; the runner cleans it after all files.
    const root = join(tmpdir(), 'pi-terminal-code');
    cache = { node: join(root, 'node'), jiti: join(root, 'jiti') };
    mkdirSync(cache.node, { recursive: true });
    mkdirSync(cache.jiti, { recursive: true });
  }
  // Jiti's environment switch is boolean; its documented default directory lives under TMPDIR.
  // Share only compiled source, not the rest of the child's temporary or application state.
  symlinkSync(cache.jiti, join(home, 'tmp', 'jiti'), 'junction');
  return cache;
}
