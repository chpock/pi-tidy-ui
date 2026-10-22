import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as turn } from 'node:timers/promises';
import { SourceController } from '../../../src/occipital/controller.ts';
import { ProviderBroker } from '../../../src/occipital/provider.ts';
import { StdioTransport } from '../../../src/occipital/stdio.ts';
import { CARD_ROLES, type CardRole } from '../../../src/occipital/semantic-codec.ts';
import { createPiRuleDefinition, PI_RULE_BINDINGS } from '../../../src/syntax/pi-rules.ts';
import { fingerprintRules } from '../../../src/occipital/style-rules.ts';
import type { ConcreteStyle } from '../../../src/syntax/style-materialization.ts';
import { readInputs, validateNative } from '../../../scripts/test/context.mjs';
import { awaitFixture } from '../../fixtures/await-fixture.ts';

type Check = { text: string; occurrence?: number; binding: string | null; attributes?: number; clear?: number };
type Case = { id: string; language: string; source: string; checks: Check[] };
const inputs = readInputs(), binary = validateNative(inputs);
const corpus: Case[] = JSON.parse(await readFile(new URL('../../../crates/occipital/tests/fixtures/follow_pi_corpus.json', import.meta.url), 'utf8'));

test('Follow Pi actual pinned grammar: independent semantic inventory, nested fonts and nonvacuous negative control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-scope-inventory-'));
  const pipe = new StdioTransport({ command: binary.path, args: ['--stdio', '--config', join(root, 'config.json')], cwd: root,
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root, XDG_RUNTIME_DIR: root }, requestDeadlineMs: 5000, terminateGraceMs: 100 });
  const broker = new ProviderBroker({ async tryShared() { return undefined; }, async acquireOwned() { return pipe; } });
  const errors: string[] = [];
  const owner = new SourceController(broker, { deadlineMs: 5000, diagnostic(level, _area, _message, fields) {
    if (level === 'ERROR') errors.push(String(fields?.code));
  } });
  const definition = createPiRuleDefinition();
  const caller: ConcreteStyle = { foreground: { kind: 'rgb', r: 250, g: 0, b: 0 }, background: { kind: 'rgb', r: 1, g: 1, b: 1 }, attributes: 0 };
  const selection = { kind: 'client' as const, definition, bindingRevision: 1, palette: 'pi:1',
    bindings: PI_RULE_BINDINGS.map((_, slot) => ({ ink: { kind: 'rgb' as const, r: slot + 1, g: 0, b: 0 }, attributes: 0, attribute_mask: 31 })),
    roles: Object.fromEntries(CARD_ROLES.map(role => [role, caller])) as Record<CardRole, ConcreteStyle> };
  const drain = async (ready?: () => boolean) => {
    let active = true;
    try {
      await awaitFixture((async () => {
        for (let i = 0; active && (i < 4 || owner.stats().unsettledJobs || ready && !ready()); i++) { owner.flush(); await turn(); }
      })());
    } finally { active = false; }
  };
  const read = (key: string) => {
    const values: { red: number; attributes: number }[] = [];
    const basis = owner.displayBasis(key); assert.ok(basis, `ready ${key}`);
    basis.visit((_source, ranges) => ranges((from, to, style) => {
      assert.equal(style.foreground.kind, 'rgb');
      for (let i = from; i < to; i++) values[i] = { red: style.foreground.kind === 'rgb' ? style.foreground.r : -1, attributes: style.attributes };
    }));
    return values;
  };
  try {
    await awaitFixture(broker.start()); assert.equal(owner.setStyleSelection(selection), true);
    const mismatches: { case: string; text: string; expected: string | null; actual: string | number; fonts: number }[] = [];
    let checked = 0;
    for (const item of corpus) {
      owner.observe({ key: item.id, version: 1, language: item.language, profile: 'pi', fingerprint: 'a'.repeat(64), text: item.source, complete: true });
      await drain(); const values = read(item.id);
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
            mismatches.push({ case: item.id, text: check.text, expected: check.binding,
              actual: PI_RULE_BINDINGS[value.red - 1] ?? value.red, fonts: value.attributes });
            break;
          }
        }
        checked++;
      }
    }
    assert.deepEqual(errors, []);
    assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
    const before = broker.stats();
    const bad = structuredClone(definition);
    bad.rules = bad.rules.filter(rule => !rule.path.includes('variable.function.shell'));
    const badFingerprint = fingerprintRules(bad);
    assert.equal(owner.setStyleSelection({ ...selection, definition: bad }), true);
    await drain(() => owner.displayBasis('bash')?.fingerprint === badFingerprint);
    const bash = corpus.find(item => item.id === 'bash')!, at = bash.source.indexOf('my_command');
    assert.notEqual(read('bash')[at]!.red, PI_RULE_BINDINGS.indexOf('syntaxFunction') + 1, 'negative broad-variable mapping must fail command identity');
    assert.equal(broker.stats().sourceDispatches, before.sourceDispatches, 'bad rules never replay source');
    console.log(JSON.stringify({ followPiInventory: { cases: corpus.length, checked, mismatches: 0, negativeControl: true,
      sourceDispatches: before.sourceDispatches, styleDispatches: before.styleDispatches, nativeSha256: binary.sha256 } }));
  } finally { owner.dispose(); await awaitFixture(broker.dispose()); await rm(root, { recursive: true, force: true }); }
  assert.equal(owner.stats().retention.retainedBytes, 0); assert.equal(owner.stats().globalTransientBytes, 0);
  assert.equal(pipe.stats().childState, 'exited'); assert.equal(pipe.stats().ownedListeners, 0);
});
