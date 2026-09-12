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
export * from "./consistency.js";
export * from "./owes.js";
export * from "./goal-validation.js";
export * from "./goal-detail.js";

// M6a — IEP % → Infinite Campus export + F4 quarterly summary (phase1-spec §4).
export * from "./quarterly.js";
export * from "./ic-export.js";
