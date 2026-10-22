import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { CARD_ROLES, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { createPiRuleDefinition } from '../../../src/syntax/pi-rules.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { awaitFixture } from '../../fixtures/await-fixture.ts';
const inputs = readInputs(), binary = validateNative(inputs);
const definition = createPiRuleDefinition();
const caller: ConcreteStyle = { foreground: { kind: 'rgb', r: 11, g: 22, b: 33 }, background: { kind: 'rgb', r: 44, g: 55, b: 66 }, attributes: 0 };
function pi(revision: number) {
  return { kind: 'client' as const, definition, bindingRevision: revision, palette: `pi:${revision}`,
    bindings: Array.from({ length: definition.binding_slots }, () => ({ ink: { kind: 'rgb' as const, r: revision, g: 2, b: 3 }, attributes: 0, attribute_mask: 31 })),
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, caller])) as Record<CardRole, ConcreteStyle> };
}
test('actual v3 styles executor: production broker pipe helper SOURCE STYLE rollback bindings and empty native palette', async () => {
  const root = await mkdtemp(join(tmpdir(), 'style-controller-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const drain = () => awaitFixture((async () => {
    for (let i = 0; i < 3 || owner.stats().unsettledJobs || owner.stats().pendingCloses; i++) { owner.flush(); await turn(); }
  })());
  const read = () => { const styles: ConcreteStyle[] = []; owner.displayBasis('bash')?.visit((_text, ranges) => ranges((_from, _to, style) => styles.push(style))); return styles; };
  try {
    await awaitFixture(broker.start()); const [a, b] = broker.snapshot().description!.profiles;
    assert.ok(a && b); owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint });
    const source = { key: 'bash', version: 1, language: 'bash', profile: a.id, fingerprint: a.fingerprint, text: 'echo α\necho t', complete: false };
    owner.observe(source); owner.flush(); await drain(); assert.ok(read().length); const first = read();
    const parsed = broker.stats().sourceDispatches;
    assert.equal(parsed, 1); assert.equal(broker.stats().styleDispatches, 1);
    owner.setStyleSelection({ kind: 'native', id: b.id, fingerprint: b.fingerprint }); await drain();
    assert.equal(broker.stats().sourceDispatches, parsed); assert.equal(broker.stats().styleDispatches, 2);
    owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint }); await drain(); assert.deepEqual(read(), first);
    assert.equal(broker.stats().styleDispatches, 2);
    owner.setStyleSelection(pi(7)); await drain(); assert.ok(read().some(style => style.foreground.kind === 'rgb' && style.foreground.r === 7));
    assert.equal(broker.stats().styleDispatches, 3);
    owner.setStyleSelection(pi(9)); await drain(); assert.ok(read().some(style => style.foreground.kind === 'rgb' && style.foreground.r === 9));
    assert.equal(broker.stats().sourceDispatches, 1); assert.equal(broker.stats().styleDispatches, 3);
    owner.observe({ ...source, version: 2, text: source.text + 'ail\n', complete: true }); owner.flush(); await drain();
    assert.equal(broker.stats().sourceDispatches, 2); assert.equal(owner.stats().committedLineCalls, 2); assert.equal(owner.stats().remoteLeases, 0);
    owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint }); owner.observe({ ...source, key: 'empty', text: '', complete: true }); await drain();
    assert.ok(owner.displayBasis('empty')); assert.equal(owner.status('empty')!.acknowledgedVersion, undefined);
    const before = broker.stats(); for (let i = 0; i < 100; i++) owner.flush(); await drain(); assert.deepEqual(broker.stats(), before);
    console.log(JSON.stringify({ executorNative: { node: process.version, native: binary, source: inputs.source,
      sourceDispatches: before.sourceDispatches, styleDispatches: before.styleDispatches, committedLineCalls: owner.stats().committedLineCalls,
      preparedSourceBytes: owner.stats().preparedBytes, sourceTextBytes: Buffer.byteLength(source.text) + 4,
      styleCaptures: owner.stats().styleCaptures, peakJobs: owner.stats().peakJobs, transientBytes: owner.stats().transientBytes,
      retainedBytes: owner.stats().retention.retainedBytes, firstNativeRanges: first.length } }));
    owner.remove('bash'); owner.remove('empty'); await drain();
    // Trusted desired configuration remains owned until disposal; all source/cache
    // payload and expression associations are released with their actual holders.
    assert.equal(owner.stats().retention.entries, 0); assert.equal(owner.stats().retention.styles, 0);
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0); assert.equal(pipe.stats().retainedBytes, 0);
});

function displayVersions(box: { owner?: WeakRef<SourceController> }, versions: number[]) {
  return () => { const version = box.owner?.deref()?.displayBasis('bash')?.version; if (version !== undefined) versions.push(version); };
}
test('actual v3 styles executor: first native V1 colors survive real parser V2 overtaking the held STYLE reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'style-race-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  let release!: () => void, arrived!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), styleArrived = new Promise<void>(resolve => { arrived = resolve; });
  // Test-only post-transport delivery gate. Both source revisions and the held
  // style body are produced by the real broker/stdio/helper, not fixture ranges.
  const provider = { snapshot: () => broker.snapshot(), isReady: (generation: number) => broker.isReady(generation),
    classificationAccepted: (generation: number) => broker.classificationAccepted(generation),
    request(generation: number, request: Record<string, unknown>, options?: Parameters<ProviderBroker['request']>[2]) {
      const result = broker.request(generation, request, options);
      if (request.op !== 'styles.resolve' || held) return result;
      held = true; return result.then(async value => { arrived(); await gate; return value; });
    } };
  const versions: number[] = [], box: { owner?: WeakRef<SourceController> } = {};
  const owner = new SourceController(provider, { deadlineMs: 5000, onChange: displayVersions(box, versions) });
  box.owner = new WeakRef(owner);
  try {
    await awaitFixture(broker.start()); const theme = broker.snapshot().description!.profiles[0]!;
    owner.setStyleSelection({ kind: 'native', id: theme.id, fingerprint: theme.fingerprint });
    const source = { key: 'bash', version: 1, language: 'bash', profile: theme.id, fingerprint: theme.fingerprint, text: 'echo first\n', complete: false };
    owner.observe(source); owner.flush(); await awaitFixture(styleArrived);
    assert.equal(owner.status('bash')!.acknowledgedVersion, 1); assert.equal(owner.stats().styleCaptures, 1);
    owner.observe({ ...source, version: 2, text: source.text + '# second\n' }); owner.flush();
    await awaitFixture((async () => { while (owner.status('bash')!.acknowledgedVersion !== 2) await turn(); })());
    assert.equal(owner.displayBasis('bash'), undefined); assert.equal(broker.stats().sourceDispatches, 2);
    release();
    await awaitFixture((async () => { while (!versions.includes(1)) await turn(); })());
    assert.ok(versions.includes(1), 'actual publication notice records V1 after parser V2 acknowledgement');
    await awaitFixture((async () => { while (owner.stats().unsettledJobs || owner.displayBasis('bash')?.version !== 2) { owner.flush(); await turn(); } })());
    await awaitFixture((async () => { while (!versions.includes(2)) await turn(); })());
    assert.equal(broker.stats().successfulClassifications, 2);
    assert.equal(owner.stats().styleCaptures, 0); assert.equal(broker.stats().styleDispatches, 2);
    console.log(JSON.stringify({ executorNativeRace: { node: process.version, source: inputs.source, nativeSha256: binary.sha256,
      sourceDispatches: broker.stats().sourceDispatches, styleDispatches: broker.stats().styleDispatches, acceptedSourceVersion: owner.status('bash')!.acknowledgedVersion,
      displayedVersions: versions, styleCaptures: owner.stats().styleCaptures, peakJobs: owner.stats().peakJobs } }));
  } finally { release(); owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().globalTransientBytes, 0); assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(pipe.stats().childState, 'exited');
});

test('actual v3 group palette-only: broker stdio helper empty-context resolution has zero source work and complete cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-palette-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const requests: { op: unknown; contexts: unknown; sourceFields: boolean }[] = [];
  const provider = { snapshot: () => broker.snapshot(), isReady: (generation: number) => broker.isReady(generation),
    classificationAccepted: (generation: number) => broker.classificationAccepted(generation),
    request(generation: number, request: Record<string, unknown>, options?: Parameters<ProviderBroker['request']>[2]) {
      requests.push({ op: request.op, contexts: request.contexts, sourceFields: ['sources', 'key', 'generation', 'source_version', 'text', 'lease'].some(key => key in request) });
      return broker.request(generation, request, options);
    } };
  const owner = new SourceController(provider, { deadlineMs: 5000 });
  const preparation = { keys: new Set<string>(), prepare() {}, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  const drain = () => awaitFixture((async () => {
    for (let i = 0; i < 4 || owner.stats().unsettledJobs; i++) { owner.flush(); await turn(); }
  })());
  try {
    await awaitFixture(broker.start());
    owner.setStyleSelection(pi(7)); owner.queuePreparation(group, true); await drain();
    assert.ok(owner.groupPresentation(group)); assert.equal(requests.length, 0);
    const [a, b] = broker.snapshot().description!.profiles; assert.ok(a && b);
    owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint }); await drain();
    const first = CARD_ROLES.map(role => owner.groupPresentation(group)!.role(role)); assert.ok(first.every(Boolean));
    assert.equal(broker.stats().styleDispatches, 1); assert.equal(broker.stats().sourceDispatches, 0);
    assert.deepEqual(requests, [{ op: 'styles.resolve', contexts: [], sourceFields: false }]);
    owner.setStyleSelection({ kind: 'native', id: b.id, fingerprint: b.fingerprint }); await drain();
    owner.setStyleSelection({ kind: 'native', id: a.id, fingerprint: a.fingerprint }); await drain();
    assert.deepEqual(CARD_ROLES.map(role => owner.groupPresentation(group)!.role(role)), first);
    const before = broker.stats(); for (let i = 0; i < 100; i++) { owner.groupPresentation(group); owner.flush(); } await drain();
    assert.deepEqual(broker.stats(), before); assert.equal(before.styleDispatches, 2); assert.equal(before.successfulClassifications, 0);
    assert.equal(owner.stats().sourceRecords, 0); assert.equal(owner.stats().retention.entries, 0); assert.equal(owner.stats().remoteLeases, 0);
    assert.equal(owner.stats().captures, 0); assert.equal(owner.stats().styleCaptures, 0); assert.equal(owner.stats().preparedBytes, 0);
    console.log(JSON.stringify({ groupPaletteNative: { node: process.version, source: inputs.source, native: binary, requests,
      sourceDispatches: before.sourceDispatches, styleDispatches: before.styleDispatches, classifications: before.successfulClassifications,
      sourceRecords: owner.stats().sourceRecords, sourceBytes: owner.stats().preparedBytes, remoteLeases: owner.stats().remoteLeases,
      roles: first.length, peakJobs: owner.stats().peakJobs, transientBytes: owner.stats().transientBytes } }));
    owner.unregisterPreparation(group); owner.setStyleSelection(undefined); assert.equal(owner.stats().retention.retainedBytes, 0);
  } finally { void preparation; owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0); assert.equal(pipe.stats().retainedBytes, 0);
});

test('actual v3 missing native definition requests catalogue metadata without source work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'missing-native-profile-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const failures: unknown[] = [], notices: { keys: readonly string[]; groups: readonly number[] }[] = [];
  const provider = { snapshot: () => broker.snapshot(), isReady: (generation: number) => broker.isReady(generation),
    classificationAccepted: (generation: number) => broker.classificationAccepted(generation),
    request(generation: number, request: Record<string, unknown>, options?: Parameters<ProviderBroker['request']>[2]) {
      return broker.request(generation, request, options).then(raw => {
        if (request.op === 'styles.resolve' && typeof raw === 'object' && raw !== null && 'status' in raw && raw.status === 'error' && 'error' in raw) failures.push(raw.error);
        return raw;
      });
    } };
  const owner = new SourceController(provider, { deadlineMs: 5000, onChange(keys, groups = []) { notices.push({ keys, groups }); } });
  const preparation = { keys: new Set<string>(), prepare() {}, needsRefresh() { return false; }, requiresCredit() { return false; } };
  const group = owner.registerPreparation(preparation)!;
  const drain = () => awaitFixture((async () => {
    for (let i = 0; i < 4 || owner.stats().unsettledJobs; i++) { owner.flush(); await turn(); }
  })());
  try {
    await awaitFixture(broker.start()); owner.setStyleSelection(pi(7)); owner.queuePreparation(group, true); await drain();
    const original = CARD_ROLES.map(role => owner.groupPresentation(group)!.role(role)); assert.ok(original.every(Boolean));
    const described = broker.snapshot().description!, missing = 'missing-profile-for-test';
    assert.equal(described.profiles.some(profile => profile.id === missing), false); assert.ok(described.profiles[0]);
    notices.length = 0;
    owner.setStyleSelection({ kind: 'native', id: missing, fingerprint: described.profiles[0].fingerprint }); await drain();
    assert.deepEqual(failures, [{ code: 'profile_unavailable', execution: 'not_started' }], 'actual helper, not a synthetic source/profile fault');
    const need = owner.profileReconciliationNeeded(); assert.ok(need, 'real native missing-definition reply must request metadata');
    assert.deepEqual(notices, [{ keys: [], groups: [group.id] }]);
    assert.deepEqual(CARD_ROLES.map(role => owner.groupPresentation(group)!.role(role)), original);
    owner.acknowledgeProfiles(need.generation, need.sequence); notices.length = 0;
    for (let i = 0; i < 100; i++) owner.flush(); await drain();
    assert.equal(broker.stats().sourceDispatches, 0); assert.equal(broker.stats().successfulClassifications, 0);
    assert.equal(broker.stats().styleDispatches, 1); assert.deepEqual(notices, []);
    owner.setStyleSelection(pi(9)); await drain(); assert.ok(owner.groupPresentation(group));
    assert.equal(broker.stats().styleDispatches, 1); assert.equal(owner.stats().remoteLeases, 0); assert.equal(owner.stats().preparedBytes, 0);
    console.log(JSON.stringify({ missingNativeProfile: { node: process.version, source: inputs.source, native: binary,
      failures, sourceDispatches: broker.stats().sourceDispatches, styleDispatches: broker.stats().styleDispatches,
      classifications: broker.stats().successfulClassifications, metadataSequence: need.sequence } }));
  } finally { void preparation; owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0); assert.equal(pipe.stats().retainedBytes, 0);
});

for (const kind of ['pi', 'native'] as const) test(`actual v3 empty Bash: ${kind} local empty paint then SOURCE STYLE append finalization`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-bash-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const revisions: number[] = [], operations: string[] = [];
  const provider = { snapshot: () => broker.snapshot(), isReady: (generation: number) => broker.isReady(generation),
    classificationAccepted: (generation: number) => broker.classificationAccepted(generation),
    async request(generation: number, request: Record<string, unknown>, options?: Parameters<ProviderBroker['request']>[2]) {
      operations.push(String(request.op));
      const reply = await broker.request(generation, request, options) as { body?: { kind?: string; sources?: { revision: number }[] } };
      if (reply.body?.kind === 'source') revisions.push(...reply.body.sources!.map(source => source.revision));
      return reply;
    } };
  const errors: string[] = [];
  const owner = new SourceController(provider, { deadlineMs: 5000, diagnostic(level, _area, _message, fields) {
    if (level === 'ERROR') errors.push(String(fields?.code));
  } });
  const drain = () => awaitFixture((async () => {
    for (let i = 0; i < 3 || owner.stats().unsettledJobs || owner.stats().pendingCloses; i++) { owner.flush(); await turn(); }
  })());
  try {
    await awaitFixture(broker.start()); const theme = broker.snapshot().description!.profiles[0]!;
    owner.setStyleSelection(kind === 'pi' ? pi(7) : { kind: 'native', id: theme.id, fingerprint: theme.fingerprint });
    const source = { key: 'empty-bash', version: 1, language: 'bash', profile: kind === 'pi' ? 'pi' : theme.id,
      fingerprint: kind === 'pi' ? 'b'.repeat(64) : theme.fingerprint, text: '', complete: false };
    owner.observe(source); await drain();
    assert.equal(owner.displayBasis(source.key)?.version, 1); assert.equal(broker.stats().sourceDispatches, 0);
    const first = { ...source, version: 2, text: 'printf "ready"\n' };
    owner.observe(first); await drain();
    assert.equal(owner.status(source.key)!.acknowledgedVersion, 2); assert.equal(owner.status(source.key)!.exact, true);
    assert.equal(owner.displayBasis(source.key)!.version, 2);
    let colored = 0; owner.displayBasis(source.key)!.visit((_text, ranges) => ranges(() => colored++)); assert.ok(colored > 0);
    const next = { ...first, version: 3, text: first.text + 'echo tail' };
    owner.observe(next); await drain(); owner.observe({ ...next, complete: true }); await drain();
    assert.deepEqual(revisions, [1, 2, 3]); assert.deepEqual(operations.filter(op => op !== 'styles.resolve'), ['stream.open', 'stream.append', 'stream.append']);
    assert.equal(owner.status(source.key)!.acknowledgedVersion, 3); assert.equal(owner.status(source.key)!.exact, true);
    assert.equal(owner.stats().remoteLeases, 0); assert.equal(owner.stats().transientBytes, 0);
    const before = broker.stats(); for (let i = 0; i < 20; i++) owner.flush(); await drain(); assert.deepEqual(broker.stats(), before);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ emptyBash: { kind, revisions, operations, colored, nativeSha256: binary.sha256, source: inputs.source } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(pipe.stats().childState, 'exited');
});

test('actual v3 font contract: Markdown strike uses trusted rules, delimiter clears and unchanged native typography', async () => {
  const root = await mkdtemp(join(tmpdir(), 'strike-controller-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio'], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const owner = new SourceController(broker, { deadlineMs: 5000 });
  const text = 'plain ~~strike **bold _italic_** [link](https://x) `code`~~ after\n';
  const drain = () => awaitFixture((async () => {
    for (let i = 0; i < 3 || owner.stats().unsettledJobs; i++) { owner.flush(); await turn(); }
  })());
  const read = () => {
    const cells: { char: string; attributes: number; red: number | null }[] = [];
    owner.displayBasis('md')?.visit((source, ranges) => ranges((from, to, style) => {
      for (const char of source.slice(from, to)) cells.push({ char, attributes: style.attributes,
        red: style.foreground.kind === 'rgb' ? style.foreground.r : null });
    }));
    return cells;
  };
  try {
    await awaitFixture(broker.start()); owner.setStyleSelection(pi(7));
    owner.observe({ key: 'md', version: 1, language: 'markdown', profile: 'pi', fingerprint: 'a'.repeat(64), text, complete: true });
    await drain(); const cells = read(); assert.equal(cells.map(cell => cell.char).join(''), text);
    for (const word of ['strike', 'bold', 'italic', 'link', 'https://x', 'code']) {
      const at = text.indexOf(word), attributes = cells[at]!.attributes;
      assert.equal(attributes & 16, 16, word);
      if (word === 'bold') assert.equal(attributes & 1, 1);
      if (word === 'italic') assert.equal(attributes & 3, 3);
      if (word === 'link' || word === 'https://x') assert.equal(attributes & 4, 4);
    }
    for (const at of [text.indexOf('~~'), text.lastIndexOf('~~')]) {
      assert.equal(cells[at]!.attributes & 16, 0); assert.equal(cells[at + 1]!.attributes & 16, 0);
      assert.equal(cells[at]!.red, 11, 'strike delimiters inherit foreground rather than generic punctuation ink');
    }
    assert.equal(cells[text.indexOf('after')]!.attributes, 0);
    const parsed = broker.stats().sourceDispatches;
    const theme = broker.snapshot().description!.profiles[0]!;
    owner.setStyleSelection({ kind: 'native', id: theme.id, fingerprint: theme.fingerprint }); await drain();
    assert.equal(broker.stats().sourceDispatches, parsed); assert.equal(read().some(cell => (cell.attributes & 16) !== 0), false);
    console.log(JSON.stringify({ fontContract: { sourceDispatches: parsed, styleDispatches: broker.stats().styleDispatches, sourceBytes: text.length, helperSha256: binary.sha256 } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(pipe.stats().childState, 'exited');
});
