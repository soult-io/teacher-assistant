// @teacher-assistant/schema — shared entity types + the privacy classification.
//
// CO-OWNED with the data-model-integration agent: the concrete entity fields and
// the IC/Toddle export formats come from their `architecture/data-model.md`.
// This package implements that spec as TypeScript types + the machine-readable
// encrypted-vs-cleartext map the FERPA-guard suite and the crypto layer read.
//
// FERPA discipline (data-model §10.2): every id that crosses the wire or reaches
// a log/URL is a random opaque identifier — never derived from initials, period
// names, or student payload. See ids.ts for the contract.

export * from "./ids.js";
export * from "./classification.js";
export * from "./enums.js";
export * from "./entities.js";
export * from "./materials.js";
export * from "./material-links.js";
export * from "./material-validation.js";
export * from "./completeness.js";
export * from "./sync-protocol.js";

/** Schema revision. Bumped as the data-model spec lands in this package. */
export const SCHEMA_VERSION = 1 as const;
