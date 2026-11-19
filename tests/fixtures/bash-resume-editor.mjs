// Stand-in editor launched by Pi; leaving the draft untouched is intentional.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const release = join(process.env.TIDY_UI_TEST_OUTPUT, 'editor-return');
process.stdout.write('BASH_RESUME_EDITOR_ACTIVE\n');
const deadline = Date.now() + 20_000;
while (!existsSync(release)) {
  if (Date.now() >= deadline) throw new Error('Timed out waiting to return from the external editor');
  await sleep(20);
}
