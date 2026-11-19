import type { DataCharge, DataGrant } from '../../resources/data-budget.ts';
import type { ContextRef } from './context-arena.ts';
import type { AccountedSnapshot, CaptureData, SemanticCaptureView } from './semantic-capture.ts';
import type { SemanticRangeView, SemanticRanges } from './semantic-ranges.ts';
import { copyPresentation, equalPresentation, type OwnedPresentation, type ReadyPresentation } from './ready-presentation.ts';

export type ReadyDisplay = { charge: DataCharge; token: object; view: SemanticRangeView; snapshot: AccountedSnapshot;
  semanticStamp: number; geometryStamp: number; effectStamp: number; rules: string; palette: string; bindingRevision: number; colors: OwnedPresentation };
export interface ReadyDisplayEntry {
  readonly key: string;
  readonly generation: number;
  basis: AccountedSnapshot | undefined;
  ranges?: SemanticRanges;
  display?: ReadyDisplay;
  semanticStamp: number;
  geometryStamp: number;
  effectStamp: number;
}
export interface ReadyDisplayCandidate {
  readonly semanticStamp: number;
  readonly sourceVersion: number;
  readonly presentation: ReadyPresentation;
  readonly capture?: SemanticCaptureView;
}
export interface ReadyDisplayUpdate { readonly generation: number; readonly candidate: ReadyDisplayCandidate }
export type CaptureSelection = number | Readonly<{ generation: number; effectStamp: number }>;

export function displayMetadataBytes(rules: string, palette: string): number {
  return 256 + 32 + 2 * rules.length + 32 + 2 * palette.length;
}
export function readyDisplayBytes(display?: ReadyDisplay): number {
  return display ? displayMetadataBytes(display.rules, display.palette) + display.colors.bytes : 0;
}

type DisplayPlan<Entry extends ReadyDisplayEntry> = { entry: Entry; old?: ReadyDisplay; newView?: SemanticRangeView; next?: ReadyDisplay };
interface ReadyDisplayAccess<Entry extends ReadyDisplayEntry> {
  entry(generation: number): Entry | undefined;
  capture(value: SemanticCaptureView): CaptureData | undefined;
}

/** A synchronous funded transaction: all plans stage before any slot changes, and
 * abort releases only values that have not transferred to retained entries. */
export class ReadyDisplayPublication<Entry extends ReadyDisplayEntry> {
  #plans: DisplayPlan<Entry>[];
  #state: 'staged' | 'committing' | 'committed' | 'aborted' = 'staged';

  private constructor(plans: DisplayPlan<Entry>[]) { this.#plans = plans; }

  static stage<Entry extends ReadyDisplayEntry>(updates: readonly ReadyDisplayUpdate[], grant: DataGrant,
    access: ReadyDisplayAccess<Entry>): ReadyDisplayPublication<Entry> | undefined {
    const plans: DisplayPlan<Entry>[] = [];
    const abortPlans = () => {
      for (const plan of plans) {
        plan.newView?.release(); plan.newView = undefined;
        const next = plan.next; plan.next = undefined;
        if (next) { next.snapshot.release(); next.colors.charge.release(); next.charge.release(); }
      }
    };
    try {
      const generations = new Set<number>();
      for (const update of updates) {
        if (generations.has(update.generation)) return undefined;
        generations.add(update.generation);
        const known = new Set<ContextRef>();
        for (const pair of update.candidate.presentation.contexts) {
          if (known.has(pair.context)) return undefined;
          known.add(pair.context);
        }
        const capture = update.candidate.capture && access.capture(update.candidate.capture);
        if (capture && (known.size !== capture.contexts.length || capture.contexts.some(ref => !known.has(ref)))) return undefined;
      }
      for (const update of updates) {
        const entry = access.entry(update.generation)!, old = entry.display, candidate = update.candidate, input = candidate.presentation;
        const sameView = !!old && old.semanticStamp === candidate.semanticStamp && old.snapshot.version === candidate.sourceVersion;
        const equal = !!old && equalPresentation(old.colors, input);
        const plan: DisplayPlan<Entry> = { entry, old }; plans.push(plan);
        if (sameView && equal && old!.rules === input.rules && old!.palette === input.palette && old!.bindingRevision === input.bindingRevision) continue;
        const capture = candidate.capture && access.capture(candidate.capture);
        const view = sameView ? old!.view : capture ? capture.view.retain(() => true, grant) : entry.ranges!.captureView(() => true, grant);
        if (!view) { abortPlans(); return undefined; }
        if (!sameView) plan.newView = view;
        let colors: OwnedPresentation | undefined, colorsChargeOwned = false;
        let snapshot: AccountedSnapshot | undefined, charge: DataCharge | undefined;
        try {
          colors = equal ? old!.colors : copyPresentation(input, grant);
          if (!equal) colorsChargeOwned = true;
          if (equal) { colors.charge.retain(); colorsChargeOwned = true; }
          charge = grant.consume(displayMetadataBytes(input.rules, input.palette));
          snapshot = (sameView ? old!.snapshot : capture ? capture.snapshot : entry.basis!).retain();
          plan.next = { charge, token: {}, view, snapshot, semanticStamp: candidate.semanticStamp,
            geometryStamp: entry.geometryStamp + (sameView ? 0 : 1), effectStamp: entry.effectStamp + (sameView && equal ? 0 : 1),
            rules: input.rules, palette: input.palette, bindingRevision: input.bindingRevision, colors };
          colors = undefined; snapshot = undefined; charge = undefined;
        } catch (error) {
          snapshot?.release(); charge?.release();
          if (colorsChargeOwned) colors?.charge.release();
          throw error;
        }
      }
      return new ReadyDisplayPublication(plans);
    } catch (error) { abortPlans(); throw error; }
  }

  commit(reaccount: (entry: Entry) => void, touch: (entry: Entry) => void): void {
    if (this.#state !== 'staged') return;
    this.#state = 'committing';
    for (const plan of this.#plans) {
      const next = plan.next;
      if (next) {
        const old = plan.old, newView = plan.newView;
        plan.next = undefined; plan.newView = undefined;
        plan.entry.display = next;
        plan.entry.geometryStamp = next.geometryStamp; plan.entry.effectStamp = next.effectStamp;
        if (old) {
          if (newView) old.view.release();
          old.snapshot.release(); old.colors.charge.release(); old.charge.release();
        }
        plan.old = undefined;
        reaccount(plan.entry);
      }
      touch(plan.entry);
    }
    this.#state = 'committed'; this.#plans = [];
  }

  abort(): void {
    if (this.#state === 'committed' || this.#state === 'aborted') return;
    this.#state = 'aborted';
    for (const plan of this.#plans) {
      plan.newView?.release(); plan.newView = undefined;
      const next = plan.next; plan.next = undefined;
      if (next) { next.snapshot.release(); next.colors.charge.release(); next.charge.release(); }
    }
    this.#plans = [];
  }
}
