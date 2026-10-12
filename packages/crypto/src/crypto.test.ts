// M0 crypto — FUNCTIONAL correctness (the primitives work). The privacy
// hard-stops (para cannot decrypt; MK never serialised; rotation revokes;
// opaque-ids not derived; ciphertext-only) are proven in the FERPA-guard suite
// (tools/ferpa-guard), the dedicated hard-stop gate — except one co-located
// negative mirror (a para keyring throws opening a master-scope record) kept here
// too, next to the primitives it exercises; ferpa-guard holds the gating copy.

import {
  asTimestamp,
  newOpaqueId,
  newScopeTag,
  type RecordEnvelope,
  type ScopeTag,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  completeDeviceEnrollment,
  completeParaEnrollment,
  createEnrollmentRequest,
  decodeEnrollmentRequest,
  encodeEnrollmentRequest,
  EnrollmentConfirmationError,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  generateRecoveryCode,
  generateSigningKeypair,
  NoKeyForScopeError,
  normalizeRecoveryCode,
  ParaKeyring,
  rotatePeriodKey,
  sodiumReady,
  TeacherKeyring,
  unwrapRecoveryBundle,
  utf8,
  wrapRecoveryBundle,
} from "./index.js";

beforeAll(async () => {
  await sodiumReady();
});

/** The two public keys an enrolling device sends (box key for the grant, signing key for the relay). */
function enrollingKeys(box: ReturnType<typeof generateDeviceKeypair>) {
  return { boxPublicKey: box.publicKey, signingPublicKey: generateSigningKeypair().publicKey };
}

function envelope(scope: ScopeTag, type: RecordEnvelope["record_type"]): RecordEnvelope {
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

describe("record AEAD", () => {
  it("round-trips a record under its scope key", () => {
    const scope = newScopeTag();
    const kr = new TeacherKeyring(scope, generateMasterKey());
    const env = envelope(scope, "goal");
    const plaintext = utf8("goal definition — synthetic");
    const blob = kr.encryptRecord(env, plaintext);
    expect(new TextDecoder().decode(kr.decryptRecord(env, blob))).toBe(
      "goal definition — synthetic",
    );
  });

  it("rejects a record moved to a different envelope (AAD binding)", () => {
    const scope = newScopeTag();
    const kr = new TeacherKeyring(scope, generateMasterKey());
    const blob = kr.encryptRecord(envelope(scope, "goal"), utf8("x"));
    // Same scope key, but a different record_id/type → AAD mismatch → throws.
    expect(() => kr.decryptRecord(envelope(scope, "data_point"), blob)).toThrow();
  });
});

describe("paper recovery code (D-ARCH-1)", () => {
  it("generates a grouped Crockford code and normalises transcription aliases", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/);
    // O→0, I/L→1, case + separators folded: OOIILL → 001111, then ABCD.
    expect(normalizeRecoveryCode("oOiIlL-abcd")).toBe("001111ABCD");
  });

  it("restores the master key on a fresh device", () => {
    const mk = generateMasterKey();
    const code = generateRecoveryCode();
    const wrap = wrapRecoveryBundle(
      { mk, masterScopeTag: newScopeTag(), masterDocId: newOpaqueId() },
      code,
    );
    const restored = unwrapRecoveryBundle(code, wrap);
    expect([...restored.mk]).toEqual([...mk]);
  });

  it("refuses a wrong recovery code", () => {
    const wrap = wrapRecoveryBundle(
      { mk: generateMasterKey(), masterScopeTag: newScopeTag(), masterDocId: newOpaqueId() },
      generateRecoveryCode(),
    );
    expect(() => unwrapRecoveryBundle(generateRecoveryCode(), wrap)).toThrow();
  });
});

describe("device enrollment (typed out-of-band code)", () => {
  it("enrolls a second teacher device cross-device and recovers MK", () => {
    const masterScope = newScopeTag();
    const trusted = new TeacherKeyring(masterScope, generateMasterKey());

    // New device builds a request + shows the code the approver types.
    const newDevice = generateDeviceKeypair();
    const { request, verificationCode } = createEnrollmentRequest(enrollingKeys(newDevice));
    const scanned = decodeEnrollmentRequest(encodeEnrollmentRequest(request));

    // Trusted device approves after confirming the OOB code.
    const grant = approveDeviceEnrollment(trusted, scanned, verificationCode, newOpaqueId());
    const { mk, masterScopeTag } = completeDeviceEnrollment(newDevice, grant);

    // The new device can now decrypt a master-scope record the trusted device wrote.
    const enrolled = new TeacherKeyring(masterScopeTag, mk);
    const env = envelope(masterScope, "goal");
    const blob = trusted.encryptRecord(env, utf8("secret"));
    expect(new TextDecoder().decode(enrolled.decryptRecord(env, blob))).toBe("secret");
  });

  it("refuses approval when the OOB verification code does not match", () => {
    const trusted = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const { request } = createEnrollmentRequest(enrollingKeys(generateDeviceKeypair()));
    expect(() => approveDeviceEnrollment(trusted, request, "000000", newOpaqueId())).toThrow(
      EnrollmentConfirmationError,
    );
  });

  it("rejects a malformed scanned request", () => {
    expect(() => decodeEnrollmentRequest("not-base64-json")).toThrow();
  });
});

describe("para enrollment + rotation", () => {
  it("wraps only the assigned Period DEK to the para device", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);

    const paraDevice = generateDeviceKeypair();
    const { request, verificationCode } = createEnrollmentRequest(enrollingKeys(paraDevice));
    const grant = approveParaEnrollment(
      teacher,
      period.scopeTag,
      request,
      verificationCode,
      newOpaqueId(),
    );
    const periodKey = completeParaEnrollment(paraDevice, grant);

    const para = new ParaKeyring([periodKey]);
    const env = envelope(period.scopeTag, "data_point");
    const blob = teacher.encryptRecord(env, utf8("3 of 5"));
    expect(new TextDecoder().decode(para.decryptRecord(env, blob))).toBe("3 of 5");
    // The para keyring holds exactly one scope — its period.
    expect(para.scopes()).toEqual([period.scopeTag]);
  });

  it("a para keyring actively throws NoKeyForScopeError decrypting a master-scope record", () => {
    // Mirror of the ferpa-guard M13 active-attempt proof: the para holds only a period
    // DEK, so opening a teacher master-scope blob throws before any plaintext is yielded.
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    const para = new ParaKeyring([generatePeriodKey(newScopeTag())]);
    expect(para.hasScope(masterScope)).toBe(false); // fixture: the para lacks the master scope
    const env = envelope(masterScope, "goal");
    const blob = teacher.encryptRecord(env, utf8("goal definition — synthetic"));

    let leaked: Uint8Array | undefined;
    expect(() => {
      leaked = para.decryptRecord(env, blob);
    }).toThrow(NoKeyForScopeError);
    expect(leaked).toBeUndefined();
  });

  it("rotatePeriodKey mints a distinct scope + key", () => {
    const oldKey = generatePeriodKey(newScopeTag());
    const rotated = rotatePeriodKey(newScopeTag());
    expect(rotated.scopeTag).not.toEqual(oldKey.scopeTag);
    expect([...rotated.dek]).not.toEqual([...oldKey.dek]);
  });
});
