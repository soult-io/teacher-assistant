// EU-5 (TEACH-57) — crypto for device enrollment (device-enrollment-spec rev 2.1 §6,
// §11 EU-5). Functional + HARD-condition tests for: the two-key enrollment request
// and its verification code, the E1 pairing helpers, the grant bundles, the recovery
// bundle, the master-wrapped period keys and Keyring.destroy(). The gating FERPA
// copies of the HARD conditions live in tools/ferpa-guard/test/ferpa-teach57.test.ts.

import { newOpaqueId, newScopeTag, type ScopeTag } from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  completeDeviceEnrollment,
  completeParaEnrollment,
  createEnrollmentRequest,
  decodeEnrollmentRequest,
  decodePairingSecret,
  deviceVerificationCode,
  encodeEnrollmentRequest,
  encodePairingSecret,
  EnrollmentConfirmationError,
  type EnrollmentRequest,
  fromBase64,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  generateRecoveryCode,
  generateSigningKeypair,
  KeyringDestroyedError,
  newPairingSecret,
  NoKeyForScopeError,
  normalizeRecoveryCode,
  openEnrollmentRequest,
  openPairing,
  pairingKey,
  pairingSid,
  PairingError,
  ParaKeyring,
  ScopeConflictError,
  sealEnrollmentRequest,
  sealPairing,
  sodiumReady,
  TeacherKeyring,
  toBase64,
  unwrapRecoveryBundle,
  utf8,
  wrapRecoveryBundle,
} from "./index.js";

beforeAll(async () => {
  await sodiumReady();
});

/** A new device's two public keys (the box key wraps grants; the signing key is the relay identity). */
function enrollingDevice() {
  const box = generateDeviceKeypair();
  const signing = generateSigningKeypair();
  return {
    box,
    signing,
    publicKeys: { boxPublicKey: box.publicKey, signingPublicKey: signing.publicKey },
  };
}

function updateAad(): Uint8Array {
  return utf8(newOpaqueId());
}

describe("enrollment request carries and binds both device keys", () => {
  it("carries the box key, the signing key and a 16-byte nonce", () => {
    const device = enrollingDevice();
    const { request } = createEnrollmentRequest(device.publicKeys);
    expect(request.devicePublicKeyB64).toBe(toBase64(device.box.publicKey));
    expect(request.signingPublicKeyB64).toBe(toBase64(device.signing.publicKey));
    expect(fromBase64(request.nonceB64)).toHaveLength(16);
  });

  it("the verification code is the one computed over boxPk, signPk and the nonce", () => {
    const device = enrollingDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.publicKeys);
    expect(verificationCode).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(
      deviceVerificationCode(
        device.box.publicKey,
        device.signing.publicKey,
        fromBase64(request.nonceB64),
      ),
    ).toBe(verificationCode);
  });

  it("the code changes when the box key, the signing key or the nonce changes", () => {
    const device = enrollingDevice();
    const other = enrollingDevice();
    const nonce = new Uint8Array(16).fill(7);
    const otherNonce = new Uint8Array(16).fill(8);
    const base = deviceVerificationCode(device.box.publicKey, device.signing.publicKey, nonce);
    expect(deviceVerificationCode(other.box.publicKey, device.signing.publicKey, nonce)).not.toBe(
      base,
    );
    expect(deviceVerificationCode(device.box.publicKey, other.signing.publicKey, nonce)).not.toBe(
      base,
    );
    expect(
      deviceVerificationCode(device.box.publicKey, device.signing.publicKey, otherNonce),
    ).not.toBe(base);
    // Swapping the two keys' positions changes the code too (fixed-order concatenation).
    expect(deviceVerificationCode(device.signing.publicKey, device.box.publicKey, nonce)).not.toBe(
      base,
    );
  });

  it("refuses wrong-length keys or nonce (no ambiguous concatenation)", () => {
    const device = enrollingDevice();
    const nonce = new Uint8Array(16);
    expect(() =>
      deviceVerificationCode(device.box.publicKey.subarray(1), device.signing.publicKey, nonce),
    ).toThrow();
    expect(() =>
      deviceVerificationCode(device.box.publicKey, device.signing.privateKey, nonce),
    ).toThrow();
    expect(() =>
      deviceVerificationCode(device.box.publicKey, device.signing.publicKey, new Uint8Array(15)),
    ).toThrow();
  });

  it("decodeEnrollmentRequest round-trips and rejects a request without a valid signing key", () => {
    const device = enrollingDevice();
    const { request } = createEnrollmentRequest(device.publicKeys);
    expect(decodeEnrollmentRequest(encodeEnrollmentRequest(request))).toEqual(request);

    const encodeRaw = (value: unknown): string => toBase64(utf8(JSON.stringify(value)));
    const { signingPublicKeyB64: _omit, ...withoutSigning } = request;
    expect(() => decodeEnrollmentRequest(encodeRaw(withoutSigning))).toThrow();
    expect(() =>
      decodeEnrollmentRequest(
        encodeRaw({ ...request, signingPublicKeyB64: toBase64(new Uint8Array(31)) }),
      ),
    ).toThrow();
    expect(() =>
      decodeEnrollmentRequest(encodeRaw({ ...request, nonceB64: toBase64(new Uint8Array(8)) })),
    ).toThrow();
  });
});

describe("assertConfirmed checks the typed code against the decrypted request", () => {
  it("rejects a request whose signing key was substituted after the code was shown", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const device = enrollingDevice();
    const attacker = enrollingDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.publicKeys);
    const substituted: EnrollmentRequest = {
      ...request,
      signingPublicKeyB64: toBase64(attacker.signing.publicKey),
    };
    expect(() =>
      approveDeviceEnrollment(teacher, substituted, verificationCode, newOpaqueId()),
    ).toThrow(EnrollmentConfirmationError);
  });

  it("rejects a request whose box key was substituted after the code was shown", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const device = enrollingDevice();
    const attacker = enrollingDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.publicKeys);
    const substituted: EnrollmentRequest = {
      ...request,
      devicePublicKeyB64: toBase64(attacker.box.publicKey),
    };
    expect(() =>
      approveDeviceEnrollment(teacher, substituted, verificationCode, newOpaqueId()),
    ).toThrow(EnrollmentConfirmationError);
  });

  it("rejects a wrong or empty typed code", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const { request } = createEnrollmentRequest(enrollingDevice().publicKeys);
    expect(() =>
      approveDeviceEnrollment(teacher, request, "0000-0000-0000-0000", newOpaqueId()),
    ).toThrow(EnrollmentConfirmationError);
    expect(() => approveDeviceEnrollment(teacher, request, "", newOpaqueId())).toThrow(
      EnrollmentConfirmationError,
    );
  });

  it("accepts the typed code regardless of case, spaces and dashes", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const { request, verificationCode } = createEnrollmentRequest(enrollingDevice().publicKeys);
    const typed = ` ${verificationCode.replace(/-/g, " ").toUpperCase()} `;
    expect(() => approveDeviceEnrollment(teacher, request, typed, newOpaqueId())).not.toThrow();
  });
});

describe("pairing secret, sid and key (E1)", () => {
  it("newPairingSecret is 32 random bytes", () => {
    const a = newPairingSecret();
    const b = newPairingSecret();
    expect(a).toHaveLength(32);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it("sid is a deterministic 128-bit hex value, distinct from the key", () => {
    const secret = newPairingSecret();
    const sid = pairingSid(secret);
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect(pairingSid(secret)).toBe(sid);
    expect(pairingSid(newPairingSecret())).not.toBe(sid);
    const key = pairingKey(secret);
    expect(key).toHaveLength(32);
    expect(toBase64(pairingKey(secret))).toBe(toBase64(key));
    // Domain separation: the sid is not a prefix of the key.
    const keyHex = Array.from(key, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(keyHex.startsWith(sid)).toBe(false);
  });

  it("the typed fallback is 52 Crockford characters and round-trips through human typing", () => {
    const secret = newPairingSecret();
    const text = encodePairingSecret(secret);
    expect(text.replace(/-/g, "")).toMatch(/^[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(toBase64(decodePairingSecret(text))).toBe(toBase64(secret));
    const typed = text.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(toBase64(decodePairingSecret(typed))).toBe(toBase64(secret));
  });

  it("rejects a typed secret of the wrong length or with an invalid character", () => {
    const text = encodePairingSecret(newPairingSecret()).replace(/-/g, "");
    expect(() => decodePairingSecret(text.slice(1))).toThrow(PairingError);
    expect(() => decodePairingSecret(`${text}0`)).toThrow(PairingError);
    expect(() => decodePairingSecret(`U${text.slice(1)}`)).toThrow(PairingError);
  });

  it("rejects a 52-character string whose unused trailing bits are not zero", () => {
    const text = encodePairingSecret(newPairingSecret()).replace(/-/g, "");
    // 256 bits use 51.2 characters; the last character carries 1 data bit + 4 zero pad bits.
    expect(() => decodePairingSecret(`${text.slice(0, 51)}Z`)).toThrow(PairingError);
  });
});

describe("pairing blobs are AEAD under K with the sid bound", () => {
  it("round-trips", () => {
    const secret = newPairingSecret();
    const key = pairingKey(secret);
    const sid = pairingSid(secret);
    const blob = sealPairing(key, sid, "grant", utf8("payload"));
    expect(new TextDecoder().decode(openPairing(key, sid, "grant", blob))).toBe("payload");
  });

  it("a blob sealed under another pairing's key fails (substitution)", () => {
    const secret = newPairingSecret();
    const sid = pairingSid(secret);
    const substitute = sealPairing(pairingKey(newPairingSecret()), sid, "request", utf8("x"));
    expect(() => openPairing(pairingKey(secret), sid, "request", substitute)).toThrow(PairingError);
  });

  it("a blob moved to another sid fails, and a tampered byte fails", () => {
    const secret = newPairingSecret();
    const key = pairingKey(secret);
    const sid = pairingSid(secret);
    const blob = sealPairing(key, sid, "request", utf8("x"));
    expect(() => openPairing(key, pairingSid(newPairingSecret()), "request", blob)).toThrow(
      PairingError,
    );
    const tampered = blob.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openPairing(key, sid, "request", tampered)).toThrow(PairingError);
  });

  it("a request blob cannot be replayed as a grant blob (direction is bound)", () => {
    const secret = newPairingSecret();
    const key = pairingKey(secret);
    const sid = pairingSid(secret);
    const blob = sealPairing(key, sid, "request", utf8("x"));
    expect(() => openPairing(key, sid, "grant", blob)).toThrow(PairingError);
  });

  it("openEnrollmentRequest validates the decrypted request", () => {
    const secret = newPairingSecret();
    const key = pairingKey(secret);
    const sid = pairingSid(secret);
    const junk = sealPairing(
      key,
      sid,
      "request",
      utf8(JSON.stringify({ devicePublicKeyB64: "x" })),
    );
    expect(() => openEnrollmentRequest(key, sid, junk)).toThrow(PairingError);
  });
});

describe("full E1 handshake (teacher device)", () => {
  it("B's request reaches A sealed; A approves with the typed code; B recovers MK + ids", () => {
    const masterScope = newScopeTag();
    const masterDocId = newOpaqueId();
    const deviceA = new TeacherKeyring(masterScope, generateMasterKey());

    // A shows S (QR or typed fallback).
    const secret = newPairingSecret();
    const typedOnB = encodePairingSecret(secret);

    // B: derive sid + K, build the request, show the code, seal the request.
    const sB = decodePairingSecret(typedOnB);
    const sidB = pairingSid(sB);
    const kB = pairingKey(sB);
    const deviceB = enrollingDevice();
    const { request, verificationCode } = createEnrollmentRequest(deviceB.publicKeys);
    const requestBlob = sealEnrollmentRequest(kB, sidB, request);

    // A: open the request with its own K, approve with the code typed from B's screen.
    const sidA = pairingSid(secret);
    const kA = pairingKey(secret);
    const opened = openEnrollmentRequest(kA, sidA, requestBlob);
    expect(opened.signingPublicKeyB64).toBe(toBase64(deviceB.signing.publicKey));
    const grant = approveDeviceEnrollment(deviceA, opened, verificationCode, masterDocId);
    const grantBlob = sealPairing(kA, sidA, "grant", utf8(JSON.stringify(grant)));

    // B: open the grant, unwrap MK with its box key.
    const received = JSON.parse(
      new TextDecoder().decode(openPairing(kB, sidB, "grant", grantBlob)),
    ) as typeof grant;
    expect(received.masterDocId).toBe(masterDocId);
    expect(received.masterScopeTag).toBe(masterScope);
    const { mk, masterScopeTag } = completeDeviceEnrollment(deviceB.box, received);
    const deviceBKeyring = new TeacherKeyring(masterScopeTag, mk);
    const aad = updateAad();
    const blob = deviceA.sealUpdate(masterScope, aad, utf8("synthetic"));
    expect(new TextDecoder().decode(deviceBKeyring.openUpdate(masterScope, aad, blob))).toBe(
      "synthetic",
    );
  });
});

describe("para grant — never MK", () => {
  it("carries the period DEK, its tag and the para doc id", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    const paraDocId = newOpaqueId();
    const device = enrollingDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.publicKeys);
    const grant = approveParaEnrollment(
      teacher,
      period.scopeTag,
      request,
      verificationCode,
      paraDocId,
    );
    expect(grant.paraDocId).toBe(paraDocId);
    expect(grant.scopeTag).toBe(period.scopeTag);
    expect(Object.keys(grant).sort()).toEqual(["paraDocId", "scopeTag", "wrappedDekB64"]);
    const para = new ParaKeyring([completeParaEnrollment(device.box, grant)]);
    const aad = updateAad();
    const blob = teacher.sealUpdate(period.scopeTag, aad, utf8("3 of 5"));
    expect(new TextDecoder().decode(para.openUpdate(period.scopeTag, aad, blob))).toBe("3 of 5");
  });

  it("a para grant for the master scope tag throws NoKeyForScopeError", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    const { request, verificationCode } = createEnrollmentRequest(enrollingDevice().publicKeys);
    expect(() =>
      approveParaEnrollment(teacher, masterScope, request, verificationCode, newOpaqueId()),
    ).toThrow(NoKeyForScopeError);
  });

  it("a period key can never be added under the master tag (MK cannot be replaced)", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    expect(() => teacher.addPeriodKey(generatePeriodKey(masterScope))).toThrow(ScopeConflictError);
  });
});

describe("recovery bundle (Argon2id, new AAD label)", () => {
  it("round-trips MK, the master scope tag and the master doc id", () => {
    const mk = generateMasterKey();
    const masterScopeTag = newScopeTag();
    const masterDocId = newOpaqueId();
    const code = generateRecoveryCode();
    const wrap = wrapRecoveryBundle({ mk, masterScopeTag, masterDocId }, code);
    expect(fromBase64(wrap.saltB64)).toHaveLength(16);
    const restored = unwrapRecoveryBundle(code, wrap);
    expect([...restored.mk]).toEqual([...mk]);
    expect(restored.masterScopeTag).toBe(masterScopeTag);
    expect(restored.masterDocId).toBe(masterDocId);
  });

  it("accepts the code as a human re-types it", () => {
    const code = generateRecoveryCode();
    const mk = generateMasterKey();
    const wrap = wrapRecoveryBundle(
      { mk, masterScopeTag: newScopeTag(), masterDocId: newOpaqueId() },
      code,
    );
    const typed = code.toLowerCase().replace(/-/g, " ");
    expect([...unwrapRecoveryBundle(typed, wrap).mk]).toEqual([...mk]);
  });

  it("refuses a wrong code and a tampered blob", () => {
    const code = generateRecoveryCode();
    const wrap = wrapRecoveryBundle(
      { mk: generateMasterKey(), masterScopeTag: newScopeTag(), masterDocId: newOpaqueId() },
      code,
    );
    expect(() => unwrapRecoveryBundle(generateRecoveryCode(), wrap)).toThrow();
    const blob = fromBase64(wrap.blobB64);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    expect(() => unwrapRecoveryBundle(code, { ...wrap, blobB64: toBase64(blob) })).toThrow();
  });

  it("the recovery code carries at least 160 bits", () => {
    for (let i = 0; i < 20; i++) {
      // 32 Crockford characters × 5 bits = 160 bits.
      expect(normalizeRecoveryCode(generateRecoveryCode()).length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe("period keys wrapped under MK (a second teacher device rebuilds its keyring)", () => {
  it("round-trips a period DEK into another teacher keyring holding the same MK", () => {
    const masterScope = newScopeTag();
    const mk = generateMasterKey();
    const deviceA = new TeacherKeyring(masterScope, mk);
    const period = generatePeriodKey(newScopeTag());
    deviceA.addPeriodKey(period);
    const wrapped = deviceA.wrapScopeKeyUnderMaster(period.scopeTag);

    const deviceB = new TeacherKeyring(masterScope, new Uint8Array(mk) as typeof mk);
    expect(deviceB.hasScope(period.scopeTag)).toBe(false);
    deviceB.addWrappedPeriodKey(period.scopeTag, wrapped);
    expect(deviceB.hasScope(period.scopeTag)).toBe(true);

    const aad = updateAad();
    const blob = deviceA.sealUpdate(period.scopeTag, aad, utf8("roster"));
    expect(new TextDecoder().decode(deviceB.openUpdate(period.scopeTag, aad, blob))).toBe("roster");
  });

  it("is idempotent for the same key and refuses a conflicting key", () => {
    const masterScope = newScopeTag();
    const mk = generateMasterKey();
    const teacher = new TeacherKeyring(masterScope, mk);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    const wrapped = teacher.wrapScopeKeyUnderMaster(period.scopeTag);
    expect(() => teacher.addWrappedPeriodKey(period.scopeTag, wrapped)).not.toThrow();

    const other = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(other);
    const otherWrapped = teacher.wrapScopeKeyUnderMaster(other.scopeTag);
    // Re-labelled blob: the tag is bound as AAD, so it does not open under another tag.
    expect(() => teacher.addWrappedPeriodKey(period.scopeTag, otherWrapped)).toThrow();

    // A different DEK under the SAME tag (same MK) is a conflict, never a silent replace.
    const twin = new TeacherKeyring(masterScope, new Uint8Array(mk) as typeof mk);
    twin.addPeriodKey(generatePeriodKey(period.scopeTag));
    const conflicting = twin.wrapScopeKeyUnderMaster(period.scopeTag);
    expect(() => teacher.addWrappedPeriodKey(period.scopeTag, conflicting)).toThrow(
      ScopeConflictError,
    );
  });

  it("refuses the master tag in both directions", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    expect(() => teacher.wrapScopeKeyUnderMaster(masterScope)).toThrow(NoKeyForScopeError);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    const wrapped = teacher.wrapScopeKeyUnderMaster(period.scopeTag);
    expect(() => teacher.addWrappedPeriodKey(masterScope, wrapped)).toThrow(ScopeConflictError);
  });

  it("an unknown period tag throws NoKeyForScopeError", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    expect(() => teacher.wrapScopeKeyUnderMaster(newScopeTag())).toThrow(NoKeyForScopeError);
  });
});

describe("Keyring.destroy()", () => {
  function teacherWithPeriod() {
    const masterScope = newScopeTag();
    const mk = generateMasterKey();
    const teacher = new TeacherKeyring(masterScope, mk);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    return { masterScope, mk, teacher, period };
  }

  it("zeroizes every key buffer the keyring holds", () => {
    const { mk, teacher, period } = teacherWithPeriod();
    expect(mk.some((b) => b !== 0)).toBe(true);
    teacher.destroy();
    expect(mk.every((b) => b === 0)).toBe(true);
    expect(period.dek.every((b) => b === 0)).toBe(true);
  });

  it("zeroizes a period key added from its MK-wrapped form", () => {
    const { masterScope, mk, teacher, period } = teacherWithPeriod();
    const wrapped = teacher.wrapScopeKeyUnderMaster(period.scopeTag);
    const other = new TeacherKeyring(masterScope, new Uint8Array(mk) as typeof mk);
    other.addWrappedPeriodKey(period.scopeTag, wrapped);
    const aad = updateAad();
    const before = other.sealUpdate(period.scopeTag, aad, utf8("x"));
    other.destroy();
    // The destroyed keyring can no longer open what it sealed; the original still can.
    expect(() => other.openUpdate(period.scopeTag, aad, before)).toThrow(KeyringDestroyedError);
    expect(new TextDecoder().decode(teacher.openUpdate(period.scopeTag, aad, before))).toBe("x");
  });

  it("every later use throws KeyringDestroyedError", () => {
    const { masterScope, teacher, period } = teacherWithPeriod();
    const device = enrollingDevice();
    const aad = updateAad();
    const sealed = teacher.sealUpdate(period.scopeTag, aad, utf8("x"));
    const wrapped = teacher.wrapScopeKeyUnderMaster(period.scopeTag);
    teacher.destroy();

    const uses: ReadonlyArray<() => unknown> = [
      () => teacher.scopes(),
      () => teacher.hasScope(masterScope),
      () => teacher.sealUpdate(period.scopeTag, aad, utf8("x")),
      () => teacher.openUpdate(period.scopeTag, aad, sealed),
      () => teacher.sealScopeKeyToDevice(period.scopeTag, device.box.publicKey),
      () => teacher.sealMasterKeyToDevice(device.box.publicKey),
      () => teacher.wrapScopeKeyUnderMaster(period.scopeTag),
      () => teacher.addWrappedPeriodKey(newScopeTag() as ScopeTag, wrapped),
      () => teacher.addPeriodKey(generatePeriodKey(newScopeTag())),
    ];
    for (const use of uses) {
      expect(use).toThrow(KeyringDestroyedError);
    }
  });

  it("enrollment approval on a destroyed keyring throws", () => {
    const { teacher } = teacherWithPeriod();
    const { request, verificationCode } = createEnrollmentRequest(enrollingDevice().publicKeys);
    teacher.destroy();
    expect(() =>
      approveDeviceEnrollment(teacher, request, verificationCode, newOpaqueId()),
    ).toThrow(KeyringDestroyedError);
  });

  it("a para keyring is destroyed the same way, and destroy() is idempotent", () => {
    const period = generatePeriodKey(newScopeTag());
    const para = new ParaKeyring([period]);
    para.destroy();
    para.destroy();
    expect(period.dek.every((b) => b === 0)).toBe(true);
    expect(() => para.hasScope(period.scopeTag)).toThrow(KeyringDestroyedError);
  });

  it("a destroyed keyring still serialises without keys (logging never throws)", () => {
    const { teacher } = teacherWithPeriod();
    teacher.destroy();
    expect(JSON.stringify(teacher)).toBe('{"scopes":[],"keys":"[withheld]"}');
  });
});
