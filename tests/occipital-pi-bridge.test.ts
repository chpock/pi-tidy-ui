import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SourceController } from '../src/occipital/controller.ts';
import { RetentionPool } from '../src/occipital/retention.ts';
import type { ProviderSnapshot } from '../src/occipital/provider.ts';

class Unavailable {
  calls = 0;
  snapshot(): ProviderSnapshot { return { generation: 1, availability: 'unavailable', reason: 'optional_unavailable', initialShared: false }; }
  isReady() { return false; }
  classificationAccepted() { return false; }
  request(): Promise<unknown> { this.calls++; return Promise.reject(new Error('unexpected dispatch')); }
}
const owners = new Set<SourceController>();
function fixture(options: ConstructorParameters<typeof SourceController>[1] = {}) {
  const host = new Unavailable(), source = new SourceController(host, options); owners.add(source);
  return { host, source };
}
function bridge(source: SourceController, key: string, version: number, palette: number) {
  const rows: string[] = [];
  const available = source.visitPiBridge(key, version, palette, (index, line) => { assert.equal(index, rows.length); rows.push(line); });
  return { available, rows };
}
function store(source: SourceController, key: string, palette: number, lines: readonly string[]) {
  const capture = source.borrowPiSource(key)!;
  return source.installPiBridge(key, capture.generation, capture.version, capture.text, palette, lines);
}
afterEach(() => {
  for (const source of owners) {
    source.dispose();
    assert.equal(source.stats().retention.entries, 0);
    assert.equal(source.stats().bookkeepingBytes, 0);
    assert.equal(source.stats().globalUnsettledJobs, 0);
  }
  owners.clear();
});

test('Pi bridge captures and exact rows work with native classification disabled, without RPC', () => {
  const { host, source } = fixture(); source.setEnabled(false);
  const text = '\tconst x = 1;\n';
  assert.equal(source.capturePiSource('card', 1, text, 'typescript'), true);
  const capture = source.borrowPiSource('card')!;
  assert.equal(capture.text, text); assert.equal(capture.utf8Bytes, Buffer.byteLength(text));
  assert.equal(capture.language, 'typescript'); assert.equal(capture.version, 1);
  assert.equal(store(source, 'card', 7, ['\t\x1b[31mconst\x1b[39m x = 1;', '']), true);
  assert.deepEqual(bridge(source, 'card', 1, 7), { available: true, rows: ['\t\x1b[31mconst\x1b[39m x = 1;', ''] });
  assert.equal(source.status('card'), undefined);
  source.flush(); assert.equal(host.calls, 0); assert.equal(source.stats().preparedBytes, 0);
  assert.equal(source.stats().piSourceRecords, 1); assert.equal(source.stats().retention.bridgeLinesCopied, 2);
});

test('warm Pi source and bridge visits use cached UTF8 and copy no rows', () => {
  const { source } = fixture(); const text = 'é😀\n';
  source.capturePiSource('warm', 1, text, 'javascript'); store(source, 'warm', 2, [text.slice(0, -1), '']);
  const before = source.stats(), byteLength = Buffer.byteLength; let measured = 0;
  Buffer.byteLength = function(value: Parameters<typeof byteLength>[0], encoding?: Parameters<typeof byteLength>[1]) {
    if (value === text) measured++;
    return byteLength(value, encoding);
  };
  try {
    for (let i = 0; i < 100; i++) {
      assert.equal(source.capturePiSource('warm', 1, text, 'javascript'), true);
      assert.equal(source.borrowPiSource('warm')!.utf8Bytes, 7);
      assert.equal(bridge(source, 'warm', 1, 2).available, true);
    }
  } finally { Buffer.byteLength = byteLength; }
  assert.equal(measured, 0); assert.deepEqual(source.stats(), before);
});

test('Pi snapshots and native snapshots share the same byte pool and removal owner', () => {
  const { host, source } = fixture({ retention: { maxBytes: 8192 } });
  const text = 'let x;';
  source.capturePiSource('same', 1, text, 'typescript'); store(source, 'same', 1, [text]);
  source.observe({ key: 'same', version: 1, text, path: 'a.ts', profile: 'pi', fingerprint: 'a'.repeat(64), complete: true });
  const held = source.stats();
  assert.equal(held.retention.entries, 2); assert.equal(held.sourceRecords, 1); assert.equal(held.piSourceRecords, 1);
  assert.ok(held.retention.bridgeBytes > 0 && held.retention.retainedBytes <= 8192);
  source.remove('same'); assert.equal(source.stats().retention.entries, 0);
  assert.equal(source.stats().piSourceRecords, 0); assert.equal(source.stats().sourceRecords, 0);
  assert.equal(source.stats().bookkeepingBytes, 128); assert.equal(host.calls, 0);
});

test('language, palette and incarnation authority reject stale Pi results', () => {
  const { source } = fixture(); const text = 'x';
  source.capturePiSource('identity', 1, text, 'javascript'); const first = source.borrowPiSource('identity')!;
  store(source, 'identity', 1, ['\x1b[31mx\x1b[39m']);
  assert.equal(bridge(source, 'identity', 1, 2).available, false);
  store(source, 'identity', 2, ['\x1b[32mx\x1b[39m']);
  assert.equal(bridge(source, 'identity', 1, 1).available, false);
  const current = bridge(source, 'identity', 1, 2);
  assert.equal(source.installPiBridge('identity', first.generation, first.version, first.text, 1, ['wrong']), false);
  assert.deepEqual(bridge(source, 'identity', 1, 2), current);
  source.capturePiSource('identity', 1, text, 'bash');
  assert.notEqual(source.borrowPiSource('identity')!.generation, first.generation);
  assert.equal(source.installPiBridge('identity', first.generation, first.version, first.text, 2, ['wrong']), false);
  assert.equal(bridge(source, 'identity', 1, 2).available, false);
  source.remove('identity'); source.capturePiSource('identity', 1, text, 'bash');
  assert.equal(source.installPiBridge('identity', first.generation, first.version, first.text, 2, ['wrong']), false);
});

test('changed text retires colors; equal text aliases later source versions without recoloring', () => {
  const { source } = fixture();
  source.capturePiSource('changing', 1, 'old', 'bash'); store(source, 'changing', 3, ['old']);
  const old = source.borrowPiSource('changing')!;
  source.capturePiSource('changing', 2, 'new', 'bash');
  assert.equal(bridge(source, 'changing', 2, 3).available, false);
  assert.equal(source.installPiBridge('changing', old.generation, 1, old.text, 3, ['old']), false);
  store(source, 'changing', 3, ['new']); const copies = source.stats().retention.bridgeLinesCopied;
  source.capturePiSource('changing', 3, 'new', 'bash');
  assert.deepEqual(bridge(source, 'changing', 3, 3), { available: true, rows: ['new'] });
  assert.equal(source.stats().retention.bridgeLinesCopied, copies);
  assert.throws(() => source.capturePiSource('changing', 2, 'new', 'bash'), /non-monotonic/);
});

test('ordinary byte pressure releases Pi rows and does not retry an unchanged capture', () => {
  const { source } = fixture({ retention: { maxBytes: 8192 } });
  source.capturePiSource('pressure', 1, 'x'.repeat(100), 'bash'); store(source, 'pressure', 1, ['x'.repeat(100)]);
  source.observe({ key: 'large', version: 1, text: 'y'.repeat(3500), profile: 'pi', fingerprint: 'a'.repeat(64), complete: true });
  assert.equal(source.borrowPiSource('pressure'), undefined);
  assert.equal(bridge(source, 'pressure', 1, 1).available, false);
  const held = source.stats();
  for (let i = 0; i < 20; i++) assert.equal(source.capturePiSource('pressure', 1, 'x'.repeat(100), 'bash'), false);
  assert.deepEqual(source.stats(), held);
  assert.equal(source.capturePiSource('pressure', 2, 'x'.repeat(100), 'bash'), true);
  assert.ok(source.stats().retention.retainedBytes <= 8192);
});

test('bridge-only lifetime closes while native work is disabled; disposal forbids resurrection', () => {
  const { source } = fixture(); source.setEnabled(false);
  source.capturePiSource('disabled', 1, 'x'); store(source, 'disabled', 0, ['x']);
  source.setEnabled(false); assert.equal(bridge(source, 'disabled', 1, 0).available, true);
  source.dispose(); assert.equal(source.stats().piSourceRecords, 0); assert.equal(source.stats().retention.entries, 0);
  assert.equal(source.capturePiSource('disabled', 1, 'x'), false); assert.equal(source.borrowPiSource('disabled'), undefined);
  assert.equal(bridge(source, 'disabled', 1, 0).available, false);
});

test('reentrant removal stops a Pi row visit and rejects its provisional result', () => {
  const { source } = fixture(); source.capturePiSource('remove', 1, 'x\ny'); store(source, 'remove', 1, ['x', 'y']);
  const seen: string[] = [];
  const available = source.visitPiBridge('remove', 1, 1, (_index, line) => { seen.push(line); source.remove('remove'); });
  assert.equal(available, false); assert.deepEqual(seen, ['x']); assert.equal(source.stats().retention.entries, 0);
});

test('a rejected replacement drops the prior Pi allocation instead of leaving unowned rows', () => {
  const { source } = fixture({ retention: { maxBytes: 8192 } });
  source.capturePiSource('replacement', 1, 'old');
  const old = source.borrowPiSource('replacement')!;
  source.installPiBridge('replacement', old.generation, 1, old.text, 1, ['old']);
  assert.equal(source.capturePiSource('replacement', 2, 'y'.repeat(4000)), false);
  assert.equal(source.stats().retention.entries, 0);
  assert.equal(source.stats().retention.retainedBytes, 0);
  assert.equal(source.borrowPiSource('replacement'), undefined);
  assert.equal(source.installPiBridge('replacement', old.generation, 1, old.text, 1, ['old']), false);
  source.remove('replacement');
  assert.equal(source.stats().bookkeepingBytes, 128);
  source.dispose();
});

function capturedPiOwner() {
  const source = new SourceController(new Unavailable());
  source.capturePiSource('first', 1, 'first\n', 'bash');
  store(source, 'first', 1, ['first', '']);
  return { weak: new WeakRef(source), capture: source.borrowPiSource('first')! };
}

test('first Pi owner collects with a borrowed primitive capture and a second live owner', { skip: !global.gc }, async () => {
  const { source } = fixture();
  source.capturePiSource('second', 1, 'second', 'bash'); store(source, 'second', 1, ['second']);
  const { weak, capture } = capturedPiOwner();
  let collected = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    global.gc!();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (weak.deref() === undefined) { collected = true; break; }
  }
  assert.equal(collected, true);
  assert.equal(capture.text, 'first\n');
  assert.deepEqual(bridge(source, 'second', 1, 1), { available: true, rows: ['second'] });
});

test('bookkeeping refusal of a changed source revokes the old Pi capture before returning false', () => {
  const { source } = fixture({ maxBookkeepingBytes: 1280 });
  assert.equal(source.capturePiSource('card', 1, 'old'), true);
  const old = source.borrowPiSource('card')!;
  assert.equal(store(source, 'card', 1, ['old']), true);
  assert.equal(source.capturePiSource('card', 2, 'new', 'x'.repeat(128)), false);
  assert.equal(source.borrowPiSource('card'), undefined);
  assert.equal(bridge(source, 'card', 1, 1).available, false);
  assert.equal(source.installPiBridge('card', old.generation, old.version, old.text, 1, ['old']), false);
  assert.equal(source.stats().retention.entries, 0);
  const held = source.stats();
  for (let attempt = 0; attempt < 20; attempt++) assert.equal(source.capturePiSource('card', 2, 'new', 'x'.repeat(128)), false);
  assert.deepEqual(source.stats(), held);
  assert.equal(source.capturePiSource('card', 3, 'new'), true);
  assert.equal(source.borrowPiSource('card')!.text, 'new');
});

test('native projection borrows its current logical snapshot without a second source/bridge allocation', () => {
  const { source, host } = fixture();
  const text = 'é\t😀\n';
  assert.equal(source.observe({ key: 'native', version: 1, text, path: 'a.ts', language: 'typescript',
    profile: 'pi', fingerprint: 'a'.repeat(64), complete: false }), true);
  const before = source.stats(), measure = Buffer.byteLength; let measured = 0;
  Buffer.byteLength = function(value: Parameters<typeof measure>[0], encoding?: Parameters<typeof measure>[1]) {
    if (value === text) measured++;
    return measure(value, encoding);
  };
  try {
    const first = source.borrowSource('native')!;
    assert.equal(first.text, text); assert.equal(first.utf8Bytes, 8);
    assert.equal(first.path, 'a.ts'); assert.equal(first.language, 'typescript');
    for (let visit = 0; visit < 100; visit++) assert.deepEqual(source.borrowSource('native'), first);
    Reflect.set(first, 'text', 'caller mutation');
    assert.equal(source.borrowSource('native')!.text, text);
  } finally { Buffer.byteLength = measure; }
  assert.equal(measured, 0); assert.deepEqual(source.stats(), before);
  assert.equal(source.stats().retention.entries, 1); assert.equal(source.stats().piSourceRecords, 0);
  assert.equal(host.calls, 0);
  source.observe({ key: 'native', version: 2, text, path: 'a.ts', language: 'typescript',
    profile: 'pi', fingerprint: 'a'.repeat(64), complete: true });
  assert.equal(source.borrowSource('native')!.version, 2);
  source.remove('native'); assert.equal(source.borrowSource('native'), undefined);
});

test('Pi bridge readiness is a constant primitive query with version/palette and alias authority', () => {
  const { source } = fixture();
  assert.equal(source.hasPiBridge('a', 1, 1), false);
  assert.ok(source.capturePiSource('a', 1, 'one'));
  const capture = source.borrowPiSource('a')!;
  assert.equal(source.hasPiBridge('a', 1, 1), false);
  assert.ok(source.installPiBridge('a', capture.generation, 1, capture.text, 1, ['one']));
  const before = source.stats();
  const visit = source.visitPiBridge;
  source.visitPiBridge = () => { throw new Error('readiness walked rows'); };
  for (let index = 0; index < 100; index++) assert.equal(source.hasPiBridge('a', 1, 1), true);
  source.visitPiBridge = visit;
  assert.deepEqual(source.stats(), before);
  assert.equal(source.hasPiBridge('a', 2, 1), false);
  assert.equal(source.hasPiBridge('a', 1, 2), false);
  assert.ok(source.capturePiSource('a', 2, 'one'));
  assert.equal(source.hasPiBridge('a', 2, 1), true);
  assert.ok(source.capturePiSource('a', 2, 'one', 'bash'));
  assert.equal(source.hasPiBridge('a', 2, 1), false);
  source.removePiSource('a');
  assert.equal(source.hasPiBridge('a', 2, 1), false);
});


test('canonical Pi classifier failure is exact, aliases equal text, and differs from admission refusal', () => {
  const { source } = fixture(); source.setEnabled(false);
  source.capturePiSource('failure', 1, 'x', 'bash');
  const capture = source.borrowPiSource('failure')!;
  assert.equal(source.piFailure('failure', 1, 1), undefined);
  assert.equal(source.recordPiFailure('failure', capture.generation, 1, 1, 'threw'), true);
  assert.equal(source.piFailure('failure', 1, 1), 'threw');
  assert.equal(source.hasPiBridge('failure', 1, 1), false);
  source.capturePiSource('failure', 2, 'x', 'bash');
  assert.equal(source.piFailure('failure', 2, 1), 'threw');
  assert.equal(source.piFailure('failure', 2, 2), undefined);
  assert.equal(source.recordPiFailure('failure', capture.generation, 1, 2, 'invalid_rows'), false, 'stale version rejected');
  assert.equal(source.recordPiFailure('failure', capture.generation, 2, 2, 'invalid_rows'), true);
  assert.equal(source.piFailure('failure', 2, 2), 'invalid_rows');
  assert.equal(source.recordPiFailure('failure', capture.generation, 2, 1, 'threw'), false, 'reentrant older palette rejected');
  source.capturePiSource('failure', 3, 'y', 'bash');
  assert.equal(source.piFailure('failure', 3, 2), undefined);
  assert.equal(source.recordPiFailure('failure', capture.generation, 3, 2, 'threw'), false, 'old incarnation rejected');
  const changed = source.borrowPiSource('failure')!;
  source.recordPiFailure('failure', changed.generation, 3, 2, 'threw');
  source.capturePiSource('failure', 3, 'y', 'rust');
  assert.equal(source.piFailure('failure', 3, 2), undefined);
  const current = source.borrowPiSource('failure')!;
  source.remove('failure'); source.capturePiSource('failure', 1, 'y', 'rust');
  assert.equal(source.recordPiFailure('failure', current.generation, 1, 2, 'threw'), false);
  assert.equal(source.stats().retention.bridgeBytes, 0, 'failure stores no dummy rows');
  const refused = fixture({ retention: { maxBytes: 1 } }).source;
  assert.equal(refused.capturePiSource('no-room', 1, 'x'), false);
  assert.equal(refused.piFailure('no-room', 1, 2), undefined);
});

test('Pi readiness and visits bypass accounting/source comparisons and retain real LRU behavior', () => {
  const { source } = fixture(); source.capturePiSource('ready', 1, 'x'); store(source, 'ready', 1, ['x']);
  const status = RetentionPool.prototype.status;
  RetentionPool.prototype.status = () => { throw Error('accounting path invoked'); };
  try {
    assert.equal(source.hasPiBridge('ready', 1, 1), true);
    assert.deepEqual(bridge(source, 'ready', 1, 1), { available: true, rows: ['x'] });
  } finally { RetentionPool.prototype.status = status; }
  const pool = new RetentionPool({ maxBytes: 2500 });
  const first = pool.admit('first', 1, 'x').generation!;
  pool.installBridge(first, 1, 'x', ['x']);
  const second = pool.admit('second', 1, 'y').generation!;
  assert.equal(pool.bridgeVersion(first), 1);
  pool.admit('third', 1, 'z');
  assert.ok(pool.status(first)); assert.equal(pool.status(second), undefined);
});


test('reentrant Pi outcomes cannot replace an already-current failure or valid same-palette bridge', () => {
  const { source } = fixture(); source.capturePiSource('reentrant', 1, 'x', 'bash');
  const capture = source.borrowPiSource('reentrant')!;
  assert.equal(source.recordPiFailure('reentrant', capture.generation, 1, 1, 'invalid_rows'), true);
  assert.equal(source.installPiBridge('reentrant', capture.generation, 1, 'x', 1, ['x']), false);
  assert.equal(source.installPiBridge('reentrant', capture.generation, 1, 'x', 2, ['x']), true);
  assert.equal(source.recordPiFailure('reentrant', capture.generation, 1, 2, 'threw'), false);
  assert.equal(source.hasPiBridge('reentrant', 1, 2), true);
  assert.equal(source.recordPiFailure('reentrant', capture.generation, 1, 1, 'threw'), false);
});
