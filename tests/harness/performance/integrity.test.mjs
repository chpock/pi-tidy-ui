import '../../fixtures/test-guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { history } from '../../../scripts/test/performance/workloads.mjs';
import { verifyPerformanceTools } from '../../fixtures/performance-integrity.mjs';

function fixture() {
  const expected = history({ cards: 4 }).tools;
  const nodes = expected.map((item, index) => ({ toolCallId: item.id, args: item.args, result: structuredClone(item.result),
    render: () => [index === 0 ? 'PERF_0 output_0_0' : index === 3 ? 'Read body 3 perf-3.txt' : `const value_${index} = 1; perf-${index}.js`] }));
  return { expected, nodes };
}
test('performance integrity: exact restored data and bounded representative bodies are independently required', () => {
  const f = fixture(); assert.equal(verifyPerformanceTools(f.nodes, f.expected, 100, 'on').samples.length, 4);
  f.nodes[0].render = () => ['PERF_0'];
  assert.throws(() => verifyPerformanceTools(f.nodes, f.expected, 100, 'on'), /actually rendered/);
});
test('performance integrity: unchanged arguments cannot mask corrupted output/details or missing tools', () => {
  const f = fixture(); f.nodes[2].result.details = {};
  assert.throws(() => verifyPerformanceTools(f.nodes, f.expected, 100, 'on'), /details/);
  f.nodes[2].result = structuredClone(f.expected[2].result); f.nodes[0].result.content[0].text = 'wrong';
  assert.throws(() => verifyPerformanceTools(f.nodes, f.expected, 100, 'on'), /content/);
  f.nodes.pop(); assert.throws(() => verifyPerformanceTools(f.nodes, f.expected, 100, 'on'), /every synthetic/);
});

test('performance integrity: real native Bash uses tail preview, not the extension prefix preview', () => {
  const f = fixture(); f.nodes[0].render = () => ['PERF_0 output_0_15'];
  assert.equal(verifyPerformanceTools(f.nodes, f.expected, 100, 'native', 'cli').tools, 4);
  assert.throws(() => verifyPerformanceTools(f.nodes, f.expected, 100, 'on', 'cli'), /actually rendered/);
});
