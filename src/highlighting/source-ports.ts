import type { CardRole } from '../appearance/card-roles.ts';
import type { ProviderRetirementOrigin, ProviderSnapshot } from '../occipital/provider.ts';
import type { ConcreteStyle } from '../appearance/style-materialization.ts';
import type { GeometryFunding } from '../resources/data-budget.ts';
import type { StyleSelection } from './controller-styles.ts';
import type { SourcePreparation, SourceWorkGroup } from './work-registry.ts';

export interface SourceDemand {
  key: string;
  version: number;
  text: string;
  language?: string;
  path?: string;
  complete: boolean;
  /** Presentation default only; never part of parser identity. */
  neutral?: 'title' | 'code';
}

export type SourceExecutionState = 'not_started' | 'unsettled' | 'acknowledged' | 'unknown' | 'started';
export interface SourceWorkStatus {
  version?: number;
  execution: SourceExecutionState;
  fallbackEligible: boolean;
}
export interface SourceRecordStatus {
  generation?: number;
  version: number;
  acknowledgedVersion?: number;
  classificationVersion?: number;
  committedBytes: number;
  exact: boolean;
  execution: SourceExecutionState;
  availability: ProviderSnapshot['availability'];
  protective: boolean;
  fallbackEligible: boolean;
  complete: boolean;
}
export interface BorrowedSource {
  readonly generation: number;
  readonly version: number;
  readonly text: string;
  readonly utf8Bytes: number;
  readonly language?: string;
  readonly path?: string;
  readonly complete: boolean;
}
export interface BorrowedPiSource {
  readonly generation: number;
  readonly version: number;
  readonly text: string;
  readonly utf8Bytes: number;
  readonly language?: string;
  readonly styleDirectives?: boolean;
}

export type PiFailure = 'threw' | 'invalid_rows';
export interface PiProjectionReader {
  readonly generation: number;
  readonly version: number;
  readonly palette: number;
  readonly revision: number;
  readonly sourceBytes: number;
  readonly rangeCount: number;
  readonly styleCount: number;
  visitRanges(consume: (start: number, end: number, style: number) => void): boolean;
  visitStyles(consume: (index: number, style: ConcreteStyle) => void): boolean;
}
export type DisplayRangeReader = (consume: (start: number, end: number, style: ConcreteStyle) => void) => boolean;

/** Historical display coordinates only, never parser/fallback/finite-work authority. */
export interface GroupDisplayMember {
  readonly key: string;
  readonly generation: number;
  readonly version: number;
  readonly stamp: number;
  readonly geometryStamp: number;
  readonly paintStamp: number;
  readonly complete: boolean;
  readonly read: DisplayRangeReader;
}
export interface GroupDisplayBasis {
  /** Strict reader validity and displayed effects are independent identities. */
  readonly stamp: number;
  readonly paintStamp: number;
  readonly rules: string;
  readonly palette: string;
  readonly bindingRevision: number;
  role(role: CardRole): ConcreteStyle | undefined;
  /** Complete ready literals (roles and member tables); identities may repeat. */
  visitStyles(consume: (style: ConcreteStyle) => void): boolean;
  /** Provisional synchronous transaction: publish caller output only on true. */
  visit(consume: (member: (key: string) => GroupDisplayMember | undefined) => void): boolean;
}
export interface SourceDisplayBasis {
  generation: number;
  version: number;
  stamp: number;
  language?: string;
  palette: string;
  rules: string;
  bindingRevision: number;
  complete: boolean;
  exactVersion?: number;
  /** Separate cache identities; stamp above is weak-reader validity, not paint. */
  geometryStamp: number;
  paintStamp: number;
  /** Detached immutable literal. Retained output/copies belong to the caller's budget. */
  role(role: CardRole): ConcreteStyle | undefined;
  /** Adopted neutral and context literals, not a traversal of source ranges. */
  visitStyles(consume: (style: ConcreteStyle) => void): boolean;
  visit(consume: (text: string, read: DisplayRangeReader) => void): boolean;
}

export interface SourceWorkPort {
  readonly active: boolean;
  observe(demand: SourceDemand): boolean;
  workStatus(key: string): SourceWorkStatus;
  borrowSource(key: string): BorrowedSource | undefined;
  status(key: string): SourceRecordStatus | undefined;
  displayBasis(key: string): SourceDisplayBasis | undefined;
  displayStamp(key: string): number;
  visitRanges(key: string, consume: (start: number, end: number, style: ConcreteStyle) => void): boolean;
}

/** Operations used by the card preparation and paint consumer. */
export interface CardSourcePort extends Pick<SourceWorkPort, 'workStatus' | 'borrowSource' | 'displayBasis'> {
  readonly active: boolean;
  geometryFunding(group?: SourceWorkGroup): GeometryFunding | undefined;
  registerPreparation(preparation: SourcePreparation): SourceWorkGroup | undefined;
  updatePreparation(group: SourceWorkGroup): boolean;
  groupPresentation(group: SourceWorkGroup): GroupDisplayBasis | undefined;
  setStyleSelection(input: StyleSelection | undefined): boolean;
  queuePreparation(group: SourceWorkGroup, local?: boolean): void;
  pausePreparation(group: SourceWorkGroup): void;
  unregisterPreparation(group: SourceWorkGroup): void;
  refreshPreparations(): void;
  freeze(key: string): void;
  remove(key: string): void;
}

export interface SourceLifecyclePort {
  readonly active: boolean;
  whenSettled(): Promise<boolean>;
  setEnabled(enabled: boolean): void;
  suspend(): void;
  retireProvider(provider: number, origin: ProviderRetirementOrigin): void;
  resume(): void;
  dispose(): void;
  ownedStopped(provider: number): void;
  workStatus(key: string): SourceWorkStatus;
}
export interface SourcePumpPort { flush(): void; }
export interface SourceRetentionStats {
  entries: number;
  retainedBytes: number;
  snapshotBytes: number;
  rangeBytes: number;
  bridgeBytes: number;
  displayBytes: number;
  rangeRunBytes: number;
  displayOnlyRangeBytes: number;
  rangeStores: number;
  rangeViews: number;
  retainedTails: number;
  rangeBlocks: number;
  contextIndexBytes: number;
  currentContexts: number;
  outstandingPeakBytes: number;
  contexts: number;
  contextBytes: number;
  styles: number;
  styleBytes: number;
  allocatedWordBytes: number;
  prefixCopiedBytes: number;
  lastGeneration: number;
  maxBytes: number;
}

export interface SourceExecutionStats {
  dispatches: number;
  preparedBytes: number;
  decodedBytes: number;
  staleReplies: number;
  restarts: number;
  committedLineCalls: number;
  committedLineBytes: number;
  tailCalls: number;
  tailBytes: number;
  cleanupRefusals: number;
  peakTransientBytes: number;
  peakJobs: number;
  stylePreparations: number;
  styleContextVisits: number;
  styleEncodes: number;
  styleDispatches: number;
  stylePublications: number;
  styleRejections: number;
  styleCaptures: number;
  unsettledJobs: number;
  captures: number;
  globalUnsettledJobs: number;
  globalTransientBytes: number;
  transientBytes: number;
  maxTransientBytes: number;
  remoteLeases: number;
  pendingCloses: number;
  sourceRecords: number;
  piSourceRecords: number;
  guardRecords: number;
  bookkeepingBytes: number;
  globalBookkeepingBytes: number;
  waitingOwners: number;
  retention: SourceRetentionStats;
}

export interface SourceStatisticsPort {
  stats(): SourceExecutionStats;
}
