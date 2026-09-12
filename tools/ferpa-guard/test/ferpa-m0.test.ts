// FERPA-guard — the M0-relevant HARD STOPS (phase0-spec §8). This is the
// dedicated privacy gate: a red check here BLOCKS merge. It mixes behavioural
// proofs (it imports the real crypto layer and exercises the invariants) with
// static source scans, because the decisive properties (a para cannot decrypt a
// goal definition; MK never reaches the wire in plaintext) are cryptographic,
// not merely textual.
//
// Covered here: #9 para key-scope, #10 ciphertext-only-at-rest, the opaque-id
// rule, MK-never-serialised, and the H-PUB-1 passkey/no-password static check.
// The suite grows with each module.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveDeviceEnrollment,
  createEnrollmentRequest,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  generateRecoveryCode,
  NoKeyForScopeError,
  ParaKeyring,
  rotatePeriodKey,
  sodiumReady,
  TeacherKeyring,
  toBase64,
  utf8,
  wrapMasterKeyWithRecoveryCode,
} from "@teacher-assistant/crypto";
import {
  asTimestamp,
  newOpaqueId,
  newScopeTag,
  type RecordEnvelope,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { collectFiles, fileContains, scanCodeForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function env(
  scope: ReturnType<typeof newScopeTag>,
  type: RecordEnvelope["record_type"],
): RecordEnvelope {
  return {
    record_id: newOpaqueId(),
    record_type: type,
    scope_tag: scope,
    crdt_version: {},
    created_ts: asTimestamp(0),
    updated_ts: asTimestamp(0),
    size: 0,
    deleted: false,
  };
}

/** True if `needle`'s bytes appear as a contiguous run inside `haystack`. */
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

beforeAll(async () => {
  await sodiumReady();
});

describe("HARD STOP #9 — para keyring cannot decrypt other periods or goal definitions", () => {
  it("a para (periodA only) cannot read the master scope or periodB; can read periodA", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    const periodA = generatePeriodKey(newScopeTag());
    const periodB = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(periodA);
    teacher.addPeriodKey(periodB);

    const goalEnv = env(masterScope, "goal");
    const aEnv = env(periodA.scopeTag, "data_point");
    const bEnv = env(periodB.scopeTag, "data_point");
    const goalBlob = teacher.encryptRecord(goalEnv, utf8("goal definition"));
    const aBlob = teacher.encryptRecord(aEnv, utf8("A point"));
    const bBlob = teacher.encryptRecord(bEnv, utf8("B point"));

    const para = new ParaKeyring([periodA]);
    // Goal definition (master scope): no key → refused.
    expect(() => para.decryptRecord(goalEnv, goalBlob)).toThrow(NoKeyForScopeError);
    // Another period: no key → refused.
    expect(() => para.decryptRecord(bEnv, bBlob)).toThrow(NoKeyForScopeError);
    // Its own period: allowed.
    expect(new TextDecoder().decode(para.decryptRecord(aEnv, aBlob))).toBe("A point");
  });

  it("rotating periodA's DEK revokes a pre-rotation para key (revocation)", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const oldKey = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(oldKey);
    const revokedPara = new ParaKeyring([oldKey]);

    // Rotate → new scope + key; future writes use it, re-wrapped only to authorized devices.
    const newKey = rotatePeriodKey(newScopeTag());
    teacher.addPeriodKey(newKey);
    const postRotationEnv = env(newKey.scopeTag, "data_point");
    const postBlob = teacher.encryptRecord(postRotationEnv, utf8("after rotation"));

    // The revoked para holds only the old scope → cannot read post-rotation writes.
    expect(() => revokedPara.decryptRecord(postRotationEnv, postBlob)).toThrow(NoKeyForScopeError);
  });
});

describe("HARD STOP #10 — no plaintext student data at rest", () => {
  it("a record is persisted only as ciphertext (the blob never contains the plaintext)", () => {
    const scope = newScopeTag();
    const teacher = new TeacherKeyring(scope, generateMasterKey());
    const plaintext = utf8("AB scored 7 of 10 — synthetic");
    const blob = teacher.encryptRecord(env(scope, "data_point"), plaintext);
    expect(containsBytes(blob, plaintext)).toBe(false);
  });

  it("server source references no decrypted student-payload field identifier", () => {
    const serviceFiles = collectFiles(join(repoRoot, "services"), [".ts"]);
    const piiFields =
      /\b(initials|goal_text|criterion_level|numerator|denominator_used|para_observations|accommodation_subtypes|color_token|baseline_value)\b/;
    const hits = scanCodeForPattern(serviceFiles, piiFields);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});

describe("opaque ids are never derived from student data (VERIFY-AT-BUILD)", () => {
  it("the id generator takes no input, so no PII can seed an id", () => {
    expect(newOpaqueId.length).toBe(0);
    expect(newScopeTag.length).toBe(0);
    expect(newOpaqueId()).not.toEqual(newOpaqueId());
  });

  it("no source derives an id from initials/goal text", () => {
    const files = [
      ...collectFiles(join(repoRoot, "packages"), [".ts"]),
      ...collectFiles(join(repoRoot, "services"), [".ts"]),
    ];
    const derivePattern =
      /\b(hash|digest|createHash|genericHash|sha\d*)\s*\([^)]*\b(initials|goal_text|goalText)\b/i;
    expect(scanCodeForPattern(files, derivePattern)).toEqual([]);
  });
});

describe("HARD STOP (M0) — the master key never reaches the wire/logs in plaintext", () => {
  it("MK bytes appear in no wire artifact, and the keyring withholds keys from JSON", () => {
    const masterScope = newScopeTag();
    const mk = generateMasterKey();
    const teacher = new TeacherKeyring(masterScope, mk);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);

    // Every artifact that could cross a boundary:
    const device = generateDeviceKeypair();
    const { request, verificationCode } = createEnrollmentRequest(device);
    const grant = approveDeviceEnrollment(teacher, request, verificationCode);
    const recovery = wrapMasterKeyWithRecoveryCode(mk, generateRecoveryCode());
    const recordBlob = teacher.encryptRecord(env(masterScope, "goal"), utf8("payload"));

    const textArtifacts = [
      grant.wrappedMasterKeyB64,
      grant.masterScopeTag,
      recovery.blobB64,
      recovery.saltB64,
      JSON.stringify(teacher),
    ];
    const mkB64 = toBase64(mk);
    for (const text of textArtifacts) {
      // raw bytes must not appear, AND the base64 form must not appear (a
      // base64-encoded leak would survive a raw-byte scan).
      expect(containsBytes(utf8(text), mk)).toBe(false);
      expect(text).not.toContain(mkB64);
    }
    expect(containsBytes(recordBlob, mk)).toBe(false);

    // The keyring's own serialisation withholds key material.
    expect(JSON.stringify(teacher)).toContain("[withheld]");
  });
});

describe("HARD STOP #1 — H-PUB-1 passkey auth present, no password path", () => {
  const authFiles = collectFiles(join(repoRoot, "packages", "auth"), [".ts"]);
  const webauthnFile = join(repoRoot, "packages", "auth", "src", "webauthn.ts");

  it("the auth package uses WebAuthn/passkeys (SimpleWebAuthn, pinned)", () => {
    expect(fileContains(webauthnFile, "@simplewebauthn/server")).toBe(true);
    expect(fileContains(webauthnFile, 'userVerification: "required"')).toBe(true);
  });

  it("there is no password anywhere in the auth surface (no password-only path)", () => {
    const hits = scanCodeForPattern(authFiles, /password/i);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
