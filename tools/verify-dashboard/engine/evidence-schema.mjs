// The evidence-file schema tags, shared by the ingest engine. The e2e custom reporter
// (e2e/reporters/evidence-reporter.ts) writes EVIDENCE_SCHEMA; the two must agree —
// ingest loud-fails on an unknown tag, so a reporter/engine version skew is caught at
// generate time rather than rendering an empty board.
//
// v4: the file carries `baseURL`, the origin the run tested. The dashboard is only
// built from a run of the local synthetic build (see checkRunOrigin in ingest.mjs). The
// tag is namespaced (`ta/`) because payroll-app's evidence uses the same bare name.
export const EVIDENCE_SCHEMA = "ta/journey-evidence/4";

// v3: a still is full-height, and its record carries `width`, `height` and
// `truncated` (true when the screen was cut off at the height cap). No origin stamp.
export const EVIDENCE_SCHEMA_V3 = "journey-evidence/3";

// v2 stills were one viewport tall with no size or truncation record. Still read, so a
// dashboard pinned to an older run keeps rendering: its stills ingest with
// `truncated` unknown (null) — never claimed complete.
export const EVIDENCE_SCHEMA_V2 = "journey-evidence/2";

// v1 predates per-step stills (steps carry no `screenshot` field). It is still read so a
// dashboard built before the first v2 e2e run reaches main keeps rendering: every v1
// step ingests with an explicit null still.
export const EVIDENCE_SCHEMA_V1 = "journey-evidence/1";
