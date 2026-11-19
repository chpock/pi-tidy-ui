import type { StylePublication } from '../../src/highlighting/style-publication.ts';
import type {
  PresentationRecord, PublicationNode, PublicationRegistry, StyleOverlapView, StyleReplyView,
} from '../../src/highlighting/execution-records.ts';

type PublicationHost = ConstructorParameters<typeof StylePublication>[0] extends WeakRef<infer Host extends object> ? Host : never;

// Uninvoked consumers make accidental widening of publication authority fail the strict compiler.
export function publicationWritesDisplayState(source: PresentationRecord, node: PublicationNode,
  registry: PublicationRegistry, reply: StyleReplyView): void {
  source.styleDirty = false;
  source.displayStamp = 1;
  source.coverage = undefined;
  node.styleRevision++;
  node.attempt = undefined;
  node.seal = undefined;
  node.ready = undefined;
  reply.outcome.cause = 'installed';
  reply.outcome.retryAt = undefined;
  registry.rewind();
  registry.schedule();
}

export function publicationHasNoExecutionAuthority(source: PresentationRecord, node: PublicationNode,
  registry: PublicationRegistry, reply: StyleReplyView, overlap: StyleOverlapView, host: PublicationHost): void {
  // @ts-expect-error Current source version belongs to execution.
  source.version = 2;
  // @ts-expect-error Parser generation belongs to execution.
  source.generation = undefined;
  // @ts-expect-error Parsed-provider provenance is not exposed to publication.
  source.parsedProvider = 1;
  // @ts-expect-error Publication cannot replace registry membership.
  node.value = source;
  // @ts-expect-error Visibility is observed, not changed by publication.
  node.paused = true;
  // @ts-expect-error The registry owns its turn epoch.
  node.epoch++;
  // @ts-expect-error Reconstruction timing belongs to execution.
  node.resyncAt = 0;
  // @ts-expect-error Pending traversal state is not a publication capability.
  node.pending = false;
  // @ts-expect-error Publication cannot remove registry membership.
  registry.clear();
  // @ts-expect-error Physical provider identity remains read-only.
  reply.provider = 1;
  // @ts-expect-error Publication cannot overwrite transport-measured reply size.
  reply.replySize.bytes = 1;
  // @ts-expect-error Publication cannot change the transport's measurement correlation.
  reply.replySize.ticket = 'other';
  // @ts-expect-error Publication cannot change the negotiated limit used to validate this receipt.
  reply.description.limits.reply_bytes = 1;
  // @ts-expect-error Publication cannot refund physical reservations.
  reply.reserved = false;
  // @ts-expect-error A cancellation observation is not an AbortController.
  reply.abort.abort();
  // @ts-expect-error Cancellation status remains read-only.
  reply.abort.signal.aborted = true;
  // @ts-expect-error Coalescing cannot mutate another operation's outcome.
  overlap.outcome.retryAt = 0;
  // @ts-expect-error Physical job construction is not a publication capability.
  host.job();
  // @ts-expect-error Physical settlement remains execution-owned.
  host.physicalSettled(reply);
  // @ts-expect-error Activity is observed, not changed by publication.
  host.active = true;
}

export function publicationBorrowsAttachedStyle(style: NonNullable<StyleReplyView['style']>): void {
  // @ts-expect-error Only execution may detach an attached capture group.
  style.captures = undefined;
  // @ts-expect-error Dispatch recorded this member's generation.
  style.members[0]!.generation++;
  // @ts-expect-error Settlement capacity is fixed at dispatch.
  style.decodedBytes = 1;
}

export function publicationReadsAttachedCaptures(group: NonNullable<NonNullable<StyleReplyView['style']>['captures']>): void {
  const capture = group.captures[0]!;
  capture.visitContexts(() => {});
  // @ts-expect-error Only execution may release the attached group.
  group.release();
  // @ts-expect-error Individual capture storage also belongs to execution.
  capture.release();
}
