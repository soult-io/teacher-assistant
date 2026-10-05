// FERPA-guard — TEACH-57 (EU-5) HARD conditions (device-enrollment-spec rev 2.1 §11):
//   1. A para grant can never yield MK (NoKeyForScopeError), and carries only the DEK.
//   2. The verification code covers both device keys and the nonce.
//   3. The enrollment request carries and binds the box key AND the signing key.
//   4. Pairing blobs are AEAD under K with the sid bound.
//   5. The recovery bundle is Argon2id-wrapped under a new AAD label; the code is ≥ 160 bits.
//   6. Keyring.destroy() zeroizes key buffers, and any later use throws.
//   7. The relay still does not depend on @teacher-assistant/crypto.
// Behavioural proofs against the real crypto layer, plus one static check.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  completeParaEnrollment,
  createEnrollmentRequest,
  deviceVerificationCode,
  EnrollmentConfirmationError,
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
  pairingKey,
  pairingSid,
  PairingError,
  ParaKeyring,
  sealEnrollmentRequest,
  sodiumReady,
  TeacherKeyring,
  toBase64,
  unwrapRecoveryBundle,
  utf8,
  wrapRecoveryBundle,
} from "@teacher-assistant/crypto";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** True if `needle`'s bytes appear as a contiguous run inside `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
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

function newDevice() {
  const box = generateDeviceKeypair();
  const signing = generateSigningKeypair();
  return {
    box,
    signing,
    keys: { boxPublicKey: box.publicKey, signingPublicKey: signing.publicKey },
  };
}

beforeAll(async () => {
  await sodiumReady();
});

describe("TEACH-57 HARD — a para grant can never yield MK", () => {
  it("a para grant requested for the master scope tag throws NoKeyForScopeError", () => {
    const masterScope = newScopeTag();
    const teacher = new TeacherKeyring(masterScope, generateMasterKey());
    const { request, verificationCode } = createEnrollmentRequest(newDevice().keys);
    let grant: unknown;
    expect(() => {
      grant = approveParaEnrollment(teacher, masterScope, request, verificationCode, newOpaqueId());
    }).toThrow(NoKeyForScopeError);
    expect(grant).toBeUndefined();
  });

  it("a para grant opens to the period DEK only — never MK bytes", () => {
    const mk = generateMasterKey();
    const mkCopy = new Uint8Array(mk);
    const teacher = new TeacherKeyring(newScopeTag(), mk);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    const device = newDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.keys);
    const grant = approveParaEnrollment(
      teacher,
      period.scopeTag,
      request,
      verificationCode,
      newOpaqueId(),
    );
    const opened = completeParaEnrollment(device.box, grant);
    expect(toBase64(opened.dek)).toBe(toBase64(period.dek));
    expect(toBase64(opened.dek)).not.toBe(toBase64(mkCopy));
    expect(containsBytes(utf8(JSON.stringify(grant)), mkCopy)).toBe(false);
    expect(new ParaKeyring([opened]).scopes()).toEqual([period.scopeTag]);
  });
});

describe("TEACH-57 HARD — the code covers boxPk, signPk and the nonce", () => {
  it("changing any one of the three changes the code", () => {
    const a = newDevice();
    const b = newDevice();
    const nonce = new Uint8Array(16).fill(1);
    const base = deviceVerificationCode(a.box.publicKey, a.signing.publicKey, nonce);
    expect(deviceVerificationCode(b.box.publicKey, a.signing.publicKey, nonce)).not.toBe(base);
    expect(deviceVerificationCode(a.box.publicKey, b.signing.publicKey, nonce)).not.toBe(base);
    expect(
      deviceVerificationCode(a.box.publicKey, a.signing.publicKey, new Uint8Array(16).fill(2)),
    ).not.toBe(base);
  });

  it("the request carries both keys, and substituting either one fails the typed code", () => {
    const teacher = new TeacherKeyring(newScopeTag(), generateMasterKey());
    const device = newDevice();
    const attacker = newDevice();
    const { request, verificationCode } = createEnrollmentRequest(device.keys);
    expect(fromBase64(request.devicePublicKeyB64)).toEqual(device.box.publicKey);
    expect(fromBase64(request.signingPublicKeyB64)).toEqual(device.signing.publicKey);
    for (const substituted of [
      { ...request, devicePublicKeyB64: toBase64(attacker.box.publicKey) },
      { ...request, signingPublicKeyB64: toBase64(attacker.signing.publicKey) },
    ]) {
      expect(() =>
        approveDeviceEnrollment(teacher, substituted, verificationCode, newOpaqueId()),
      ).toThrow(EnrollmentConfirmationError);
    }
  });
});

describe("TEACH-57 HARD — pairing blobs are AEAD under K with aad bound to the sid", () => {
  it("a blob from another pairing, or moved to another sid, fails", () => {
    const secret = newPairingSecret();
    const { request } = createEnrollmentRequest(newDevice().keys);
    const other = newPairingSecret();
    const forged = sealEnrollmentRequest(pairingKey(other), pairingSid(secret), request);
    expect(() => openEnrollmentRequest(pairingKey(secret), pairingSid(secret), forged)).toThrow(
      PairingError,
    );
    const genuine = sealEnrollmentRequest(pairingKey(secret), pairingSid(secret), request);
    expect(() => openEnrollmentRequest(pairingKey(secret), pairingSid(other), genuine)).toThrow(
      PairingError,
    );
    expect(openEnrollmentRequest(pairingKey(secret), pairingSid(secret), genuine)).toEqual(request);
  });

  it("the sid reveals neither the secret nor the key", () => {
    const secret = newPairingSecret();
    const sid = utf8(pairingSid(secret));
    expect(containsBytes(sid, utf8(toBase64(secret)))).toBe(false);
    expect(pairingSid(secret)).not.toContain(toBase64(pairingKey(secret)));
  });
});

describe("TEACH-57 HARD — recovery bundle", () => {
  it("round-trips, never contains MK in its stored halves, and refuses a wrong code", () => {
    const mk = generateMasterKey();
    const code = generateRecoveryCode();
    const wrap = wrapRecoveryBundle(
      { mk, masterScopeTag: newScopeTag(), masterDocId: newOpaqueId() },
      code,
    );
    expect(containsBytes(fromBase64(wrap.blobB64), mk)).toBe(false);
    expect(wrap.blobB64).not.toContain(toBase64(mk));
    expect([...unwrapRecoveryBundle(code, wrap).mk]).toEqual([...mk]);
    expect(() => unwrapRecoveryBundle(generateRecoveryCode(), wrap)).toThrow();
  });

  it("uses Argon2id (crypto_pwhash ALG_ARGON2ID13) and a new AAD label", () => {
    const sodium = readFileSync(join(repoRoot, "packages", "crypto", "src", "sodium.ts"), "utf8");
    expect(sodium).toContain("crypto_pwhash_ALG_ARGON2ID13");
    const recovery = readFileSync(
      join(repoRoot, "packages", "crypto", "src", "recovery.ts"),
      "utf8",
    );
    expect(recovery).toContain("deriveKeyFromSecret(");
    expect(recovery).toContain('"ta-recovery-bundle-v1"');
    expect(recovery).not.toContain('utf8("recovery-wrap")');
  });

  it("the recovery code carries at least 160 bits", () => {
    expect(normalizeRecoveryCode(generateRecoveryCode()).length * 5).toBeGreaterThanOrEqual(160);
  });
});

describe("TEACH-57 HARD — Keyring.destroy()", () => {
  it("zeroizes MK and period DEKs in place, and every later use throws", () => {
    const masterScope = newScopeTag();
    const mk = generateMasterKey();
    const teacher = new TeacherKeyring(masterScope, mk);
    const period = generatePeriodKey(newScopeTag());
    teacher.addPeriodKey(period);
    teacher.destroy();
    expect(mk.every((b) => b === 0)).toBe(true);
    expect(period.dek.every((b) => b === 0)).toBe(true);
    expect(() => teacher.sealUpdate(masterScope, utf8("doc"), utf8("x"))).toThrow(
      KeyringDestroyedError,
    );
    expect(() => teacher.sealMasterKeyToDevice(newDevice().box.publicKey)).toThrow(
      KeyringDestroyedError,
    );
    expect(() => teacher.scopes()).toThrow(KeyringDestroyedError);
  });
});

describe("TEACH-57 HARD — the relay still does not depend on the crypto package", () => {
  it("services/sync-relay/package.json lists no @teacher-assistant/crypto dependency", () => {
    const pkg = readFileSync(join(repoRoot, "services", "sync-relay", "package.json"), "utf8");
    expect(pkg).not.toContain("@teacher-assistant/crypto");
  });
});
