import type { DataCharge } from '../resources/data-budget.ts';
import type { PreparedSelection } from './controller-styles.ts';
import type { ContextRef } from './storage/context-arena.ts';
import type { SemanticCaptureGroup, SemanticCaptureGroupView } from './storage/semantic-capture.ts';
import type { SemanticStyleExpectation, SemanticDescription as Description } from '../occipital/semantic-protocol.ts';
import type { SemanticExpectation as ExpectedSource } from '../occipital/semantic-source.ts';
import type { ReplySize } from '../occipital/data-json.ts';
import type { ProviderRetirementOrigin } from '../occipital/provider.ts';
import type { SourceFacts } from './source-state.ts';
import type { SourceDemand, SourceExecutionStats } from './source-ports.ts';
import type { nextStyle, StyleAttempt } from './style-state.ts';
import type { SemanticRetentionPool } from './storage/semantic-retention.ts';
import type { CardPublicationMetadata, GroupHold } from './card-publication.ts';
import type { WorkRegistry, SourceWorkGroup, WorkEntry as WorkEntryType, WorkNode as WorkNodeType } from './work-registry.ts';

export type WorkEntry = WorkEntryType<SourceState>;

export type WorkMetadata = CardPublicationMetadata & { resyncAt?: number; styleRevision: number; attempt?: { outcome: StyleAttempt; epoch: number; revision: number; vocabulary: string }; failedEpoch?: number; failedRevision?: number; failedVocabulary?: string; failedCacheRevision?: number; failedPalette?: string; failedBindingRevision?: number };

export type WorkNode = WorkNodeType<WorkEntry, WorkMetadata>;

export type StyleCoverage = { generation: number; semanticStamp: number; sourceVersion: number; vocabulary: string; invalidation: number; charge: DataCharge };

export type SourceState = SourceFacts & {
  coverage?: Map<string, StyleCoverage>;
  // Two primitive role receipts fit the existing source entry allowance.
  neutral: NonNullable<SourceDemand['neutral']>; displayNeutral?: NonNullable<SourceDemand['neutral']>;
  id: number; key: string; group?: SourceWorkGroup; generation?: number; previous?: number; previousCoverage?: boolean; committedUnits: number;
  // Last validated palette/rules display identity is independent of source identity.
  // Its bounded protocol strings fit the existing per-entry bookkeeping allowance.
  displayStamp: number; displayEffect?: number; displayPalette?: string; displayRules?: string; displayVersion?: number; frozen?: boolean;
  language?: string; path?: string;
  parsedAssets?: string; parsedProvider?: number; styleDirty: boolean; bytes: number;
};

export type Close = { key: string; ownerKey: string; generation: number; lease: string; provider: number; bytes: number; health?: WeakRef<SourceState> };

export type StyleMember = Readonly<{ key: string; id: number; generation: number }>;

export type SourceSnapshot = NonNullable<ReturnType<SemanticRetentionPool['borrowSnapshot']>>;

export type StyleJob = {
  expected: Readonly<SemanticStyleExpectation>; captures?: SemanticCaptureGroup; refs: readonly ContextRef[];
  members: readonly StyleMember[]; group?: WeakRef<SourceWorkGroup>; groupRevision?: number; node: WeakRef<PublicationNode>; epoch: number; revision: number; demandRevision: number; decodedBytes: number
};

export type StyleCache = { revision: number; charge: DataCharge };

export type StyleSubject = Readonly<{ members: readonly StyleMember[]; selection: PreparedSelection; vocabulary: string; epoch: number; revision: number }>;

export type StyleFailure = Readonly<{ failed: boolean; genericFailure: boolean; opportunity: ReturnType<typeof nextStyle>; blocked: boolean }>;

export type StyleDispatch = {
  provider: number; description: Description; bytes: number; style: StyleJob; contexts: number[][];
  definition: PreparedSelection['input']['definition']; charge: DataCharge
};

export type JobBase = {
  id: number; provider: number; generation?: number; key?: string; ticket: string; pendingRetire?: true;
  abort: AbortController; bytes: number; description: Description; reserved: boolean; replySize: ReplySize;
  kind?: 'shared' | 'owned'; stopped?: boolean; origin?: ProviderRetirementOrigin; lifetimeRef?: WeakRef<Job>
};

export type SourceOperation = {
  operation: 'source'; key: string; generation: number; stateId: number; inputRevision: number;
  source: { capture: Readonly<{ version: number; text: string }>; expected: ExpectedSource; replaceUnits: number; open: boolean; decodedBytes: number } | undefined
};

export type StyleOperation = { operation: 'style'; key?: string; generation?: number; outcome: StyleAttempt; style: StyleJob | undefined; styleCharge?: DataCharge };

export type CloseOperation = { operation: 'close'; key: string; generation: number; close: Close };

export type SourceJob = JobBase & SourceOperation;

export type StyleRequest = JobBase & StyleOperation;

export type CloseJob = JobBase & CloseOperation;

export type Job = SourceJob | StyleRequest | CloseJob;

export type PresentationRecord = Readonly<Pick<SourceState,
  'id' | 'key' | 'version' | 'contentVersion' | 'complete' | 'empty' | 'frozen' | 'retired'
  | 'generation' | 'previous' | 'previousCoverage' | 'group' | 'language' | 'neutral'>>
  & Pick<SourceState, 'coverage' | 'displayNeutral' | 'displayStamp' | 'displayEffect' | 'displayPalette' | 'displayRules' | 'displayVersion' | 'styleDirty'>;
export type PublicationNode = Readonly<Pick<WorkNode, 'epoch' | 'paused'>> & {
  readonly value: SourceWorkGroup | PresentationRecord;
} & Pick<WorkMetadata, 'seal' | 'ready' | 'styleRevision' | 'attempt' | 'failedEpoch' | 'failedRevision'
  | 'failedVocabulary' | 'failedCacheRevision' | 'failedPalette' | 'failedBindingRevision'>;
export type PublicationRegistry = Pick<WorkRegistry<SourceState, WorkMetadata>, 'rewind' | 'schedule' | 'requestRetry' | 'noteCreditBlocked'>
  & { get(value: SourceWorkGroup | PresentationRecord): PublicationNode | undefined };
export type StyleCleanup = { charges: Set<DataCharge>; groups: Set<GroupHold> };
export type StyleCounters = Pick<SourceExecutionStats,
  'stylePreparations' | 'styleContextVisits' | 'styleEncodes' | 'stylePublications' | 'styleRejections'>;
export type StyleOverlapView = Readonly<{
  style: Readonly<Pick<StyleJob, 'expected' | 'refs' | 'epoch' | 'demandRevision'>> | undefined;
  outcome: Readonly<StyleAttempt>;
}>;
export type StyleJobView = Readonly<Omit<StyleJob, 'captures'> & { captures?: SemanticCaptureGroupView }>;
export type StyleReplyView = Readonly<Pick<StyleRequest, 'id' | 'provider' | 'key' | 'ticket' | 'pendingRetire' | 'stopped' | 'origin'> & {
  description: Readonly<Omit<Description, 'limits'> & { limits: Readonly<Description['limits']> }>;
  replySize: Readonly<ReplySize>;
  style: StyleJobView | undefined;
  abort: { readonly signal: Pick<AbortSignal, 'aborted'> };
  outcome: StyleAttempt;
}>;
