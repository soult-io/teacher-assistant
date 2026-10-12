// EU-4 (TEACH-60) — the typed grant seal/open helpers (device-enrollment-spec rev 2.2
// change log: "typed grant seal and open helpers with validation"). The grant crosses
// the relay only as an AEAD blob under the pairing key K, bound to the sid and the
// `grant` direction, and tagged with its type so a para device never accepts a
// teacher grant (or the reverse). Both directions validate every field.

import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  completeDeviceEnrollment,
  completeParaEnrollment,
  createEnrollmentRequest,
  type DeviceEnrollmentGrant,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  generateSigningKeypair,
  newPairingSecret,
  openParaGrant,
  openTeacherGrant,
  pairingKey,
  pairingSid,
  PairingError,
  type ParaEnrollmentGrant,
  sealEnrollmentRequest,
  sealPairing,
  sealParaGrant,
  sealTeacherGrant,
  sodiumReady,
  TeacherKeyring,
  toBase64,
  utf8,
} from "./index.js";

beforeAll(async () => {
  await sodiumReady();
});

function newDevice() {
  const box = generateDeviceKeypair();
  const signing = generateSigningKeypair();
  return { box, keys: { boxPublicKey: box.publicKey, signingPublicKey: signing.publicKey } };
}

function pairing() {
  const secret = newPairingSecret();
  return { sid: pairingSid(secret), key: pairingKey(secret) };
}

function fixture() {
  const mk = generateMasterKey();
  const teacher = new TeacherKeyring(newScopeTag(), mk);
  const period = generatePeriodKey(newScopeTag());
  teacher.addPeriodKey(period);
  const device = newDevice();
  const { request, verificationCode } = createEnrollmentRequest(device.keys);
  const teacherGrant = approveDeviceEnrollment(teacher, request, verificationCode, newOpaqueId());
  const paraGrant = approveParaEnrollment(
    teacher,
    period.scopeTag,
    request,
    verificationCode,
    newOpaqueId(),
  );
  return { mk, period, device, teacherGrant, paraGrant, ...pairing() };
}

/** A grant-direction blob whose plaintext is exactly `value`, bypassing the typed sealer. */
function forged(key: Uint8Array, sid: string, value: unknown): Uint8Array {
  return sealPairing(key, sid, "grant", utf8(JSON.stringify(value)));
}

describe("typed grant helpers — round trip", () => {
  it("teacher: seal → open gives the grant back, and B unwraps MK from it", () => {
    const { mk, device, teacherGrant, sid, key } = fixture();
    const opened = openTeacherGrant(key, sid, sealTeacherGrant(key, sid, teacherGrant));
    expect(opened).toEqual(teacherGrant);
    expect(toBase64(completeDeviceEnrollment(device.box, opened).mk)).toBe(toBase64(mk));
  });

  it("para: seal → open gives the grant back, and B unwraps the period DEK only", () => {
    const { period, device, paraGrant, sid, key } = fixture();
    const opened = openParaGrant(key, sid, sealParaGrant(key, sid, paraGrant));
    expect(opened).toEqual(paraGrant);
    const dek = completeParaEnrollment(device.box, opened);
    expect(dek.scopeTag).toBe(period.scopeTag);
    expect(toBase64(dek.dek)).toBe(toBase64(period.dek));
  });

  it("the sealed blob carries none of the grant's fields in the clear", () => {
    const { teacherGrant, paraGrant, sid, key } = fixture();
    const teacherBlob = new TextDecoder("latin1").decode(sealTeacherGrant(key, sid, teacherGrant));
    const paraBlob = new TextDecoder("latin1").decode(sealParaGrant(key, sid, paraGrant));
    for (const value of Object.values(teacherGrant)) {
      expect(teacherBlob).not.toContain(value);
    }
    for (const value of Object.values(paraGrant)) {
      expect(paraBlob).not.toContain(value);
    }
    for (const field of ["wrappedMasterKeyB64", "wrappedDekB64", "teacher", "para", "{"]) {
      expect(teacherBlob.includes(`"${field}`)).toBe(false);
      expect(paraBlob.includes(`"${field}`)).toBe(false);
    }
  });
});

describe("typed grant helpers — binding", () => {
  it("a teacher blob never opens as a para grant, nor the reverse", () => {
    const { teacherGrant, paraGrant, sid, key } = fixture();
    expect(() => openParaGrant(key, sid, sealTeacherGrant(key, sid, teacherGrant))).toThrow(
      PairingError,
    );
    expect(() => openTeacherGrant(key, sid, sealParaGrant(key, sid, paraGrant))).toThrow(
      PairingError,
    );
  });

  it("another pairing's key or sid, or the request direction, fails", () => {
    const { teacherGrant, sid, key, device } = fixture();
    const other = pairing();
    const blob = sealTeacherGrant(key, sid, teacherGrant);
    expect(() => openTeacherGrant(other.key, sid, blob)).toThrow(PairingError);
    expect(() => openTeacherGrant(key, other.sid, blob)).toThrow(PairingError);
    // The relay hands B the REQUEST blob back as if it were the grant.
    const { request } = createEnrollmentRequest(device.keys);
    expect(() => openTeacherGrant(key, sid, sealEnrollmentRequest(key, sid, request))).toThrow(
      PairingError,
    );
    // A tampered byte fails AEAD.
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    expect(() => openTeacherGrant(key, sid, tampered)).toThrow(PairingError);
  });
});

describe("typed grant helpers — validation", () => {
  const UPPER = "3F2B8C1E-5A4D-4E6F-9A7B-0C1D2E3F4A5B";

  function badTeacher(g: DeviceEnrollmentGrant): unknown[] {
    return [
      { ...g, label: "Laptop" },
      { wrappedMasterKeyB64: g.wrappedMasterKeyB64, masterScopeTag: g.masterScopeTag },
      { ...g, wrappedMasterKeyB64: toBase64(new Uint8Array(32)) },
      { ...g, wrappedMasterKeyB64: "not base64!" },
      { ...g, wrappedMasterKeyB64: 7 },
      { ...g, masterScopeTag: UPPER },
      { ...g, masterScopeTag: "3rd period" },
      { ...g, masterDocId: "J.S. IEP" },
      { ...g, masterDocId: "" },
    ];
  }

  function badPara(g: ParaEnrollmentGrant): unknown[] {
    return [
      { ...g, label: "Para phone" },
      { ...g, mk: g.wrappedDekB64 },
      { wrappedDekB64: g.wrappedDekB64, scopeTag: g.scopeTag },
      { ...g, wrappedDekB64: toBase64(new Uint8Array(81)) },
      { ...g, scopeTag: UPPER },
      { ...g, scopeTag: "control" },
      { ...g, paraDocId: `${g.paraDocId} ` },
    ];
  }

  it("seal refuses a malformed grant before anything is sealed", () => {
    const { teacherGrant, paraGrant, sid, key } = fixture();
    for (const bad of badTeacher(teacherGrant)) {
      expect(() => sealTeacherGrant(key, sid, bad as DeviceEnrollmentGrant)).toThrow(PairingError);
    }
    for (const bad of badPara(paraGrant)) {
      expect(() => sealParaGrant(key, sid, bad as ParaEnrollmentGrant)).toThrow(PairingError);
    }
  });

  it("open refuses a genuine-key blob whose plaintext is malformed", () => {
    const { teacherGrant, paraGrant, sid, key } = fixture();
    for (const bad of badTeacher(teacherGrant)) {
      const blob = forged(key, sid, { type: "teacher", ...(bad as object) });
      expect(() => openTeacherGrant(key, sid, blob), JSON.stringify(bad)).toThrow(PairingError);
    }
    for (const bad of badPara(paraGrant)) {
      const blob = forged(key, sid, { type: "para", ...(bad as object) });
      expect(() => openParaGrant(key, sid, blob), JSON.stringify(bad)).toThrow(PairingError);
    }
    // No type tag, the wrong one, non-JSON, and a bare array.
    expect(() => openTeacherGrant(key, sid, forged(key, sid, teacherGrant))).toThrow(PairingError);
    expect(() =>
      openTeacherGrant(key, sid, forged(key, sid, { ...teacherGrant, type: "para" })),
    ).toThrow(PairingError);
    expect(() => openTeacherGrant(key, sid, sealPairing(key, sid, "grant", utf8("{")))).toThrow(
      PairingError,
    );
    expect(() => openParaGrant(key, sid, forged(key, sid, [paraGrant]))).toThrow(PairingError);
  });

  it("errors name no secret, key or id", () => {
    const { teacherGrant, sid, key } = fixture();
    const bad = { ...teacherGrant, masterDocId: "SENTINEL_DOC" };
    try {
      openTeacherGrant(key, sid, forged(key, sid, { type: "teacher", ...bad }));
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      for (const value of [sid, toBase64(key), "SENTINEL_DOC", teacherGrant.wrappedMasterKeyB64]) {
        expect(message).not.toContain(value);
      }
    }
  });
});
