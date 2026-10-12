// M10-U5 — material-support link store (spec architecture/m10-u5-spec.md §1/§2).
//
// The store that WRITES the two link records that couple a material to a goal or
// a student. Both are ENCRYPTED under the TEACHER master key, initials-only,
// TEACHER-ONLY (spec §Hard-constraints 3, U1 §A.5(4)) — never a Period DEK, never
// the para surface. It mirrors the U2 MaterialStore's at-rest shape exactly: an
// identity-clean `RecordEnvelope` + an opaque ciphertext blob, scope_tag pinned to
// `keyring.masterScopeTag`.
//
// Link-level `accom_mod` is the OPERATIVE compliance label (U1 §A.3): REQUIRED at
// attach-time, no silent default. The UI may pre-fill it from the material's
// advisory `Material.accom_mod`, but the store demands an explicit, valid value
// and validates it against the ATTACHED MATERIAL's facets — the same two SME-locked
// rules the material carries (none only at on_grade; modified_assessment ⟹
// modification), reused from `validateMaterialConstraints` so the link posture can
// never drift from the material posture. The same material may attach to different
// goals with different postures — no cross-goal constraint.
//
// Detach is an AUDITABLE soft-remove: the record is re-persisted with the
// envelope's CRDT tombstone (`deleted=true`) and retained (no destructive hard
// delete that loses history). The live projections drop tombstoned edges.
//
// SURFACE-ONLY, NO DATA EDGE (U1 §A.4): this store imports nothing from the
// monitoring engine. It writes/reads the link edges only; the Goal Detail
// surfacing is a separate pure projection in domain-core.

import type { TeacherKeyring } from "@teacher-assistant/crypto";
import {
  ACCOM_MODS,
  type AccomMod,
  type Material,
  type MaterialConstraintViolation,
  type MaterialGoalSupport,
  type MaterialStudentSupport,
  type OpaqueId,
  type RecordEnvelope,
  type RecordType,
  type Timestamp,
  asTimestamp,
  newOpaqueId,
  validateMaterialConstraints,
} from "@teacher-assistant/schema";

/** The at-rest form of one link record: the identity-clean envelope + its ciphertext blob. */
export interface StoredSupportRecord {
  readonly env: RecordEnvelope;
  readonly blob: Uint8Array;
}

/** A link-time constraint rule: the two material-facet rules plus "accom_mod required". */
export type LinkConstraintRule = MaterialConstraintViolation["rule"] | "accom_mod_required";

export interface LinkConstraintViolation {
  readonly rule: LinkConstraintRule;
  readonly message: string;
}

/** Thrown when a goal attach's link `accom_mod` is missing/invalid or violates the material's facets. */
export class LinkConstraintError extends Error {
  constructor(readonly violations: readonly LinkConstraintViolation[]) {
    super(
      `link violates ${violations.length} constraint(s): ${violations.map((v) => v.rule).join(", ")}`,
    );
    this.name = "LinkConstraintError";
  }
}

/** Thrown when a goal attach names a material the store cannot resolve (validation needs its facets). */
export class LinkMaterialNotFoundError extends Error {
  constructor(readonly materialId: OpaqueId) {
    super(`no material with id ${materialId}`);
    this.name = "LinkMaterialNotFoundError";
  }
}

/** Thrown when a detach names a support id the store does not hold. */
export class SupportNotFoundError extends Error {
  constructor(readonly supportId: OpaqueId) {
    super(`no support with id ${supportId}`);
    this.name = "SupportNotFoundError";
  }
}

const RECORD_TYPE_GOAL_SUPPORT: RecordType = "material_goal_support";
const RECORD_TYPE_STUDENT_SUPPORT: RecordType = "material_student_support";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isAccomMod(value: unknown): value is AccomMod {
  return (ACCOM_MODS as readonly string[]).includes(value as string);
}

export interface MaterialSupportStoreOptions {
  readonly keyring: TeacherKeyring;
  /** Resolves a material by id for link-time facet validation (U2's `getMaterial`). */
  readonly resolveMaterial: (id: OpaqueId) => Material | undefined;
  readonly now?: () => Timestamp;
}

/**
 * The link store. Client-side only: it holds a `TeacherKeyring` and encrypts every
 * link under the teacher master scope. Records live in memory as `{ env, blob }`
 * (the sync layer moves the ciphertext); a `now` clock is injectable for tests.
 */
export class MaterialSupportStore {
  readonly #keyring: TeacherKeyring;
  readonly #resolveMaterial: (id: OpaqueId) => Material | undefined;
  readonly #now: () => Timestamp;
  readonly #goalRecords = new Map<OpaqueId, StoredSupportRecord>();
  readonly #studentRecords = new Map<OpaqueId, StoredSupportRecord>();

  constructor(opts: MaterialSupportStoreOptions) {
    this.#keyring = opts.keyring;
    this.#resolveMaterial = opts.resolveMaterial;
    this.#now = opts.now ?? (() => asTimestamp(Date.now()));
  }

  /** Attach a material to a goal. Validates the link posture at the boundary; encrypts under the teacher MK. */
  attachMaterialToGoal(
    materialId: OpaqueId,
    goalId: OpaqueId,
    accomMod: AccomMod,
  ): MaterialGoalSupport {
    const material = this.#resolveMaterial(materialId);
    if (material === undefined) {
      throw new LinkMaterialNotFoundError(materialId);
    }
    this.#validateGoalLink(material, accomMod);
    const link: MaterialGoalSupport = {
      support_id: newOpaqueId(),
      material_id: materialId,
      goal_id: goalId,
      accom_mod: accomMod,
    };
    this.#persist(this.#goalRecords, RECORD_TYPE_GOAL_SUPPORT, link.support_id, link, false);
    return link;
  }

  /** Detach a material→goal link: auditable tombstone (record retained). Idempotent; throws on unknown id. */
  detachMaterialFromGoal(supportId: OpaqueId): void {
    this.#tombstone(this.#goalRecords, RECORD_TYPE_GOAL_SUPPORT, supportId);
  }

  /** Attach a material to a student's personal support set. ENCRYPTED, teacher-MK, initials-only. */
  attachMaterialToStudent(materialId: OpaqueId, studentId: OpaqueId): MaterialStudentSupport {
    const link: MaterialStudentSupport = {
      support_id: newOpaqueId(),
      material_id: materialId,
      student_id: studentId,
    };
    this.#persist(this.#studentRecords, RECORD_TYPE_STUDENT_SUPPORT, link.support_id, link, false);
    return link;
  }

  /** Detach a material→student link: auditable tombstone (record retained). Idempotent; throws on unknown id. */
  detachMaterialFromStudent(supportId: OpaqueId): void {
    this.#tombstone(this.#studentRecords, RECORD_TYPE_STUDENT_SUPPORT, supportId);
  }

  /** The live (non-tombstoned) goal-support links, decrypted. Feeds the Goal Detail surface. */
  listGoalSupports(): readonly MaterialGoalSupport[] {
    return this.#live(this.#goalRecords);
  }

  /** The live (non-tombstoned) student-support links, decrypted. */
  listStudentSupports(): readonly MaterialStudentSupport[] {
    return this.#live(this.#studentRecords);
  }

  /** Every at-rest ciphertext record (goal + student, live AND tombstoned) — what the sync layer moves. */
  storedRecords(): readonly StoredSupportRecord[] {
    return [...this.#goalRecords.values(), ...this.#studentRecords.values()];
  }

  /** §A.3 link rules, reused from the material validator so the link posture cannot drift from it. */
  #validateGoalLink(material: Material, accomMod: AccomMod): void {
    // REQUIRED at link-time, no silent default (U1 §A.3): a missing/invalid value
    // is rejected before anything is persisted (guards untyped-JSON callers).
    if (!isAccomMod(accomMod)) {
      throw new LinkConstraintError([
        { rule: "accom_mod_required", message: "link accom_mod is required and must be valid" },
      ]);
    }
    // The band + modified_assessment rules apply to the LINK's accom_mod against
    // the material's facets. myp_criteria_conditional is a material-only rule (the
    // material is already valid, U2) — filter it out so it can't mask a link error.
    const violations = validateMaterialConstraints({
      access_band: material.access_band,
      support_types: material.support_types,
      accom_mod: accomMod,
      ...(material.myp_criteria !== undefined ? { myp_criteria: material.myp_criteria } : {}),
    }).filter((v) => v.rule !== "myp_criteria_conditional");
    if (violations.length > 0) {
      throw new LinkConstraintError(violations);
    }
  }

  /** The decrypted, non-tombstoned link payloads of a map, insertion order preserved. */
  #live<T>(records: Map<OpaqueId, StoredSupportRecord>): readonly T[] {
    const live: T[] = [];
    for (const record of records.values()) {
      if (!record.env.deleted) {
        live.push(this.#decrypt<T>(record));
      }
    }
    return live;
  }

  /** Encrypt a link payload under the teacher MK and store it (create or tombstone re-persist). */
  #persist<T>(
    records: Map<OpaqueId, StoredSupportRecord>,
    recordType: RecordType,
    supportId: OpaqueId,
    payload: T,
    deleted: boolean,
  ): void {
    const existing = records.get(supportId);
    const when = this.#now();
    const plaintext = encoder.encode(JSON.stringify(payload));
    // scope_tag is ALWAYS the teacher master scope — never a Period DEK. size is a
    // placeholder (not part of the AEAD additional data) filled after encryption.
    const env: RecordEnvelope = {
      record_id: supportId,
      record_type: recordType,
      scope_tag: this.#keyring.masterScopeTag,
      crdt_version: {},
      created_ts: existing?.env.created_ts ?? when,
      updated_ts: when,
      size: 0,
      deleted,
    };
    const blob = this.#keyring.encryptRecord(env, plaintext);
    records.set(supportId, { env: { ...env, size: blob.length }, blob });
  }

  /** Soft-remove a link: re-persist its payload with the tombstone set. Idempotent; throws on unknown id. */
  #tombstone(
    records: Map<OpaqueId, StoredSupportRecord>,
    recordType: RecordType,
    supportId: OpaqueId,
  ): void {
    const existing = records.get(supportId);
    if (existing === undefined) {
      throw new SupportNotFoundError(supportId);
    }
    if (existing.env.deleted) {
      return; // already tombstoned — idempotent, no second write
    }
    const payload = this.#decrypt(existing);
    this.#persist(records, recordType, supportId, payload, true);
  }

  #decrypt<T>(record: StoredSupportRecord): T {
    const plaintext = this.#keyring.decryptRecord(record.env, record.blob);
    return JSON.parse(decoder.decode(plaintext)) as T;
  }
}
