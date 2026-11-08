import '../../fixtures/test-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { adapters } from '../../../scripts/highlight-compare/adapters/index.mjs';
import { parseOptions } from '../../../scripts/highlight-compare/run.mjs';

const base = ['--inputs', resolve('comparison-inputs.json'), '--output', resolve('comparison-output')];
const collect = ['collect', ...base, '--fixture', 'python-3.14', '--theme', 'github', '--variant', 'dark'];

test('comparison CLI and collector share one lazy reference registry', () => {
  let loads = 0;
  adapters['test-reference'] = { load: () => { loads++; throw new Error('must remain lazy'); }, collect: 'collect', prepare: 'prepare' };
  try {
    const selected = parseOptions([...collect, '--adapter', 'test-reference']);
    assert.equal(selected.adapter, 'test-reference'); assert.equal(selected.fixture, 'python-3.14');
    assert.equal(parseOptions(['prepare', ...base, '--adapter', 'test-reference', '--theme', 'github', '--variant', 'dark']).command, 'prepare');
    assert.equal(loads, 0, 'parsing does not launch/import application code outside the guarded process');
  } finally { delete adapters['test-reference']; }
});

test('comparison CLI rejects unknown sources, unbounded dimensions and implicit output paths', () => {
  assert.throws(() => parseOptions([...collect, '--adapter', 'unknown']), /registered/);
  assert.throws(() => parseOptions([...collect, '--adapter', 'pi-tidy-ui', '--columns', '241']), /dimensions/);
  assert.throws(() => parseOptions(['fixtures', '--inputs', 'relative', '--output', resolve('output')]), /absolute/);
  assert.throws(() => parseOptions(['compare', ...base, '--left', 'relative', '--right', resolve('capture.json')]), /absolute/);
  assert.throws(() => parseOptions(['prepare', ...base, '--adapter', 'pi-tidy-ui']), /prepared input graph/);
  assert.throws(() => parseOptions([...collect, '--adapter', 'pi-tidy-ui', '--variant', 'unsupported']), /variant/);
});

test('reference preparation requires an explicit requested theme and variant', () => {
  const prepare = ['prepare', ...base, '--adapter', 'opencode'];
  assert.throws(() => parseOptions(prepare), /theme.*variant/i);
  assert.throws(() => parseOptions([...prepare, '--theme', 'github']), /theme.*variant/i);
  assert.throws(() => parseOptions([...prepare, '--theme', 'github', '--variant', 'auto']), /theme.*variant/i);
  const selected = parseOptions([...prepare, '--theme', 'one-dark', '--variant', 'light']);
  assert.equal(selected.theme, 'one-dark');
  assert.equal(selected.variant, 'light');
});
