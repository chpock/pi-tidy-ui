import { CardSources } from '../../src/syntax/cards.ts';

// Primitive source markers belonging to the selected physical scenarios.
// UI strings containing them are excluded by the actual measurement call site.
export const selectedSyntaxSource = (text: string) => text.startsWith("printf 'SYNTAX_OUTPUT") || text.includes('const x=')
  || text.includes('STABLE_text') || text.includes('THEME_') || text.includes('HEADER_SCOPE')
  || text.includes('ONLINE_WAIT_') || text.includes('USER_BASH_OUTPUT') || text.includes('ORDER_CARD_');

export function observeSyntaxLocalWork(watches: (text: string) => boolean = selectedSyntaxSource) {
  let sourceSegments = 0, sourceSegmentUnits = 0, prefixScalarReads = 0, basisDepth = 0, sourceUpdateDepth = 0;
  const segment = Intl.Segmenter.prototype.segment, scalar = String.prototype.codePointAt, visit = CardSources.prototype.visit, update = CardSources.prototype.updateDisplay;
  const observedSegment = function(this: Intl.Segmenter, text: string) {
    if (typeof text === 'string' && (sourceUpdateDepth || watches(text)) && new Error().stack?.includes('measured-rows.ts')) { sourceSegments++; sourceSegmentUnits += text.length; }
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
    snapshot: () => ({ sourceSegments, sourceSegmentUnits, prefixScalarReads }),
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
  publication: number; status: 'ready' | 'pending' | 'stale' | 'failed' | 'refused' | 'waiting' | 'native'; sources: number;
  preparation?: { processed?: number; sourceRevision: number; palette?: number; lease?: number; receipt?: string };
};
type CardTicket = Parameters<CardSources<object>['prepare']>[0];
type CardState = NonNullable<ReturnType<CardTicket['state']['deref']>>;
type WriteReceipt = { revision: number; version: number; palette: number; theme: number; publication: number };

// Empty sources have no token table, but their role paint still needs adoption
// proof. refreshPaint assigns paintToken only together with the compiled paint.
function currentEmptyPiPaint(state: CardState): boolean {
  const input = state.input, paint = state.paint;
  if (!input || !paint || paint.origin !== 'pi' || paint.mode !== input.mode || state.pi?.terminalMode !== input.mode) return false;
  const group = paint.group;
  if (group && (group.palette !== `pi:${input.palette}` || group.bindingRevision !== input.palette)) return false;
  return state.paintToken === `${group?.stamp ?? -input.palette}:${input.mode}:`;
}

// No source/projection borrowing here: successful work and compiled token maps
// are inspected only at the original preparation and accepted-visit boundaries.
function writeReceipt(state: CardState, before: { processed?: number; palette?: number; publication?: number }): WriteReceipt | undefined {
  const input = state.input, paint = state.paint;
  if (input?.kind !== 'file' || !state.sourceEligible || !paint || paint.origin !== 'pi'
    || state.processed !== state.sourceRevision || state.preparedPalette !== input.palette
    || state.pi?.paletteRevision !== input.palette || paint.mode !== input.mode || state.pi.terminalMode !== input.mode || state.preparedTheme === undefined) return;
  const slots = [...state.slots.values()];
  if (!slots.length && !currentEmptyPiPaint(state)) return;
  if (slots.some(slot => slot.outcome !== 'pi' || slot.version !== state.version || slot.palette !== input.palette || !paint.piTokens.has(slot.key))) return;
  if (state.display?.kind !== 'file' || state.display.rows.some(row => [row.oldSource, row.nextSource].some(source => source && !state.slots.has(source.key)))) return;
  // A new source/palette cannot reuse the old compiled token map if compilation
  // was refused after successful classification. Repeated cached work may reuse it.
  if (slots.length && (before.processed !== state.sourceRevision || before.palette !== input.palette) && before.publication === paint.publication) return;
  return { revision: state.sourceRevision, version: state.version, palette: input.palette, theme: state.preparedTheme, publication: paint.publication };
}

export function observeSyntaxCards(record: (event: SyntaxCardObservation) => void,
  options: { writeCapture?: (event: WriteCaptureObservation) => void } = {}) {
  const prepare = CardSources.prototype.prepare, visit = CardSources.prototype.visit;
  let identities: WeakMap<object, { id: number; kind: string; path?: string; ticket: WeakRef<CardTicket>; receipt?: WriteReceipt; prior?: { processed?: number; palette?: number; publication?: number } }> | undefined = new WeakMap();
  let writes: WeakMap<object, WriteCaptureObservation> | undefined = options.writeCapture ? new WeakMap() : undefined;
  const publishWrite = (owner: object, event: WriteCaptureObservation) => {
    if (!identities || !writes) return;
    writes.set(owner, event); options.writeCapture?.(event);
  };
  const revokeWrite = (cards: CardSources<object>, owner: object, state?: CardState, force = false) => {
    const previous = writes?.get(owner); if (!identities || previous?.status !== 'ready') return;
    if (!force && state?.ticket?.owner.deref() === owner && previous.revision === state.revision
      && previous.version === state.version && previous.palette === state.input?.palette && previous.theme === Reflect.get(cards, 'themeRevision')) return;
    publishWrite(owner, { ...previous, id: state?.ticket?.id, revision: state?.revision ?? previous.revision,
      version: state?.version, palette: state?.input?.palette, theme: state?.preparedTheme, publication: state?.paint?.publication ?? previous.publication,
      path: state?.display?.kind === 'file' ? state.display.path ?? previous.path : previous.path,
      sources: state?.slots.size ?? 0, status: 'stale', preparation: state ? { processed: state.processed,
        sourceRevision: state.sourceRevision, palette: state.preparedPalette, lease: state.pi?.paletteRevision } : undefined });
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
        && state.processed === state.sourceRevision && state.preparedPalette === state.input?.palette
        && state.preparedTheme === Reflect.get(this, 'themeRevision')
        && [...state.slots.values()].every(slot => slot.version === state.version && slot.palette === state.input?.palette);
      const bad = currentSource && state && [...state.slots.values()].find(slot => slot.outcome === 'failed' || slot.outcome === 'refused' || slot.outcome === 'stale');
      const currentPaint = currentSource && receipt && state?.input?.palette === receipt.palette && state.version === receipt.version
        && state.sourceRevision === receipt.revision && state.preparedTheme === receipt.theme
        && (state.slots.size ? write.publication === receipt.publication : currentEmptyPiPaint(state))
        && state.paint?.publication === write.publication && state.paint.mode === state.input?.mode;
      publishWrite(owner, { call: write.call, id: identity?.id, path: write.path, revision: write.revision, version: state?.version,
        palette: state?.input?.palette, theme: state?.preparedTheme, publication: write.publication, sources: state?.slots.size ?? 0,
        preparation: state ? { processed: state.processed, sourceRevision: state.sourceRevision, palette: state.preparedPalette, lease: state.pi?.paletteRevision,
          receipt: receipt ? `${receipt.revision}/${receipt.version}/${receipt.palette}/${receipt.publication}` : undefined } : undefined,
        status: write.origin === 'native' ? 'native' : bad ? bad.outcome as 'failed' | 'refused' | 'stale'
          : currentPaint ? 'ready' : receipt ? 'stale' : currentSource ? 'waiting' : 'pending' });
    }
    return accepted;
  };
  CardSources.prototype.prepare = observedPrepare; CardSources.prototype.visit = observedVisit;
  return { restore() {
    identities = undefined; writes = undefined;
    if (CardSources.prototype.prepare === observedPrepare) CardSources.prototype.prepare = prepare;
    if (CardSources.prototype.visit === observedVisit) CardSources.prototype.visit = visit;
  } };
}

/** Finite, fixture-local primitive journal. It never owns a card or initiates work. */
export function createWriteCaptureGate(record: (event: WriteCaptureObservation) => void) {
  const current = new Map<string, WriteCaptureObservation>(), waiters = new Set<() => void>();
  let closed = false;
  const snapshot = () => [...current.values()].map(event => ({ ...event }));
  return {
    observe(event: WriteCaptureObservation) {
      if (closed || JSON.stringify(current.get(event.call)) === JSON.stringify(event)) return;
      current.set(event.call, { ...event }); record(event);
      for (const check of [...waiters]) check();
    },
    wait(): Promise<WriteCaptureObservation[]> {
      if (closed) return Promise.reject(new Error('Write capture observer is closed'));
      if (!current.size) return Promise.reject(new Error('Write capture has no observed source-card owners'));
      return new Promise((resolve, reject) => {
        const check = () => {
          const values = snapshot(), failure = values.find(event => ['failed', 'refused', 'native'].includes(event.status));
          if (closed || failure) { waiters.delete(check); reject(new Error(closed ? 'Write capture observer closed during wait' : `Write capture ${failure!.status}: ${failure!.call}`)); }
          else if (values.every(event => event.status === 'ready')) { waiters.delete(check); resolve(values); }
        };
        waiters.add(check); check();
      });
    },
    close() { closed = true; current.clear(); for (const check of [...waiters]) check(); waiters.clear(); },
  };
}
