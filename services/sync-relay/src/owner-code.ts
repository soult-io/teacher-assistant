// Operator owner codes (device-enrollment spec DN-3, §5.2). A code is 26
// Crockford base32 characters (130 random bits), printed once by the CLI in
// groups of four. The relay stores only the hex SHA-256 of the canonical form,
// so the CLI (which issues) and POST /sync/enroll/redeem (which redeems) must
// canonicalize the same way: this module is the one place that does it.
//
// Never log a code or its hash (spec §5.6).

import { createHash, randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const OWNER_CODE_LENGTH = 26;
/** A redeem body's code is at most this long before canonicalizing (separators included). */
export const MAX_OWNER_CODE_INPUT = 64;

/** Default lifetime of an issued code (spec DN-3). */
export const OWNER_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** A fresh code in canonical form (26 characters, no separators). */
export function newOwnerCode(): string {
  let code = "";
  for (let i = 0; i < OWNER_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** The printed form: groups of four joined by hyphens. */
export function formatOwnerCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Crockford decoding rules: case-insensitive, hyphens and spaces ignored,
 * I/L read as 1 and O as 0. Undefined when the result is not a well-formed code.
 */
function canonicalOwnerCode(input: string): string | undefined {
  if (input.length > MAX_OWNER_CODE_INPUT) {
    return undefined;
  }
  const code = input.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (code.length !== OWNER_CODE_LENGTH || ![...code].every((c) => ALPHABET.includes(c))) {
    return undefined;
  }
  return code;
}

/** Hex SHA-256 of the canonical code; undefined for input that cannot be a code. */
export function ownerCodeHash(input: string): string | undefined {
  const code = canonicalOwnerCode(input);
  return code === undefined ? undefined : createHash("sha256").update(code).digest("hex");
}
