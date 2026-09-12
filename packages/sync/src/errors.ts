// Identity-clean sync errors (FERPA Item-2d). Every message references opaque ids
// ONLY — never initials, goal text, scores, or any student payload. These are the
// strings that end up in retry logs / telemetry, so they are the regression-prone
// surface the FERPA-guard suite asserts against.

/** Base class for all sync errors. Carries only the opaque doc id it concerns. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly docId: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/** A relay request failed. Carries the HTTP status and the relay's opaque record id. */
export class RelayRequestError extends SyncError {
  constructor(
    readonly status: number,
    docId: string,
    readonly recordId: string | null,
  ) {
    super(`relay request for doc ${docId} failed with status ${status}`, docId);
    this.name = "RelayRequestError";
  }
}

/** A pulled update failed to decrypt/apply (wrong scope key, tampered blob, …). */
export class IntegrateError extends SyncError {
  constructor(docId: string) {
    super(`could not integrate a remote update for doc ${docId}`, docId);
    this.name = "IntegrateError";
  }
}
