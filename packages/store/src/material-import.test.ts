// M10-U7 — seed import (copy-on-import) tests (spec architecture/m10-u7-spec.md §Tests 1–3, 5).
// Failing-first: they encode the spec before `importSeed` exists.
//
// The payoff of the differentiation toolkit (differentiation-architecture §6):
// seeding is import/attach, NEVER generation. `importSeed` COPIES a CLEARTEXT
// `material_seed` into the teacher's library as a NEW ENCRYPTED `material` under
// the teacher master key — her editable copy, decoupled from the shared seed.
// `accom_mod` is NOT on the seed (U1: it is the teacher's SDI call at add-time,
// never baked into a shared cleartext catalog); the import supplies it and the
// U2 constraint validator gates it against the seed's facets.

import { TeacherKeyring, generateMasterKey, sodiumReady } from "@teacher-assistant/crypto";
import {
  type MaterialContent,
  type MaterialSeed,
  type Timestamp,
  asTimestamp,
  newOpaqueId,
  newScopeTag,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FileContentNotSupportedError,
  MaterialConstraintError,
  type MaterialInput,
  MaterialStore,
} from "./material-store.js";

beforeAll(async () => {
  await sodiumReady();
});

/** A fresh store with a teacher keyring and a fixed clock (the U2 test fixture). */
function freshStore(now?: () => Timestamp): MaterialStore {
  const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
  return now === undefined
    ? new MaterialStore({ keyring, now: () => asTimestamp(1_000) })
    : new MaterialStore({ keyring, now });
}

/**
 * A valid, fully-tagged on-grade text `material_seed` (no `accom_mod` — a seed
 * never carries the SDI posture). `on_grade` so the default import posture
 * `accom_mod=none` is legal (§A.3). Overridable per test.
 */
function validSeed(overrides: Partial<MaterialSeed> = {}): MaterialSeed {
  return {
    seed_id: newOpaqueId(),
    title: "Slope-intercept worked example",
    content: { kind: "text", body: "y = mx + b — three worked lines" },
    standard_codes: ["KY.8.EE.6"],
    segment_ids: [newOpaqueId()],
    support_types: ["worked_example_full"],
    access_band: "on_grade",
    lesson_blocks: ["i_do"],
    udl_principles: ["representation"],
    cra_stages: ["abstract"],
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

describe("M10-U7 test 1 — importSeed copies a seed into the library (encrypted, tagged, origin)", () => {
  it("mints a new ENCRYPTED material with origin=imported_seed carrying every seed tag", () => {
    const store = freshStore();
    const seed = validSeed({
      standard_codes: ["KY.8.EE.6", "KY.8.F.4"],
      support_types: ["worked_example_full", "step_chunked"],
      lesson_blocks: ["i_do", "we_do"],
      udl_principles: ["representation", "action_expression"],
      cra_stages: ["representational", "abstract"],
      access_band: "grade_level_scaffolded",
    });

    const material = store.importSeed(seed, "accommodation");

    // Store-owned identity/lifecycle fields are freshly minted.
    expect(material.material_id).toBeTruthy();
    expect(material.active).toBe(true);
    expect(material.revisions).toEqual([]);
    // Provenance + the teacher's add-time SDI posture.
    expect(material.origin).toBe("imported_seed");
    expect(material.accom_mod).toBe("accommodation");
    // Every material-descriptive facet copies across unchanged.
    expect(material.title).toBe(seed.title);
    expect(material.content).toEqual(seed.content);
    expect(material.standard_codes).toEqual(seed.standard_codes);
    expect(material.segment_ids).toEqual(seed.segment_ids);
    expect(material.support_types).toEqual(seed.support_types);
    expect(material.access_band).toBe(seed.access_band);
    expect(material.lesson_blocks).toEqual(seed.lesson_blocks);
    expect(material.udl_principles).toEqual(seed.udl_principles);
    expect(material.cra_stages).toEqual(seed.cra_stages);
    // The seed_id is NOT a material field — provenance is the origin tag, not the id.
    expect(material).not.toHaveProperty("seed_id");

    // Read-back round-trips through decrypt.
    expect(store.getMaterial(material.material_id)).toEqual(material);
  });

  it("carries a modified_assessment seed's myp_criteria across the copy", () => {
    const store = freshStore();
    const seed = validSeed({
      support_types: ["modified_assessment"],
      access_band: "access_foundational",
      myp_criteria: ["A", "C"],
    });
    // modified_assessment ⟹ accom_mod=modification (§A.3).
    const material = store.importSeed(seed, "modification");
    expect(material.myp_criteria).toEqual(["A", "C"]);
    expect(material.accom_mod).toBe("modification");
  });

  it("persists the copy as ciphertext at rest under the teacher master scope", () => {
    const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const store = new MaterialStore({ keyring, now: () => asTimestamp(1) });
    const title = "SEED-TITLE-marker-zzz";
    const body = "SEED-BODY-marker-qqq";
    const material = store.importSeed(
      validSeed({ title, content: { kind: "text", body } }),
      "none",
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
    // Identity-clean envelope, teacher master scope (never a period DEK).
    expect(record.env.record_type).toBe("material");
    expect(record.env.record_id).toBe(material.material_id);
    expect(record.env.scope_tag).toBe(keyring.masterScopeTag);
  });
});

describe("M10-U7 test 2 — the imported copy is independent (edit + re-import)", () => {
  it("editing the imported material does not mutate the source seed", () => {
    const store = freshStore();
    const seed = validSeed({ title: "Original seed title" });
    const material = store.importSeed(seed, "none");

    const edited = store.editMaterial(
      material.material_id,
      { title: "Niah's edited title" },
      "teacher-1",
    );
    expect(edited.title).toBe("Niah's edited title");
    // The shared seed is untouched — copy, not reference.
    expect(seed.title).toBe("Original seed title");
    expect(store.getMaterial(material.material_id)?.title).toBe("Niah's edited title");
  });

  it("re-importing the same seed yields a second, independent material", () => {
    const store = freshStore();
    const seed = validSeed();

    const first = store.importSeed(seed, "none");
    const second = store.importSeed(seed, "none");

    expect(second.material_id).not.toBe(first.material_id);
    expect(store.listMaterials()).toHaveLength(2);

    // Editing the second leaves the first (and the seed) unchanged.
    store.editMaterial(second.material_id, { title: "second only" }, "teacher-1");
    expect(store.getMaterial(first.material_id)?.title).toBe(seed.title);
    expect(store.getMaterial(second.material_id)?.title).toBe("second only");
  });
});

describe("M10-U7 test 3 — importSeed runs validateMaterialConstraints (invalid seed rejected)", () => {
  it("rejects a seed whose facets + posture violate a constraint and persists nothing", () => {
    const store = freshStore();
    // access_band off on_grade, but the teacher imports with accom_mod=none → §A.3 violation.
    const seed = validSeed({ access_band: "grade_level_scaffolded" });
    expect(() => store.importSeed(seed, "none")).toThrow(MaterialConstraintError);
    expect(store.storedRecords()).toHaveLength(0);
    expect(store.listMaterials()).toHaveLength(0);
  });

  it("rejects a modified_assessment seed missing myp_criteria and persists nothing", () => {
    const store = freshStore();
    const seed = validSeed({
      support_types: ["modified_assessment"],
      access_band: "access_foundational",
      // myp_criteria absent → the two-way rule (§B) is violated regardless of posture.
    });
    expect(() => store.importSeed(seed, "modification")).toThrow(MaterialConstraintError);
    expect(store.storedRecords()).toHaveLength(0);
  });

  it("rejects a seed carrying file content (the blob channel is deferred, D-ARCH-4a)", () => {
    const store = freshStore();
    const fileContent: MaterialContent = {
      kind: "file",
      asset_id: newOpaqueId(),
      filename: "handout.pdf",
      mime: "application/pdf",
      size: 1024,
    };
    expect(() => store.importSeed(validSeed({ content: fileContent }), "none")).toThrow(
      FileContentNotSupportedError,
    );
    expect(store.storedRecords()).toHaveLength(0);
  });
});

describe("M10-U7 test 5 — manual import is the existing U2 createMaterial (no new engine path)", () => {
  function manualInput(overrides: Partial<MaterialInput> = {}): MaterialInput {
    return {
      title: "Colleague's fractions organizer",
      content: { kind: "link", url: "https://example.org/organizer", label: "organizer" },
      standard_codes: ["KY.8.NS.1"],
      segment_ids: [newOpaqueId()],
      support_types: ["graphic_organizer"],
      access_band: "on_grade",
      lesson_blocks: ["we_do"],
      udl_principles: ["representation"],
      cra_stages: ["representational"],
      accom_mod: "none",
      origin: "imported_colleague",
      ...overrides,
    };
  }

  it("round-trips a link material imported from a colleague", () => {
    const store = freshStore();
    const created = store.createMaterial(manualInput());
    expect(created.origin).toBe("imported_colleague");
    expect(store.getMaterial(created.material_id)?.content).toEqual({
      kind: "link",
      url: "https://example.org/organizer",
      label: "organizer",
    });
  });

  it("round-trips a purchased text material", () => {
    const store = freshStore();
    const created = store.createMaterial(
      manualInput({
        origin: "purchased",
        content: { kind: "text", body: "purchased practice set" },
      }),
    );
    expect(created.origin).toBe("purchased");
    expect(store.getMaterial(created.material_id)?.content).toEqual({
      kind: "text",
      body: "purchased practice set",
    });
  });

  it("still rejects file content on a manual import", () => {
    const store = freshStore();
    const fileContent: MaterialContent = {
      kind: "file",
      asset_id: newOpaqueId(),
      filename: "packet.pdf",
      mime: "application/pdf",
      size: 2048,
    };
    expect(() => store.createMaterial(manualInput({ content: fileContent }))).toThrow(
      FileContentNotSupportedError,
    );
    expect(store.storedRecords()).toHaveLength(0);
  });
});
