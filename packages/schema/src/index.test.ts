import { describe, expect, it } from "vitest";
import {
  isEncryptedRecordType,
  newOpaqueId,
  newScopeTag,
  RECORD_CLASSIFICATION,
  RECORD_TYPES,
} from "./index.js";

describe("opaque ids (data-model §10.2)", () => {
  it("newOpaqueId mints a fresh UUID each call — never derived from input", () => {
    const a = newOpaqueId();
    const b = newOpaqueId();
    expect(a).not.toEqual(b);
    // UUIDv4 shape — proves it is a random id, not a hash/substring of PII.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("newScopeTag mints a fresh opaque key-id each call", () => {
    expect(newScopeTag()).not.toEqual(newScopeTag());
  });
});

describe("classification map (data-model §10.1)", () => {
  it("classifies every record type (no gap can leave a type unguarded)", () => {
    for (const type of RECORD_TYPES) {
      expect(RECORD_CLASSIFICATION[type]).toMatch(/^(ENCRYPTED|CLEARTEXT)$/);
    }
    expect(Object.keys(RECORD_CLASSIFICATION).sort()).toEqual([...RECORD_TYPES].sort());
  });

  it("every student-linked type is ENCRYPTED; reference types are CLEARTEXT", () => {
    for (const type of [
      "student",
      "goal",
      "baseline_point",
      "data_point",
      "myp_achievement",
      "block_goal_attach",
      "plan_week",
    ] as const) {
      expect(isEncryptedRecordType(type)).toBe(true);
    }
    for (const type of ["class_period", "para", "ky_standard", "calendar_week"] as const) {
      expect(isEncryptedRecordType(type)).toBe(false);
    }
  });
});
