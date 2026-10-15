import { writeFileSync } from 'node:fs';
import { readInputs, validateHost } from './context.mjs';

let reason = 'bootstrap-runtime';
try {
  if (process.env.TIDY_TEST_CONTEXT_READY !== '1') throw new Error('Launch tests through scripts/test/run.mjs so isolation precedes Node startup');
  process.umask(0o077);
  const inputs = readInputs();
  validateHost(inputs);
  reason = 'bootstrap-sdk-import';
  const tui = await import('@earendil-works/pi-tui');
  const coding = await import('@earendil-works/pi-coding-agent');
  reason = 'bootstrap-class-identity';
  if (!(coding.CustomEditor.prototype instanceof tui.Editor)) throw new Error('Selected CLI/SDK TUI class identities do not match');
} catch (error) {
  if (process.env.TIDY_TEST_BOOTSTRAP_STATUS) writeFileSync(process.env.TIDY_TEST_BOOTSTRAP_STATUS, JSON.stringify({ reason }));
  throw error;
}
