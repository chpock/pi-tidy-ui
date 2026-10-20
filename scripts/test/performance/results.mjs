const metricNames = ['elapsedMs', 'cpuUserMs', 'cpuSystemMs', 'allocatedBytes'];
const memoryNames = ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss', 'maxRssKiB'];
const fail = message => { throw new TypeError(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const number = (value, path, integer = false) => {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(`${path} must be a nonnegative ${integer ? 'safe integer' : 'finite number'}`);
};
const text = (value, path) => { if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a nonempty string`); };
const object = (value, path) => { if (!record(value)) fail(`${path} must be a plain object`); };
const keys = value => Object.keys(value).sort();
const canonical = value => JSON.stringify(value, function (key, item) {
  return record(item) ? Object.fromEntries(keys(item).map(name => [name, item[name]])) : item;
});
const same = (a, b) => canonical(a) === canonical(b);

function jsonBoundary(value, path = 'run', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(`${path} is nonfinite`); return; }
  if (typeof value !== 'object' || (!Array.isArray(value) && !record(value))) fail(`${path} is not plain JSON data`);
  if (seen.has(value)) fail(`${path} is circular`);
  if (Object.getOwnPropertySymbols(value).length) fail(`${path} has symbol keys`);
  seen.add(value);
  const names = Object.keys(value);
  if (Array.isArray(value) && (names.length !== value.length || names.some((name, index) => name !== String(index)))) fail(`${path} is not a dense JSON array`);
  for (const key of names) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail(`${path}.${key} is an accessor`);
    jsonBoundary(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function validateCapability(value, path) {
  object(value, path);
  if (!['available', 'unavailable'].includes(value.status)) fail(`${path}.status is invalid`);
  text(value.method, `${path}.method`);
  if (value.status === 'unavailable') text(value.reason, `${path}.reason`);
  else if (Object.hasOwn(value, 'reason')) fail(`${path} conflicts: available with an unavailable reason`);
}

function validateSnapshot(snapshot, path) {
  object(snapshot, path);
  if (!same(keys(snapshot), [...memoryNames].sort())) fail(`${path} must name the six separate memory measurements`);
  for (const key of memoryNames) number(snapshot[key], `${path}.${key}`, true);
}

const scopeFields = ['memoryPeakBytes', 'memoryEvents', 'pidsPeak', 'pidsEvents'];
const memoryUnit = key => key === 'maxRssKiB' ? 'KiB' : 'bytes';

function validateAccounting(value, path) {
  if (value === null) return;
  object(value, path);
  for (const [key, entry] of Object.entries(value)) {
    if (record(entry) || entry === null) validateAccounting(entry, `${path}.${key}`);
    else number(entry, `${path}.${key}`, true);
  }
}

function validateOptional(repetition) {
  if (Object.hasOwn(repetition, 'retained') && repetition.retained !== null) validateSnapshot(repetition.retained, 'retained');
  if (Object.hasOwn(repetition, 'lifecycle')) {
    if (!Array.isArray(repetition.lifecycle)) fail('lifecycle must be an array');
    const ids = new Set();
    for (const sample of repetition.lifecycle) {
      object(sample, 'lifecycle sample'); text(sample.id, 'lifecycle.id');
      if (ids.has(sample.id)) fail('Duplicate lifecycle id');
      ids.add(sample.id);
      if (sample.memory !== null) validateSnapshot(sample.memory, `lifecycle.${sample.id}.memory`);
      if (Object.hasOwn(sample, 'accounting')) validateAccounting(sample.accounting, `lifecycle.${sample.id}.accounting`);
    }
  }
  if (Object.hasOwn(repetition, 'scope')) {
    object(repetition.scope, 'scope');
    for (const boundary of ['preCleanup', 'finalLifetime']) {
      if (!Object.hasOwn(repetition.scope, boundary)) continue;
      const sample = repetition.scope[boundary], path = `scope.${boundary}`;
      object(sample, path);
      if (!Array.isArray(sample.unavailable) || new Set(sample.unavailable).size !== sample.unavailable.length || sample.unavailable.some(key => !scopeFields.includes(key))) fail(`${path}.unavailable must list unique counter names`);
      for (const key of scopeFields) {
        const value = sample[key];
        if (sample.unavailable.includes(key)) {
          if (value !== null) fail(`${path}.${key} conflicts with unavailable readback`);
        } else if (key === 'memoryPeakBytes' || key === 'pidsPeak') number(value, `${path}.${key}`, true);
        else {
          object(value, `${path}.${key}`);
          for (const [event, count] of Object.entries(value)) number(count, `${path}.${key}.${event}`, true);
        }
      }
    }
  }
}

function numericStructure(value) {
  if (value === null) return null;
  if (typeof value === 'number') return 'number';
  return Object.fromEntries(keys(value).map(key => [key, numericStructure(value[key])]));
}

function optionalStructure(repetition) {
  const shape = {};
  if (Object.hasOwn(repetition, 'retained')) shape.retained = 'snapshot';
  if (Object.hasOwn(repetition, 'lifecycle')) shape.lifecycle = repetition.lifecycle.map(sample => ({ id: sample.id, memory: 'snapshot',
    ...(Object.hasOwn(sample, 'accounting') ? { accounting: numericStructure(sample.accounting) } : {}) }));
  if (Object.hasOwn(repetition, 'scope')) shape.scope = Object.fromEntries(['preCleanup', 'finalLifetime'].filter(key => Object.hasOwn(repetition.scope, key)).map(key => {
    const sample = repetition.scope[key];
    return [key, { memoryPeakBytes: 'number', pidsPeak: 'number', memoryEvents: numericStructure(sample.memoryEvents), pidsEvents: numericStructure(sample.pidsEvents) }];
  }));
  return shape;
}

// A null readback has no known leaf shape. Refine it from available samples,
// but never treat absent optional fields or different known keys as equivalent.
function mergeStructure(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if ((record(a) && record(b)) || (Array.isArray(a) && Array.isArray(b))) {
    if (!same(keys(a), keys(b))) fail('Optional observation structure mismatch');
    if (Array.isArray(a)) return a.map((value, index) => mergeStructure(value, b[index]));
    return Object.fromEntries(keys(a).map(key => [key, mergeStructure(a[key], b[key])]));
  }
  if (a !== b) fail('Optional observation structure mismatch');
  return a;
}

function optionalObservations(repetition) {
  const observations = [];
  const add = (phase, metric, value, unit) => observations.push({ phase, metric, value, unit });
  const snapshot = (phase, prefix, value) => {
    for (const key of memoryNames) add(phase, prefix + key, value === null ? null : value[key], memoryUnit(key));
  };
  const accounting = (prefix, value) => {
    if (value === null) { add('lifecycle', prefix, null, null); return; }
    for (const key of keys(value)) {
      const entry = value[key], path = `${prefix}.${key}`;
      if (record(entry) || entry === null) accounting(path, entry);
      else add('lifecycle', path, entry, key.endsWith('Bytes') ? 'bytes' : 'count');
    }
  };
  if (Object.hasOwn(repetition, 'retained')) snapshot('retained', '', repetition.retained);
  for (const sample of repetition.lifecycle ?? []) {
    snapshot('lifecycle', `${sample.id}.memory.`, sample.memory);
    if (Object.hasOwn(sample, 'accounting')) accounting(`${sample.id}.accounting`, sample.accounting);
  }
  for (const boundary of ['preCleanup', 'finalLifetime']) {
    const sample = repetition.scope?.[boundary];
    if (!sample) continue;
    add('scope', `${boundary}.memoryPeakBytes`, sample.memoryPeakBytes, 'bytes');
    add('scope', `${boundary}.pidsPeak`, sample.pidsPeak, 'count');
    for (const key of ['memoryEvents', 'pidsEvents']) {
      if (sample[key] === null) add('scope', `${boundary}.${key}`, null, 'count');
      else for (const event of keys(sample[key])) add('scope', `${boundary}.${key}.${event}`, sample[key][event], 'count');
    }
  }
  return observations;
}

export function validateRun(run) {
  jsonBoundary(run);
  object(run, 'run');
  if (run.schema !== 1) fail('Unsupported result schema');
  for (const name of ['environment', 'product', 'measurement', 'scenario', 'capabilities']) object(run[name], name);
  if (!keys(run.environment).length) fail('environment must not be empty');
  object(run.product.source, 'product.source');
  if (!keys(run.product.source).length) fail('product.source must not be empty');
  if (run.product.native !== null) {
    object(run.product.native, 'product.native');
    if (!keys(run.product.native).length) fail('product.native identity must not be empty');
  }
  for (const key of ['contract', 'workloadHash', 'collectorHash']) text(run.measurement[key], `measurement.${key}`);
  text(run.scenario.id, 'scenario.id');
  if (!['sdk', 'cli'].includes(run.scenario.driver)) fail('Invalid scenario driver');
  if (!['native', 'off', 'on'].includes(run.scenario.variant)) fail('Invalid scenario variant');
  object(run.scenario.parameters, 'scenario.parameters');
  object(run.capabilities.runtime, 'capabilities.runtime');
  for (const key of ['node', 'v8']) text(run.capabilities.runtime[key], `capabilities.runtime.${key}`);
  for (const [key, value] of Object.entries(run.capabilities)) if (key !== 'runtime') validateCapability(value, `capabilities.${key}`);
  for (const key of ['elapsed', 'cpu', 'memory', 'allocatedBytes', 'gc', 'afterGC', 'allocationProfile']) {
    if (!Object.hasOwn(run.capabilities, key)) fail(`Missing capabilities.${key}`);
  }
  for (const key of ['elapsed', 'cpu', 'memory']) if (run.capabilities[key].status !== 'available') fail(`Required collector capability ${key} is unavailable`);
  if (!Array.isArray(run.repetitions) || !run.repetitions.length) fail('repetitions must not be empty');
  let shape, optionalShape;
  for (const [index, repetition] of run.repetitions.entries()) {
    object(repetition, `repetitions.${index}`);
    if (repetition.index !== index) fail('Repetition indexes must be complete, unique and ordered from zero');
    if (!['passed', 'failed'].includes(repetition.outcome)) fail('Invalid repetition outcome');
    if (repetition.outcome === 'failed') {
      object(repetition.failure, 'failure');
      if (!keys(repetition.failure).length) fail('Failed repetition requires a failure receipt');
    } else if (Object.hasOwn(repetition, 'failure')) fail('Passed repetition has a failure receipt');
    if (!Array.isArray(repetition.phases) || (repetition.outcome === 'passed' && !repetition.phases.length)) fail('Passed repetition requires phases');
    const ids = new Set();
    for (const phase of repetition.phases) {
      object(phase, 'phase'); text(phase.id, 'phase.id');
      if (ids.has(phase.id)) fail('Duplicate phase id');
      ids.add(phase.id);
      number(phase.operations, 'phase.operations', true);
      object(phase.counts, 'phase.counts');
      for (const [key, value] of Object.entries(phase.counts)) number(value, `phase.counts.${key}`, true);
      object(phase.metrics, 'phase.metrics');
      if (!same(keys(phase.metrics), [...metricNames].sort())) fail('Incomplete or unknown phase metrics');
      for (const key of metricNames) {
        const unavailable = key === 'allocatedBytes' && run.capabilities.allocatedBytes.status === 'unavailable';
        if (unavailable) { if (phase.metrics[key] !== null) fail('Unavailable allocations must be null, not zero'); }
        else number(phase.metrics[key], `phase.metrics.${key}`, key === 'allocatedBytes');
      }
      object(phase.memory, 'phase.memory');
      validateSnapshot(phase.memory.before, 'memory.before'); validateSnapshot(phase.memory.after, 'memory.after');
      if (phase.memory.after.maxRssKiB < phase.memory.before.maxRssKiB) fail('Process-lifetime maxRSS must not decrease');
      if (phase.gc !== null) {
        object(phase.gc, 'phase.gc');
        if (run.capabilities.gc.status !== 'available' || phase.gc.status !== 'available' || phase.gc.method !== run.capabilities.gc.method) fail('Conflicting GC availability');
        number(phase.gc.count, 'gc.count', true); number(phase.gc.durationMs, 'gc.durationMs');
        object(phase.gc.types, 'gc.types');
        let count = 0, duration = 0;
        for (const value of Object.values(phase.gc.types)) {
          object(value, 'gc.type'); number(value.count, 'gc.type.count', true); number(value.durationMs, 'gc.type.durationMs');
          count += value.count; duration += value.durationMs;
        }
        number(count, 'gc total count', true); number(duration, 'gc total durationMs');
        if (count !== phase.gc.count || Math.abs(duration - phase.gc.durationMs) > 1e-8 * Math.max(1, duration)) fail('GC totals conflict with GC type receipts');
      }
    }
    validateOptional(repetition);
    if (repetition.outcome === 'passed') {
      const currentOptional = optionalStructure(repetition);
      optionalShape = optionalShape === undefined ? currentOptional : mergeStructure(optionalShape, currentOptional);
      const current = phaseShape(repetition);
      if (shape && !same(shape, current)) fail('Incomplete or inconsistent phase structure across repetitions');
      shape = current;
    }
  }
  return JSON.parse(JSON.stringify(run));
}

function phaseShape(repetition) {
  return repetition.phases.map(phase => ({ id: phase.id, operations: phase.operations, counts: keys(phase.counts), gc: phase.gc === null ? null : { method: phase.gc.method } }));
}

function distribution(samples) {
  if (samples.every(value => value === null)) return { status: 'unavailable', samples: [...samples], n: 0, median: null, spread: null, min: null, max: null };
  const sorted = samples.filter(value => value !== null).sort((a, b) => a - b), n = sorted.length, middle = Math.floor(n / 2);
  const min = sorted[0], max = sorted[n - 1];
  return { status: n === samples.length ? 'available' : 'partial', samples: [...samples], n, median: n % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2, spread: max - min, min, max };
}

export function summarizeRun(input) {
  const run = validateRun(input);
  const successful = run.repetitions.filter(repetition => repetition.outcome === 'passed');
  const observations = [];
  if (successful.length) {
    for (const [index, first] of successful[0].phases.entries()) {
      const phases = successful.map(repetition => repetition.phases[index]);
      const add = (suffix, get) => observations.push({ phase: first.id, metric: suffix, ...distribution(phases.map(get)) });
      for (const key of metricNames) {
        add(`metrics.${key}`, phase => phase.metrics[key]);
        add(`perOperation.${key}`, phase => phase.operations && phase.metrics[key] !== null ? phase.metrics[key] / phase.operations : null);
      }
      for (const key of keys(first.counts)) add(`counts.${key}`, phase => phase.counts[key]);
      for (const key of memoryNames) {
        add(`memory.before.${key}`, phase => phase.memory.before[key]);
        add(`memory.after.${key}`, phase => phase.memory.after[key]);
        // A lifetime high-water mark cannot be turned into a per-phase peak by subtraction.
        if (key !== 'maxRssKiB') add(`memory.delta.${key}`, phase => phase.memory.after[key] - phase.memory.before[key]);
      }
      if (first.gc !== null) {
        for (const key of ['count', 'durationMs']) add(`gc.${key}`, phase => phase.gc[key]);
      }
    }
    const raw = successful.map(optionalObservations);
    const descriptors = new Map();
    for (const { value, ...descriptor } of raw.flat()) {
      const key = JSON.stringify([descriptor.phase, descriptor.metric]);
      if (descriptor.unit !== null || !descriptors.has(key)) descriptors.set(key, descriptor);
    }
    const samples = raw.map(entries => new Map(entries.map(entry => [JSON.stringify([entry.phase, entry.metric]), entry.value])));
    for (const [key, descriptor] of [...descriptors].sort(([a], [b]) => a.localeCompare(b))) observations.push({ ...descriptor, ...distribution(samples.map(values => values.get(key) ?? null)) });
  }
  return { schema: 1, status: successful.length === run.repetitions.length ? 'passed' : 'failed',
    repetitions: run.repetitions, successfulRepetitions: successful.length,
    timingEvidence: successful.length >= 3 ? 'repeated-observations' : 'descriptive-only', observations };
}

function productChange(before, after) {
  const extension = !same(before.source, after.source), helper = !same(before.native, after.native);
  return extension && helper ? 'both' : extension ? 'extension' : helper ? 'helper' : 'none';
}

function validateThresholds(thresholds) {
  jsonBoundary(thresholds, 'thresholds'); object(thresholds, 'thresholds');
  for (const [key, value] of Object.entries(thresholds)) {
    object(value, `thresholds.${key}`);
    if (keys(value).some(name => !['absolute', 'relative', 'minRepetitions'].includes(name))) fail(`Unknown threshold field for ${key}`);
    number(value.absolute, `thresholds.${key}.absolute`); number(value.relative, `thresholds.${key}.relative`);
    if (Object.hasOwn(value, 'minRepetitions') && (!Number.isSafeInteger(value.minRepetitions) || value.minRepetitions < 1)) fail('minRepetitions must be a positive safe integer');
  }
}

export function compareRuns(beforeInput, afterInput, { thresholds = {} } = {}) {
  let before, after;
  try { before = validateRun(beforeInput); after = validateRun(afterInput); validateThresholds(thresholds); }
  catch (error) { return { schema: 1, status: 'invalid', reasons: [error.message], comparisons: [] }; }
  const change = productChange(before.product, after.product);
  const result = (status, reasons, comparisons = []) => ({ schema: 1, status, productChange: change, attribution: change === 'both' ? 'combined-product-only' : change, reasons, comparisons });
  const mismatches = ['environment', 'measurement', 'scenario', 'capabilities'].filter(key => !same(before[key], after[key]));
  if (mismatches.length) return result('not-comparable', mismatches.map(key => `${key} mismatch`));
  if (before.repetitions.length !== after.repetitions.length) return result('not-comparable', ['Repetition count mismatch']);
  if ([before, after].some(run => run.repetitions.some(repetition => repetition.outcome !== 'passed'))) return result('failed', ['Failed repetitions cannot pass comparison']);
  if (!same(before.repetitions.map(phaseShape), after.repetitions.map(phaseShape))) return result('not-comparable', ['Phase/work structure mismatch']);
  try {
    const structure = run => run.repetitions.map(optionalStructure).reduce(mergeStructure);
    mergeStructure(structure(before), structure(after));
  } catch { return result('not-comparable', ['Optional observation structure mismatch']); }
  const a = summarizeRun(before), b = summarizeRun(after);
  const countSelectors = new Set(before.repetitions[0].phases.flatMap(phase => keys(phase.counts).map(key => `${phase.id}.counts.${key}`)));
  const selectors = new Map(a.observations.map(item => [`${item.phase}.${item.metric}`, item]));
  const nextSelectors = new Map(b.observations.map(item => [`${item.phase}.${item.metric}`, item]));
  if (selectors.size !== a.observations.length || nextSelectors.size !== b.observations.length) return result('invalid', ['Ambiguous phase/metric selectors']);
  const unavailable = descriptor => ({ phase: descriptor.phase, metric: descriptor.metric, unit: descriptor.unit, ...distribution(before.repetitions.map(() => null)) });
  for (const [key, next] of nextSelectors) if (!selectors.has(key)) selectors.set(key, unavailable(next));
  for (const [key, previous] of selectors) if (!nextSelectors.has(key)) nextSelectors.set(key, unavailable(previous));
  for (const [key, policy] of Object.entries(thresholds)) {
    const observation = selectors.get(key);
    if (!observation) return result('invalid', ['Threshold names an unknown phase/metric']);
    if (!countSelectors.has(key) && (policy.minRepetitions ?? 3) < 3) return result('invalid', ['Non-count threshold conclusions require at least three repetitions']);
  }
  const comparisons = [...selectors].map(([key, observation]) => {
    const next = nextSelectors.get(key), policy = thresholds[key];
    if (observation.status !== 'available' || next.status !== 'available') return { key, status: 'unavailable', before: observation, after: next, delta: null, relativeDelta: null };
    const delta = next.median - observation.median;
    const ratio = observation.median === 0 ? null : delta / Math.abs(observation.median);
    const relativeDelta = Number.isFinite(ratio) ? ratio : null;
    let status = 'observed';
    if (policy) {
      const minimum = policy.minRepetitions ?? (countSelectors.has(key) ? 1 : 3);
      if (observation.n < minimum || next.n < minimum) status = 'inconclusive';
      else status = delta > policy.absolute && delta > Math.abs(observation.median) * policy.relative ? 'regression' : 'pass';
    }
    return { key, status, before: observation, after: next, delta, relativeDelta, zeroBaseline: observation.median === 0 };
  });
  const selected = comparisons.filter(item => Object.hasOwn(thresholds, item.key));
  if (selected.some(item => item.status === 'unavailable')) return result('unavailable', ['A required metric is unavailable'], comparisons);
  if (selected.some(item => item.status === 'regression')) return result('regression', ['Explicit tolerances exceeded'], comparisons);
  if (selected.some(item => item.status === 'inconclusive')) return result('inconclusive', ['Insufficient repetitions for the selected metric policies'], comparisons);
  return result(selected.length ? 'pass' : 'observed', selected.length ? [] : ['Descriptive deltas only; no threshold policy supplied'], comparisons);
}

export function renderSummary(result) {
  object(result, 'result'); text(result.status, 'result.status');
  const lines = [`Performance: ${result.status}${result.productChange ? `; product change: ${result.productChange}` : ''}`];
  if (result.reasons) lines.push(...result.reasons);
  if (result.observations) {
    lines.push(`Repetitions: ${result.successfulRepetitions}; ${result.timingEvidence}`);
    for (const item of result.observations) lines.push(`${item.phase}.${item.metric}: ${item.status === 'unavailable' ? 'unavailable' : `${item.status === 'partial' ? 'partial ' : ''}median=${item.median} min=${item.min} max=${item.max} spread=${item.spread} n=${item.n}${item.unit ? ` unit=${item.unit}` : ''}`}`);
  }
  if (result.comparisons) for (const item of result.comparisons) lines.push(`${item.key}: ${item.status}; delta=${item.delta ?? 'unavailable'}; relative=${item.relativeDelta ?? 'unavailable'}`);
  return lines.join('\n');
}
