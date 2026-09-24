// The evidence-file schema tags, shared by the ingest engine. The e2e custom reporter
// (e2e/reporters/evidence-reporter.ts) writes EVIDENCE_SCHEMA; the two must agree —
// ingest loud-fails on an unknown tag, so a reporter/engine version skew is caught at
// generate time rather than rendering an empty board.
export const EVIDENCE_SCHEMA = "journey-evidence/2";

// v1 predates per-step stills (steps carry no `screenshot` field). It is still read so a
// dashboard built before the first v2 e2e run reaches main keeps rendering: every v1
// step ingests with an explicit null still.
export const EVIDENCE_SCHEMA_V1 = "journey-evidence/1";
