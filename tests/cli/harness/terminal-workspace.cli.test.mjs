import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiTerminal } from '../../fixtures/terminal-harness.mjs';
import { closeTerminals } from '../../fixtures/terminal-cleanup.mjs';

test('terminal fixture seeding stays default-on but can preserve an explicit caller workspace', async () => {
  const terminals = [], workspace = mkdtempSync(join(tmpdir(), 'terminal-workspace-'));
  try {
    const normal = new PiTerminal('workspace-default-fixtures'); terminals.push(normal);
    await normal.ready();
    assert.equal(readFileSync(join(normal.work, 'a.txt'), 'utf8'), 'READ_A_CONTENT\n');
    assert.equal(existsSync(join(normal.work, 'pixel.png')), true);
    await normal.close();
    writeFileSync(join(workspace, 'a.txt'), 'caller-owned read file\n');
    writeFileSync(join(workspace, 'written.txt'), 'caller-owned write file\n');
    const explicit = new PiTerminal('workspace-without-fixtures', { workspace, seedFixtures: false }); terminals.push(explicit);
    await explicit.ready();
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'caller-owned read file\n');
    assert.equal(readFileSync(join(workspace, 'written.txt'), 'utf8'), 'caller-owned write file\n');
    assert.deepEqual(readdirSync(workspace).sort(), ['a.txt', 'written.txt']);
    assert.equal(explicit.events().filter(event => ['call', 'result', 'model_context'].includes(event.type)).length, 0);
  } finally { await closeTerminals(terminals); rmSync(workspace, { recursive: true, force: true }); }
});
