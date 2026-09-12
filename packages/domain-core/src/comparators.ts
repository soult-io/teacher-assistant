// Deterministic comparators for output ordering. NEVER String.prototype.localeCompare
// (locale-dependent, host-varying — banned by the vendored GritQL biome plugin).

/**
 * Deterministic code-point string comparator. Use for any output ordering
 * (diff-friendly tables, admin-date sorts, dedup tiebreaks). ISO dates and opaque
 * ids are ASCII, so this is also their correct chronological/stable order.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
