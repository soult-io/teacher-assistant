// Record types + the encrypted-vs-cleartext classification map (data-model §0, §10.1).
//
// Storage posture D1 (locked): PALLAS stores ciphertext + minimal non-PII sync
// metadata only. Every student-linked record is serialised and encrypted
// client-side into ONE opaque blob; the server sees only the envelope metadata
// below, which must be identity-clean (no initials, goal text, or scores).
//
// The classification map is the machine-readable source of truth the
// FERPA-guard suite reads to assert hard-stop #10 (no plaintext student data at
// rest): an ENCRYPTED record's payload must only ever be persisted as a blob.

import type { OpaqueId, ScopeTag, Timestamp } from "./ids.js";

/**
 * Coarse record tag (data-model §0). Deliberately coarse: it reveals no
 * student, only the kind of record, so it is safe in the cleartext envelope.
 */
export const RECORD_TYPES = [
  // ── Student-linked: whole payload lives inside the encrypted blob ──
  "student",
  "goal",
  "baseline_point",
  "probe_definition",
  "data_point",
  "mastery_observation",
  "myp_progress",
  "myp_achievement",
  "myp_atl",
  "block_goal_attach",
  "plan_week",
  "plan_day",
  // ── Teacher-private differentiation library (M10). ENCRYPTED under the TEACHER
  //    master key — NOT because they are student-linked (the curriculum records
  //    are PII-free), but so the private library + its access_band pitch never
  //    cross the Period-DEK boundary onto the para surface. The two link records
  //    ARE the student/goal coupling (initials-only, opaque). material_plan_attach
  //    is DEFERRED to M10-U8 (it references M9 PlanDay/Block) — NOT defined here. ──
  "material",
  "material_asset",
  "material_goal_support",
  "material_student_support",
  // ── Non-PII: may live in a server-visible envelope or a plaintext table ──
  "teacher_profile",
  "class_period",
  "para",
  "unit",
  "segment",
  "ky_standard",
  "segment_standard_map",
  "myp_criterion",
  "strand",
  "atl_skill",
  "lesson_skeleton",
  "lesson_task",
  "calendar_day",
  "calendar_week",
  // ── SME-curated differentiation reference (M10). PII-free, content-api. ──
  "material_seed",
  "prompt_template",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** Whether a record's payload must be ciphertext at rest, or may be plaintext. */
export type Confidentiality = "ENCRYPTED" | "CLEARTEXT";

/**
 * The encrypted-vs-cleartext map (data-model §10.1). ENCRYPTED = student-linked,
 * whole payload in the blob, server-unreadable. CLEARTEXT = non-PII, a
 * server-side plaintext table is acceptable.
 *
 * Fail-closed calls: `plan_week`/`plan_day` are marked ENCRYPTED even though
 * they are non-PII UNTIL a goal attaches (data-model §7.3) — the conservative
 * default keeps a plan blob out of cleartext the moment any goal edge exists.
 */
export const RECORD_CLASSIFICATION: Readonly<Record<RecordType, Confidentiality>> = {
  student: "ENCRYPTED",
  goal: "ENCRYPTED",
  baseline_point: "ENCRYPTED",
  probe_definition: "ENCRYPTED",
  data_point: "ENCRYPTED",
  mastery_observation: "ENCRYPTED",
  myp_progress: "ENCRYPTED",
  myp_achievement: "ENCRYPTED",
  myp_atl: "ENCRYPTED",
  block_goal_attach: "ENCRYPTED",
  plan_week: "ENCRYPTED",
  plan_day: "ENCRYPTED",
  material: "ENCRYPTED",
  material_asset: "ENCRYPTED",
  material_goal_support: "ENCRYPTED",
  material_student_support: "ENCRYPTED",
  teacher_profile: "CLEARTEXT",
  class_period: "CLEARTEXT",
  para: "CLEARTEXT",
  unit: "CLEARTEXT",
  segment: "CLEARTEXT",
  ky_standard: "CLEARTEXT",
  segment_standard_map: "CLEARTEXT",
  myp_criterion: "CLEARTEXT",
  strand: "CLEARTEXT",
  atl_skill: "CLEARTEXT",
  lesson_skeleton: "CLEARTEXT",
  lesson_task: "CLEARTEXT",
  calendar_day: "CLEARTEXT",
  calendar_week: "CLEARTEXT",
  material_seed: "CLEARTEXT",
  prompt_template: "CLEARTEXT",
} as const;

/** True iff a record of this type must be persisted only as ciphertext. */
export function isEncryptedRecordType(type: RecordType): boolean {
  return RECORD_CLASSIFICATION[type] === "ENCRYPTED";
}

/**
 * CRDT merge metadata. The concrete vector/lamport shape is the sync engine's
 * (M1, Yjs) to fix; typed opaquely here so the envelope compiles against it
 * without M1 being built. `[→ DMI/M1]` confirm the exact representation.
 */
export type CrdtVersion = Readonly<Record<string, number>>;

/**
 * The server-visible envelope shared by every record (data-model §0). CLEARTEXT
 * and MUST be identity-clean: no initials, no goal text, no scores — only opaque
 * ids, the coarse type, the opaque scope tag, sync metadata, and relay times.
 */
export interface RecordEnvelope {
  /** Opaque UUIDv4; primary sync key. NEVER derived from initials/goal text. */
  readonly record_id: OpaqueId;
  /** Coarse type tag — reveals no student. */
  readonly record_type: RecordType;
  /** Opaque key-id: which capability/period key encrypts this record. */
  readonly scope_tag: ScopeTag;
  /** Client-merge metadata (M1 sets the concrete shape). */
  readonly crdt_version: CrdtVersion;
  /** Relay-set receive time — NOT the admin date. */
  readonly created_ts: Timestamp;
  /** Relay-set update time — NOT the admin date. */
  readonly updated_ts: Timestamp;
  /** Ciphertext blob size in bytes (CRDT housekeeping). */
  readonly size: number;
  /** Tombstone flag (CRDT housekeeping). */
  readonly deleted: boolean;
}
