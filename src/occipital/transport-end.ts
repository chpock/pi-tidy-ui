/** Lifetime origin, separate from any request's execution outcome.
 * lost: actual peer channel/process loss, permitting bounded recovery.
 * closed: owner-initiated shutdown. uncertain: local timeout/protocol retirement.
 * denied: policy/capability/scope closure, including unknown forward reasons.
 * The first origin wins; later cleanup cannot turn a local timeout into lost.
 * This signal never promises that remote parsing did not start or stopped.
 */
export type TransportEnd = 'lost' | 'closed' | 'uncertain' | 'denied';
