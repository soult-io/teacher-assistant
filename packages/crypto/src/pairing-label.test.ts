// EU-8 (TEACH-75) — the device name travels only inside the AEAD_K request blob
// (device-enrollment-spec rev 2.7 §4.2 step 2, §7 EU-8, §11 EU-8), and the approver can
// check a typed matching code without approving (§13 A-4: 3 tries per session).

import { beforeAll, describe, expect, it } from "vitest";
import {
  createEnrollmentRequest,
  generateDeviceKeypair,
  generateSigningKeypair,
  newPairingSecret,
  openLabelledEnrollmentRequest,
  openPairing,
  pairingKey,
  pairingSid,
  PairingError,
  sealLabelledEnrollmentRequest,
  sealPairing,
  sodiumReady,
  utf8,
  verificationCodeMatches,
} from "./index.js";

beforeAll(async () => {
  await sodiumReady();
});

function request() {
  return createEnrollmentRequest({
    boxPublicKey: generateDeviceKeypair().publicKey,
    signingPublicKey: generateSigningKeypair().publicKey,
  });
}

function mailbox() {
  const secret = newPairingSecret();
  return { key: pairingKey(secret), sid: pairingSid(secret) };
}

describe("labelled enrollment request (label inside AEAD_K)", () => {
  it("round-trips the request and the label", () => {
    const { key, sid } = mailbox();
    const { request: req } = request();
    const blob = sealLabelledEnrollmentRequest(key, sid, req, "Phone");
    expect(openLabelledEnrollmentRequest(key, sid, blob)).toEqual({
      request: req,
      label: "Phone",
    });
  });

  it("the label is not readable in the sealed blob", () => {
    const { key, sid } = mailbox();
    const blob = sealLabelledEnrollmentRequest(key, sid, request().request, "School computer");
    const asText = new TextDecoder("latin1").decode(blob);
    expect(asText).not.toContain("School computer");
    expect(asText).not.toContain("label");
  });

  it("a tampered blob (label bytes included) fails AEAD", () => {
    const { key, sid } = mailbox();
    const blob = sealLabelledEnrollmentRequest(key, sid, request().request, "Phone");
    for (const index of [0, Math.floor(blob.length / 2), blob.length - 1]) {
      const tampered = blob.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(() => openLabelledEnrollmentRequest(key, sid, tampered)).toThrow(PairingError);
    }
  });

  it("a blob sealed with another label under another key does not open", () => {
    const a = mailbox();
    const b = mailbox();
    const blob = sealLabelledEnrollmentRequest(b.key, a.sid, request().request, "Para phone");
    expect(() => openLabelledEnrollmentRequest(a.key, a.sid, blob)).toThrow(PairingError);
  });

  it("refuses a request with no label, a non-string label or an over-long one", () => {
    const { key, sid } = mailbox();
    const { request: req } = request();
    const seal = (extra: Record<string, unknown>) =>
      sealPairing(key, sid, "request", utf8(JSON.stringify({ ...req, ...extra })));
    expect(() => openLabelledEnrollmentRequest(key, sid, seal({}))).toThrow(PairingError);
    expect(() => openLabelledEnrollmentRequest(key, sid, seal({ label: 7 }))).toThrow(
      PairingError,
    );
    expect(() => openLabelledEnrollmentRequest(key, sid, seal({ label: "" }))).toThrow(
      PairingError,
    );
    expect(() =>
      openLabelledEnrollmentRequest(key, sid, seal({ label: "x".repeat(65) })),
    ).toThrow(PairingError);
    expect(() =>
      sealLabelledEnrollmentRequest(key, sid, req, "x".repeat(65)),
    ).toThrow(PairingError);
  });

  it("the blob is bound to the request direction", () => {
    const { key, sid } = mailbox();
    const blob = sealLabelledEnrollmentRequest(key, sid, request().request, "Phone");
    expect(() => openPairing(key, sid, "grant", blob)).toThrow(PairingError);
  });
});

describe("verificationCodeMatches", () => {
  it("accepts the code in any case, with or without dashes and spaces", () => {
    const { request: req, verificationCode } = request();
    expect(verificationCodeMatches(req, verificationCode)).toBe(true);
    expect(verificationCodeMatches(req, verificationCode.toUpperCase())).toBe(true);
    expect(verificationCodeMatches(req, verificationCode.replace(/-/g, " "))).toBe(true);
  });

  it("refuses another request's code, an empty code and a one-character change", () => {
    const one = request();
    const other = request();
    expect(verificationCodeMatches(one.request, other.verificationCode)).toBe(false);
    expect(verificationCodeMatches(one.request, "")).toBe(false);
    const code = one.verificationCode;
    const flipped = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
    expect(verificationCodeMatches(one.request, flipped)).toBe(false);
  });
});
