// Opaque identifiers (data-model §0, §10.2).
//
// FERPA invariant (D-ARCH-FERPA VERIFY-AT-BUILD): every id that crosses the
// wire or reaches a log/URL is a RANDOM opaque identifier. An id is NEVER
// derived from — or a hash of — initials, goal text, or any student payload
// (a hash of initials would leak via a dictionary attack at this caseload
// size). The generators below take NO arguments by design: there is no input
// channel through which student data could seed an id. The FERPA-guard suite
// asserts both the structural (no PII-seeded id in source) and behavioural
// (two generated ids always differ) forms of this rule.

// Web Crypto (`crypto.randomUUID`) is a standard global in browsers and Node ≥ 20
// (typed via the DOM lib in this package's tsconfig).

/** A random, opaque, PII-free identifier (UUIDv4). Never derived from student data. */
export type OpaqueId = string & { readonly __brand: "OpaqueId" };

/**
 * An opaque key-id naming which capability/period key encrypts a record
 * (data-model §0 `scope_tag`). It is NOT a period name and carries no student
 * payload — it is the handle the para least-privilege boundary keys on (§10.7).
 */
export type ScopeTag = string & { readonly __brand: "ScopeTag" };

/** Epoch-milliseconds timestamp (relay-set for envelope times; admin dates are separate fields). */
export type Timestamp = number & { readonly __brand: "Timestamp" };

/** Mint a fresh random opaque id. Takes no input, so no PII can seed it. */
export function newOpaqueId(): OpaqueId {
  return crypto.randomUUID() as OpaqueId;
}

/** Mint a fresh random opaque key-id (scope tag). Takes no input, so no PII can seed it. */
export function newScopeTag(): ScopeTag {
  return crypto.randomUUID() as ScopeTag;
}

/** Brand a millisecond epoch value as a Timestamp. */
export function asTimestamp(ms: number): Timestamp {
  return ms as Timestamp;
}
