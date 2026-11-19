import { concreteStyle, expectation, prepareSelection, selectionBytes, type PreparedSelection, type StyleRoles, type StyleSelection } from './controller-styles.ts';
import type { SourceWorkGroup } from './work-registry.ts';
import { dropCardPublication, publishGroupReady, visitGroupReady, type GroupMember, type GroupReady, type GroupReadyMember, type GroupSeal } from './card-publication.ts';
import { collectStyleContexts, estimateStyleRepresentation } from './style-preparation.ts';
import type { DataCharge, DataGrant } from '../resources/data-budget.ts';
import type { ContextRef } from './storage/context-arena.ts';
import { CARD_ROLES, type CardRole } from '../appearance/card-roles.ts';
import type { SemanticCaptureGroup, SemanticCaptureGroupView, SemanticCaptureView } from './storage/semantic-capture.ts';
import { decodeSemanticStyleReply, type SemanticDescription as Description } from '../occipital/semantic-protocol.ts';
import type { CaptureSelection, ReadyDisplayUpdate } from './storage/ready-display-publication.ts';
import { diagnosticError, reportRuntime, unexpectedDiagnostic, type DiagnosticSink } from '../diagnostics.ts';
import { RemoteFault } from '../occipital/protocol.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { DisplayRangeReader, GroupDisplayBasis, GroupDisplayMember, SourceDisplayBasis } from './source-ports.ts';
import type { SemanticRetentionPool } from './storage/semantic-retention.ts';
import { OCCIPITAL_LIMITS } from '../occipital/limits.ts';
import { HIGHLIGHT_LIMITS } from './limits.ts';
import { sourceIdentifier as identifier } from './controller-limits.ts';
import type { ProviderBroker, ProviderClock } from '../occipital/provider.ts';
import { matchingSourceVersion } from './source-state.ts';
import { nextStyle, styleFaultCause, type StyleCause } from './style-state.ts';
import type { SourceExecution } from './source-execution.ts';
import type { PresentationRecord, PublicationNode, PublicationRegistry, StyleCache, StyleCleanup, StyleCounters, StyleFailure, StyleJobView, StyleMember, StyleReplyView, StyleSubject } from './execution-records.ts';

export function displayGeneration(state: Pick<PresentationRecord, 'generation' | 'previous'>, pool: Pick<SemanticRetentionPool, 'displayStatus'>): number | undefined {
  return state.generation !== undefined && pool.displayStatus(state.generation) !== undefined ? state.generation : state.previous;
}

export function displayVisit(owner: WeakRef<PublicationExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (text: string, read: DisplayRangeReader) => void) => owner.deref()?.visitDisplayBasis(key, id, generation, version, stamp, consume) ?? false;
}

export function displayRanges(owner: WeakRef<PublicationExecution>, key: string, id: number, generation: number, version: number, stamp: number): DisplayRangeReader {
  return consume => owner.deref()?.visitDisplayRanges(key, id, generation, version, stamp, consume) ?? false;
}

export function displayRole(owner: WeakRef<PublicationExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (role: CardRole) => owner.deref()?.readDisplayRole(key, id, generation, version, stamp, role);
}

export function displayStyles(owner: WeakRef<PublicationExecution>, key: string, id: number, generation: number, version: number, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitDisplayStyles(key, id, generation, version, stamp, consume) ?? false;
}

export function groupStyles(owner: WeakRef<PublicationExecution>, node: WeakRef<PublicationNode>, stamp: number) {
  return (consume: (style: ConcreteStyle) => void) => owner.deref()?.visitGroupStyles(node, stamp, consume) ?? false;
}

export function groupRole(owner: WeakRef<PublicationExecution>, node: WeakRef<PublicationNode>, stamp: number) {
  return (role: CardRole) => owner.deref()?.readGroupRole(node, stamp, role);
}

export function groupVisit(owner: WeakRef<PublicationExecution>, node: WeakRef<PublicationNode>, stamp: number) {
  return (consume: (member: (key: string) => GroupDisplayMember | undefined) => void) => owner.deref()?.visitGroup(node, stamp, consume) ?? false;
}

export function groupMember(owner: WeakRef<PublicationExecution>, node: WeakRef<PublicationNode>, stamp: number) {
  return (key: string) => owner.deref()?.readGroupMember(node, stamp, key);
}

export function groupRanges(owner: WeakRef<PublicationExecution>, node: WeakRef<PublicationNode>, stamp: number, key: string): DisplayRangeReader {
  return consume => owner.deref()?.visitGroupRanges(node, stamp, key, consume) ?? false;
}

function equalInk(a: ConcreteStyle['foreground'], b: ConcreteStyle['foreground']): boolean {
  return a.kind === 'rgb' ? b.kind === 'rgb' && a.r === b.r && a.g === b.g && a.b === b.b
    : a.kind === 'indexed' ? b.kind === 'indexed' && a.index === b.index : b.kind === 'terminal-default';
}

function equalRoles(a: StyleRoles, b: StyleRoles): boolean {
  return CARD_ROLES.every(role => a[role].attributes === b[role].attributes && equalInk(a[role].foreground, b[role].foreground)
    && equalInk(a[role].background, b[role].background));
}

export class StylePublication {
  private readonly owner: WeakRef<PublicationExecution>;
  private readonly pool: SemanticRetentionPool;
  private readonly provider: Pick<ProviderBroker, 'snapshot' | 'isReady'>;
  private readonly work: PublicationRegistry;
  private readonly clock: Pick<ProviderClock, 'now'>;
  private readonly diagnostic?: DiagnosticSink;
  private readonly counters: StyleCounters;
  private readonly cleanup: StyleCleanup;
  private selection?: PreparedSelection;
  private selectionCharge?: DataCharge;
  private styleEpoch = 0;
  private styleRevision = 0;
  private readonly styleCache = new Map<string, StyleCache>();
  private displaySequence = 0;

  constructor(owner: WeakRef<PublicationExecution>, pool: SemanticRetentionPool, provider: Pick<ProviderBroker, 'snapshot' | 'isReady'>,
    work: PublicationRegistry, clock: Pick<ProviderClock, 'now'>, diagnostic: DiagnosticSink | undefined,
    counters: StyleCounters, cleanup: StyleCleanup) {
    this.owner = owner; this.pool = pool; this.provider = provider; this.work = work; this.clock = clock;
    this.diagnostic = diagnostic; this.counters = counters; this.cleanup = cleanup;
  }
  private execution(): PublicationExecution { return this.owner.deref()!; }
  get selectionPresent(): boolean { return !!this.selection; }

  sourceUnavailable(state: PresentationRecord): void { state.styleDirty = false; }
  aliasInputDisplay(state: PresentationRecord, oldVersion: number, nextVersion: number, displayedText: string | undefined, nextText: string, complete: boolean): void {
    if (state.displayVersion === undefined) return;
    const displayed = displayedText ?? (state.previous === undefined ? undefined : this.pool.borrowSnapshot(state.previous, 'basis')?.text);
    state.displayVersion = complete && state.displayVersion === oldVersion && displayed === nextText ? nextVersion : undefined;
  }
  sourceReused(state: PresentationRecord): void {
    const display = this.pool.displayStatus(displayGeneration(state, this.pool)!);
    state.displayVersion = display?.complete && matchingSourceVersion(state, display.sourceVersion) ? state.version : undefined;
  }
  sourceAdopted(state: PresentationRecord, sameSemantic: boolean): void {
    state.styleDirty = true; this.invalidateSource(state, sameSemantic, !sameSemantic);
  }
  freezeDisplay(state: PresentationRecord, retainedGeneration: number | undefined): void {
    if (retainedGeneration === undefined) state.displayStamp = 0;
  }
  clearDisplayReceipt(state: PresentationRecord): void {
    state.displayStamp = 0; state.displayPalette = undefined; state.displayRules = undefined; state.displayVersion = undefined;
  }
  withdrawDisplay(state: PresentationRecord, generation: number, mode: 'prior-group' | 'prior-notice' | 'current'): void {
    if (mode === 'prior-group') {
      const node = state.group && this.work.get(state.group), member = node?.ready?.members.get(state.key);
      if (node && member?.id === state.id && member.generation === generation) this.dropGroup(node);
    } else if (mode === 'prior-notice') {
      if (state.generation === undefined || this.pool.status(state.generation)?.sourceVersion === undefined) {
        state.displayStamp = 0; this.execution().changed(state.key);
      }
    } else {
      state.displayStamp = 0;
      if (state.group) { const node = this.work.get(state.group); if (node) this.dropGroup(node); }
      this.execution().changed(state.key);
    }
  }
  disposeSelectionAndCache(): void { this.releaseSelection(); this.selection = undefined; this.clearCache(); }
  private unexpectedStyleFailure(job: StyleReplyView, error: unknown): boolean {
    return !job.stopped && !job.abort.signal.aborted && !this.execution().publicationDisposed && unexpectedDiagnostic(error);
  }

  /** One desired trusted rule/binding generation; source/parser identity is unchanged. */
  setStyleSelection(input: StyleSelection | undefined): boolean {
    if (this.execution().publicationDisposed) return false;
    if (!input) {
      if (!this.selection) return true;
      this.selection = undefined; this.releaseSelection(); this.styleEpoch++; this.work.rewind(); this.execution().reconcileCreditInterest(); return true;
    }
    const bytes = selectionBytes(input), reserved = this.pool.reserve(undefined, bytes); this.execution().receipts(reserved.released);
    if (!reserved.accepted) return false;
    const grant = this.pool.budget.reserve(bytes); if (!grant) return false;
    try {
      const next = prepareSelection(input), charge = grant.consume(bytes), previous = this.selection;
      const rulesChanged = !previous || previous.rules !== next.rules;
      this.releaseSelection(); this.selectionCharge = charge; this.cleanup.charges.add(charge); this.selection = next;
      if (rulesChanged) {
        for (const state of this.execution().sources()) state.styleDirty = true;
        this.styleEpoch++;
      }
      this.work.rewind(); this.work.schedule(); if (rulesChanged) this.execution().reconcileCreditInterest(); return true;
    } finally { grant.close(); }
  }

  private releaseSelection(): void {
    if (this.selectionCharge) { this.cleanup.charges.delete(this.selectionCharge); this.selectionCharge.release(); this.selectionCharge = undefined; }
  }

  clearCache(): void {
    for (const [key, cache] of this.styleCache) {
      // Pressure cannot reclaim a useful group's pin. Keep that same funded
      // cache association discoverable instead of requesting its roles again.
      let pinned = false;
      for (const hold of this.cleanup.groups) if (hold.pin === cache.charge) { pinned = true; break; }
      if (pinned) continue;
      this.styleCache.delete(key); this.cleanup.charges.delete(cache.charge); cache.charge.release();
    }
    for (const state of this.execution().sources()) this.clearCoverage(state);
  }

  /** Cold, idempotent ordered membership seal after logical preparation.
   * Call explicitly after membership edits outside prepare(); registration alone is not useful demand. */
  updatePreparation(group: SourceWorkGroup): boolean {
    const node = this.work.get(group);
    if (!node || !group.preparation.deref() || !this.execution().publicationEnabled || this.execution().publicationDisposed) return false;
    if (node.seal && this.sealMatches(group, node.seal)) return true;
    this.dropGroup(node, true);
    node.styleRevision = ++this.styleRevision; node.attempt = undefined; this.clearStyleRefusal(node);
    let bytes = 256;
    for (const key of group.keys) {
      if (this.execution().source(key)?.group !== group || !identifier(key)) return false;
      bytes += 256 + 2 * key.length;
    }
    const grant = this.pool.budget.reserve(bytes); if (!grant) return false;
    try {
      const members: GroupMember[] = [];
      for (const key of group.keys) members.push({ key, id: this.execution().source(key)!.id });
      const seal = { members, revision: node.styleRevision, charge: grant.consume(bytes) };
      node.seal = seal; this.cleanup.charges.add(seal.charge);
      if (this.execution().publicationPreparing !== group) { this.work.rewind(); this.work.schedule(); } return true;
    } finally { grant.close(); }
  }

  private sealMatches(group: SourceWorkGroup, seal: GroupSeal): boolean {
    if (group.keys.size !== seal.members.length) return false;
    let i = 0;
    for (const key of group.keys) {
      const member = seal.members[i++]!;
      if (member.key !== key || this.execution().source(key)?.id !== member.id) return false;
    }
    return true;
  }

  dropGroup(node: PublicationNode, seal = false): void {
    if (dropCardPublication(node, this.cleanup.groups, this.cleanup.charges, seal) && 'preparation' in node.value)
      this.execution().changedGroup(node.value.id);
  }

  groupPresentation(group: SourceWorkGroup): GroupDisplayBasis | undefined {
    const node = this.work.get(group), ready = node?.ready;
    if (!node || !ready || !this.groupCurrent(node, ready.stamp)) return undefined;
    const weak = new WeakRef(node);
    return {
      stamp: ready.stamp, paintStamp: ready.paintStamp,
      rules: ready.rules, palette: ready.palette, bindingRevision: ready.bindingRevision,
      role: groupRole(this.owner, weak, ready.stamp), visitStyles: groupStyles(this.owner, weak, ready.stamp),
      visit: groupVisit(this.owner, weak, ready.stamp)
    };
  }

  private groupCurrent(node: PublicationNode, stamp: number, boundary = false): boolean {
    const entry = node.value, ready = node.ready;
    if (this.execution().publicationDisposed || !this.execution().publicationEnabled || !ready || ready.stamp !== stamp || !('preparation' in entry)
      || this.work.get(entry) !== node || !entry.preparation.deref() || !node.seal || entry.keys.size !== node.seal.members.length) return false;
    // Trust only this exact publication during a synchronous validated borrow.
    // Cold mutations revoke node.ready; the outer boundary still checks every source and ordered key.
    if (ready.readers && !boundary) return true;
    if (!this.sealMatches(entry, node.seal)) return false;
    for (const member of ready.members.values()) {
      if (!this.currentDisplay(member.key, member.id, member.generation, member.version, member.stamp)) return false;
    }
    return true;
  }

  readGroupRole(weak: WeakRef<PublicationNode>, stamp: number, role: CardRole): ConcreteStyle | undefined {
    const node = weak.deref();
    // Membership/source mutations invalidate the node on their cold update path.
    return !this.execution().publicationDisposed && this.execution().publicationEnabled && node?.ready?.stamp === stamp && 'preparation' in node.value
      && !!node.value.preparation.deref() && this.work.get(node.value) === node ? node.ready.roles[role] : undefined;
  }

  visitGroupStyles(weak: WeakRef<PublicationNode>, stamp: number, consume: (style: ConcreteStyle) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), (_node, ready) => {
      for (const role of CARD_ROLES) {
        if (!this.readGroupRole(weak, stamp, role)) return false;
        consume(ready.roles[role]);
      }
      for (const member of ready.members.values()) {
        if (!this.readGroupRole(weak, stamp, 'code')) return false;
        if (!this.visitDisplayStyles(member.key, member.id, member.generation, member.version, member.stamp, style => {
          if (this.readGroupRole(weak, stamp, 'code')) consume(style);
        })) return false;
      }
      return true;
    });
  }

  visitGroup(weak: WeakRef<PublicationNode>, stamp: number, consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), () => {
      consume(groupMember(this.owner, weak, stamp)); return true;
    });
  }

  readGroupMember(weak: WeakRef<PublicationNode>, stamp: number, key: string): GroupDisplayMember | undefined {
    const node = weak.deref(); if (!node || !this.groupCurrent(node, stamp)) return undefined;
    const member = node.ready!.members.get(key);
    return member && this.currentDisplay(key, member.id, member.generation, member.version, member.stamp) ? {
      key, generation: member.generation, version: member.version, stamp: member.stamp,
      geometryStamp: member.geometryStamp, paintStamp: member.paintStamp, complete: member.complete,
      read: groupRanges(this.owner, weak, stamp, key)
    } : undefined;
  }

  visitGroupRanges(weak: WeakRef<PublicationNode>, stamp: number, key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    return visitGroupReady(weak, stamp, (node, currentStamp, boundary) => this.groupCurrent(node, currentStamp, boundary), (node, ready) => {
      const member = ready.members.get(key); if (!member) return false;
      return this.visitDisplayRanges(key, member.id, member.generation, member.version, member.stamp, (from, to, style) => {
        if (this.groupCurrent(node, stamp)) consume(from, to, style);
      });
    });
  }

  /** Historical display reads are not current-source proof. Persistent views keep only weak ownership and primitives. */
  displayBasis(key: string): SourceDisplayBasis | undefined {
    const state = this.execution().source(key);
    if (this.execution().publicationDisposed || !this.execution().publicationEnabled || !state || !state.displayStamp) return undefined;
    const generation = displayGeneration(state, this.pool);
    if (generation === undefined) return undefined;
    const display = this.pool.displayStatus(generation);
    if (!display) return undefined;
    const version = display.sourceVersion;
    return {
      generation, version, stamp: state.displayStamp, language: state.language,
      palette: display.palette, rules: display.rules, bindingRevision: display.bindingRevision,
      complete: display.complete, exactVersion: state.displayVersion, geometryStamp: display.geometryStamp, paintStamp: display.effectStamp,
      role: displayRole(this.owner, key, state.id, generation, version, state.displayStamp),
      visitStyles: displayStyles(this.owner, key, state.id, generation, version, state.displayStamp),
      visit: displayVisit(this.owner, key, state.id, generation, version, state.displayStamp)
    };
  }

  displayStamp(key: string, palette?: string, rules?: string, language?: string): number {
    const state = this.execution().source(key);
    const display = state && displayGeneration(state, this.pool) !== undefined ? this.pool.displayStatus(displayGeneration(state, this.pool)!) : undefined;
    return !this.execution().publicationDisposed && this.execution().publicationEnabled && state && (palette === undefined || display?.palette === palette && display.rules === rules && state.language === language)
      ? state.displayStamp : 0;
  }

  private currentDisplay(key: string, id: number, generation: number, version: number, stamp: number): boolean {
    const state = this.execution().source(key);
    return !this.execution().publicationDisposed && this.execution().publicationEnabled && state?.id === id && state.displayStamp === stamp
      && displayGeneration(state, this.pool) === generation && this.pool.displayStatus(generation)?.sourceVersion === version;
  }

  readDisplayRole(key: string, id: number, generation: number, version: number, stamp: number, role: CardRole): ConcreteStyle | undefined {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return undefined;
    return this.pool.displayRole(generation, this.pool.displayStatus(generation)!.effectStamp, role);
  }

  /** Internal weak-view delivery; source text never escapes as a stored field. */
  visitDisplayBasis(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (text: string, read: DisplayRangeReader) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const display = this.pool.displayStatus(generation)!;
    const valid = this.pool.visitDisplayText(generation, display.effectStamp, basis => {
      if (basis.version === version) consume(basis.text, displayRanges(this.owner, key, id, generation, version, stamp));
    });
    return valid && this.currentDisplay(key, id, generation, version, stamp);
  }

  visitDisplayStyles(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (style: ConcreteStyle) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const effect = this.pool.displayStatus(generation)!.effectStamp;
    const valid = this.pool.visitDisplayStyles(generation, effect, style => {
      if (this.currentDisplay(key, id, generation, version, stamp)) consume(style);
    });
    return valid && this.currentDisplay(key, id, generation, version, stamp);
  }

  visitDisplayRanges(key: string, id: number, generation: number, version: number, stamp: number,
    consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    if (!this.currentDisplay(key, id, generation, version, stamp)) return false;
    const effect = this.pool.displayStatus(generation)!.effectStamp;
    const available = this.pool.visitDisplay(generation, effect, (start, end, _context, style) => {
      const state = this.execution().source(key);
      if (state?.id === id && state.displayStamp === stamp && (state.generation === generation || state.previous === generation)) consume(start, end, style);
    });
    return available && this.currentDisplay(key, id, generation, version, stamp);
  }

  visitRanges(key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean {
    const state = this.execution().source(key); if (!state) return false;
    const current = state.generation === undefined ? undefined : this.pool.status(state.generation);
    const generation = current?.sourceVersion !== undefined ? state.generation : state.previousCoverage ? state.previous : undefined;
    if (generation === undefined) return state.empty;
    const status = this.pool.status(generation); if (!status) return false;
    const limit = matchingSourceVersion(state, status.sourceVersion) ? status.sourceBytes : status.committedBytes;
    const display = this.pool.displayStatus(generation);
    return !!display && this.pool.visitDisplay(generation, display.effectStamp, (start, end, _context, style) => {
      if (this.execution().source(key) === state && start < limit) consume(start, Math.min(end, limit), style);
    });
  }

  private clearCoverage(state: PresentationRecord): void {
    for (const proof of state.coverage?.values() ?? []) { this.cleanup.charges.delete(proof.charge); proof.charge.release(); }
    state.coverage = undefined;
  }

  invalidateSource(state: PresentationRecord, preserveView = false, newSubject = false): void {
    if (!preserveView) this.clearCoverage(state);
    const node = this.work.get(state.group ?? state);
    if (node) {
      this.clearStyleRefusal(node);
      if (newSubject) { node.styleRevision = ++this.styleRevision; node.attempt = undefined; }
    }
  }

  private clearStyleRefusal(node: PublicationNode): void {
    node.failedEpoch = undefined; node.failedRevision = undefined; node.failedVocabulary = undefined;
    node.failedCacheRevision = undefined; node.failedPalette = undefined; node.failedBindingRevision = undefined;
  }

  private refuseStyles(node: PublicationNode, vocabulary: string, epoch: number, revision: number): void {
    const selection = this.selection;
    if (this.work.get(node.value) !== node || this.styleEpoch !== epoch || node.styleRevision !== revision || !selection) return;
    node.failedEpoch = epoch; node.failedRevision = revision; node.failedVocabulary = vocabulary;
    node.failedCacheRevision = this.styleCache.get(this.styleKey(vocabulary, selection.rules))?.revision ?? 0;
    node.failedPalette = selection.palette; node.failedBindingRevision = selection.bindingRevision;
  }

  private styleHealthOwner(style: StyleJobView, provider: number): PublicationNode | undefined {
    const node = style.node.deref();
    return node && this.work.get(node.value) === node && this.styleEpoch === style.epoch
      && node.styleRevision === style.revision && this.provider.isReady(provider) ? node : undefined;
  }

  // After the generic expressions are installed, publication funding belongs to this owner only.
  private refuseStyleOwner(style: StyleJobView): void {
    const node = style.node.deref();
    if (node) this.refuseStyles(node, style.expected.vocabulary, style.epoch, style.revision);
  }

  private refuseStyleJob(job: StyleReplyView, cause: StyleCause): void {
    const at = cause === 'retry' ? this.clock.now() + 60000 : undefined;
    job.outcome.cause = cause; job.outcome.retryAt = at;
    if (job.style && cause !== 'withdrawn') this.refuseStyleOwner(job.style);
  }

  private hasCoverage(member: StyleMember, vocabulary: string, rules: string): boolean {
    const state = this.execution().source(member.key);
    if (!state || state.id !== member.id) return false;
    const proof = state.coverage?.get(rules);
    if (!proof) return false;
    if (proof.invalidation !== this.pool.arena.styleInvalidationRevision) { this.clearCoverage(state); return false; }
    const data = state.frozen ? this.pool.displayStatus(member.generation) : this.pool.status(member.generation);
    return proof.generation === member.generation && data?.vocabulary === vocabulary && proof.vocabulary === vocabulary
      && proof.semanticStamp === data.semanticStamp && (proof.sourceVersion === data.sourceVersion
        || !state.frozen && matchingSourceVersion(state, proof.sourceVersion));
  }

  private rememberCoverage(member: StyleMember, vocabulary: string, rules: string, invalidation: number): void {
    if (this.pool.arena.styleInvalidationRevision !== invalidation) return;
    const state = this.execution().source(member.key), display = this.pool.displayStatus(member.generation);
    if (!state || state.id !== member.id || !display || this.hasCoverage(member, vocabulary, rules)) return;
    const data = state.frozen ? display : this.pool.status(member.generation);
    if (!data || data.vocabulary !== vocabulary || data.semanticStamp !== display.semanticStamp
      || data.sourceVersion !== display.sourceVersion && (state.frozen || !matchingSourceVersion(state, display.sourceVersion))) return;
    const old = state.coverage?.get(rules);
    if (old) { this.cleanup.charges.delete(old.charge); old.charge.release(); state.coverage!.delete(rules); }
    // Optional evidence never evicts source data just to accelerate a later probe.
    // Each map association, immutable namespace/rule key and scalar identity is paid.
    const bytes = 512 + 2 * (vocabulary.length + rules.length), grant = this.pool.budget.reserve(bytes);
    if (!grant) return;
    try {
      const charge = grant.consume(bytes); this.cleanup.charges.add(charge);
      (state.coverage ??= new Map()).set(rules, {
        generation: member.generation, semanticStamp: display.semanticStamp,
        sourceVersion: display.sourceVersion, vocabulary, invalidation, charge
      });
    } finally { grant.close(); }
  }



  private styleReserve(generation: number | undefined, bytes: number): boolean {
    const result = this.pool.reserve(generation, bytes); this.execution().receipts(result.released);
    if (result.accepted) return true;
    this.clearCache();
    const retry = this.pool.reserve(generation, bytes); this.execution().receipts(retry.released); return retry.accepted;
  }

  private styleKey(vocabulary: string, rules: string): string { return `${vocabulary}/${rules}`; }

  private canDispatchStyles(description: Description | undefined, vocabulary: string): description is Description {
    return !!description && description.vocabulary.fingerprint === vocabulary && this.provider.isReady(this.execution().publicationWorkProvider);
  }

  prepare(node: PublicationNode, description: Description | undefined, full: boolean): void {
    const selection = this.selection;
    if (!selection || !this.execution().publicationEnabled || !this.execution().active) return;
    const subject = this.styleSubject(node, selection, description); if (!subject) return;
    const failure = this.styleFailure(node, subject, description); if (failure.blocked) return;
    const refuse = () => this.refuseStyles(node, subject.vocabulary, subject.epoch, subject.revision);
    try {
      if ('preparation' in node.value) {
        const accepts = node.value.preparation.deref()?.acceptsSelection, preparation = node.value.preparation.deref();
        if (accepts && preparation && !accepts.call(preparation, selection.palette, selection.rules)) return;
      }
      if (!this.execution().active || this.selection !== selection) return;
      if (full && this.waitForUncoveredStyles(subject, description)) return;
      if (!this.qualifyStyleMembers(subject, refuse)) return;
      if (this.stylesCurrent(node, subject)) {
        this.clearStyleRefusal(node); node.attempt = undefined;
        for (const member of subject.members) this.execution().source(member.key)!.styleDirty = false;
        return;
      }
      this.prepareStyleContexts(node, subject, description, full, failure);
    } catch (error) {
      refuse(); this.counters.styleRejections++;
      this.execution().log(unexpectedDiagnostic(error) ? 'ERROR' : 'WARN', 'Local style preparation refused; source execution authority is unchanged', { code: diagnosticError(error) });
      if (unexpectedDiagnostic(error)) reportRuntime(this.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
    }
  }

  private styleSubject(node: PublicationNode, selection: PreparedSelection, description: Description | undefined): StyleSubject | undefined {
    const entry = node.value, members: StyleMember[] = [];
    if (node.paused) return;
    if ('preparation' in entry && (!entry.preparation.deref() || !node.seal || !this.sealMatches(entry, node.seal))) return;
    for (const key of 'preparation' in entry ? entry.keys : [entry.key]) {
      const state = this.execution().source(key), generation = state?.frozen ? state.previous : state?.generation;
      if (!state || state.retired && !state.frozen || generation === undefined) return;
      members.push({ key, id: state.id, generation });
    }
    if (!members.length && !('preparation' in entry)) return;
    const first = members[0], state = first && this.execution().source(first.key)!;
    const vocabulary = (first && state?.frozen ? this.pool.displayStatus(first.generation)?.vocabulary : undefined)
      ?? (first && this.pool.status(first.generation)?.vocabulary) ?? description?.vocabulary.fingerprint;
    if (!vocabulary && members.length) return;
    return { members, selection, vocabulary: vocabulary ?? '', epoch: this.styleEpoch, revision: node.styleRevision };
  }

  private styleFailure(node: PublicationNode, subject: StyleSubject, description: Description | undefined): StyleFailure {
    const { selection, vocabulary, epoch, revision } = subject, cache = this.styleCache.get(this.styleKey(vocabulary, selection.rules));
    const attempt = node.attempt, matching = attempt?.epoch === epoch && attempt.revision === revision && attempt.vocabulary === vocabulary;
    if (attempt && !matching) node.attempt = undefined;
    const outcome = matching ? attempt.outcome : undefined;
    const genericFailure = outcome?.cause !== undefined && outcome.cause !== 'installed' && outcome.cause !== 'withdrawn';
    const observed = node.failedEpoch === epoch && node.failedRevision === revision && node.failedVocabulary === vocabulary;
    const firstVisit = genericFailure && !observed;
    if (firstVisit) this.refuseStyles(node, vocabulary, epoch, revision);
    const failed = observed || firstVisit, opportunity = nextStyle(outcome, this.canDispatchStyles(description, vocabulary), this.execution().publicationWorkProvider, this.clock.now());
    const localInput = node.failedPalette === selection.palette && node.failedBindingRevision === selection.bindingRevision;
    const blocked = failed && !firstVisit && localInput && node.failedCacheRevision === (cache?.revision ?? 0)
      && (!genericFailure || this.deferStyleOpportunity(opportunity, vocabulary));
    return { failed, genericFailure, opportunity, blocked };
  }

  private deferStyleOpportunity(opportunity: ReturnType<typeof nextStyle>, vocabulary: string): boolean {
    if (opportunity.kind === 'delayed') { this.execution().noteWake(opportunity.at); return true; }
    if (opportunity.kind === 'provider') { if (vocabulary) this.execution().requestProviderOpportunity(); return true; }
    return opportunity.kind === 'refused';
  }

  private waitForUncoveredStyles(subject: StyleSubject, description: Description | undefined): boolean {
    const { members, selection, vocabulary } = subject;
    if (!this.canDispatchStyles(description, vocabulary) || members.every(member => this.execution().source(member.key)?.frozen
      ? this.pool.displayStatus(member.generation)?.sourceBytes === 0 : (this.pool.status(member.generation)?.currentContexts ?? 0) === 0)
      || members.every(member => this.hasCoverage(member, vocabulary, selection.rules))) return false;
    if (this.canDispatchStyles(description, vocabulary)) { this.work.requestRetry(); this.execution().waitForCredit(); }
    return true;
  }

  private qualifyStyleMembers(subject: StyleSubject, refuse: () => void): boolean {
    for (const member of subject.members) {
      const state = this.execution().source(member.key)!;
      let status = this.pool.status(member.generation); if (!status) return false;
      if (state.empty && status.sourceVersion === undefined) {
        const result = this.pool.installChunk(member.generation, {
          key: status.key, generation: member.generation,
          source_version: state.version, revision: 1, source_bytes: 0, replace_from: 0, committed_bytes: 0, complete: true,
          vocabulary: subject.vocabulary, contexts: [], runs: new Uint32Array(), counters: { committed_line_calls: 0, committed_line_bytes: 0, tail_calls: 0, tail_bytes: 0 }
        });
        this.execution().receipts(result.released); if (!result.accepted) { refuse(); return false; }
        status = this.pool.status(member.generation)!;
      }
      if (status.sourceVersion === undefined || (state.frozen ? this.pool.displayStatus(member.generation)?.vocabulary ?? status.vocabulary : status.vocabulary) !== subject.vocabulary) return false;
    }
    return true;
  }

  private stylesCurrent(node: PublicationNode, subject: StyleSubject): boolean {
    const { selection, members } = subject;
    return (!('preparation' in node.value) || !!node.ready && node.ready.rules === selection.rules
      && node.ready.palette === selection.palette && node.ready.bindingRevision === selection.bindingRevision
      && this.groupCurrent(node, node.ready.stamp)) && members.every(member => {
        const state = this.execution().source(member.key)!, display = this.pool.displayStatus(member.generation), status = this.pool.status(member.generation)!;
        return display?.rules === selection.rules && display.palette === selection.palette && display.bindingRevision === selection.bindingRevision
          && state.displayNeutral === state.neutral
          && (state.frozen || display.semanticStamp === status.semanticStamp && matchingSourceVersion(state, display.sourceVersion));
      });
  }

  private collectStyleMember(member: StyleMember, captures: CaptureSelection[], add: (context: ContextRef) => void): boolean {
    const state = this.execution().source(member.key), display = this.pool.displayStatus(member.generation);
    if (state?.frozen) {
      if (!display) return false;
      captures.push({ generation: member.generation, effectStamp: display.effectStamp });
      return this.pool.visitDisplayContexts(member.generation, display.effectStamp, add);
    }
    captures.push(member.generation);
    return this.pool.visitContexts(member.generation, add);
  }

  private deferStyleRequest(node: PublicationNode, subject: StyleSubject, failure: StyleFailure, full: boolean, missing: readonly ContextRef[], description: Description | undefined): boolean {
    const { vocabulary, epoch, revision, selection } = subject;
    if (failure.failed && !failure.genericFailure) { this.refuseStyles(node, vocabulary, epoch, revision); return true; }
    if (failure.genericFailure && failure.opportunity.kind !== 'resolve') this.refuseStyles(node, vocabulary, epoch, revision);
    if (this.deferStyleOpportunity(failure.opportunity, vocabulary)) return true;
    if (full) {
      if (this.canDispatchStyles(description, vocabulary)) { this.work.requestRetry(); this.execution().waitForCredit(); }
      return true;
    }
    const overlap = this.execution().styleOverlap(vocabulary, selection.rules, missing);
    if (!overlap) return false;
    const prior = overlap.style!;
    if (prior.epoch === epoch && revision <= prior.demandRevision) node.attempt = { outcome: overlap.outcome, epoch, revision, vocabulary };
    this.work.requestRetry(); return true;
  }

  private prepareStyleContexts(node: PublicationNode, subject: StyleSubject, description: Description | undefined, full: boolean, failure: StyleFailure): void {
    const { members, selection, vocabulary, epoch, revision } = subject;
    const refuse = () => this.refuseStyles(node, vocabulary, epoch, revision);
    this.counters.stylePreparations++;
    const count = members.reduce((n, member) => n + (this.pool.status(member.generation)?.currentContexts ?? 0), 0);
    const historical = members.reduce((n, member) => n + (this.execution().source(member.key)?.frozen ? this.pool.status(member.generation)?.displayBytes ?? 0 : 0), 0);
    const scratch = 2048 + members.length * 1024 + count * 1024 + historical * 4;
    if (!this.styleReserve(members[0]?.generation, scratch)) { refuse(); return; }
    const grant = this.pool.budget.reserve(scratch); if (!grant) { refuse(); return; }
    let pendingCapture: SemanticCaptureGroup | undefined;
    try {
      const captureSelections: CaptureSelection[] = [];
      const plan = collectStyleContexts(members, (member, add) => this.collectStyleMember(member, captureSelections, add),
        ref => !!this.pool.arena.style(vocabulary, ref, selection.rules), () => { this.counters.styleContextVisits++; });
      if (!plan) return;
      const { missing } = plan;
      if (!missing.length) {
        if (!this.publishStyles(members, selection, undefined, node, vocabulary)) refuse();
        else { this.clearStyleRefusal(node); node.attempt = undefined; }
        return;
      }
      if (this.deferStyleRequest(node, subject, failure, full, missing, description) || !this.canDispatchStyles(description, vocabulary)) return;
      const estimate = estimateStyleRepresentation(this.pool.arena, this.pool, vocabulary, missing, captureSelections, HIGHLIGHT_LIMITS.contextWords);
      const { encodedPeak, capturePeak } = estimate;
      if (!estimate.fits) { refuse(); this.counters.styleRejections++; return; }
      if (members.length && !capturePeak) { refuse(); return; }
      const decodedBytes = Math.min(this.execution().publicationMaxDecodedBytes, 256 * (missing.length + 26) + 4 * missing.length + 258);
      const frameBytes = Math.min(OCCIPITAL_LIMITS.dataWireBytes, Math.max(description.limits.request_bytes, description.limits.reply_bytes));
      const bytes = 4 * frameBytes + encodedPeak + capturePeak + decodedBytes + scratch + 32768 + 1024 + members.length * 128 + missing.length * 16;
      if (bytes > this.execution().publicationMaxTransientBytes) { refuse(); this.counters.styleRejections++; return; }
      if (!this.execution().capacity(bytes)) { this.work.noteCreditBlocked(); this.work.requestRetry(); this.execution().waitForCredit(); return; }
      const captured = members.length ? this.pool.captureDisplays(captureSelections, () => true) : undefined;
      if (captured) this.execution().receipts(captured.released);
      if (captured && (!captured.accepted || !captured.group)) { refuse(); return; }
      const captures = captured?.group; pendingCapture = captures;
      const contexts = this.pool.arena.encode(vocabulary, missing, peak => this.styleReserve(members[0]?.generation, peak), HIGHLIGHT_LIMITS.contextWords);
      if (!contexts) { captures?.release(); refuse(); return; }
      this.counters.styleEncodes++;
      this.execution().submitStyle({
        provider: this.execution().publicationWorkProvider, description, bytes, contexts, definition: selection.input.definition, charge: this.selectionCharge!,
        style: {
          expected: expectation(selection, vocabulary), captures, refs: missing, members,
          group: 'preparation' in node.value ? new WeakRef(node.value) : undefined, groupRevision: node.seal?.revision,
          node: new WeakRef(node), epoch, revision, demandRevision: this.styleRevision, decodedBytes
        }
      }, outcome => {
        this.clearStyleRefusal(node); node.attempt = { outcome, epoch, revision, vocabulary }; pendingCapture = undefined;
      });
    } finally { pendingCapture?.release(); grant.close(); }
  }

  private publishStyles(members: readonly StyleMember[], selection: PreparedSelection, captures?: SemanticCaptureGroupView, node?: PublicationNode, vocabularyHint?: string): boolean {
    if (!this.execution().publicationEnabled || !this.execution().active || this.selection !== selection) return false;
    const vocabulary = captures?.captures[0]?.vocabulary ?? (members[0] && this.pool.status(members[0].generation)?.vocabulary) ?? vocabularyHint;
    if (vocabulary === undefined) return false;
    const roles = selection.input.roles, grouped = node && 'preparation' in node.value ? node : undefined;
    if (grouped && !this.matchingGroupSubject(grouped, members)) return false;
    if (!this.execution().active || this.selection !== selection) return false;
    const readyBytes = 1024 + members.reduce((bytes, member) => bytes + 512 + 2 * member.key.length, 0);
    const groupGrant = grouped ? this.pool.budget.reserve(readyBytes) : undefined;
    if (grouped && !groupGrant) return false;
    try {
      const invalidation = this.pool.arena.styleInvalidationRevision;
      const updates = this.materializeDisplays(members, selection, vocabulary, captures); if (!updates) return false;
      const result = updates.length ? this.pool.publishDisplays(updates) : { accepted: true, released: [] }; this.execution().receipts(result.released);
      if (!result.accepted) return false;
      this.installDisplayReceipts(members, updates, selection, vocabulary, invalidation);
      if (grouped && !this.publishGroup(grouped, members, selection, roles, groupGrant!, readyBytes)) return false;
      if (grouped) for (const member of members) this.execution().releaseSupersededBasis(member);
      if (node) reportRuntime(this.diagnostic, { kind: 'recovered', scope: node, operation: 'styles' });
      this.counters.stylePublications++; return true;
    } finally { groupGrant?.close(); }
  }

  private matchingGroupSubject(node: PublicationNode, members: readonly StyleMember[]): boolean {
    return !!node.seal && 'preparation' in node.value && this.sealMatches(node.value, node.seal)
      && node.seal.members.length === members.length
      && members.every((member, i) => member.key === node.seal!.members[i]!.key && member.id === node.seal!.members[i]!.id);
  }

  private materializeDisplays(members: readonly StyleMember[], selection: PreparedSelection, vocabulary: string, captures?: SemanticCaptureGroupView): (ReadyDisplayUpdate & { bindingChanged: boolean })[] | undefined {
    const updates: (ReadyDisplayUpdate & { bindingChanged: boolean })[] = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!, capture = captures?.captures[i], currentCapture = !!captures && members.length > 1;
      const state = this.execution().source(member.key);
      if (state?.id !== member.id || (state.frozen ? state.previous : state.generation) !== member.generation || state.retired && !state.frozen) return;
      const status = this.pool.status(member.generation), display = this.pool.displayStatus(member.generation);
      if (!status || currentCapture && (status.semanticStamp !== capture!.semanticStamp || status.sourceVersion !== capture!.sourceVersion)) return;
      const contexts = this.materializeContexts(state, member.generation, vocabulary, selection, display, capture);
      if (!contexts) return;
      // Version-only acknowledgements preserve the already-owned display text/scopes.
      const retained = display && (state.frozen || display.semanticStamp === status.semanticStamp && matchingSourceVersion(state, display.sourceVersion));
      updates.push({
        generation: member.generation,
        bindingChanged: !display || display.palette !== selection.palette || display.bindingRevision !== selection.bindingRevision,
        candidate: {
          ...(capture ? { capture } : {}), semanticStamp: capture?.semanticStamp ?? (retained ? display.semanticStamp : status.semanticStamp),
          sourceVersion: capture?.sourceVersion ?? (retained ? display.sourceVersion : status.sourceVersion!),
          presentation: { vocabulary, rules: selection.rules, palette: selection.palette, bindingRevision: selection.bindingRevision, roles: selection.input.roles, contexts }
        }
      });
    }
    return updates;
  }



  private materializeContexts(state: PresentationRecord, generation: number, vocabulary: string, selection: PreparedSelection,
    display: ReturnType<SemanticRetentionPool['displayStatus']>, capture?: SemanticCaptureView): { context: ContextRef; style: ConcreteStyle }[] | undefined {
    const contexts: { context: ContextRef; style: ConcreteStyle }[] = [];
    let complete = true;
    const add = (context: ContextRef) => {
      const expression = this.pool.arena.style(vocabulary, context, selection.rules);
      if (!expression) complete = false;
      else contexts.push({ context, style: concreteStyle(expression, selection, selection.input.roles, state.neutral) });
    };
    if (capture) { if (!capture.visitContexts(add)) return; }
    else if (state.frozen && display) { if (!this.pool.visitDisplayContexts(generation, display.effectStamp, add)) return; }
    else if (!this.pool.visitContexts(generation, add)) return;
    return complete ? contexts : undefined;
  }

  private installDisplayReceipts(members: readonly StyleMember[], updates: readonly (ReadyDisplayUpdate & { bindingChanged: boolean })[],
    selection: PreparedSelection, vocabulary: string, invalidation: number): void {
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!, state = this.execution().source(member.key), display = this.pool.displayStatus(member.generation);
      if (!state || !display) continue;
      this.rememberCoverage(member, vocabulary, selection.rules, invalidation);
      const effect = display.effectStamp;
      if (updates[i]!.bindingChanged || state.displayEffect !== effect || state.displayPalette !== selection.palette || state.displayRules !== selection.rules) {
        state.displayStamp = ++this.displaySequence; state.displayEffect = effect; this.execution().changed(state.key);
      }
      state.displayNeutral = state.neutral; state.displayPalette = selection.palette; state.displayRules = selection.rules;
      state.displayVersion = display.complete && matchingSourceVersion(state, display.sourceVersion) ? state.version : undefined;
      state.styleDirty = display.semanticStamp !== this.pool.status(member.generation)?.semanticStamp;
    }
  }

  private publishGroup(node: PublicationNode, members: readonly StyleMember[], selection: PreparedSelection, roles: StyleRoles,
    grant: DataGrant, bytes: number): boolean {
    const entry = node.value;
    if (!('preparation' in entry) || !node.seal || !this.sealMatches(entry, node.seal) || !entry.preparation.deref() || !this.execution().active) return false;
    // The existing 512-byte/member allowance funds one ordered map association and scalar receipt.
    // Its grant is reserved by publishStyles before this controlled collection allocation.
    const readyMembers = new Map<string, GroupReadyMember>();
    for (const member of members) {
      const state = this.execution().source(member.key), display = this.pool.displayStatus(member.generation);
      if (!state || !display || state.id !== member.id || display.rules !== selection.rules || display.palette !== selection.palette
        || display.bindingRevision !== selection.bindingRevision) return false;
      readyMembers.set(member.key, {
        ...member, version: display.sourceVersion, stamp: state.displayStamp,
        geometryStamp: display.geometryStamp, paintStamp: display.effectStamp, complete: display.complete
      });
    }
    const prior = node.ready, comparison = this.compareGroupReady(prior, readyMembers, roles);
    const unchanged = comparison === 'same' && prior!.rules === selection.rules && prior!.palette === selection.palette && prior!.bindingRevision === selection.bindingRevision;
    if (unchanged) return true;
    const pin = this.selectionCharge;
    if (!pin) return false;
    const stamp = ++this.displaySequence;
    const ready: GroupReady = {
      members: readyMembers, readers: 0, roles, rules: selection.rules, palette: selection.palette, bindingRevision: selection.bindingRevision,
      stamp, paintStamp: comparison === 'changed' ? stamp : prior!.paintStamp, pin: pin.retain(), charge: grant.consume(bytes)
    };
    publishGroupReady(node, ready, this.cleanup.groups); this.execution().changedGroup(entry.id);
    return true;
  }

  private compareGroupReady(prior: GroupReady | undefined, members: ReadonlyMap<string, GroupReadyMember>, roles: StyleRoles): 'changed' | 'paint' | 'same' {
    if (!prior || !equalRoles(prior.roles, roles) || prior.members.size !== members.size) return 'changed';
    let sameStamps = true;
    const previous = prior.members.values();
    for (const member of members.values()) {
      const old = previous.next().value!;
      if (old.key !== member.key || old.id !== member.id || old.generation !== member.generation
        || old.geometryStamp !== member.geometryStamp || old.paintStamp !== member.paintStamp) return 'changed';
      if (old.stamp !== member.stamp) sameStamps = false;
    }
    return sameStamps ? 'same' : 'paint';
  }

  settle(job: StyleReplyView, raw: unknown, rejected: boolean): void {
    const style = job.style;
    let expressionsInstalled = false, workerUnavailable = false;
    let failureCause: StyleCause = 'retry';
    try {
      if (!style || !this.styleReplyActive(job)) { this.refuseInactiveStyleReply(job); return; }
      if (rejected) { this.rejectStyleRequest(job, style, raw); return; }
      let decoded: ReturnType<typeof decodeSemanticStyleReply>;
      try { decoded = decodeSemanticStyleReply(raw, job.ticket, job.description, style.expected, style.refs.length, style.decodedBytes, HIGHLIGHT_LIMITS, job.replySize); }
      catch (error) {
        if (error instanceof RemoteFault) { failureCause = styleFaultCause(error.code, error.execution); workerUnavailable = error.code === 'worker_gone'; }
        throw error;
      }
      failureCause = 'local';
      const reserve = (bytes: number) => this.styleReserve(undefined, bytes);
      if (!this.pool.arena.installStyles(style.expected.vocabulary, style.expected.rules, style.refs, decoded.styles, decoded.indices, reserve)) {
        this.refuseStyleJob(job, 'local'); return;
      }
      expressionsInstalled = true; job.outcome.cause = 'installed'; job.outcome.retryAt = undefined;
      if (this.cacheInstalledStyles(style, reserve)) this.publishStyleReply(style);
    } catch (error) {
      this.execution().log(this.unexpectedStyleFailure(job, error) ? 'ERROR' : 'WARN', 'Native style reply refused; source execution authority is unchanged', { source: job.key, job: job.id, provider: job.provider, code: diagnosticError(error) });
      const node = style && this.styleHealthOwner(style, job.provider);
      if (node && this.unexpectedStyleFailure(job, error))
        reportRuntime(this.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(error) });
      this.counters.styleRejections++;
      if (style) {
        if (expressionsInstalled) this.refuseStyleOwner(style);
        else this.refuseStyleJob(job, failureCause);
      }
    } finally { this.execution().finishStyleReply(job, workerUnavailable); }
  }

  private styleReplyActive(job: StyleReplyView): boolean {
    return !this.execution().publicationDisposed && this.execution().publicationEnabled && this.execution().active && !job.stopped && !job.pendingRetire && !job.abort.signal.aborted;
  }

  private refuseInactiveStyleReply(job: StyleReplyView): void {
    const intentional = job.origin === 'suspended' || job.origin === 'disabled' || job.origin === 'disposed' || job.origin === 'handoff';
    this.refuseStyleJob(job, job.origin && !intentional ? 'route' : 'withdrawn');
  }

  private rejectStyleRequest(job: StyleReplyView, style: StyleJobView, raw: unknown): void {
    this.refuseStyleJob(job, this.provider.isReady(job.provider) ? 'other' : 'route');
    const node = this.styleHealthOwner(style, job.provider);
    if (node && unexpectedDiagnostic(raw)) {
      this.execution().log('ERROR', 'Native style request failed unexpectedly', { source: job.key, job: job.id, code: diagnosticError(raw) });
      reportRuntime(this.diagnostic, { kind: 'failure', scope: node, operation: 'styles', area: 'syntax', code: diagnosticError(raw) });
    }
  }

  private cacheInstalledStyles(style: StyleJobView, reserve: (bytes: number) => boolean): boolean {
    const key = this.styleKey(style.expected.vocabulary, style.expected.rules);
    if (!this.styleCache.has(key)) {
      const bytes = 512;
      if (!reserve(bytes)) { this.refuseStyleOwner(style); return false; }
      const grant = this.pool.budget.reserve(bytes); if (!grant) { this.refuseStyleOwner(style); return false; }
      try {
        const cache: StyleCache = { revision: 0, charge: grant.consume(bytes) };
        this.styleCache.set(key, cache); this.cleanup.charges.add(cache.charge);
      } finally { grant.close(); }
    }
    this.styleCache.get(key)!.revision++;
    return true;
  }

  private publishStyleReply(style: StyleJobView): void {
    const selected = this.selection, group = style.group?.deref(), node = group && this.work.get(group);
    const current = this.provider.snapshot().description, preparation = group?.preparation.deref();
    if (preparation?.acceptsSelection && selected && !preparation.acceptsSelection(selected.palette, selected.rules)) return;
    // Callback withdrawal is not a local funding refusal; installed generic styles remain useful.
    if (!this.execution().active || this.selection !== selected || !selected || style.group && (style.epoch !== this.styleEpoch || style.groupRevision !== node?.seal?.revision) || selected.rules !== style.expected.rules
      || current?.vocabulary.fingerprint !== style.expected.vocabulary || style.group && (!node || node.paused || !preparation)) return;
    if (!this.publishStyles(style.members, selected, style.captures, node, style.expected.vocabulary)) this.refuseStyleOwner(style);
    else {
      const owner = style.node.deref();
      if (owner) reportRuntime(this.diagnostic, { kind: 'recovered', scope: owner, operation: 'styles' });
    }
  }
}

// This type-only view is the exact synchronous capability retained through the root WeakRef.
type PublicationExecution = Pick<SourceExecution,
  'active' | 'publicationEnabled' | 'publicationDisposed' | 'publicationPreparing' | 'publicationWorkProvider'
  | 'publicationMaxTransientBytes' | 'publicationMaxDecodedBytes' | 'source' | 'sources' | 'receipts'
  | 'releaseSupersededBasis' | 'styleOverlap' | 'capacity' | 'waitForCredit' | 'submitStyle' | 'finishStyleReply'
  | 'reconcileCreditInterest' | 'noteWake' | 'requestProviderOpportunity' | 'changed' | 'changedGroup' | 'log'
  | 'readGroupRole' | 'visitGroupStyles' | 'visitGroup' | 'readGroupMember' | 'visitGroupRanges'
  | 'readDisplayRole' | 'visitDisplayBasis' | 'visitDisplayStyles' | 'visitDisplayRanges'>;
