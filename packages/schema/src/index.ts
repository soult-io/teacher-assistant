// @teacher-assistant/schema — shared types + validators.
//
// CO-OWNED with the data-model-integration agent: the concrete entity schema
// (goals, data points, weeks/day-blocks, MYP scores, baseline points, arc/iep
// dates, para observations) and the IC/Toddle export field formats are defined
// by their data-model spec, not here. This is a SCAFFOLD — it exists so other
// packages can import it from day one.
//
// FERPA discipline (M14): every id that crosses the wire or reaches a log/URL is
// a random opaque identifier. No initials, period names, or student payload ever
// appear in an id. The branded type below marks that contract at the type level.

/** A random, opaque, PII-free identifier (e.g. a UUIDv4). Never derived from student data. */
export type OpaqueId = string & { readonly __brand: "OpaqueId" };

/** Placeholder — replaced by the data-model-integration entity schema. */
export const SCHEMA_SCAFFOLD_VERSION = 0 as const;
