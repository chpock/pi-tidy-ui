import { CardSources } from '../../src/syntax/cards.ts';
import { Theme } from '@earendil-works/pi-coding-agent';

// Primitive source markers belonging to the selected physical scenarios.
// UI strings containing them are excluded by the actual measurement call site.
export const selectedSyntaxSource = (text: string) => text.startsWith("printf 'SYNTAX_OUTPUT") || text.includes('const x=')
  || text.includes('STABLE_text') || text.includes('THEME_') || text.includes('HEADER_SCOPE')
  || text.includes('ONLINE_WAIT_') || text.includes('USER_BASH_OUTPUT') || text.includes('ORDER_CARD_') || text.includes('FOLLOW_PI_')
  || text.includes('#!/usr/bin/env python3') || text.includes('#!/usr/bin/env bash') || text.includes('echo "same"')
    || text.includes('NO_SHEBANG_CONTROL') || text.includes('BASH_NO_SHEBANG_HINT') || text.includes('SHEBANG_FILE_ONLY_MEASURE_7F3A');

export function observeSyntaxLocalWork(watches: (text: string) => boolean = selectedSyntaxSource) {
  let sourceSegments = 0, sourceSegmentUnits = 0, shebangFileSegments = 0, prefixScalarReads = 0, basisDepth = 0, sourceUpdateDepth = 0;
  const segment = Intl.Segmenter.prototype.segment, scalar = String.prototype.codePointAt, visit = CardSources.prototype.visit, update = CardSources.prototype.updateDisplay;
  const observedSegment = function(this: Intl.Segmenter, text: string) {
    if (typeof text === 'string' && (sourceUpdateDepth || watches(text)) && new Error().stack?.includes('measured-rows.ts')) {
      sourceSegments++; sourceSegmentUnits += text.length;
      if (text.includes('SHEBANG_FILE_ONLY_MEASURE_7F3A')) shebangFileSegments++;
    }
    return segment.call(this, text);
  };
  const observedScalar = function(this: string, index: number) {
    // A geometry-only paint.basis visitor does not read any source scalars.
    // Count actual reads inside an owned basis callback, not basis borrowing.
    if (basisDepth && watches(String(this))) prefixScalarReads++;
    return scalar.call(this, index);
  };
  const observedVisit = function(this: CardSources<object>, owner: object, consume: Parameters<typeof visit>[1]) {
    return visit.call(this, owner, (display, paint) => {
      const observedPaint = Object.create(paint, { basis: { value: (key: string, read: Parameters<typeof paint.basis>[1]) =>
        paint.basis(key, (text, ranges) => { basisDepth++; try { read(text, ranges); } finally { basisDepth--; } }) } });
      consume(display, observedPaint);
    });
  };
  const observedUpdate = function(this: CardSources<object>, ...args: Parameters<typeof update>) {
    const input = args[1], selected = input.kind === 'bash' && typeof input.args?.command === 'string' && watches(input.args.command);
    // Appended graphemes need not contain the full source marker. Correlate only
    // this synchronous update, without retaining its component or source text.
    if (selected) sourceUpdateDepth++;
    try { return update.apply(this, args); } finally { if (selected) sourceUpdateDepth--; }
  };
  CardSources.prototype.updateDisplay = observedUpdate;
  Intl.Segmenter.prototype.segment = observedSegment;
  String.prototype.codePointAt = observedScalar;
  CardSources.prototype.visit = observedVisit;
  return {
    snapshot: () => ({ sourceSegments, sourceSegmentUnits, shebangFileSegments, prefixScalarReads }),
    restore() {
      if (Intl.Segmenter.prototype.segment === observedSegment) Intl.Segmenter.prototype.segment = segment;
      if (String.prototype.codePointAt === observedScalar) String.prototype.codePointAt = scalar;
      if (CardSources.prototype.visit === observedVisit) CardSources.prototype.visit = visit;
      if (CardSources.prototype.updateDisplay === observedUpdate) CardSources.prototype.updateDisplay = update;
    },
  };
}

export type SyntaxCardObservation = { type: 'syntax_card_prepare' | 'syntax_card_prepared'; id: number; kind: string; path?: string }
  | { type: 'syntax_card_publication'; id: number; kind: string; path?: string; mode?: string; publication: number; paintStamp: number; origin: string };

export type WriteCaptureObservation = {
  call: string; id?: number; path: string; revision: number; version?: number; palette?: number; theme?: number;
  publication: number; status: 'ready' | 'pending' | 'stale' | 'failed' | 'refused' | 'waiting' | 'owned'; sources: number;
  preparation?: { processed?: number; sourceRevision: number; palette?: string; lease?: number; receipt?: string };
};
type CardTicket = Parameters<CardSources<object>['prepare']>[0];
type CardState = NonNullable<ReturnType<CardTicket['state']['deref']>>;
type WriteReceipt = { revision: number; version: number; palette: number; theme: number; publication: number };
type WriteCaptureJournal = {
  activate(call: string, owner: object): void;
  observe(event: WriteCaptureObservation, owner: object): void;
  retire(call: string, owner: object): void;
};

// Empty sources have no token table, but their role paint still needs adoption
// proof. refreshPaint assigns paintToken only together with the compiled paint.
function currentEmptyPiPaint(state: CardState): boolean {
  const input = state.input, paint = state.paint;
  if (!input || !paint || paint.origin !== 'pi' || paint.mode !== input.mode || state.paletteInput?.terminalMode !== input.mode) return false;
  const group = paint.group;
  if (group && (group.palette !== paint.palette || group.bindingRevision !== input.palette)) return false;
  return state.paintToken === `${paint.palette}:${group?.stamp ?? -(input.palette + 1)}:${input.mode}:`;
}

// No source/projection borrowing here: successful work and compiled token maps
// are inspected only at the original preparation and accepted-visit boundaries.
function writeReceipt(state: CardState, before: { processed?: number; palette?: string; publication?: number }): WriteReceipt | undefined {
  const input = state.input, paint = state.paint;
  if (input?.kind !== 'file' || !state.sourceEligible || !paint || paint.origin !== 'pi'
    || state.processed !== state.sourceRevision || state.preparedPalette !== paint.palette
    || state.paletteInput?.paletteRevision !== input.palette || paint.mode !== input.mode || state.paletteInput.terminalMode !== input.mode || state.preparedTheme === undefined) return;
  const slots = [...state.slots.values()];
  if (!slots.length && !currentEmptyPiPaint(state)) return;
  if (slots.some(slot => slot.outcome !== 'pi' || slot.version !== state.version || slot.palette !== input.palette || !paint.piTokens.has(slot.key))) return;
  if (state.display?.kind !== 'file' || state.display.rows.some(row => [row.oldSource, row.nextSource].some(source => source && !state.slots.has(source.key)))) return;
  // A new source/palette cannot reuse the old compiled token map if compilation
  // was refused after successful classification. Repeated cached work may reuse it.
  if (slots.length && (before.processed !== state.sourceRevision || before.palette !== paint.palette) && before.publication === paint.publication) return;
  return { revision: state.sourceRevision, version: state.version, palette: input.palette, theme: state.preparedTheme, publication: paint.publication };
}

export function observeSyntaxCards(record: (event: SyntaxCardObservation) => void,
  options: { writeCapture?: WriteCaptureJournal } = {}) {
  const prepare = CardSources.prototype.prepare, visit = CardSources.prototype.visit, useful = CardSources.prototype.useful;
  const pause = CardSources.prototype.pause, remove = CardSources.prototype.remove;
  let identities: WeakMap<object, { id: number; kind: string; path?: string; ticket: WeakRef<CardTicket>; receipt?: WriteReceipt; prior?: { processed?: number; palette?: string; publication?: number } }> | undefined = new WeakMap();
  let writes: WeakMap<object, WriteCaptureObservation> | undefined = options.writeCapture ? new WeakMap() : undefined;
  const publishWrite = (owner: object, event: WriteCaptureObservation) => {
    if (!identities || !writes) return;
    writes.set(owner, event); options.writeCapture?.observe(event, owner);
  };
  const writeCall = (owner: object) => Reflect.get(owner, 'toolName') === 'write' ? Reflect.get(owner, 'toolCallId') : undefined;
  const retireWrite = (owner: object) => {
    const call = writeCall(owner);
    if (typeof call === 'string') options.writeCapture?.retire(call, owner);
  };
  const revokeWrite = (cards: CardSources<object>, owner: object, state?: CardState, force = false) => {
    const previous = writes?.get(owner); if (!identities || previous?.status !== 'ready') return;
    if (!force && state?.ticket?.owner.deref() === owner && previous.revision === state.revision
      && previous.version === state.version && previous.palette === state.input?.palette && previous.theme === Reflect.get(cards, 'themeRevision')) return;
    publishWrite(owner, { ...previous, id: state?.ticket?.id, revision: state?.revision ?? previous.revision,
      version: state?.version, palette: state?.input?.palette, theme: state?.preparedTheme, publication: state?.paint?.publication ?? previous.publication,
      path: state?.display?.kind === 'file' ? state.display.path ?? previous.path : previous.path,
      sources: state?.slots.size ?? 0, status: 'stale', preparation: state ? { processed: state.processed,
        sourceRevision: state.sourceRevision, palette: state.preparedPalette, lease: state.paletteInput?.paletteRevision } : undefined });
  };
  const observedPrepare: typeof prepare = function(this: CardSources<object>, ticket) {
    if (!identities) return prepare.call(this, ticket);
    const state = ticket.state.deref(), input = state?.input;
    const identity = input && { id: ticket.id, kind: input.kind === 'file' ? input.node.toolName ?? 'file' : 'bash',
      path: input.kind === 'file' && typeof input.node.args.path === 'string' ? input.node.args.path : undefined };
    const before = state?.preparedTheme, owner = ticket.owner.deref();
    const association = identity && { ...identity, ticket: new WeakRef(ticket), receipt: owner ? identities.get(owner)?.receipt : undefined };
    const prior = { processed: state?.processed, palette: state?.preparedPalette, publication: state?.paint?.publication };
    if (association && owner) identities.set(owner, association);
    if (owner) revokeWrite(this, owner, state);
    if (options.writeCapture && association) Object.assign(association, { prior });
    if (identity) record({ type: 'syntax_card_prepare', ...identity });
    try {
      prepare.call(this, ticket);
      if (options.writeCapture && identities && association && state?.ticket === ticket) association.receipt = writeReceipt(state, prior);
    } finally { if (association) Reflect.deleteProperty(association, 'prior'); }
    if (identities && identity && state?.ticket === ticket && state.preparedTheme !== before && state.processed === state.sourceRevision)
      record({ type: 'syntax_card_prepared', ...identity });
  };
  const observedVisit: typeof visit = function(this: CardSources<object>, owner, consume) {
    if (!identities) return visit.call(this, owner, consume);
    revokeWrite(this, owner, identities.get(owner)?.ticket.deref()?.state.deref());
    let candidate: SyntaxCardObservation | undefined;
    let write: { call: string; path: string; revision: number; publication: number; origin: string } | undefined;
    let accepted = false;
    try { accepted = visit.call(this, owner, (display, paint) => {
      const identity = identities?.get(owner);
      if (identity) candidate = { type: 'syntax_card_publication', id: identity.id, kind: identity.kind, path: identity.path,
        mode: display.kind === 'file' ? display.mode : undefined, publication: paint.publication, paintStamp: paint.paintStamp, origin: paint.origin };
      if (options.writeCapture && display.kind === 'file' && display.mode && Reflect.get(owner, 'toolName') === 'write') {
        const call = Reflect.get(owner, 'toolCallId');
        if (typeof call === 'string' && display.path) write = { call, path: display.path, revision: display.revision, publication: paint.publication, origin: paint.origin };
      }
      consume(display, paint);
    }); } finally {
      if (!accepted) revokeWrite(this, owner, identities?.get(owner)?.ticket.deref()?.state.deref(), true);
    }
    if (identities && accepted && candidate) record(candidate);
    if (identities && accepted && write) {
      const identity = identities.get(owner), ticket = identity?.ticket.deref(), state = ticket?.state.deref();
      // refreshPaint may synchronously invalidate/visit while prepare is still on
      // stack. That accepted publication must not require an unrelated later frame.
      const receipt = identity?.prior && state ? writeReceipt(state, identity.prior) : identity?.receipt;
      const currentSource = !!state && state.ticket === ticket && ticket?.owner.deref() === owner && state.revision === write.revision
        && state.processed === state.sourceRevision && state.preparedPalette === state.paint?.palette
        && state.preparedTheme === Reflect.get(this, 'themeRevision')
        && [...state.slots.values()].every(slot => slot.version === state.version && slot.palette === state.input?.palette);
      const bad = currentSource && state && [...state.slots.values()].find(slot => slot.outcome === 'failed' || slot.outcome === 'refused' || slot.outcome === 'stale');
      const currentPaint = currentSource && receipt && state?.input?.palette === receipt.palette && state.version === receipt.version
        && state.sourceRevision === receipt.revision && state.preparedTheme === receipt.theme
        && (state.slots.size ? write.publication === receipt.publication : currentEmptyPiPaint(state))
        && state.paint?.publication === write.publication && state.paint.mode === state.input?.mode;
      publishWrite(owner, { call: write.call, id: identity?.id, path: write.path, revision: write.revision, version: state?.version,
        palette: state?.input?.palette, theme: state?.preparedTheme, publication: write.publication, sources: state?.slots.size ?? 0,
        preparation: state ? { processed: state.processed, sourceRevision: state.sourceRevision, palette: state.preparedPalette, lease: state.paletteInput?.paletteRevision,
          receipt: receipt ? `${receipt.revision}/${receipt.version}/${receipt.palette}/${receipt.publication}` : undefined } : undefined,
        status: write.origin === 'owned' ? 'owned' : bad ? bad.outcome as 'failed' | 'refused' | 'stale'
          : currentPaint ? 'ready' : receipt ? 'stale' : currentSource ? 'waiting' : 'pending' });
    }
    return accepted;
  };
  const observedUseful: typeof useful = function(this: CardSources<object>, owner, revision) {
    useful.call(this, owner, revision);
    if (!identities || !writes || !options.writeCapture || Reflect.get(owner, 'toolName') !== 'write') return;
    const states = Reflect.get(this, 'states');
    const state = states instanceof WeakMap ? states.get(owner) as CardState | undefined : undefined;
    if (!state || state.revision !== revision || !state.useful || state.paused || state.ticket?.owner.deref() !== owner) return;
    const call = Reflect.get(owner, 'toolCallId');
    if (typeof call !== 'string') throw new Error('Write capture owner has no tool-call identity');
    options.writeCapture.activate(call, owner);
    const event = writes.get(owner);
    if (event) options.writeCapture.observe(event, owner);
  };
  const observedPause: typeof pause = function(this: CardSources<object>, owner) {
    pause.call(this, owner); retireWrite(owner);
  };
  const observedRemove: typeof remove = function(this: CardSources<object>, owner) {
    retireWrite(owner);
    try { remove.call(this, owner); } finally { identities?.delete(owner); writes?.delete(owner); }
  };
  CardSources.prototype.prepare = observedPrepare; CardSources.prototype.visit = observedVisit;
  if (options.writeCapture) {
    CardSources.prototype.useful = observedUseful; CardSources.prototype.pause = observedPause; CardSources.prototype.remove = observedRemove;
  }
  return { restore() {
    identities = undefined; writes = undefined;
    if (CardSources.prototype.prepare === observedPrepare) CardSources.prototype.prepare = prepare;
    if (CardSources.prototype.visit === observedVisit) CardSources.prototype.visit = visit;
    if (CardSources.prototype.useful === observedUseful) CardSources.prototype.useful = useful;
    if (CardSources.prototype.pause === observedPause) CardSources.prototype.pause = pause;
    if (CardSources.prototype.remove === observedRemove) CardSources.prototype.remove = remove;
  } };
}

export function createWriteCaptureGate(record: (event: WriteCaptureObservation) => void) {
  type Participant = { owner: WeakRef<object>; event?: WriteCaptureObservation };
  const current = new Map<string, Participant>(), waiters = new Set<() => void>();
  let closed = false;
  const live = () => {
    const values: Participant[] = [];
    for (const [call, participant] of current) {
      if (!participant.owner.deref()) current.delete(call);
      else values.push(participant);
    }
    return values;
  };
  const notify = () => { for (const check of [...waiters]) check(); };
  return {
    activate(call: string, owner: object) {
      if (closed) return;
      const previous = current.get(call);
      if (previous?.owner.deref() === owner) return;
      current.set(call, { owner: new WeakRef(owner) });
      notify();
    },
    observe(event: WriteCaptureObservation, owner: object) {
      if (closed) return;
      const participant = current.get(event.call);
      if (!participant || participant.owner.deref() !== owner || JSON.stringify(participant.event) === JSON.stringify(event)) return;
      participant.event = { ...event }; record(event); notify();
    },
    retire(call: string, owner: object) {
      const participant = current.get(call);
      if (!participant || participant.owner.deref() !== owner) return;
      current.delete(call); notify();
    },
    wait(): Promise<WriteCaptureObservation[]> {
      if (closed) return Promise.reject(new Error('Write capture observer is closed'));
      if (!live().length) return Promise.reject(new Error('Write capture has no observed source-card owners'));
      return new Promise((resolve, reject) => {
        const check = () => {
          const participants = live(), events = participants.flatMap(participant => participant.event ? [participant.event] : []);
          const failure = events.find(event => ['failed', 'refused', 'owned'].includes(event.status));
          if (closed || failure || !participants.length) {
            waiters.delete(check);
            reject(new Error(closed ? 'Write capture observer closed during wait' : failure
              ? `Write capture ${failure.status}: ${failure.call}` : 'Write capture has no observed source-card owners'));
          } else if (participants.every(participant => participant.event?.status === 'ready')) {
            waiters.delete(check); resolve(events.map(event => ({ ...event })));
          }
        };
        waiters.add(check); check();
      });
    },
    close() { closed = true; current.clear(); notify(); waiters.clear(); },
  };
}

// Test-only operation counters, not timing or render-time product instrumentation.
export function observePiPaletteWork() {
  const background = Theme.prototype.getBgAnsi;
  let paletteSamples = 0;
  const observedBackground: typeof background = function(this: Theme, ...args) {
    if (args[0] === 'toolPendingBg' && new Error().stack?.includes('pi-palette.ts')) paletteSamples++;
    return background.apply(this, args);
  };
  Theme.prototype.getBgAnsi = observedBackground;
  return {
    snapshot: () => ({ paletteSamples }),
    restore() {
      if (Theme.prototype.getBgAnsi === observedBackground) Theme.prototype.getBgAnsi = background;
    },
  };
}
