import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticRetentionPool } from '../../../src/occipital/semantic-retention.ts';
import { SemanticRanges } from '../../../src/occipital/semantic-ranges.ts';
import type { SemanticChunk } from '../../../src/occipital/semantic-source.ts';
import { installProjection, visitProjection } from '../../fixtures/pi-projection.ts';

function chunk(key: string, generation: number, text: string, version = 1, revision = 1, replace_from = 0): SemanticChunk {
  return { vocabulary: 'a'.repeat(64), key, generation, source_version: version, revision, source_bytes: Buffer.byteLength(text), replace_from,
    committed_bytes: Buffer.byteLength(text), complete: true, contexts: [Uint32Array.of(1)], runs: text.length ? Uint32Array.of(Buffer.byteLength(text), 1) : new Uint32Array(),
    counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 } };
}

test('retention: ordinary small sources remain retained beyond the old 256-entry ceiling', () => {
  const pool = new SemanticRetentionPool(), generations: number[] = [];
  try {
    for (let i = 0; i < 257; i++) {
      const admitted = pool.admit(`s${i}`, 1, 'x'); assert.equal(admitted.accepted, true); assert.deepEqual(admitted.released, []); generations.push(admitted.generation!);
    }
    for (let pass = 0; pass < 3; pass++) for (const generation of generations) assert.equal(pool.borrowSnapshot(generation)!.text, 'x');
    assert.equal(pool.stats().entries, 257); assert.equal(pool.stats().lastGeneration, 257);
  } finally { pool.dispose(); }
  assert.equal(pool.stats().retainedBytes, 0);
});

test('default retained policy admits a source just beyond the old snapshot ceiling', () => {
  const pool = new SemanticRetentionPool(), text = 'a'.repeat((1 << 20) + 1);
  try {
    const admitted = pool.admit('ordinary', 1, text); assert.equal(admitted.accepted, true); assert.deepEqual(admitted.released, []);
    for (let i = 0; i < 3; i++) assert.equal(pool.borrowSnapshot(admitted.generation!)!.text, text);
    assert.ok(pool.stats().retainedBytes < 4 << 20);
  } finally { pool.dispose(); }
  assert.equal(pool.stats().retainedBytes, 0);
});

test('retention: ordinary short-line bridge is admitted by bytes beyond the old row ceiling', () => {
  const pool = new SemanticRetentionPool(), text = '\n'.repeat(65536), lines = Array<string>(65537).fill('');
  const generation = pool.admit('rows', 1, text).generation!;
  try {
    assert.equal(installProjection(pool, generation, 1, text, lines).accepted, true);
    let visits = 0; assert.equal(visitProjection(pool, generation, (from, to) => { visits++; assert.equal(from, 0); assert.equal(to, 65536); }), true);
    assert.equal(visits, 1, 'flat adapter coalesces equal newline styles without a row-count limit');
  } finally { pool.dispose(); }
  assert.equal(pool.stats().retainedBytes, 0);
});

test('retention I2: append UTF8 measurements count only suffixes and unchanged text does no repeat work', () => {
  const pool = new SemanticRetentionPool(), original = Buffer.byteLength, texts: string[] = [];
  Buffer.byteLength = new Proxy(original, { apply(target, receiver, args) { if (typeof args[0] === 'string') texts.push(args[0]); return Reflect.apply(target, receiver, args); } });
  try {
    const generation = pool.admit('a', 0, 'a').generation!;
    for (let i = 2; i <= 100; i++) pool.replaceSnapshot(generation, i - 1, 'a'.repeat(i));
    const before = texts.length;
    pool.replaceSnapshot(generation, 100, 'a'.repeat(100));
    for (let i = 0; i < 4; i++) assert.equal(pool.borrowSnapshot(generation)!.utf8Bytes, 100);
    assert.equal(texts.length, before); assert.deepEqual(texts, Array<string>(100).fill('a'));
  } finally { Buffer.byteLength = original; pool.dispose(); }
});

test('retention I1: stale, wrong, nonprefix and future captures refuse without changes', () => {
  const pool = new SemanticRetentionPool(), generation = pool.admit('a', 1, 'a').generation!;
  pool.replaceSnapshot(generation, 3, 'abc'); const reply = chunk('a', generation, 'ab', 2), before = pool.stats();
  try {
    for (const capture of [{ version: 0, text: 'ab' }, { version: 3, text: 'ab' }, { version: 2, text: 'az' }, { version: 2, text: 'z' }, { version: 2, text: 'abcd' }, { version: -1, text: 'ab' }, { version: 1.5, text: 'ab' }]) {
      assert.equal(pool.installChunk(generation, reply, capture).accepted, false); assert.deepEqual(pool.stats(), before);
    }
    assert.equal(pool.installChunk(generation, reply, { version: 2, text: 'ab' }).accepted, true);
    assert.equal(pool.borrowSnapshot(generation, 'basis')!.text, 'ab'); assert.equal(pool.borrowSnapshot(generation)!.text, 'abc');
  } finally { pool.dispose(); }
});

test('retention: maintained byte total stays exact across mutation, replacement and release', () => {
  const pool = new SemanticRetentionPool(), generations: number[] = [];
  const verify = () => {
    let snapshots = 0, ranges = 0, bridges = 0, entries = 0;
    for (const generation of generations) { const status = pool.status(generation); if (status) { snapshots += status.snapshotBytes; ranges += status.rangeBytes; bridges += status.bridgeBytes; entries++; } }
    assert.equal(pool.stats().snapshotBytes, snapshots); assert.equal(pool.stats().rangeBytes, ranges); assert.equal(pool.stats().bridgeBytes, bridges); assert.equal(pool.stats().entries, entries);
  };
  const a = pool.admit('a', 1, 'a\n').generation!; generations.push(a); verify();
  pool.installChunk(a, chunk('a', a, 'a\n')); verify();
  assert.equal(installProjection(pool, a, 1, 'a\n').accepted, true); verify();
  pool.replaceSnapshot(a, 2, 'a\nx'); verify();
  const b = pool.admit('b', 1, 'x'.repeat(1000)).generation!; generations.push(b); verify();
  const replaced = pool.admit('b', 2, 'short'); generations.push(replaced.generation!);
  assert.deepEqual(replaced.released.map(value => [value.generation, value.reason]), [[b, 'replaced']]); verify();
  pool.remove(a); verify(); pool.clear(); verify(); assert.equal(pool.stats().retainedBytes, 0);
});

test('retention: lower-only byte limits, bounded keys and UTF16 snapshot costs remain explicit', () => {
  for (const maxBytes of [0, 1.5, (1 << 30) + 1]) assert.throws(() => new SemanticRetentionPool({ maxBytes }));
  const pool = new SemanticRetentionPool();
  try {
    assert.throws(() => pool.admit('x'.repeat(65), 1, ''));
    const generation = pool.admit('a', 1, '').generation!, empty = pool.status(generation)!.snapshotBytes;
    pool.replaceSnapshot(generation, 2, '😀');
    assert.ok(pool.status(generation)!.snapshotBytes > empty + 4, 'new text and its snapshot metadata are both charged');
    const before = pool.stats(); pool.replaceSnapshot(generation, 3, '😀'); assert.deepEqual(pool.stats(), before, 'equal text reuses the holder');
  } finally { pool.dispose(); }
});

test('retention I2: UTF8 split surrogate join, multibyte suffix, isolated surrogates and rewrites stay exact', () => {
  const cases = [
    { texts: ['é', 'é漢', 'é漢😀'], measured: ['é', '漢', '😀'] },
    { texts: ['x\ud83d', 'x😀', 'x😀z'], measured: ['x\ud83d', '😀', 'z'] },
    { texts: ['\ud83d', '\ud83d\ud83d', '\ud83d😀'], measured: ['\ud83d', '\ud83d', '😀'] },
    { texts: ['\ud83d', '\ud83dx', '\ud83dx\udc00'], measured: ['\ud83d', 'x', '\udc00'] },
    { texts: ['ab', 'z', 'zz', 'zz'], measured: ['ab', 'z', 'z', undefined] },
    { texts: ['😀x', '😀'], measured: ['😀x', '😀'] },
    { texts: ['', 'a', 'a', 'ab'], measured: ['', 'a', undefined, 'b'] },
  ];
  const original = Buffer.byteLength;
  for (const [caseIndex, { texts, measured }] of cases.entries()) for (let last = 0; last < texts.length; last++) {
    const pool = new SemanticRetentionPool(), observed: string[] = [], accepted: boolean[] = [];
    // Full-prefix oracle and all assertions stay outside measurement interception.
    const expectedBytes = original(texts[last]!), expectedMeasures = measured.slice(0, last + 1).filter(text => text !== undefined);
    let generation: number, snapshot: ReturnType<SemanticRetentionPool['borrowSnapshot']>;
    try {
      Buffer.byteLength = new Proxy(original, { apply(target, receiver, args) {
        if (typeof args[0] === 'string') observed.push(args[0]);
        return Reflect.apply(target, receiver, args);
      } });
      try {
        const admitted = pool.admit('a', 0, texts[0]!); generation = admitted.generation!; accepted.push(admitted.accepted);
        for (let i = 1; i <= last; i++) accepted.push(pool.replaceSnapshot(generation, i, texts[i]!).accepted);
        snapshot = pool.borrowSnapshot(generation);
      } finally { Buffer.byteLength = original; }
      assert.deepEqual(accepted, Array<boolean>(last + 1).fill(true));
      assert.deepEqual(observed, expectedMeasures, `case ${caseIndex}, prefix ${last}: measure only explicit new suffixes`);
      assert.ok(snapshot); assert.equal(snapshot.text, texts[last]); assert.equal(snapshot.utf8Bytes, expectedBytes);
      const changed = { ...snapshot, text: 'tampered', utf8Bytes: 0 }; assert.notDeepEqual(pool.borrowSnapshot(generation), changed);
      console.log(JSON.stringify({ unicodeSnapshot: { caseIndex, last, texts: texts.slice(0, last + 1), expectedMeasures,
        measured: observed, expectedBytes, actualBytes: snapshot.utf8Bytes } }));
      pool.remove(generation); assert.equal(pool.borrowSnapshot(generation), undefined);
    } finally { pool.dispose(); }
  }
});

test('retention: unrelated admission does not rescan all existing range accounts', () => {
  const pool = new SemanticRetentionPool();
  for (let i = 0; i < 6; i++) {
    const key = `r${i}`, generation = pool.admit(key, 1, 'x').generation!;
    assert.equal(pool.installChunk(generation, chunk(key, generation, 'x')).accepted, true);
  }
  const stats = SemanticRanges.prototype.stats;
  let visits = 0;
  SemanticRanges.prototype.stats = function () { visits++; return stats.call(this); };
  try {
    assert.equal(pool.admit('unrelated', 1, 'x').accepted, true);
    assert.equal(visits, 0, 'unrelated admission uses maintained totals, never existing range accounts');
  } finally { SemanticRanges.prototype.stats = stats; pool.dispose(); }
  assert.equal(pool.stats().retainedBytes, 0);
});
