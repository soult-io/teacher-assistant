// M10-U2 — material store tests (spec architecture/m10-u2-spec.md §Tests 1–6).
// Failing-first: they encode the spec before the store satisfies it.

import { TeacherKeyring, generateMasterKey, sodiumReady } from "@teacher-assistant/crypto";
import {
  type MaterialContent,
  type OpaqueId,
  type Timestamp,
  asTimestamp,
  newOpaqueId,
  newScopeTag,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FileContentNotSupportedError,
  MaterialConstraintError,
  MaterialNotFoundError,
  MaterialStore,
  type MaterialInput,
} from "./material-store.js";

beforeAll(async () => {
  await sodiumReady();
});

/** A fresh store with a teacher keyring and a controllable clock (defaults to a fixed tick). */
function freshStore(now?: () => Timestamp): MaterialStore {
  const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
  return now === undefined
    ? new MaterialStore({ keyring, now: () => asTimestamp(1_000) })
    : new MaterialStore({ keyring, now });
}

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

describe("M10-U2 test 1 — create → read round-trip (text + link)", () => {
  it("persists a text material and reads it back with tags + active=true", () => {
    const store = freshStore();
    const created = store.createMaterial(validTextInput());

    expect(created.active).toBe(true);
    expect(created.material_id).toBeTruthy();
    expect(created.revisions).toEqual([]);

    const read = store.getMaterial(created.material_id);
    expect(read).toEqual(created);
    expect(read?.content).toEqual({ kind: "text", body: "y = mx + b — three worked lines" });
    expect(read?.support_types).toEqual(["worked_example_full"]);
    expect(read?.standard_codes).toEqual(["KY.8.EE.6"]);
    expect(read?.access_band).toBe("on_grade");
  });

  it("persists a link material (label optional) and reads it back", () => {
    const store = freshStore();
    const content: MaterialContent = {
      kind: "link",
      url: "https://example.org/fraction-tiles",
      label: "Fraction tiles",
    };
    const created = store.createMaterial(validTextInput({ content }));
    expect(store.getMaterial(created.material_id)?.content).toEqual(content);
  });

  it("mints distinct ids for two creates", () => {
    const store = freshStore();
    const a = store.createMaterial(validTextInput());
    const b = store.createMaterial(validTextInput());
    expect(a.material_id).not.toBe(b.material_id);
  });
});

describe("M10-U2 test 2 — at-rest encryption (ciphertext blob, no plaintext)", () => {
  it("the stored blob does not contain the plaintext title or content body", () => {
    const store = freshStore();
    const title = "SECRET-TITLE-marker-zzz";
    const body = "SECRET-BODY-marker-qqq";
    const created = store.createMaterial(
      validTextInput({ title, content: { kind: "text", body } }),
    );

    const records = store.storedRecords();
    expect(records).toHaveLength(1);
    const record = records[0];
    if (record === undefined) {
      throw new Error("expected one stored record");
    }
    const enc = new TextEncoder();
    expect(containsBytes(record.blob, enc.encode(title))).toBe(false);
    expect(containsBytes(record.blob, enc.encode(body))).toBe(false);
    // The envelope is identity-clean: it names the coarse type + opaque ids only.
    expect(record.env.record_type).toBe("material");
    expect(record.env.record_id).toBe(created.material_id);
    expect(JSON.stringify(record.env)).not.toContain(title);
    expect(JSON.stringify(record.env)).not.toContain(body);
    // Sanity: the decrypt path still recovers the plaintext.
    expect(store.getMaterial(created.material_id)?.title).toBe(title);
  });

  it("encrypts every material under the teacher master scope (never a period DEK)", () => {
    const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const store = new MaterialStore({ keyring, now: () => asTimestamp(1) });
    store.createMaterial(validTextInput());
    const record = store.storedRecords()[0];
    expect(record?.env.scope_tag).toBe(keyring.masterScopeTag);
  });
});

describe("M10-U2 test 3 — file content rejected (create + edit), nothing persisted", () => {
  const fileContent: MaterialContent = {
    kind: "file",
    asset_id: newOpaqueId(),
    filename: "handout.pdf",
    mime: "application/pdf",
    size: 1024,
  };

  it("rejects file content at create and persists nothing", () => {
    const store = freshStore();
    expect(() => store.createMaterial(validTextInput({ content: fileContent }))).toThrow(
      FileContentNotSupportedError,
    );
    expect(store.storedRecords()).toHaveLength(0);
    expect(store.listMaterials()).toHaveLength(0);
  });

  it("rejects file content at edit and leaves the stored material unchanged", () => {
    const store = freshStore();
    const created = store.createMaterial(validTextInput());
    expect(() =>
      store.editMaterial(created.material_id, { content: fileContent }, "teacher-1"),
    ).toThrow(FileContentNotSupportedError);
    const read = store.getMaterial(created.material_id);
    expect(read?.content).toEqual(created.content);
    expect(read?.revisions).toEqual([]);
  });
});

describe("M10-U2 test 4 — validateMaterialConstraints enforced at the boundary (create + edit)", () => {
  it("rejects accom_mod=none when access_band is not on_grade (create)", () => {
    const store = freshStore();
    expect(() =>
      store.createMaterial(
        validTextInput({ access_band: "grade_level_scaffolded", accom_mod: "none" }),
      ),
    ).toThrow(MaterialConstraintError);
    expect(store.storedRecords()).toHaveLength(0);
  });

  it("rejects modified_assessment without accom_mod=modification (create)", () => {
    const store = freshStore();
    // modified_assessment ⟹ modification; also needs myp_criteria — use accommodation to isolate the rule.
    expect(() =>
      store.createMaterial(
        validTextInput({
          support_types: ["modified_assessment"],
          access_band: "access_foundational",
          accom_mod: "accommodation",
          myp_criteria: ["A"],
        }),
      ),
    ).toThrow(MaterialConstraintError);
    expect(store.storedRecords()).toHaveLength(0);
  });

  it("rejects a bad myp_criteria combination — present without modified_assessment (create)", () => {
    const store = freshStore();
    expect(() => store.createMaterial(validTextInput({ myp_criteria: ["A"] }))).toThrow(
      MaterialConstraintError,
    );
    expect(store.storedRecords()).toHaveLength(0);
  });

  it("rejects an edit that makes the material invalid and changes nothing", () => {
    const store = freshStore();
    const created = store.createMaterial(validTextInput());
    // Flip the band away from on_grade while leaving accom_mod=none → invalid.
    expect(() =>
      store.editMaterial(created.material_id, { access_band: "foundational_bridge" }, "teacher-1"),
    ).toThrow(MaterialConstraintError);
    const read = store.getMaterial(created.material_id);
    expect(read).toEqual(created);
    expect(read?.revisions).toEqual([]);
  });

  it("accepts a valid modified_assessment material with myp_criteria (create + edit round-trip)", () => {
    const store = freshStore();
    const created = store.createMaterial(
      validTextInput({
        support_types: ["modified_assessment"],
        access_band: "access_foundational",
        accom_mod: "modification",
        myp_criteria: ["A", "C"],
      }),
    );
    expect(created.myp_criteria).toEqual(["A", "C"]);
    // Edit that drops modified_assessment MUST also clear myp_criteria (two-way rule).
    const edited = store.editMaterial(
      created.material_id,
      {
        support_types: ["guided_notes"],
        access_band: "grade_level_scaffolded",
        accom_mod: "accommodation",
        myp_criteria: undefined,
      },
      "teacher-1",
    );
    expect(edited.myp_criteria).toBeUndefined();
    expect("myp_criteria" in edited).toBe(false);
  });
});

describe("M10-U2 test 5 — edit appends a Revision; history retrievable", () => {
  it("records who/when and the old→new snapshots, retrievable via getMaterial", () => {
    let tick = 100;
    const store = freshStore(() => {
      tick += 100;
      return asTimestamp(tick);
    });
    const created = store.createMaterial(validTextInput({ title: "v1" }));
    const edited = store.editMaterial(created.material_id, { title: "v2" }, "teacher-42");

    expect(edited.title).toBe("v2");
    expect(edited.revisions).toHaveLength(1);
    const rev = edited.revisions[0];
    if (rev === undefined) {
      throw new Error("expected one revision");
    }
    expect(rev.who).toBe("teacher-42");
    expect(typeof rev.when).toBe("number");
    expect((rev.old as { title: string }).title).toBe("v1");
    expect((rev.new as { title: string }).title).toBe("v2");
    // A snapshot does not nest the revisions array (no unbounded audit growth).
    expect((rev.old as Record<string, unknown>).revisions).toBeUndefined();

    // History survives a second edit and a round-trip through the store.
    const retagged = store.retagMaterial(
      created.material_id,
      { support_types: ["guided_notes"] },
      "teacher-7",
    );
    expect(retagged.revisions).toHaveLength(2);
    expect(store.getMaterial(created.material_id)?.revisions).toHaveLength(2);
    expect(retagged.revisions[1]?.who).toBe("teacher-7");
  });

  it("throws MaterialNotFoundError for edit/retag/retire on an unknown id", () => {
    const store = freshStore();
    const ghost = newOpaqueId() as OpaqueId;
    expect(() => store.editMaterial(ghost, { title: "x" }, "t")).toThrow(MaterialNotFoundError);
    expect(() => store.retagMaterial(ghost, { cra_stages: ["concrete"] }, "t")).toThrow(
      MaterialNotFoundError,
    );
    expect(() => store.retireMaterial(ghost, "t")).toThrow(MaterialNotFoundError);
  });
});

describe("M10-U2 test 6 — retire is soft (active=false), retrievable by id", () => {
  it("sets active=false, appends a revision, and keeps the record retrievable", () => {
    const store = freshStore();
    const created = store.createMaterial(validTextInput());
    const retired = store.retireMaterial(created.material_id, "teacher-1");

    expect(retired.active).toBe(false);
    expect(retired.revisions).toHaveLength(1);
    // Still retrievable by id (no hard delete) — the record persists.
    const read = store.getMaterial(created.material_id);
    expect(read?.active).toBe(false);
    expect(store.storedRecords()).toHaveLength(1);
  });

  it("retiring an already-retired material is idempotent (no second revision)", () => {
    const store = freshStore();
    const created = store.createMaterial(validTextInput());
    store.retireMaterial(created.material_id, "teacher-1");
    const again = store.retireMaterial(created.material_id, "teacher-1");
    expect(again.active).toBe(false);
    expect(again.revisions).toHaveLength(1);
  });
});
