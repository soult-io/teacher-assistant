// M13 — the para-visible administer-label (field-split §2, DECISIONS
// D-ARCH-FERPA-M13 condition #2). The para must know WHICH probe to administer to
// WHICH student, but must never receive the goal definition. The only near-text
// field on the entire para surface is this label, and it is DERIVED from the
// NON-PII curriculum spine — there is NO code edge from goal_text or the free-form
// ProbeDefinition.label. When no catalog entry exists, the fallback is an opaque
// "Probe N" handle + item count with zero topic (the F-1 downgrade).

/**
 * A NON-PII curriculum-catalog entry (data-model §10, classified CLEARTEXT): the
 * gen-ed topic label, the KY standard code, and the probe item count. These are
 * shared 8th-grade curriculum content, not student data and not goal definition.
 * This is the ONLY shape the administer-label may be built from.
 */
export interface AdministerCatalogEntry {
  /** Segment.topic_label — the gen-ed topic the whole class works (non-PII). */
  readonly topicLabel: string;
  /** KYStandard.code — e.g. "EE7" (non-PII shared standard reference). */
  readonly standardCode: string;
  /** expected_denominator — a bare probe item count (administer-necessary, non-PII). */
  readonly expectedDenominator: number;
}

/**
 * Build the para-visible administer-label from the NON-PII catalog entry ONLY:
 * `<topic> · <standard> · <N> items`. An `ordinal` is appended ONLY to disambiguate
 * two probes a single student has under the same topic (F-4) — a system sequence
 * number, never a teacher-only attribute. Never contains criterion, condition,
 * accom/mod, baseline, "independently", or any free text.
 */
export function buildAdministerLabel(entry: AdministerCatalogEntry, ordinal?: number): string {
  const base = `${entry.topicLabel} · ${entry.standardCode} · ${entry.expectedDenominator} items`;
  return ordinal === undefined ? base : `${base} · Probe ${ordinal}`;
}

/**
 * The opaque fallback when no catalog entry is available (F-1 downgrade): an opaque
 * "Probe N" ordinal plus the item count, carrying zero curriculum topic. `ordinal`
 * is a system sequence number assigned per student.
 */
export function opaqueAdministerLabel(ordinal: number, expectedDenominator: number): string {
  return `Probe ${ordinal} · ${expectedDenominator} items`;
}
