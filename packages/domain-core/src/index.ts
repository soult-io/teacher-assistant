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
// Scaffold only below.

/**
 * Deterministic code-point string comparator. Use this for any output ordering
 * (diff-friendly tables, dedup tiebreaks) — never String.prototype.localeCompare,
 * which is locale-dependent and non-deterministic across hosts (banned by the
 * vendored GritQL biome plugin).
 */
export function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
