import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PiTerminal, root, fixtures, artifacts, plain, until } from './terminal-harness.mjs';
import { closeTerminals } from './terminal-cleanup.mjs';
import { childEnv, readInputs } from '../../scripts/test/context.mjs';

async function compilationCacheControl(probe) {
  const extension = join(probe, 'cached-extension.ts'), records = join(probe, 'executions.jsonl');
  const release = join(probe, 'release'), gate = join(probe, 'cold-gate.mjs');
  writeFileSync(gate, `import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    writeFileSync(join(process.env.HOME, 'cache-ready'), String(process.pid));
    const deadline = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() >= deadline) throw new Error('Cold compilation gate timed out');
      await setTimeout(10);
    }`);
  const source = label => `import { appendFileSync } from 'node:fs';
let evaluations: number = 0;
export default function probe() {
  evaluations++;
  appendFileSync(${JSON.stringify(records)}, JSON.stringify({ label: ${JSON.stringify(label)}, evaluations, pid: process.pid, home: process.env.HOME }) + '\\n');
}\n`;
  const histories = [], sessions = [], terminals = [];
  // The outer timeout must reap the PTYs before removing this suite's cache.
  process.once('SIGTERM', () => {
    closeTerminals(terminals).catch(error => console.error(error.message)).finally(() => process.exit(1));
  });
  const history = () => readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const observe = async (terminal, label, stage, expectedCache) => {
    await terminal.run('user-card');
    const dump = await terminal.capture('cache-physical-proof');
    assert.equal(dump.tools.length, 2);
    assert.equal(terminal.events().filter(event => event.type === 'call').length, 2);
    assert.equal(terminal.events().filter(event => event.type === 'result').length, 2);
    assert.equal(typeof dump.session, 'string'); sessions.push(dump.session);
    const log = plain(Buffer.concat(terminal.raw).toString());
    const cacheMessages = log.split(/\r?\n/u).filter(line => line.includes('[jiti] [cache]') && line.includes(extension));
    assert.ok(cacheMessages.some(line => expectedCache ? line.includes(expectedCache) : /\[(?:hit|miss)\]/u.test(line)), JSON.stringify(cacheMessages));
    histories.push({ stage, label, cacheMessages, history: history(), session: dump.session });
    return log;
  };
  assert.equal(Buffer.byteLength(source('FIRST')), Buffer.byteLength(source('OTHER')));
  assert.equal(existsSync(join(tmpdir(), 'pi-terminal-code')), false, 'the controlled suite cache starts absent');
  writeFileSync(extension, source('FIRST'));
  const cold = [];
  try {
    for (const index of [0, 1]) {
      const terminal = new PiTerminal(`compile-cache-cold-${index}`, { tidyUi: true, extensions: [extension],
        extraEnv: { NODE_DEBUG_NATIVE: 'COMPILE_CACHE', JITI_DEBUG: '1', NODE_OPTIONS: `--import=${pathToFileURL(gate).href}` } });
      cold.push(terminal); terminals.push(terminal);
    }
    await until(() => {
      for (const terminal of cold) terminal.health();
      return cold.every(terminal => existsSync(join(terminal.temp, 'cache-ready')));
    }, 'both cold CLI processes waiting before loading Pi');
    const gatePids = cold.map(terminal => Number(readFileSync(join(terminal.temp, 'cache-ready'), 'utf8')));
    assert.ok(gatePids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    assert.equal(new Set(gatePids).size, 2);
    for (const kind of ['node', 'jiti']) {
      assert.equal(cold[0].codeCache[kind], join(tmpdir(), 'pi-terminal-code', kind));
      assert.equal(cold[0].codeCache[kind], cold[1].codeCache[kind]);
    }
    for (const directory of Object.values(cold[0].codeCache)) {
      assert.equal(readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length, 0,
        'both processes must be gated before any compiled cache entries exist');
    }
    writeFileSync(release, 'release');
    await Promise.all(cold.map(terminal => terminal.ready()));
    for (const terminal of cold) await observe(terminal, 'FIRST', 'simultaneous-cold');
    assert.ok(histories.some(entry => entry.cacheMessages.some(line => line.includes('[miss]'))), 'cold source must actually be compiled');
    assert.deepEqual(history().map(entry => entry.pid).sort((a, b) => a - b), gatePids.sort((a, b) => a - b));
  } finally { await closeTerminals(cold); }
  for (const [index, label] of ['FIRST', 'OTHER'].entries()) {
    if (index === 1) writeFileSync(extension, source(label));
    const terminal = new PiTerminal(`compile-cache-${index === 0 ? 'warm' : 'changed'}`, { tidyUi: true, extensions: [extension],
      extraEnv: { NODE_DEBUG_NATIVE: 'COMPILE_CACHE', JITI_DEBUG: '1' } });
    terminals.push(terminal);
    try {
      await terminal.ready();
      const log = await observe(terminal, label, index === 0 ? 'warm' : 'changed', index === 0 ? '[hit]' : '[miss]');
      if (index === 0) {
        const plan = JSON.parse(readFileSync(join(terminal.output, 'native-observer.json'), 'utf8'));
        const accepted = [`cache for ${plan.module}`, `V8 code cache for ESM ${plan.module}`]
          .some(message => log.includes(`[compile cache] ${message} was accepted, keeping the in-memory entry`));
        assert.ok(accepted, 'native CLI bytecode must actually be reused');
        const badPlan = join(probe, 'invalid-observer.json');
        writeFileSync(badPlan, JSON.stringify({ ...plan, sha256: '0'.repeat(64) }));
        const inputs = readInputs();
        const rejected = spawnSync(inputs.node.path, ['--import', pathToFileURL(join(fixtures, 'terminal-preload.mjs')).href, inputs.pi.cli, '--version'], {
          cwd: root, env: childEnv(join(probe, 'hash-rejection'), { NODE_COMPILE_CACHE: terminal.codeCache.node,
            TIDY_UI_TEST_OBSERVER_PLAN: badPlan }, inputs), encoding: 'utf8', timeout: 12000,
        });
        assert.equal(rejected.error?.message, undefined);
        assert.notEqual(rejected.status, 0, 'a warm compilation cache must not bypass selected-source validation');
        assert.match(rejected.stderr, /Selected Pi changed after terminal observer planning/u);
      }
    } finally { await closeTerminals([terminal]); }
    assert.deepEqual(history().map(entry => entry.label), ['FIRST', 'FIRST', 'FIRST', 'OTHER'].slice(0, index + 3));
  }
  const executions = history();
  assert.ok(executions.every(entry => entry.evaluations === 1), 'every process must evaluate the extension afresh');
  assert.equal(new Set(executions.map(entry => entry.pid)).size, 4);
  assert.equal(new Set(executions.map(entry => entry.home)).size, 4);
  assert.equal(new Set(sessions).size, 4, 'compiled code must not share application sessions');
  writeFileSync(join(artifacts, 'compilation-cache-proof.json'), JSON.stringify(histories, null, 2));
}

if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
  throw new Error('Usage: compilation-cache-control.mjs ABSOLUTE_PROBE_DIRECTORY');
}
await compilationCacheControl(process.argv[2]);
