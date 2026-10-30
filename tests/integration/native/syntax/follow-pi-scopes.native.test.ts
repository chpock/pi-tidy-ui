import '../../../fixtures/test-guard.mjs';
import { PI_RULE_BINDINGS } from '../../../../src/syntax/pi-adapter.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceController } from '../../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../../src/occipital/stdio.ts';
import { CARD_ROLES, type CardRole } from '../../../../src/occipital/semantic-codec.ts';
import { createSemanticRuleDefinition } from '../../../../src/syntax/semantic-rules.ts';
import { fingerprintRules } from '../../../../src/occipital/style-rules.ts';
import type { ConcreteStyle } from '../../../../src/syntax/style-materialization.ts';
import { readInputs, validateNative } from '../../../../scripts/test/context.mjs';
import { awaitFixture } from '../../../fixtures/await-fixture.ts';

type Check = { text: string; occurrence?: number; binding: string | null; attributes?: number; clear?: number };
type Case = { id: string; language: string; source: string; checks: Check[] };
const inputs = readInputs(), binary = validateNative(inputs);
const corpus: Case[] = JSON.parse(await readFile(new URL('../../../../crates/occipital/tests/fixtures/follow_pi_corpus.json', import.meta.url), 'utf8'));
function contextAt(source: { contexts: number[][]; runs: number[] } | undefined, text: string, offset: number) {
  if (!source) return { id: -1, scopes: [] };
  const byte = Buffer.byteLength(text.slice(0, offset), 'utf8');
  let end = 0;
  for (let i = 0; i < source.runs.length; i += 2) {
    end += source.runs[i]!;
    if (byte < end) {
      const id = source.runs[i + 1]!;
      if (id === 0) return { id, scopes: [] };
      let scopes: number[] = [];
      for (let row = 0; row < id; row++) {
        const packed = source.contexts[row]!;
        scopes = [...scopes.slice(0, packed[0]!), ...packed.slice(1)];
      }
      return { id, scopes };
    }
  }
  return { id: -2, scopes: [] };
}

test('Follow Pi actual pinned grammar: focused bindings, nested fonts and nonvacuous negative control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-scope-regression-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio'], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const errors: string[] = [], wireErrors: string[] = [], sourceReplies = new Map<string, { contexts: number[][]; runs: number[] }>();
  const sourceByCase = new Map<string, { contexts: number[][]; runs: number[] }>();
  let latestSource: { contexts: number[][]; runs: number[] } | undefined;
  const request = pipe.request.bind(pipe);
  pipe.request = (frame, options) => request(frame, options).then(reply => {
    if (frame.op === 'styles.resolve' && reply && typeof reply === 'object' && 'status' in reply && reply.status === 'error'
      && 'error' in reply && reply.error && typeof reply.error === 'object' && 'code' in reply.error)
      wireErrors.push(String(reply.error.code));
    const envelope = reply as { body?: { sources?: { key: string; contexts: number[][]; runs: number[] }[] } } | undefined;
    const sources = envelope?.body?.sources;
    for (const source of sources ?? []) {
      latestSource = { contexts: source.contexts, runs: source.runs };
      sourceReplies.set(source.key, latestSource);
    }
    return reply;
  });
  const owner = new SourceController(broker, { deadlineMs: 5000, diagnostic(level, _area, _message, fields) {
    if (level === 'ERROR') errors.push(String(fields?.code));
  } });
  const definition = createSemanticRuleDefinition();
  const caller: ConcreteStyle = { foreground: { kind: 'rgb', r: 250, g: 0, b: 0 }, background: { kind: 'rgb', r: 1, g: 1, b: 1 }, attributes: 0 };
  const selection = { definition, bindingRevision: 1, palette: 'pi:1',
    bindings: PI_RULE_BINDINGS.map((_, slot) => ({ ink: { kind: 'rgb' as const, r: slot + 1, g: 0, b: 0 }, attributes: 0, attribute_mask: 31 })),
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, caller])) as Record<CardRole, ConcreteStyle> };
  const flushAndSettle = async () => {
    owner.flush();
    assert.equal(await awaitFixture(owner.whenSettled()), true, 'source producer settled without cancellation');
  };
  const mismatches: { case: string; text: string; occurrence: number; expected: string | null; actual: string | number; fonts: number; context?: { id: number; scopes: number[] } }[] = [];
  let checked = 0, sourceDispatches = 0, styleDispatches = 0;
  const read = (key: string) => {
    const values: { red: number; attributes: number }[] = [];
    const basis = owner.displayBasis(key); assert.ok(basis, `ready ${key}: ${JSON.stringify({ work: owner.workStatus(key), controller: owner.stats(), broker: broker.stats(), errors, wireErrors })}`);
    basis.visit((_source, ranges) => ranges((from, to, style) => {
      assert.equal(style.foreground.kind, 'rgb');
      for (let i = from; i < to; i++) values[i] = { red: style.foreground.kind === 'rgb' ? style.foreground.r : -1, attributes: style.attributes };
    }));
    return values;
  };
  try {
    await awaitFixture(broker.start()); assert.equal(owner.setStyleSelection(selection), true);
    await flushAndSettle();
    for (const item of corpus) {
      assert.equal(owner.observe({ key: item.id, version: 1, language: item.language, text: item.source, complete: true }), true, `accepted ${item.id}`);
      await flushAndSettle();
      if (latestSource) sourceByCase.set(item.id, latestSource);
      const values = read(item.id);
      assert.equal(values.length, item.source.length, item.id);
      for (const check of item.checks) {
        let at = -1;
        for (let occurrence = 0; occurrence < (check.occurrence ?? 1); occurrence++) {
          at = item.source.indexOf(check.text, at < 0 ? 0 : at + check.text.length);
          assert.ok(at >= 0, `fixture checkpoint exists: ${item.id} ${check.text} #${occurrence + 1}`);
        }
        const expected = check.binding === null ? 250 : PI_RULE_BINDINGS.indexOf(check.binding as typeof PI_RULE_BINDINGS[number]) + 1;
        assert.ok(expected > 0, `declared expected binding ${check.binding}`);
        for (let i = at; i < at + check.text.length; i++) {
          const value = values[i]!;
          if (value.red !== expected || check.attributes !== undefined && (value.attributes & check.attributes) !== check.attributes
            || check.clear !== undefined && (value.attributes & check.clear) !== 0) {
            mismatches.push({ case: item.id, text: check.text, occurrence: check.occurrence ?? 1, expected: check.binding,
              actual: PI_RULE_BINDINGS[value.red - 1] ?? value.red, fonts: value.attributes,
              context: contextAt(sourceByCase.get(item.id), item.source, at) });
            break;
          }
        }
        checked++;
      }
    }
    const before = broker.stats();
    sourceDispatches = before.sourceDispatches;
    styleDispatches = before.styleDispatches;
    const bad = structuredClone(definition);
    bad.rules = bad.rules.filter(rule => !rule.path.includes('variable.function.shell'));
    const badFingerprint = fingerprintRules(bad);
    assert.equal(owner.setStyleSelection({ ...selection, definition: bad }), true);
    await flushAndSettle();
    assert.equal(owner.displayBasis('bash')?.rules, badFingerprint, 'replacement rules reached the current display');
    const bash = corpus.find(item => item.id === 'bash')!, at = bash.source.indexOf('my_command');
    assert.notEqual(read('bash')[at]!.red, PI_RULE_BINDINGS.indexOf('syntax-command') + 1, 'negative broad-variable mapping must fail command identity');
    assert.equal(broker.stats().sourceDispatches, before.sourceDispatches, 'bad rules never replay source');
    assert.deepEqual(errors, []);
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0);
  console.log(JSON.stringify({ followPiRegressions: { cases: corpus.length, checked, mismatches: mismatches.length, negativeControl: true,
    sourceDispatches, styleDispatches, wireErrors, nativeSha256: binary.sha256 } }));
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
});
