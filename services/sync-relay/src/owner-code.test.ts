// TEACH-58 (EU-2): owner-code format and the canonical form both the CLI and the
// redeem route hash.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatOwnerCode, newOwnerCode, OWNER_CODE_LENGTH, ownerCodeHash } from "./owner-code.js";

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

describe("owner codes", () => {
  it("a new code is 26 Crockford characters (130 random bits) and codes differ", () => {
    const codes = new Set(Array.from({ length: 200 }, newOwnerCode));
    expect(codes.size).toBe(200);
    for (const c of codes) {
      expect(c).toHaveLength(OWNER_CODE_LENGTH);
      expect(c).toMatch(CROCKFORD);
    }
  });

  it("prints in groups of four", () => {
    expect(formatOwnerCode("ABCDEFGHJKMNPQRSTVWXYZ0123")).toBe("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23");
  });

  it("hashes the canonical form: case, separators and I/L/O are read the Crockford way", () => {
    const code = "0123456789ABCDEFGHJKMNPQRS";
    const hex = createHash("sha256").update(code).digest("hex");
    expect(ownerCodeHash(code)).toBe(hex);
    expect(ownerCodeHash(formatOwnerCode(code))).toBe(hex);
    expect(ownerCodeHash(" o1234-56789abcdefghjkmnpqrs ")).toBe(hex);
    expect(ownerCodeHash("O-I23456789ABCDEFGHJKMNPQRS")).toBe(hex);
    expect(ownerCodeHash("0L23456789ABCDEFGHJKMNPQRS")).toBe(hex);
  });

  it("anything that cannot be a code has no hash", () => {
    for (const bad of [
      "",
      "0123456789ABCDEFGHJKMNPQR", // 25
      "0123456789ABCDEFGHJKMNPQRST", // 27
      "0123456789ABCDEFGHJKMNPQRU", // U is not Crockford
      "0123456789ABCDEFGHJKMNPQR!",
      `${"-".repeat(40)}0123456789ABCDEFGHJKMNPQRS`, // over the input cap
    ]) {
      expect(ownerCodeHash(bad), bad).toBeUndefined();
    }
  });
});
