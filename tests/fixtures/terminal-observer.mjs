import { terminalCaptureBridge, captureChanged, producerCompletion } from './terminal-capture.mjs';

const protocol = /\x1b\[\?997;(\d+);([012345])n/g;

export function installTerminalObserver(InteractiveMode, { restorable = false, interruptWindow = 500, capture = terminalCaptureBridge(), Editor } = {}) {
  const prototype = InteractiveMode.prototype;
  const states = new WeakMap(), restorers = [];
  function replace(object, name, factory) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (typeof descriptor?.value !== 'function') throw new Error(`Unsupported Pi terminal observer: ${name}`);
    const replacement = factory(descriptor.value);
    Object.defineProperty(object, name, { ...descriptor, value: replacement });
    if (restorable) restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(object, name)?.value === replacement) Object.defineProperty(object, name, descriptor);
    });
  }
  for (const name of ['getUserInput', 'setupEditorSubmitHandler', 'mountInteractiveTui']) {
    if (typeof prototype[name] !== 'function') throw new Error(`Unsupported Pi terminal observer: ${name}`);
  }
  if (Editor) for (const name of ['startAutocompleteRequest', 'cancelAutocompleteRequest']) {
    replace(Editor.prototype, name, original => function (...args) {
      const result = Reflect.apply(original, this, args);
      capture.changed?.();
      return result;
    });
  }
  function state(mode) {
    let value = states.get(mode);
    if (!value) {
      if (typeof mode.lastSigintTime !== 'number') throw new Error('Unsupported native clear-key state');
      value = { mode, generation: 0, renderers: new WeakMap(), requests: [], operations: new Map(), armed: [], submissions: [], ready: false, capture, captureEpoch: 0 };
      const changed = captureChanged(new WeakRef(value), schedule), previous = capture.changed;
      capture.changed = changed;
      if (restorable) restorers.push(() => {
        clearImmediate(value.check); value.requests = []; value.sourceSlot = undefined;
        if (capture.changed === changed) capture.changed = previous;
      });
      states.set(mode, value);
    }
    return value;
  }
  function emit(value, packet) {
    value.current.tui.terminal.write(`\x1b]777;tidy-test;${Buffer.from(JSON.stringify(packet)).toString('base64')}\x07`);
  }
  function schedule(value) {
    if (value.check) return;
    value.check = setImmediate(() => {
      value.check = undefined;
      flush(value);
    });
  }
  function completed(value, operation) {
    if (operation.loopStarted) return operation.loopFinished;
    if (!operation.submitted) return false;
    return !value.mode.pendingUserInputs?.includes(operation.text);
  }
  function cancelCapture(value, request, message, error) {
    if (error) emit(value, { type: 'error', id: request.id, message: error });
    emit(value, { type: 'cancelled', id: request.id, message });
  }
  function captureReady(value, request, current) {
    const producer = capture.producer;
    request.producer ??= producer;
    const owner = producer?.owner.deref();
    if (!owner) { cancelCapture(value, request, 'Capture producer is unavailable'); return 'cancelled'; }
    let slot = value.sourceSlot;
    const same = slot?.producer === producer;
    if (!(same && slot.sequence >= request.epoch && (!slot.done || slot.frames === current.frames))) {
      const promise = owner.whenSettled();
      if (!same || slot.promise !== promise) {
        slot = { producer, promise, frames: current.frames, sequence: value.captureEpoch, done: false };
        value.sourceSlot = slot;
        const observed = new WeakRef(value);
        void promise.then(producerCompletion(observed, slot), producerCompletion(observed, slot, true));
      } else { slot.sequence = value.captureEpoch; slot.frames = current.frames; }
    }
    if (!slot.done) return false;
    if (slot.result !== true) { cancelCapture(value, request, 'Capture producer observation was cancelled', slot.error); return 'cancelled'; }
    return true;
  }
  function flush(value) {
    const current = value.current;
    if (!current) return;
    value.requests = value.requests.filter(request => {
      if (request.kind !== 4) return true;
      if (request.generation !== value.generation || request.producer && request.producer !== capture.producer) {
        cancelCapture(value, request, 'Capture owner was replaced'); return false;
      }
      const slot = value.sourceSlot;
      if (slot?.done && slot.producer === request.producer && slot.sequence >= request.epoch && slot.result !== true) {
        cancelCapture(value, request, 'Capture producer observation was cancelled', slot.error); return false;
      }
      return true;
    });
    if (!value.ready || !current.frames || current.tui.stopped) return;
    const editor = value.mode.editor;
    if (value.autocompleteEditor !== editor) {
      value.autocompleteEditor = editor;
      value.autocompleteTask = undefined;
      value.autocompletePending = false;
    }
    if (editor?.autocompleteDebounceTimer) return;
    const task = editor?.autocompleteRequestTask;
    if (task && task !== value.autocompleteTask) {
      value.autocompleteTask = task;
      value.autocompletePending = true;
      task.then(() => {
        if (value.autocompleteTask !== task) return;
        value.autocompletePending = false; schedule(value);
      }, error => {
        if (value.autocompleteTask !== task) return;
        value.autocompletePending = false;
        emit(value, { type: 'error', message: `Native autocomplete failed: ${error}` });
      });
      return;
    }
    if (value.autocompletePending || current.tui.renderRequested || current.tui.renderTimer || current.tui.immediateRenderScheduled) return;
    if (!value.readySent) {
      value.readySent = true;
      emit(value, { type: 'ready', generation: value.generation, frames: current.frames });
    }
    const remaining = [];
    for (const request of value.requests) {
      if (request.kind === 2) {
        const operation = value.operations.get(request.id);
        if (!operation) throw new Error(`Unknown terminal operation: ${request.id}`);
        if (!completed(value, operation)) { remaining.push(request); continue; }
        if (operation.error) emit(value, { type: 'error', id: request.id, message: operation.error });
        value.operations.delete(request.id);
        value.submissions = value.submissions.filter(entry => entry !== operation);
      }
      if (request.kind === 4) {
        const ready = captureReady(value, request, current);
        if (!ready) { remaining.push(request); continue; }
        if (ready === 'cancelled') continue;
      }
      const packet = { type: request.kind === 3 || request.kind === 4 ? 'capture' : 'frame', id: request.id, generation: value.generation, frames: current.frames,
        columns: current.tui.terminal.columns, rows: current.tui.terminal.rows,
        clearAfter: value.mode.lastSigintTime + interruptWindow + 1 };
      if (request.kind === 4) packet.sample = request.producer.sample();
      emit(value, packet);
    }
    value.requests = remaining;
  }
  replace(prototype, 'mountInteractiveTui', original => function (tui, ...args) {
    if (!tui || typeof tui.addInputListener !== 'function' || typeof tui.doRender !== 'function' ||
      typeof tui.terminal?.write !== 'function' || typeof tui.renderRequested !== 'boolean' ||
      typeof tui.immediateRenderScheduled !== 'boolean' || typeof tui.stopped !== 'boolean' || !('renderTimer' in tui)) {
      throw new Error('Unsupported Pi terminal observer renderer');
    }
    const value = state(this);
    let current = value.renderers.get(tui);
    if (!current) {
      current = { tui, frames: 0 };
      value.renderers.set(tui, current);
      const own = Object.getOwnPropertyDescriptor(tui, 'doRender'), render = tui.doRender;
      Object.defineProperty(tui, 'doRender', { configurable: true, writable: true, value: function (...renderArgs) {
        const result = Reflect.apply(render, this, renderArgs);
        current.frames++;
        schedule(value);
        return result;
      } });
      if (restorable) restorers.push(() => own ? Object.defineProperty(tui, 'doRender', own) : Reflect.deleteProperty(tui, 'doRender'));
      const remove = tui.addInputListener(data => {
        let consumed = false;
        const rest = data.replace(protocol, (_, digits, kind) => {
          consumed = true;
          const id = Number(digits);
          if (!Number.isSafeInteger(id) || id <= 0 || value.current !== current) throw new Error('Invalid or stale terminal fence');
          if (kind === '1') {
            if (value.operations.has(id)) throw new Error(`Duplicate terminal operation: ${id}`);
            const operation = { id };
            value.operations.set(id, operation);
            value.armed.push(operation);
            emit(value, { type: 'armed', id });
          } else if (kind === '5') {
            value.requests = value.requests.filter(request => request.kind !== 4 || request.id !== id);
            cancelCapture(value, { id }, 'Capture request was cancelled');
          } else {
            value.requests.push({ id, kind: Number(kind), ...(kind === '4' ? { generation: value.generation, producer: capture.producer, epoch: ++value.captureEpoch } : {}) });
            schedule(value);
          }
          return '';
        });
        if (consumed) return rest ? { data: rest } : { consume: true };
      });
      if (restorable) restorers.push(remove);
    }
    value.current = current;
    value.generation++;
    const result = Reflect.apply(original, this, [tui, ...args]);
    schedule(value);
    return result;
  });
  replace(prototype, 'getUserInput', original => function (...args) {
    const value = state(this);
    if (value.loopOperation) {
      value.loopOperation.loopFinished = true;
      value.loopOperation = undefined;
    }
    const result = Reflect.apply(original, this, args);
    if (!result || typeof result.then !== 'function') throw new Error('Unsupported native input-loop promise');
    value.ready = true;
    result.then(text => {
      const operation = value.submissions.find(entry => !entry.loopStarted && entry.text === text);
      if (operation) {
        operation.loopStarted = true;
        value.loopOperation = operation;
      }
      schedule(value);
    }, error => emit(value, { type: 'error', message: `Native input loop failed: ${error}` }));
    schedule(value);
    return result;
  });
  replace(prototype, 'setupEditorSubmitHandler', original => function (...args) {
    const result = Reflect.apply(original, this, args);
    const value = state(this), editor = this.defaultEditor;
    const descriptor = Object.getOwnPropertyDescriptor(editor, 'onSubmit'), submit = editor?.onSubmit;
    if (typeof submit !== 'function' || !descriptor) throw new Error('Unsupported native editor submit handler');
    Object.defineProperty(editor, 'onSubmit', { ...descriptor, value: function (text, ...submitArgs) {
      const operation = value.armed.shift();
      if (operation) {
        operation.text = text;
        value.submissions.push(operation);
      }
      let response;
      try { response = Reflect.apply(submit, this, [text, ...submitArgs]); }
      catch (error) {
        if (operation) { operation.error = String(error); operation.submitted = true; schedule(value); }
        throw error;
      }
      if (operation) {
        const done = error => {
          operation.submitted = true;
          if (error) operation.error = String(error);
          schedule(value);
        };
        if (response && typeof response.then === 'function') response.then(() => done(), done);
        else done();
      }
      return response;
    } });
    return result;
  });
  return () => { for (const restore of restorers.reverse()) restore(); };
}
