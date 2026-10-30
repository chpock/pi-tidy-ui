// Fixed-pass SDK measurements are deliberately distinct from actual Pi frame trials.
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { Container, ScrollView, Markdown, Loader, Text } from '@earendil-works/pi-tui';
import { ToolExecutionComponent, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { renderLayoutFrame } from '../../node_modules/@earendil-works/pi-tui/dist/layout.js';
import { UserMessageComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js';
import { initTheme, theme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { verifyPerformanceTools } from './performance-integrity.mjs';
import { preparedCardReady, waitForPerformanceReady } from './performance-readiness.mjs';
import { beginPhase, endPhase, afterGC, capabilities, startAllocationProfile, stopAllocationProfile, summarizeAllocationProfile } from '../../scripts/test/performance/metrics.mjs';
import { history, workload } from '../../scripts/test/performance/workloads.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const config = JSON.parse(readFileSync(process.env.TIDY_TEST_PERF_CONFIG, 'utf8'));
const scenario = workload(config.scenario.id, config.scenario.variant, config.scenario.parameters), p = scenario.parameters;
if (scenario.hash !== config.scenario.hash || scenario.driver !== 'sdk') throw new Error('Invalid SDK performance workload');
const data = history(p), componentInputs = structuredClone(data.tools), toolResults = new Map(data.messages.filter(message => message.role === 'toolResult')
  .map(message => [message.toolCallId, structuredClone(message)])), phases = [], lifecycle = [];
let expectedAfter = data.tools;
let controller, root, viewport, contentRoot, queueHost, tools = [], width = p.width, height = p.height, draws = 0, renderedRows = 0, allocationProfile = null, integrity;
initTheme('dark', false);
const install = scenario.variant === 'native' ? undefined : (await import('../../src/index.ts')).installTidyUi;
const QueueMode = scenario.id === 'queued' ? (await import('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js')).InteractiveMode : undefined;
let preparedSources, restorePreparation = () => {};
if (scenario.variant === 'on') {
  const { CardSources } = await import('../../src/syntax/cards.ts');
  const original = CardSources.prototype.prepare;
  CardSources.prototype.prepare = function (...args) {
    if (preparedSources?.deref() !== this) preparedSources = new WeakRef(this);
    return Reflect.apply(original, this, args);
  };
  restorePreparation = () => { CardSources.prototype.prepare = original; };
}
function historyReady() {
  const consumer = preparedSources?.deref(), states = consumer && Reflect.get(consumer, 'states');
  if (!states) return false;
  assert.ok(states instanceof WeakMap, 'SDK private prepared-source observation contract');
  return tools.every((tool, index) => data.tools[index % data.tools.length].name === 'read' || preparedCardReady(consumer, tool));
}
async function ready() {
  if (scenario.variant !== 'on') return;
  const prepared = await waitForPerformanceReady({ frame: async () => { draw(); await tick(); }, check: historyReady,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs: 20_000 });
  if (!prepared) throw new Error('SDK source preparation did not become ready');
}
let requests = 0;
class Root extends Container { terminal = { rows: p.height }; requestRender() { requests++; } }
const snapshot = () => ({ draws, renderedRows, requests, ...(controller?.cacheStats() ?? {}) });
function counters(before, after) {
  return Object.fromEntries(['draws', 'renderedRows', 'requests', 'hits', 'misses', 'builds', 'collected'].filter(key => typeof after[key] === 'number' && typeof before[key] === 'number').map(key => [key, after[key] - before[key]]));
}
function draw() { const rows = renderLayoutFrame(viewport, width, height, () => {}).lines; draws++; renderedRows += rows.length; return rows.length; }
function add(index) {
  const item = componentInputs[index % componentInputs.length];
  contentRoot.addChild(new UserMessageComponent(data.messages[(index % data.tools.length) * 3].content[0].text));
  contentRoot.addChild(new Markdown(`Result ${index}: **stable** body.`, 0, 0, getMarkdownTheme()));
  const tool = new ToolExecutionComponent(item.name, item.id, item.args, undefined, undefined, root, process.cwd());
  const result = toolResults.get(item.id);
    assert.equal(result?.role, 'toolResult', 'SDK components receive their completed transcript result');
    tool.updateResult(result); contentRoot.addChild(tool); tools.push(tool);
}
async function phase(id, operations, action, strictWarm = false) {
  const before = snapshot(), token = beginPhase({ gcProfile: config.gcProfile === true });
  let ended = false, result;
  try { await action(); ended = true; result = endPhase(token, { operations }); }
  finally { if (!ended) endPhase(token, { operations: 0 }); }
  result.counts = counters(before, snapshot());
  phases.push({ id, ...result });
  if (strictWarm) assert.equal(result.counts.builds ?? 0, 0, 'ready SDK pass cannot rebuild product layouts');
}
try {
  await phase('cold-build-layout', 1, async () => {
    root = new Root(); contentRoot = root;
    if (scenario.id === 'queued') {
      assert.equal(typeof QueueMode.prototype.updatePendingMessagesDisplay, 'function', 'selected host native queue construction contract');
      const slots = Array.from({ length: 7 }, () => new Container()); for (const slot of slots) root.addChild(slot); contentRoot = slots[0];
      queueHost = Object.assign(Object.create(QueueMode.prototype, { session: { value: { getSteeringMessages: () => [], getFollowUpMessages: () => [] } } }), {
        pendingMessagesContainer: slots[1], compactionQueuedMessages: [], getAppKeyDisplay: () => 'Alt+Up', ui: root });
      queueHost.updatePendingMessagesDisplay();
    }
    viewport = new ScrollView(root, { primary: true, follow: 'none', scrollbar: 'hidden' });
    if (install) { controller = install(root, () => theme); if (scenario.variant === 'off') controller.restore(); }
    for (let index = 0; index < p.cards; index++) add(index);
    assert.equal(tools.length, p.cards); assert.ok(draw() > 0);
  });
  await phase('prepare-to-ready', 1, ready);
  integrity = verifyPerformanceTools(tools, data.tools, p.width, scenario.variant);
  await phase('warmup', p.warmup, async () => { for (let i = 0; i < p.warmup; i++) { draw(); await tick(); } });
  await phase('noop-envelope', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) await tick(); });
  const sampling = config.allocationProfile ? startAllocationProfile() : undefined;
  try { await phase('warm-layout', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true); }
  finally { if (sampling) {
    const sampled = stopAllocationProfile(sampling); allocationProfile = { method: sampled.method, estimate: true, options: sampled.options, summary: summarizeAllocationProfile(sampled.profile) };
    writeFileSync(process.env.TIDY_TEST_PERF_PROFILE, JSON.stringify(sampled.profile));
  } }
  if (scenario.id === 'activity') {
    const loader = new Loader(root, value => theme.fg('accent', value), value => theme.fg('muted', value), 'performance activity', { frames: ['·', '•'], intervalMs: 20 });
    contentRoot.addChild(loader);
    try {
      await phase('active-native-indicator', 1, async () => { await new Promise(resolve => setTimeout(resolve, p.idleMs)); draw(); });
      assert.ok(phases.at(-1).counts.requests > 0, 'actual Loader timer schedules native requests');
      await phase('active-indicator-render-passes', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); });
    } finally { loader.stop(); contentRoot.removeChild(loader); }
    await phase('stopped-indicator', 1, async () => { await new Promise(resolve => setTimeout(resolve, 50)); draw(); }, true);
    assert.equal(phases.at(-1).counts.requests, 0, 'indicator stop releases its timer');
  }
  if (scenario.id === 'queued') {
    const dock = queueHost.pendingMessagesContainer;
    await phase('queue-absent', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true);
    queueHost.session.getSteeringMessages = () => ['PERF_STEERING']; queueHost.session.getFollowUpMessages = () => ['PERF_FOLLOWUP'];
    queueHost.updatePendingMessagesDisplay(); draw();
    const present = dock.render(width).join('\n'); assert.match(present, /PERF_STEERING/); assert.match(present, /PERF_FOLLOWUP/);
    await phase('queue-present', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true);
    dock.clear(); dock.addChild(new Text('PERF_FOREIGN_QUEUE_ROW', 0, 0)); draw();
    assert.match(dock.render(width).join('\n'), /PERF_FOREIGN_QUEUE_ROW/, 'unsupported native prefix preserves foreign row');
    await phase('queue-unsupported-prefix', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true);
  }
  if (scenario.id === 'arguments') {
    const actor = new ToolExecutionComponent('bash', 'performance-arguments', {}, undefined, undefined, root, process.cwd());
    contentRoot.addChild(actor); tools.push(actor); draw();
    const command = Array.from(`printf '%s\\n' 'argument${p.unicode ? ' 界 é 👩‍💻' : ' ascii'}'`);
    await phase('command-formation', p.iterations, async () => {
      for (let i = 0; i < p.iterations; i++) {
        actor.updateArgs({ command: command.slice(0, Math.ceil(command.length * (i + 1) / p.iterations)).join('') });
        draw(); await tick();
      }
    });
    await phase('equal-text-arguments-complete', 1, async () => { actor.setArgsComplete(); draw(); await tick(); });
    await phase('arguments-ready', 1, ready);
    assert.deepEqual(actor.args, { command: command.join('') });
    assert.match(actor.render(p.width).join(''), /argument/, 'completed synthetic command is rendered');
    await phase('formed-command-warm', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true);
  }
  if (scenario.id === 'stream') {
    let output = data.tools[0].result.content[0].text, result;
    tools[0].setArgsComplete(); tools[0].markExecutionStarted();
    await phase('stream-updates', p.iterations, async () => {
      for (let i = 0; i < p.iterations; i++) {
        output += `\nstream_${i}`;
        result = { ...componentInputs[0].result, content: [{ type: 'text', text: output }] };
        tools[0].updateResult(result, true); draw(); await tick();
      }
    });
    await phase('equal-text-completion', 1, async () => { tools[0].updateResult(result, false); draw(); await tick(); });
    await phase('updated-result-ready', 1, ready);
    await phase('completed-result-warm', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) draw(); }, true);
    expectedAfter = [{ ...data.tools[0], result: { ...structuredClone(data.tools[0].result), content: [{ type: 'text', text: output }] } }, ...data.tools.slice(1)];
  }
  if (scenario.id === 'layout') {
    await phase('scroll', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) { viewport.scrollBy(i % 2 ? -1 : 1); draw(); } }, true);
    await phase('height-only-resize', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) { height = p.height + (i % 2 ? 0 : 8); draw(); } }, true);
    height = p.height;
    await phase('resize', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) { width = p.width + (i % 2 ? 0 : 12); draw(); } });
    width = p.width;
    await phase('expand-collapse', p.iterations, async () => { for (let i = 0; i < p.iterations; i++) { tools[0].setExpanded(i % 2 === 0); draw(); } });
    await phase('theme-switch', 2, async () => { for (const name of ['light', 'dark']) { initTheme(name, false); root.invalidate(); await ready(); draw(); await tick(); } });
  }
  integrity.afterActions = verifyPerformanceTools(tools.slice(0, p.cards), expectedAfter, p.width, scenario.variant);
  if (scenario.id === 'lifetime') {
    lifecycle.push({ id: 'owned-ready', memory: await afterGC({ turns: 3 }), accounting: controller?.cacheStats() ?? null });
    await phase('remove-history', 1, async () => { root.clear(); tools = []; draw(); await tick(); });
    lifecycle.push({ id: 'removed', memory: await afterGC({ turns: 3 }), accounting: controller?.cacheStats() ?? null });
    await phase('attach-remove-cycles', p.iterations, async () => {
      for (let i = 0; i < p.iterations; i++) { add(i); draw(); root.clear(); tools = []; draw(); await tick(); }
    });
    lifecycle.push({ id: 'cycled', memory: await afterGC({ turns: 3 }), accounting: controller?.cacheStats() ?? null });
    controller?.restore(); controller = undefined;
    let activePaints = 0, disabledPaints = 0;
    await phase('adapter-reset-cycles', install ? p.iterations : 0, async () => {
      if (!install) return;
      for (let i = 0; i < p.iterations; i++) {
        const adapter = install(root, () => theme);
        if (scenario.variant === 'off') adapter.restore();
        if (adapter.active) activePaints++; else disabledPaints++;
        draw(); adapter.restore(); controller = adapter; await tick();
      }
    });
    Object.assign(phases.at(-1).counts, { adapterActivePaints: activePaints, adapterDisabledPaints: disabledPaints });
    assert.equal(activePaints, scenario.variant === 'on' ? p.iterations : 0, 'Off cycles never paint through an enabled adapter');
    lifecycle.push({ id: 'restored', memory: await afterGC({ turns: 3 }), accounting: controller?.cacheStats() ?? null });
  }
  const retained = await afterGC({ turns: 3 });
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'passed', phases, retained, lifecycle, allocationProfile, integrity, capabilities: capabilities(),
    input: { cards: tools.length, modelBytes: data.sourceBytes }, target: { pid: process.pid, node: process.version, v8: process.versions.v8 } }));
} catch (error) {
  writeFileSync(process.env.TIDY_TEST_PERF_RESULT, JSON.stringify({ outcome: 'failed', phases, failure: { name: error.name, message: String(error.message).slice(0, 1500), accounting: controller?.cacheStats() ?? null } }));
  process.exitCode = 1;
} finally { controller?.restore(); restorePreparation(); }
