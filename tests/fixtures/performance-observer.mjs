// Test-only light observer. No transcript walks, event history or per-frame receipts.
import { endPhase } from '../../scripts/test/performance/metrics.mjs';
const key = Symbol.for('pi-tidy-ui.performance.observer');
export function setPerformanceInstrumentation(state, enabled) {
  const tui = state.renderer.deref();
  if (!tui || typeof enabled !== 'boolean') throw new Error('Unavailable performance instrumentation target');
  for (const name of ['doRender', 'render', 'requestRender']) tui[name] = (enabled ? state.wrapped : state.original)[name];
  tui.terminal.write = (enabled ? state.wrapped : state.original).write;
  state.instrumented = enabled;
}
const fence = /\x1b\[\?997;(\d+);([012])n/g;

export function performanceBridge() {
  const bridge = globalThis[key];
  if (!bridge?.current) throw new Error('Performance observer has no active native renderer');
  return bridge;
}

export function installPerformanceObserver(InteractiveMode) {
  if (globalThis[key]) throw new Error('Duplicate performance observer');
  const bridge = { current: undefined, ready: false };
  Object.defineProperty(globalThis, key, { configurable: true, value: bridge });
  const mounted = InteractiveMode.prototype.mountInteractiveTui, input = InteractiveMode.prototype.getUserInput;
  if (typeof mounted !== 'function' || typeof input !== 'function') throw new Error('Unsupported performance observer host');
  function emit(state, packet) {
    const tui = state.renderer.deref();
    if (!tui) throw new Error('Performance renderer was collected');
    state.write.call(tui.terminal, `\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`);
  }
  function settled(state) {
    const tui = state.renderer.deref();
    return tui && !tui.stopped && !tui.renderRequested && !tui.renderTimer && !tui.immediateRenderScheduled;
  }
  function publishReady(state) {
    if (state.readySent || !bridge.ready || !state.calls) return;
    state.readySent = true;
    const startup = globalThis[Symbol.for('pi-tidy-ui.performance.startup')];
    if (startup) {
      bridge.startupPhase = { id: 'preload-to-native-ready', ...endPhase(startup, { operations: 1 }) };
      delete globalThis[Symbol.for('pi-tidy-ui.performance.startup')];
    }
    emit(state, { type: 'ready', frames: state.calls, generation: state.generation });
  }
  function replyFence(state, id) {
    if (!settled(state)) { setTimeout(() => replyFence(state, id), 2); return; }
    emit(state, { type: 'frame', id, frames: state.calls, generation: state.generation, clearAfter: 0 });
  }
  InteractiveMode.prototype.mountInteractiveTui = function (tui, ...args) {
    if (typeof tui?.doRender !== 'function' || typeof tui.render !== 'function' || typeof tui.terminal?.write !== 'function' || typeof tui.addInputListener !== 'function') throw new Error('Unsupported native performance renderer');
    const state = { renderer: new WeakRef(tui), generation: (bridge.current?.generation ?? 0) + 1,
      calls: 0, requests: 0, forcedRequests: 0, rootRenders: 0, layoutPasses: 0, writes: 0, bytes: 0, observing: false, waiter: undefined, instrumented: true,
      readySent: false, write: tui.terminal.write };
    const render = tui.doRender, layout = tui.render, request = tui.requestRender;
    if (typeof request !== 'function') throw new Error('Unsupported native render-request observation');
    state.original = { doRender: render, render: layout, requestRender: request, write: tui.terminal.write };
    tui.doRender = function (...values) {
      try { return Reflect.apply(render, this, values); }
      finally {
        state.calls++;
        const waiter = state.waiter; state.waiter = undefined;
        if (waiter) waiter();
        if (!state.readySent && bridge.ready) queueMicrotask(() => publishReady(state));
      }
    };
    tui.render = function (...values) { state.rootRenders++; return Reflect.apply(layout, this, values); };
    tui.terminal.write = function (data, ...values) {
      if (state.observing) { state.writes++; state.bytes += Buffer.byteLength(data); }
      return Reflect.apply(state.write, this, [data, ...values]);
    };
    tui.requestRender = function (...values) {
      state.requests++; if (values[0] === true) state.forcedRequests++;
      return Reflect.apply(request, this, values);
    };
    state.wrapped = { doRender: tui.doRender, render: tui.render, requestRender: tui.requestRender, write: tui.terminal.write };
    tui.addInputListener(data => {
      let consumed = false;
      const rest = data.replace(fence, (_packet, digits, kind) => {
        if (kind !== '0') throw new Error('Performance observer supports readiness fences only');
        consumed = true; const id = Number(digits);
        if (!Number.isSafeInteger(id) || id < 1 || bridge.current !== state) throw new Error('Invalid performance fence');
        setImmediate(() => replyFence(state, id)); return '';
      });
      return consumed ? rest ? { data: rest } : { consume: true } : undefined;
    });
    bridge.current = state;
    return Reflect.apply(mounted, this, [tui, ...args]);
  };
  InteractiveMode.prototype.getUserInput = function (...args) {
    const result = Reflect.apply(input, this, args); bridge.ready = true;
    if (bridge.current) queueMicrotask(() => publishReady(bridge.current));
    return result;
  };
  bridge.counts = () => {
    const state = bridge.current;
    return { nativeRequests: state.requests, forcedRequests: state.forcedRequests, nativeCalls: state.calls, rootRenders: state.rootRenders, layoutPasses: state.layoutPasses, terminalWrites: state.writes, terminalBytes: state.bytes };
  };
  bridge.layout = () => { if (bridge.current) bridge.current.layoutPasses++; };
  bridge.instrument = enabled => setPerformanceInstrumentation(bridge.current, enabled);
  bridge.observe = enabled => { bridge.current.observing = enabled; };
  bridge.frame = () => new Promise(resolve => {
    const state = bridge.current, tui = state.renderer.deref();
    if (!tui || tui.stopped || state.waiter) throw new Error('Unavailable or already awaited performance frame');
    state.waiter = resolve; tui.requestRender();
  });
  bridge.frames = async count => { for (let i = 0; i < count; i++) await bridge.frame(); };
  return bridge;
}
