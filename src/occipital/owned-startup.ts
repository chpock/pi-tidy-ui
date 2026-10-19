/** Known optional absence, not a failed acquisition, process or handshake.
 * Only this fixed category crosses bounded startup waits; never a raw error payload. */
export class ExpectedOwnedUnavailable extends Error {
  constructor() { super('occipital owned factory unavailable'); }
}
