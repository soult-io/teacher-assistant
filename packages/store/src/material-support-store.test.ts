// M10-U5 — material-support link store tests (spec architecture/m10-u5-spec.md
// §Tests 1–6, 9). Failing-first: they encode the spec before the store satisfies
// it. Tests 7 (no-data-edge) and 8 (Goal Detail surfacing) live in domain-core.

import { TeacherKeyring, generateMasterKey, sodiumReady } from "@teacher-assistant/crypto";
import {
  type Material,
  type OpaqueId,
  type Timestamp,
  asTimestamp,
  newOpaqueId,
  newScopeTag,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { MaterialStore, type MaterialInput } from "./material-store.js";
import {
  LinkConstraintError,
  LinkMaterialNotFoundError,
  MaterialSupportStore,
  SupportNotFoundError,
} from "./material-support-store.js";

beforeAll(async () => {
  await sodiumReady();
});

/** A valid, unadapted, on-grade text material (accom_mod=none is legal only at on_grade). */
function validTextInput(overrides: Partial<MaterialInput> = {}): MaterialInput {
  return {
    title: "Slope-intercept worked example",
    content: { kind: "text", body: "y = mx + b — three worked lines" },
    standard_codes: ["KY.8.EE.6"],
    segment_ids: [newOpaqueId()],
    support_types: ["worked_example_full"],
    access_band: "on_grade",
    lesson_blocks: ["i_do"],
    udl_principles: ["representation"],
    cra_stages: ["abstract"],
    accom_mod: "none",
    origin: "teacher_authored",
    ...overrides,
  };
}

/**
 * A fresh support store backed by a material store sharing ONE teacher keyring,
 * with a controllable clock. The support store resolves materials (for link-time
 * facet validation) through the material store's `getMaterial`.
 */
function freshStores(now?: () => Timestamp): {
  readonly keyring: TeacherKeyring;
  readonly materials: MaterialStore;
  readonly supports: MaterialSupportStore;
} {
  const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
  const clock = now ?? (() => asTimestamp(1_000));
  const materials = new MaterialStore({ keyring, now: clock });
  const supports = new MaterialSupportStore({
    keyring,
    now: clock,
    resolveMaterial: (id) => materials.getMaterial(id),
  });
  return { keyring, materials, supports };
}

/** True if `needle`'s bytes appear as a contiguous run inside `haystack` (ferpa-m0 at-rest pattern). */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

describe("M10-U5 test 1 — material→goal attach/detach round-trip, ENCRYPTED teacher MK", () => {
  it("attaches a material to a goal, reads it back, and encrypts under the master scope", () => {
    const { keyring, materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());
    const goalId = newOpaqueId();

    const link = supports.attachMaterialToGoal(material.material_id, goalId, "none");
    expect(link.support_id).toBeTruthy();
    expect(link.material_id).toBe(material.material_id);
    expect(link.goal_id).toBe(goalId);
    expect(link.accom_mod).toBe("none");

    // Live read returns the link.
    expect(supports.listGoalSupports()).toEqual([link]);

    // At rest: exactly one goal-support record, encrypted under the teacher MK.
    const records = supports.storedRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) {
      throw new Error("expected one stored record");
    }
    expect(record.env.record_type).toBe("material_goal_support");
    expect(record.env.scope_tag).toBe(keyring.masterScopeTag);
    expect(record.env.record_id).toBe(link.support_id);
    expect(record.env.deleted).toBe(false);
  });

  it("detaches (soft-remove/tombstone): dropped from the live list, record retained", () => {
    const { materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());
    const link = supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "none");

    supports.detachMaterialFromGoal(link.support_id);

    // Gone from the live projection…
    expect(supports.listGoalSupports()).toEqual([]);
    // …but the tombstoned record is retained (auditable — no hard delete).
    const records = supports.storedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.env.deleted).toBe(true);
  });

  it("detach is idempotent and throws on an unknown support id", () => {
    const { materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());
    const link = supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "none");

    supports.detachMaterialFromGoal(link.support_id);
    // A second detach is a no-op (still one tombstoned record, no throw).
    supports.detachMaterialFromGoal(link.support_id);
    expect(supports.storedRecords()).toHaveLength(1);

    expect(() => supports.detachMaterialFromGoal(newOpaqueId())).toThrow(SupportNotFoundError);
  });
});

describe("M10-U5 test 2 — material→student attach/detach round-trip, ENCRYPTED teacher MK", () => {
  it("attaches a material to a student, reads it back, and encrypts under the master scope", () => {
    const { keyring, materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());
    const studentId = newOpaqueId();

    const link = supports.attachMaterialToStudent(material.material_id, studentId);
    expect(link.support_id).toBeTruthy();
    expect(link.material_id).toBe(material.material_id);
    expect(link.student_id).toBe(studentId);

    expect(supports.listStudentSupports()).toEqual([link]);

    const records = supports.storedRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) {
      throw new Error("expected one stored record");
    }
    expect(record.env.record_type).toBe("material_student_support");
    expect(record.env.scope_tag).toBe(keyring.masterScopeTag);
  });

  it("detaches (tombstone): dropped from the live list, record retained", () => {
    const { materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());
    const link = supports.attachMaterialToStudent(material.material_id, newOpaqueId());

    supports.detachMaterialFromStudent(link.support_id);
    expect(supports.listStudentSupports()).toEqual([]);
    expect(supports.storedRecords()).toHaveLength(1);
    expect(supports.storedRecords()[0]?.env.deleted).toBe(true);
  });
});

describe("M10-U5 test 3 — link accom_mod REQUIRED at attach (missing → rejected, nothing persisted)", () => {
  it("rejects a goal attach with a missing/invalid accom_mod and persists nothing", () => {
    const { materials, supports } = freshStores();
    const material = materials.createMaterial(validTextInput());

    // A caller from untyped JSON hands undefined / a bogus value.
    expect(() =>
      supports.attachMaterialToGoal(material.material_id, newOpaqueId(), undefined as never),
    ).toThrow(LinkConstraintError);
    expect(() =>
      supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "sometimes" as never),
    ).toThrow(LinkConstraintError);

    expect(supports.storedRecords()).toHaveLength(0);
    expect(supports.listGoalSupports()).toHaveLength(0);
  });

  it("rejects a goal attach for a material the store cannot resolve", () => {
    const { supports } = freshStores();
    expect(() => supports.attachMaterialToGoal(newOpaqueId(), newOpaqueId(), "none")).toThrow(
      LinkMaterialNotFoundError,
    );
    expect(supports.storedRecords()).toHaveLength(0);
  });
});

describe("M10-U5 test 4 — validator: accom_mod=none only when material access_band=on_grade", () => {
  it("rejects none for an adapted (non-on_grade) material and persists nothing", () => {
    const { materials, supports } = freshStores();
    // Adapted material: grade_level_scaffolded needs a real accom/mod, not none.
    const adapted = materials.createMaterial(
      validTextInput({
        support_types: ["guided_notes"],
        access_band: "grade_level_scaffolded",
        accom_mod: "accommodation",
      }),
    );
    expect(() => supports.attachMaterialToGoal(adapted.material_id, newOpaqueId(), "none")).toThrow(
      LinkConstraintError,
    );
    expect(supports.storedRecords()).toHaveLength(0);
  });

  it("accepts none for an on_grade material", () => {
    const { materials, supports } = freshStores();
    const onGrade = materials.createMaterial(validTextInput()); // on_grade
    const link = supports.attachMaterialToGoal(onGrade.material_id, newOpaqueId(), "none");
    expect(link.accom_mod).toBe("none");
    expect(supports.storedRecords()).toHaveLength(1);
  });

  it("accepts a real accom/mod for an adapted material", () => {
    const { materials, supports } = freshStores();
    const adapted = materials.createMaterial(
      validTextInput({
        support_types: ["guided_notes"],
        access_band: "grade_level_scaffolded",
        accom_mod: "accommodation",
      }),
    );
    const link = supports.attachMaterialToGoal(adapted.material_id, newOpaqueId(), "accommodation");
    expect(link.accom_mod).toBe("accommodation");
  });
});

describe("M10-U5 test 5 — validator: modified_assessment material ⟹ link accom_mod must be modification", () => {
  function modifiedMaterial(materials: MaterialStore): Material {
    return materials.createMaterial(
      validTextInput({
        support_types: ["modified_assessment"],
        access_band: "access_foundational",
        accom_mod: "modification",
        myp_criteria: ["A"],
      }),
    );
  }

  it("rejects a link accom_mod of accommodation for a modified_assessment material", () => {
    const { materials, supports } = freshStores();
    const material = modifiedMaterial(materials);
    expect(() =>
      supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "accommodation"),
    ).toThrow(LinkConstraintError);
    expect(supports.storedRecords()).toHaveLength(0);
  });

  it("rejects a link accom_mod of none for a modified_assessment material", () => {
    const { materials, supports } = freshStores();
    const material = modifiedMaterial(materials);
    expect(() =>
      supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "none"),
    ).toThrow(LinkConstraintError);
  });

  it("accepts modification for a modified_assessment material", () => {
    const { materials, supports } = freshStores();
    const material = modifiedMaterial(materials);
    const link = supports.attachMaterialToGoal(material.material_id, newOpaqueId(), "modification");
    expect(link.accom_mod).toBe("modification");
  });
});

describe("M10-U5 test 6 — same material attaches to two goals with different accom_mod", () => {
  it("allows accommodation for one goal and modification for another (no cross-goal constraint)", () => {
    const { materials, supports } = freshStores();
    // A material adaptable either way — non-on_grade, no modified_assessment.
    const material = materials.createMaterial(
      validTextInput({
        support_types: ["adapted_practice"],
        access_band: "foundational_bridge",
        accom_mod: "accommodation",
      }),
    );
    const goalA = newOpaqueId();
    const goalB = newOpaqueId();

    const linkA = supports.attachMaterialToGoal(material.material_id, goalA, "accommodation");
    const linkB = supports.attachMaterialToGoal(material.material_id, goalB, "modification");

    expect(linkA.accom_mod).toBe("accommodation");
    expect(linkB.accom_mod).toBe("modification");
    expect(linkA.support_id).not.toBe(linkB.support_id);
    expect(supports.listGoalSupports()).toHaveLength(2);
  });
});

describe("M10-U5 test 9 — envelope identity-clean; no student/content/score leak", () => {
  it("the student-support blob + envelope carry no student id or content in cleartext", () => {
    const { materials, supports } = freshStores();
    const body = "SECRET-BODY-marker-qqq";
    const material = materials.createMaterial(validTextInput({ content: { kind: "text", body } }));
    // A distinctive opaque student id we can search the at-rest bytes for.
    const studentId = "STUDENT-MARKER-zzz" as OpaqueId;
    const link = supports.attachMaterialToStudent(material.material_id, studentId);

    const record = supports.storedRecords().find((r) => r.env.record_id === link.support_id);
    if (record === undefined) {
      throw new Error("expected the student-support record");
    }
    const enc = new TextEncoder();
    // The student id and the material body are inside the ciphertext, never cleartext.
    expect(containsBytes(record.blob, enc.encode(studentId))).toBe(false);
    expect(containsBytes(record.blob, enc.encode(body))).toBe(false);

    // The envelope is identity-clean: opaque ids + coarse type only.
    const envJson = JSON.stringify(record.env);
    expect(envJson).not.toContain(studentId);
    expect(envJson).not.toContain(body);
    expect(envJson).not.toContain(material.material_id);
    expect(record.env.record_type).toBe("material_student_support");

    // Round-trip still recovers the coupling under the teacher key.
    expect(supports.listStudentSupports()[0]?.student_id).toBe(studentId);
  });
});
