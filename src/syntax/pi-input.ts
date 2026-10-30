import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TerminalColorMode } from '@earendil-works/pi-tui';
import type { GeometryFunding } from '../occipital/controller.ts';
import { type DataBudget, type DataCharge, type DataCleanupReceipt, type DataGrantFactory } from '../occipital/data-budget.ts';
import { CARD_ROLES, type CardRole } from '../occipital/semantic-codec.ts';
import { samplePiPalette } from './pi-palette.ts';
import { sampleOwnedPalette } from '../themes/owned-palette.ts';
import { PI_MARKER_VARIANT_SCRATCH_BYTES } from './pi-variants.ts';
import { PI_DIRECT_BINDINGS, PI_RULE_BINDINGS } from './pi-adapter.ts';
import { compileStyleAnsi, type AnsiStyle } from './style-ansi.ts';
import type { ConcreteStyle, StyleBinding } from './style-materialization.ts';

export type PiInputTheme = Pick<Theme, 'colors' | 'getFgAnsi' | 'getBgAnsi'>;
interface InputData {
  readonly bindings: readonly StyleBinding[];
  readonly roles: Readonly<Record<CardRole, ConcreteStyle>>;
  readonly compiledRoles: Readonly<Record<CardRole, AnsiStyle>>;
}
export interface PiInputRead extends InputData { readonly isValid: boolean }
// Policy bytes: handles include receipt/weak-reference tokens. Each binding funds
// its object, ink and array slot; each card role funds concrete/ANSI objects,
// inks, record slots and the bounded public SGR strings (including intermediates).
const handleBytes = 256;
const dataBytes = 512 + PI_RULE_BINDINGS.length * 256 + CARD_ROLES.length * 1024;
// The fixed public role samplers use bounded SGR parsing/map/diff temporaries.
// This is operation scratch, not a root-pool or response-size reservation.
const piScratchBytes = 8192 + PI_DIRECT_BINDINGS.length * 256 + PI_MARKER_VARIANT_SCRATCH_BYTES;
const ownedPaletteScratchBytes = 128 * 1024;
const denied = Symbol('Pi input allocation denied');
type SharedOwnership = { charge: DataCharge; holders: number; owners: number };
type Store = { readonly paletteId: string; readonly paletteRevision: number; readonly terminalMode: TerminalColorMode; data?: InputData; ownership: SharedOwnership };
type LeaseOwnership = { header?: DataCharge; shared?: SharedOwnership };
// An opaque capability: consumers cannot dereference the weak store and bypass
// lease validity/physical pins to obtain unguarded input tables.
class InputCache {
  #store: WeakRef<Store>;
  constructor(store: Store) { this.#store = new WeakRef(store); }
  static prepare(theme: PiInputTheme | undefined, paletteId: string, paletteRevision: number, terminalMode: TerminalColorMode,
    funding: GeometryFunding, cache?: InputCache): PiInputLease | undefined {
    return prepare(theme, paletteId, paletteRevision, terminalMode, funding, cache ? cache.#store.deref() : undefined);
  }
}
export type PaletteInputCache = InputCache;
export type PiInputCache = PaletteInputCache;

function fund(budget: DataBudget, bytes: number, funding?: DataGrantFactory): DataCharge {
  const grant = funding ? funding(bytes) : budget.reserve(bytes);
  if (!grant) throw denied;
  try {
    if (grant.budget !== budget) throw new Error('foreign Pi input data grant');
    return grant.consume(bytes);
  } finally { grant.close(); }
}
function releaseShared(shared: SharedOwnership): void {
  if (!--shared.holders) shared.charge.release();
}
function releaseStore(store: Store): void {
  if (store.ownership.holders === 1) store.data = undefined;
  releaseShared(store.ownership);
}
function releaseLease(ownership: LeaseOwnership): void {
  const { header, shared } = ownership;
  ownership.header = ownership.shared = undefined;
  if (shared) { shared.owners--; releaseShared(shared); }
  header?.release();
}
// Detached numeric tokens only: never close over the store, data or caller.
function cleanup(owner: WeakRef<InputLease>, ownership: LeaseOwnership): DataCleanupReceipt {
  return { release() { const lease = owner.deref(); if (lease) lease.dispose(); else releaseLease(ownership); } };
}
// Clear the only data reference on unwind, so even an escaped stale reader does
// not retain its input. Internal tables are immutable synchronous borrows.
function scopedRead(data: InputData | undefined, owner: WeakRef<InputLease>) {
  const valid = () => data !== undefined && owner.deref()?.isValid === true;
  const current = () => { if (!valid()) throw new Error('stale Pi input read'); return data!; };
  return { read: Object.freeze({ get isValid() { return valid(); },
    get bindings() { return current().bindings; }, get roles() { return current().roles; },
    get compiledRoles() { return current().compiledRoles; } }), clear() { data = undefined; } };
}

/** Caller-owned funded lease. Adopt cleanupReceipt into existing owner cleanup;
 * neither the runtime's weak cache nor this module finalizes abandoned leases. */
class InputLease {
  #store?: Store;
  #ownership: LeaseOwnership;
  #receipt: DataCleanupReceipt;
  readonly cache: PiInputCache;
  readonly paletteId: string;
  readonly paletteRevision: number;
  readonly terminalMode: TerminalColorMode;
  readonly allocationBytes: number;
  constructor(store: Store, header: DataCharge) {
    this.#store = store; this.#ownership = { header, shared: store.ownership };
    this.#receipt = cleanup(new WeakRef(this), this.#ownership);
    this.cache = new InputCache(store); this.paletteId = store.paletteId; this.paletteRevision = store.paletteRevision; this.terminalMode = store.terminalMode;
    this.allocationBytes = header.bytes + store.ownership.charge.bytes;
  }
  cleanupReceipt(): DataCleanupReceipt { return this.#receipt; }
  get isValid(): boolean { return this.#store !== undefined; }
  visit(consume: (read: PiInputRead) => void, funding?: DataGrantFactory): boolean {
    const store = this.#store, header = this.#ownership.header;
    if (!store || !header) return false;
    store.ownership.holders++; header.retain();
    let scratch: DataCharge | undefined, lookup: ReturnType<typeof scopedRead> | undefined;
    try {
      scratch = fund(header.budget, 256, funding);
      if (this.#store !== store) return false;
      lookup = scopedRead(store.data, new WeakRef(this));
      consume(lookup.read); return this.#store === store;
    } catch (error) { if (error === denied) return false; throw error; }
    finally { lookup?.clear(); releaseStore(store); header.release(); scratch?.release(); }
  }
  dispose(): void {
    const store = this.#store; this.#store = undefined;
    if (store?.ownership.holders === 1) store.data = undefined;
    releaseLease(this.#ownership);
  }
}
export type PaletteInputLease = InputLease;
export type PiInputLease = PaletteInputLease;

/** Outside-render only. A hit funds only a new handle, never resamples or
 * recompiles. The physical store, not the first lease, is the weak cache target. */
export const preparePaletteInput = InputCache.prepare;
/** Pi-only convenience used by embedders and focused compatibility controls. */
export function preparePiInput(theme: PiInputTheme, paletteRevision: number, terminalMode: TerminalColorMode,
  funding: GeometryFunding, cache?: PaletteInputCache): PaletteInputLease | undefined {
  return preparePaletteInput(theme, 'pi', paletteRevision, terminalMode, funding, cache);
}
function prepare(theme: PiInputTheme | undefined, paletteId: string, paletteRevision: number, terminalMode: TerminalColorMode,
  funding: GeometryFunding, previous?: Store): PaletteInputLease | undefined {
  if (previous?.data && previous.ownership.owners && previous.paletteId === paletteId && previous.paletteRevision === paletteRevision && previous.terminalMode === terminalMode) {
    previous.ownership.holders++;
    let header: DataCharge | undefined;
    try {
      header = fund(funding.budget, handleBytes, funding.grant);
      if (!previous.ownership.owners) return undefined;
      const lease = new InputLease(previous, header); previous.ownership.holders++; previous.ownership.owners++;
      header = undefined; return lease;
    } catch (error) { if (error === denied) return undefined; throw error; }
    finally { header?.release(); releaseStore(previous); }
  }
  let scratch: DataCharge | undefined, charge: DataCharge | undefined, header: DataCharge | undefined;
  try {
    scratch = fund(funding.budget, paletteId === 'pi' ? piScratchBytes : ownedPaletteScratchBytes, funding.grant); charge = fund(funding.budget, dataBytes, funding.grant); header = fund(funding.budget, handleBytes, funding.grant);
    const sampled = paletteId === 'pi'
      ? theme ? samplePiPalette(theme, terminalMode) : undefined
      : sampleOwnedPalette(paletteId, terminalMode);
    if (!sampled) return undefined;
    const { bindings, roles } = sampled;
    const compiledRoles = 'compiledRoles' in sampled ? sampled.compiledRoles
      : Object.freeze(Object.fromEntries(CARD_ROLES.map(role => [role, compileStyleAnsi(roles[role], terminalMode)])) as Record<CardRole, AnsiStyle>);
    const data = Object.freeze({ bindings, roles, compiledRoles });
    const store: Store = { paletteId, paletteRevision, terminalMode, data, ownership: { charge, holders: 1, owners: 1 } };
    const lease = new InputLease(store, header); charge = header = undefined; return lease;
  } catch (error) { if (error === denied) return undefined; throw error; }
  finally { header?.release(); charge?.release(); scratch?.release(); }
}
