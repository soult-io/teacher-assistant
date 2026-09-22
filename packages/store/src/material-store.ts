// M10-U2 — Material store + library CRUD (spec architecture/m10-u2-spec.md).
//
// The teacher's private differentiation library. A `Material` is a PII-FREE
// curriculum artifact (no student/goal field, by construction — U1), but it is
// persisted ENCRYPTED under the TEACHER master key: the private library and its
// `access_band` pitch must never cross the Period-DEK boundary onto the para
// surface (spec §Invariants, U1 §A.5(4)). The store therefore encrypts EVERY
// material under `keyring.masterScopeTag` — never a Period DEK — producing an
// opaque ciphertext blob + an identity-clean envelope, exactly the at-rest shape
// the FERPA-guard suite asserts for student-linked records (HARD STOP #10).
//
// Boundary rules enforced here on every create AND edit:
//   - `validateMaterialConstraints` (U1) gates persistence — an invalid material
//     (accom/mod↔band, modified_assessment⟹modification, the two-way myp_criteria
//     rule) NEVER reaches the store.
//   - `content.kind === "file"` is REJECTED — the encrypted blob channel is
//     DEFERRED (v1 = text|link only, D-ARCH-4a). No bytes are persisted.
//   - Retire is SOFT (`active=false`); there is NO hard delete (audit). A retired
//     material stays retrievable by id.
//   - An edit/retag/retire appends a `Revision` (the existing audit shape).
//
// No student coupling lives here: the store creates/edits ONLY `material`
// records. The link records (U5) are a separate concern.

import type { TeacherKeyring } from "@teacher-assistant/crypto";
import {
  type AccomMod,
  type Material,
  type MaterialConstraintViolation,
  type MaterialContent,
  type MaterialSeed,
  type MypCriterion,
  type OpaqueId,
  type RecordEnvelope,
  type Timestamp,
  asTimestamp,
  newOpaqueId,
  validateMaterialConstraints,
} from "@teacher-assistant/schema";

/** The at-rest form of one material: the identity-clean envelope + its ciphertext blob. */
export interface StoredMaterialRecord {
  readonly env: RecordEnvelope;
  readonly blob: Uint8Array;
}

/**
 * The fields supplied to create a material: everything except the store-owned
 * identity/lifecycle/audit fields (`material_id`, `active`, `created_ts`,
 * `revisions`), which the store mints.
 */
export type MaterialInput = Omit<Material, "material_id" | "active" | "created_ts" | "revisions">;

/** The facets an edit may overwrite (everything a create supplies, save myp_criteria — see below). */
type EditableFields = Omit<MaterialInput, "myp_criteria">;

/**
 * A partial edit. Every editable field is optional; a field left out is kept.
 * `myp_criteria` additionally accepts an explicit `undefined` to CLEAR it — the
 * two-way rule (U1 §B) requires it absent whenever `modified_assessment` is
 * dropped, so a caller needs a way to remove it in the same edit.
 */
export interface MaterialEdit extends Partial<EditableFields> {
  readonly myp_criteria?: readonly MypCriterion[] | undefined;
}

/** The tag facets `retagMaterial` may overwrite: no title/content/origin. */
type RetaggableFields = Omit<EditableFields, "title" | "content" | "origin">;

/** A partial retag — tag facets only. `myp_criteria` clears with explicit `undefined` (as `MaterialEdit`). */
export interface MaterialRetag extends Partial<RetaggableFields> {
  readonly myp_criteria?: readonly MypCriterion[] | undefined;
}

/** Thrown when a create/edit would persist a material that violates the U1 constraints. */
export class MaterialConstraintError extends Error {
  constructor(readonly violations: readonly MaterialConstraintViolation[]) {
    super(
      `material violates ${violations.length} constraint(s): ${violations.map((v) => v.rule).join(", ")}`,
    );
    this.name = "MaterialConstraintError";
  }
}

/** Thrown when a create/edit supplies `content.kind === "file"` — the blob channel is deferred (D-ARCH-4a). */
export class FileContentNotSupportedError extends Error {
  constructor() {
    super("file attachments are not yet supported (v1 accepts text or link content only)");
    this.name = "FileContentNotSupportedError";
  }
}

/** Thrown when an edit/retag/retire names a material id the store does not hold. */
export class MaterialNotFoundError extends Error {
  constructor(readonly materialId: OpaqueId) {
    super(`no material with id ${materialId}`);
    this.name = "MaterialNotFoundError";
  }
}

const RECORD_TYPE_MATERIAL = "material" as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** All the concrete fields of a material, with `myp_criteria` explicit (possibly undefined) — the merge form. */
interface MaterialFields extends Omit<Material, "myp_criteria"> {
  readonly myp_criteria: readonly MypCriterion[] | undefined;
}

/**
 * Assemble a `Material` from its fields, OMITTING the `myp_criteria` key entirely
 * when it is undefined (never persisting `myp_criteria: undefined`, which
 * `exactOptionalPropertyTypes` and the two-way validator both treat as distinct
 * from absent).
 */
function assembleMaterial(fields: MaterialFields): Material {
  const { myp_criteria, ...rest } = fields;
  return myp_criteria === undefined ? rest : { ...rest, myp_criteria };
}

/** A prior/next snapshot for the audit `Revision`, without the nested revisions array. */
function snapshot(m: Material): Omit<Material, "revisions"> {
  const { revisions: _revisions, ...rest } = m;
  return rest;
}

/**
 * The material library store. Client-side only: it holds a `TeacherKeyring` and
 * encrypts every material under the teacher master scope. Records live in memory
 * as `{ env, blob }` (the sync/persistence layer moves the ciphertext; this store
 * owns the CRUD + the at-rest encryption). A `now` clock is injectable for tests.
 */
export class MaterialStore {
  readonly #keyring: TeacherKeyring;
  readonly #now: () => Timestamp;
  readonly #records = new Map<OpaqueId, StoredMaterialRecord>();

  constructor(opts: { readonly keyring: TeacherKeyring; readonly now?: () => Timestamp }) {
    this.#keyring = opts.keyring;
    this.#now = opts.now ?? (() => asTimestamp(Date.now()));
  }

  /** Create a material: validate at the boundary, encrypt under the teacher MK, persist. */
  createMaterial(input: MaterialInput): Material {
    rejectFileContent(input.content);
    const material = assembleMaterial({
      ...input,
      myp_criteria: input.myp_criteria,
      material_id: newOpaqueId(),
      active: true,
      created_ts: this.#now(),
      revisions: [],
    });
    this.#validateOrThrow(material);
    this.#persist(material, material.created_ts);
    return material;
  }

  /**
   * Copy-on-import (M10-U7, differentiation-architecture §6): COPY a CLEARTEXT
   * SME `MaterialSeed` into the teacher's library as a NEW ENCRYPTED `material`
   * (`origin = imported_seed`), carrying every seed facet. Seeding is
   * import/attach, NEVER generation — no egress, no runtime AI.
   *
   * The result is HER copy: a fresh `material_id` is minted (so re-importing the
   * same seed yields a second, independent material) and subsequent edits go
   * through `editMaterial`, never touching the shared seed. `accom_mod` is NOT a
   * seed field (U1: the accommodation/modification posture is the teacher's SDI
   * call at add-time, never baked into a shared cleartext catalog); the caller
   * supplies it here and `validateMaterialConstraints` gates it against the
   * seed's facets exactly as for any create (an invalid seed cannot import).
   * File content stays rejected (D-ARCH-4a) — inherited from `createMaterial`.
   */
  importSeed(seed: MaterialSeed, accomMod: AccomMod): Material {
    // A seed is "a material minus the SDI posture and lifecycle"; drop the
    // catalog-only `seed_id` (provenance is the origin tag, not the id) and add
    // the teacher's posture + origin. The remaining facets ARE MaterialInput.
    const { seed_id: _seed_id, ...facets } = seed;
    return this.createMaterial({ ...facets, accom_mod: accomMod, origin: "imported_seed" });
  }

  /** The decrypted material, or undefined if unknown. Retired materials ARE retrievable. */
  getMaterial(id: OpaqueId): Material | undefined {
    const record = this.#records.get(id);
    return record === undefined ? undefined : this.#decrypt(record);
  }

  /** Every material the store holds, decrypted (active AND retired). Feeds the library projection. */
  listMaterials(): readonly Material[] {
    return [...this.#records.values()].map((record) => this.#decrypt(record));
  }

  /** The at-rest ciphertext records (envelope + blob) — what the sync layer would move. */
  storedRecords(): readonly StoredMaterialRecord[] {
    return [...this.#records.values()];
  }

  /** Edit fields/tags; re-validate at the boundary; append a Revision. */
  editMaterial(id: OpaqueId, patch: MaterialEdit, editor: string): Material {
    return this.#applyEdit(id, patch, editor);
  }

  /** Edit tag facets only; re-validate at the boundary; append a Revision. */
  retagMaterial(id: OpaqueId, patch: MaterialRetag, editor: string): Material {
    return this.#applyEdit(id, patch, editor);
  }

  /** Soft-retire (`active=false`); append a Revision. No hard delete — the record stays retrievable. */
  retireMaterial(id: OpaqueId, editor: string): Material {
    const current = this.#load(id);
    if (!current.active) {
      return current;
    }
    const retired = assembleMaterial({ ...toFields(current), active: false });
    return this.#commit(current, retired, editor);
  }

  #applyEdit(id: OpaqueId, patch: MaterialEdit, editor: string): Material {
    const current = this.#load(id);
    if (patch.content !== undefined) {
      rejectFileContent(patch.content);
    }
    const candidate = assembleMaterial(mergeFields(current, patch));
    // Validate the merged material BEFORE persisting — an invalid edit changes nothing.
    this.#validateOrThrow(candidate);
    return this.#commit(current, candidate, editor);
  }

  /** Append the `old→new` audit revision to `next`, persist it, and return the persisted material. */
  #commit(current: Material, next: Material, editor: string): Material {
    const when = this.#now();
    const revised = assembleMaterial({
      ...toFields(next),
      revisions: [
        ...current.revisions,
        { who: editor, when, old: snapshot(current), new: snapshot(next) },
      ],
    });
    this.#persist(revised, when);
    return revised;
  }

  #validateOrThrow(material: Material): void {
    const violations = validateMaterialConstraints(material);
    if (violations.length > 0) {
      throw new MaterialConstraintError(violations);
    }
  }

  #load(id: OpaqueId): Material {
    const material = this.getMaterial(id);
    if (material === undefined) {
      throw new MaterialNotFoundError(id);
    }
    return material;
  }

  #persist(material: Material, when: Timestamp): void {
    const existing = this.#records.get(material.material_id);
    const plaintext = encoder.encode(JSON.stringify(material));
    // `size` (the ciphertext-blob length, CRDT housekeeping) is NOT part of the
    // AEAD additional data — recordAad binds only record_id|record_type|scope_tag
    // — so it is a placeholder here and filled with the real blob length after
    // encryption. created_ts is preserved across edits; updated_ts advances.
    const env: RecordEnvelope = {
      record_id: material.material_id,
      record_type: RECORD_TYPE_MATERIAL,
      scope_tag: this.#keyring.masterScopeTag,
      crdt_version: {},
      created_ts: existing?.env.created_ts ?? when,
      updated_ts: when,
      size: 0,
      deleted: false,
    };
    const blob = this.#keyring.encryptRecord(env, plaintext);
    this.#records.set(material.material_id, { env: { ...env, size: blob.length }, blob });
  }

  #decrypt(record: StoredMaterialRecord): Material {
    const plaintext = this.#keyring.decryptRecord(record.env, record.blob);
    return JSON.parse(decoder.decode(plaintext)) as Material;
  }
}

/** Reject a `file` content variant — the blob channel is deferred (D-ARCH-4a). */
function rejectFileContent(content: MaterialContent): void {
  if (content.kind === "file") {
    throw new FileContentNotSupportedError();
  }
}

/** A material's fields in merge form (myp_criteria explicit). */
function toFields(m: Material): MaterialFields {
  return { ...m, myp_criteria: m.myp_criteria };
}

/** Merge a partial edit over the current material, honoring an explicit `myp_criteria: undefined` as a clear. */
function mergeFields(current: Material, patch: MaterialEdit): MaterialFields {
  const base = toFields(current);
  const mypCriteria = "myp_criteria" in patch ? patch.myp_criteria : base.myp_criteria;
  return {
    material_id: base.material_id,
    title: patch.title ?? base.title,
    content: patch.content ?? base.content,
    standard_codes: patch.standard_codes ?? base.standard_codes,
    segment_ids: patch.segment_ids ?? base.segment_ids,
    support_types: patch.support_types ?? base.support_types,
    access_band: patch.access_band ?? base.access_band,
    lesson_blocks: patch.lesson_blocks ?? base.lesson_blocks,
    udl_principles: patch.udl_principles ?? base.udl_principles,
    cra_stages: patch.cra_stages ?? base.cra_stages,
    accom_mod: patch.accom_mod ?? base.accom_mod,
    origin: patch.origin ?? base.origin,
    active: base.active,
    created_ts: base.created_ts,
    revisions: base.revisions,
    myp_criteria: mypCriteria,
  };
}
