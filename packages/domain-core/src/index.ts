// @teacher-assistant/domain-core — pure, PII-free domain logic.
//
// This package must never import a crypto key, a network client, or any
// student-identifying value. It computes over already-decrypted, in-memory
// values handed to it by the caller, and returns plain data. That purity is
// what lets it be the single source of truth reused by every feature (the
// architect's cross-cutting directive) and exhaustively unit-tested.
//
// Modules that will live here (per the architecture, delivered by later specs):
//   M4  instructional-weeks primitive + calendar    (Phase 0)
//   M6  dual grading engines + export shaping        (Phase 1 / 4)
//   M8  auto progress-statement + trend engine       (Phase 1)
//   consistency-window mastery observation, validators
//
export * from "./comparators.js";

// M4 — the shared instructional-weeks primitive (architecture §3, data-model §5).
export * from "./instructional-weeks.js";

// M5 — goal-tracker + progress monitoring domain logic (phase1-spec §2).
export * from "./value.js";
export * from "./data-point.js";
// F-2 — the teacher's denominator-mismatch window disposition (design §B).
export * from "./mismatch.js";
export * from "./consistency.js";
export * from "./owes.js";
export * from "./goal-validation.js";
export * from "./goal-detail.js";

// M6a — IEP % → Infinite Campus export + F4 quarterly summary (phase1-spec §4).
export * from "./quarterly.js";
export * from "./ic-export.js";

// M7 — baseline / proposed-goal track + ARC/IEP dates (phase1-spec §3).
export * from "./baseline.js";
export * from "./lifecycle.js";
export * from "./arc-window.js";

// M8 — auto progress-statement + trend engine (phase1-spec §5, design §G R3-3).
export * from "./trend.js";
export * from "./auto-statement.js";

// M13 — para role surface: capture + teacher-validation + administer-label
// (phase1-spec §6, field-split §1.4/§2/§3, DECISIONS D-ARCH-FERPA-M13).
export * from "./para-administer-label.js";
export * from "./para-capture.js";

// M10-U2 — the material library-list projection (spec architecture/m10-u2-spec.md).
// Pure: active-only, stable order, over already-decrypted PII-free materials.
export * from "./material-library.js";

// M10-U3 — the multi-facet tag query (spec architecture/m10-u3-spec.md).
// Pure: filter/search the library by any facet combination, same stable order.
export * from "./material-query.js";

// M10-U4 — the scaffold-completeness (gap) projection (spec architecture/m10-u4-spec.md).
// Pure: score a target's material set against a CompletenessTemplate → covered/gaps.
export * from "./scaffold-completeness.js";
