// Theme-independent SOURCE streaming in a real owned helper; no terminal/FPS claim.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { SyntaxClient } from '../../src/occipital/client.ts';
import { createLocalOwnedFactory } from '../../src/occipital/factories.ts';
import { readInputs, validateNative } from '../../scripts/test/context.mjs';
import { workload } from '../../scripts/test/performance/workloads.mjs';
import { beginPhase, endPhase, afterGC, capabilities } from '../../scripts/test/performance/metrics.mjs';

const config = JSON.parse(readFileSync(process.env.TIDY_TEST_PERF_CONFIG, 'utf8'));
const scenario = workload(config.scenario.id, config.scenario.variant, config.scenario.parameters);
assert.equal(scenario.id, 'source-stream'); assert.equal(scenario.hash, config.scenario.hash);
const inputs = readInputs(), native = validateNative(inputs), p = scenario.parameters, phases = [], lifecycle = [];
if (config.allocationProfile) throw new Error('Select render/frames for allocation stack profiling; SOURCE streaming exposes exact allocation metrics without stack sampling');
let client = new SyntaxClient({ standaloneVersion: '0.0.0', initialTheme: { kind: 'occipital', id: 'syntect:InspiredGitHub' },
  provider: { tryShared: async () => undefined, acquireOwned: createLocalOwnedFactory({ command: native.path, requestDeadlineMs: 10000, terminateGraceMs: 100 }) } });
const counters = ['dispatches', 'preparedBytes', 'decodedBytes', 'committedLineCalls', 'committedLineBytes', 'tailCalls', 'tailBytes', 'styleDispatches', 'styleEncodes'];
const snapshot = () => client.sources.stats();
const accounting = () => { const s = snapshot(); return { records: s.sourceRecords, entries: s.retention.entries, unsettledJobs: s.unsettledJobs, retainedBytes: s.retention.retainedBytes, outstandingPeakBytes: s.retention.outstandingPeakBytes }; };
const line = index => `printf '%s\\n' 'source_${index}${p.unicode ? ' 界 é 👩‍💻' : ' ascii'}'\n`;
const keys = Array.from({ length: p.cards }, (_, i) => `performance-source:${i}`);
let profile, text = line(0), version = 1, disposed = false;
async function ready(key, wanted, expected) {
  const end = performance.now() + 30000;
  while (performance.now() < end) {
    client.sources.flush();
    const status = client.sources.status(key), basis = client.sources.displayBasis(key);
    if (status?.exact && status.version === wanted && basis && snapshot().unsettledJobs === 0 && snapshot().pendingCloses === 0) {
      let accepted; basis.visit(value => { accepted = value; });
      assert.equal(accepted, expected, 'native response covers exactly the requested source text'); return;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Native SOURCE streaming did not reach the exact requested result: ${JSON.stringify({ key, wanted,
    status: client.sources.status(key), work: client.sources.workStatus(key), statistics: accounting() })}`);
}
function observe(key, sourceVersion, value, complete) {
  assert.equal(client.sources.observe({ key, version: sourceVersion, text: value, language: 'bash', neutral: 'title',
    profile: profile.id, fingerprint: profile.fingerprint, complete }), true);
}
async function phase(id, operations, action) {
  const before = snapshot(), token = beginPhase({ gcProfile: config.gcProfile }); let result, ended = false;
  try { await action(); ended = true; result = endPhase(token, { operations }); }
  finally { if (!ended) endPhase(token, { operations: 0 }); }
  const after = snapshot(); result.counts = Object.fromEntries(counters.map(key => [key, after[key] - before[key]]));
  phases.push({ id, ...result });
}
try {
  await phase('owned-startup-and-history', p.cards, async () => {
    await client.start(); assert.equal(client.snapshot().provider.availability, 'ready'); profile = client.snapshot().effective; assert.ok(profile); assert.equal(profile.id, 'syntect:InspiredGitHub');
    client.sources.setStyleSelection({ kind: 'native', id: profile.id, fingerprint: profile.fingerprint });
    for (const key of keys) observe(key, 1, text, key !== keys.at(-1));
    for (const key of keys) await ready(key, 1, text);
  });
  lifecycle.push({ id: 'owned-ready', memory: await afterGC({ turns: 3 }), accounting: accounting() });
  await phase('source-append', p.iterations, async () => {
    for (let i = 0; i < p.iterations; i++) { text += line(i + 1); version++; observe(keys.at(-1), version, text, false); await ready(keys.at(-1), version, text); }
  });
  assert.equal(phases.at(-1).counts.committedLineCalls, p.iterations, 'each append classifies only its new completed line');
  await phase('equal-text-finalize', 1, async () => { version++; observe(keys.at(-1), version, text, true); await ready(keys.at(-1), version, text); });
  assert.equal(phases.at(-1).counts.committedLineCalls, 0, 'completion does not reparse the committed prefix');
  await phase('unchanged-source', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) { observe(keys.at(-1), version, text, true); client.sources.flush(); } });
  assert.equal(phases.at(-1).counts.dispatches, 0); assert.equal(phases.at(-1).counts.styleDispatches, 0);
  for (const key of keys) client.sources.remove(key);
  lifecycle.push({ id: 'removed', memory: await afterGC({ turns: 3 }), accounting: accounting() });
  assert.equal(accounting().entries, 0, 'SOURCE removal releases every source entry; the live selection can still own its palette');
  await client.dispose(); disposed = true;
  const disposedAccounting = accounting(); assert.equal(disposedAccounting.retainedBytes, 0, 'dispose releases the selection and all remaining budget charges');
  client = undefined; profile = undefined; text = '';
  const retained = await afterGC({ turns: 3 });
  lifecycle.push({ id: 'disposed-collected', memory: retained, accounting: disposedAccounting });
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'passed', phases, lifecycle, retained, capabilities: capabilities(),
    workloadCapabilities: { nativeSourceStreaming: 'actual-owned-helper', terminalFrames: 'not-applicable' } }));
} catch (error) {
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'failed', phases, lifecycle,
    failure: { name: error.name, message: String(error.message).slice(0, 1500) } })); process.exitCode = 1;
} finally { if (!disposed) await client.dispose(); }
