// The evidence-file schema tag, shared by the ingest engine. The e2e custom reporter
// (e2e/reporters/evidence-reporter.ts) writes this same tag; the two must agree —
// ingest loud-fails on a mismatch, so a reporter/engine version skew is caught at
// generate time rather than rendering an empty board.
export const EVIDENCE_SCHEMA = "journey-evidence/1";
