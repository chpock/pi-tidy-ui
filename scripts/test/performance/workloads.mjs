import { createHash } from 'node:crypto';

export const CONTRACT = 'pi-tidy-ui-performance/v1';
export const variants = Object.freeze(['native', 'off', 'on']);
export const definitions = Object.freeze([
  { id: 'render', driver: 'sdk', description: 'Cold and warm actual SDK transcript layout' },
  { id: 'stream', driver: 'sdk', description: 'Result updates in a fixed older history' },
  { id: 'layout', driver: 'sdk', description: 'Scroll, resize, expansion and theme invalidation' },
  { id: 'lifetime', driver: 'sdk', description: 'Attach/remove and adapter reset cycles with post-GC samples' },
  { id: 'frames', driver: 'cli', description: 'Cold restore, idle frequency and completed native TUI frames' },
  { id: 'syntax', driver: 'cli', allowedVariants: ['on'], description: 'Same-source Occipital preparation and cached recoloring' },
  { id: 'arguments', driver: 'sdk', description: 'Incremental command-argument formation and equal-text completion' },
  { id: 'status', driver: 'cli', description: 'Public extension-status-only updates in ready history' },
  { id: 'activity', driver: 'sdk', description: 'Actual SDK Loader scheduling and fixed render passes, not real-Pi FPS' },
  { id: 'queued', driver: 'sdk', description: 'Actual native queue-row construction absent/present and unsupported-prefix fallback' },
  { id: 'source-stream', driver: 'sdk', entry: 'source', requiresNative: true, allowedVariants: ['on'], description: 'Real SOURCE append/finalization and STYLE, without claiming terminal rendering' },
  { id: 'observer', driver: 'sdk', entry: 'calibration', allowedVariants: ['native'], description: 'Matched light-observer disabled/enabled synthetic-call calibration' },
]);

export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return value;
}

export function parameters(value = {}) {
  const allowed = new Set(['cards', 'iterations', 'warmup', 'width', 'height', 'unicode', 'seed', 'idleMs']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key))) throw new Error('Invalid workload parameters');
  const result = { cards: 100, iterations: 50, warmup: 5, width: 100, height: 40, unicode: true, seed: 1, idleMs: 500, ...value };
  integer(result.cards, 'cards', 1, 3000); integer(result.iterations, 'iterations', 1, 1000);
  integer(result.warmup, 'warmup', 1, 100); integer(result.width, 'width', 24, 240);
  integer(result.height, 'height', 10, 150); integer(result.seed, 'seed', 0, 0x7fffffff);
  integer(result.idleMs, 'idleMs', 100, 5000);
  if (typeof result.unicode !== 'boolean') throw new Error('Invalid unicode switch');
  return Object.freeze(result);
}

export function workload(id, variant, options = {}) {
  const definition = definitions.find(value => value.id === id);
  if (!definition || !variants.includes(variant)) throw new Error('Unknown workload or variant');
  if (definition.allowedVariants && !definition.allowedVariants.includes(variant)) throw new Error('Workload does not support this variant');
  const value = { ...definition, variant, parameters: parameters(options) };
  return Object.freeze({ ...value, hash: createHash('sha256').update(JSON.stringify({ contract: CONTRACT, ...value })).digest('hex') });
}

export function plan({ profile = 'quick', cases, selectedVariants = [...variants], overrides = {} } = {}) {
  if (!['quick', 'standard', 'extended'].includes(profile)) throw new Error('Unknown performance profile');
  const ids = cases ?? definitions.map(value => value.id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !definitions.some(value => value.id === id))) throw new Error('Invalid selected cases');
  if (!Array.isArray(selectedVariants) || !selectedVariants.length || new Set(selectedVariants).size !== selectedVariants.length || selectedVariants.some(value => !variants.includes(value))) throw new Error('Invalid selected variants');
  const result = [];
  for (const id of ids) {
    const sizes = Object.hasOwn(overrides, 'cards') ? [overrides.cards] : profile === 'quick' ? [10] : id === 'frames' || id === 'render' ? [10, 100, 1000] : [100];
    if (!Object.hasOwn(overrides, 'cards') && profile === 'extended' && (id === 'frames' || id === 'render')) sizes.push(3000);
    for (const cards of sizes) for (const variant of selectedVariants) {
      const definition = definitions.find(value => value.id === id);
      if (definition.allowedVariants && !definition.allowedVariants.includes(variant)) continue;
      result.push(workload(id, variant, { cards, iterations: profile === 'quick' ? 10 : 50, warmup: 5, ...overrides }));
    }
  }
  if (!result.length) throw new Error('Empty performance selection');
  return result;
}

export function trialOrder(cases, repetitions) {
  integer(repetitions, 'repetitions', 1, 15);
  const result = [];
  for (let index = 0; index < repetitions; index++) {
    const values = index % 2 ? [...cases].reverse() : cases;
    for (const scenario of values) result.push({ scenario, repetition: index });
  }
  return result;
}

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const timestamp = 1700000000000;

export function history(options = {}) {
  const p = parameters(options), tools = [], messages = [];
  const suffix = p.unicode ? ' 界 e\u0301 👩‍💻' : ' ascii';
  for (let i = 0; i < p.cards; i++) {
    const name = ['bash', 'write', 'edit', 'read'][i % 4], id = `perf-${p.seed}-${i}`;
    const source = `const value_${i} = ${p.seed + i}; // prepared${suffix}\n`;
    const args = name === 'bash' ? { command: `printf '%s\\n' 'PERF_${i}${suffix}'` }
      : name === 'write' ? { path: `perf-${i}.js`, content: source }
      : name === 'edit' ? { path: `perf-${i}.js`, oldText: `const value_${i} = 0;`, newText: source.trimEnd() }
      : { path: `perf-${i}.txt`, offset: 1, limit: 20 };
    const result = { content: [{ type: 'text', text: name === 'bash'
      ? Array.from({ length: 16 }, (_, row) => `output_${i}_${row}${suffix}`).join('\n')
      : name === 'read' ? `Read body ${i}${suffix}\n` : `Updated perf-${i}.js` }],
      details: name === 'bash' ? { exit_code: 0 } : name === 'edit' ? { diff: `-1 const value_${i} = 0;\n+1 ${source.trimEnd()}` } : {}, isError: false };
    tools.push({ id, name, args, result });
    messages.push({ role: 'user', content: [{ type: 'text', text: `Inspect item ${i}${suffix}: **ready** and unchanged.` }], timestamp: timestamp + i * 3 },
      { role: 'assistant', content: [{ type: 'text', text: `Working on item ${i}.` }, { type: 'toolCall', id, name, arguments: args }],
        api: 'openai-completions', provider: 'tidy-ui-offline', model: 'scripted', usage: usage(), stopReason: 'toolUse', timestamp: timestamp + i * 3 + 1 },
      { role: 'toolResult', toolCallId: id, toolName: name, ...result, timestamp: timestamp + i * 3 + 2 });
  }
  return { tools, messages, sourceBytes: Buffer.byteLength(JSON.stringify(messages)) };
}

export function sessionText(options, cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('Synthetic session requires an absolute workspace');
  const { messages } = history(options);
  const entries = [{ type: 'session', version: 3, id: '00000000-0000-4000-8000-000000000001', timestamp: new Date(timestamp).toISOString(), cwd }];
  let parentId = null;
  for (let index = 0; index < messages.length; index++) {
    const id = (index + 1).toString(16).padStart(8, '0');
    entries.push({ type: 'message', id, parentId, timestamp: new Date(timestamp + index).toISOString(), message: messages[index] }); parentId = id;
  }
  return entries.map(value => JSON.stringify(value)).join('\n') + '\n';
}
