import type { DataCharge } from '../resources/data-budget.ts';
import type { StyleRoles } from './controller-styles.ts';

export type GroupMember = { key: string; id: number };
export type GroupSeal = { members: readonly GroupMember[]; revision: number; charge: DataCharge };
export type GroupReadyMember = GroupMember & { generation: number; version: number; stamp: number; geometryStamp: number; paintStamp: number; complete: boolean };
export type GroupHold = { charge: DataCharge; pin: DataCharge };
export type GroupReady = GroupHold & { members: ReadonlyMap<string, GroupReadyMember>; readers: number; roles: StyleRoles; stamp: number; paintStamp: number;
  rules: string; palette: string; bindingRevision: number };

/** Publication metadata shares the execution node; it is not another registry entry. */
export interface CardPublicationMetadata {
  seal?: GroupSeal;
  ready?: GroupReady;
}

export function createCardPublicationMetadata(): CardPublicationMetadata { return {}; }

export function releaseGroupHold(hold: GroupHold): void {
  hold.pin.release(); hold.charge.release();
}

function dropGroupReady(metadata: CardPublicationMetadata, groups: Set<GroupHold>): boolean {
  const ready = metadata.ready; metadata.ready = undefined;
  if (ready) { groups.delete(ready); releaseGroupHold(ready); }
  return ready !== undefined;
}

export function dropCardPublication(metadata: CardPublicationMetadata, groups: Set<GroupHold>, charges: Set<DataCharge>, seal = false): boolean {
  const droppedReady = dropGroupReady(metadata, groups);
  if (seal && metadata.seal) {
    const current = metadata.seal; metadata.seal = undefined;
    charges.delete(current.charge); current.charge.release();
  }
  return droppedReady;
}

export function publishGroupReady(metadata: CardPublicationMetadata, ready: GroupReady, groups: Set<GroupHold>): boolean {
  const replaced = dropGroupReady(metadata, groups);
  metadata.ready = ready; groups.add(ready);
  return replaced;
}

/** Hold one ready record only for the duration of a weak synchronous visit. */
export function visitGroupReady<Node extends CardPublicationMetadata>(
  owner: WeakRef<Node>, stamp: number,
  current: (node: Node, stamp: number, boundary?: boolean) => boolean,
  visit: (node: Node, ready: GroupReady) => boolean,
): boolean {
  const node = owner.deref(), ready = node?.ready;
  if (!node || !ready || ready.stamp !== stamp || !current(node, stamp)) return false;
  const pin = ready.pin.retain(), charge = ready.charge.retain();
  ready.readers++;
  try {
    return visit(node, ready) && current(node, stamp, ready.readers === 1);
  } finally {
    ready.readers--; pin.release(); charge.release();
  }
}
