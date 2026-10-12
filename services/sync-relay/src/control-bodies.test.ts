// TEACH-59 (EU-3) / TEACH-60 (EU-4): the strict control-route body parsers (spec §5.3).

import { describe, expect, it } from "vitest";
import {
  MAX_BLOB_LENGTH,
  MAX_GRANT_SCOPES,
  parseGrantBody,
  parseListBody,
  parsePairingGrantBody,
  parsePairingRequestBody,
  parsePairingSidBody,
  parseRecoveryWrapBody,
  parseRedeemBody,
  parseRetireBody,
  parseRevokeBody,
} from "./control-bodies.js";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const DEVICE = "q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80";
const TAG = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b";
const SID = "0123456789abcdef0123456789abcdef";

describe("control bodies", () => {
  it("redeem: exactly {code: string}", () => {
    expect(parseRedeemBody(enc({ code: "ABCD-EFGH" }))).toBe("ABCD-EFGH");
    for (const bad of [
      { code: "x", extra: 1 },
      {},
      { code: 42 },
      ["x"],
      "null",
      "not json",
      '{"__proto__":"x"}',
    ]) {
      expect(parseRedeemBody(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("list: exactly {}", () => {
    expect(parseListBody(enc({}))).toEqual({});
    for (const bad of [{ a: 1 }, [], "null", "1", "nope", ""]) {
      expect(parseListBody(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("grant: {device, scopes 1..16 of exactly {tag, kind}}", () => {
    const scope = { tag: TAG, kind: "period" };
    expect(parseGrantBody(enc({ device: DEVICE, scopes: [scope] }))).toEqual({
      device: DEVICE,
      scopes: [scope],
    });
    const max = Array.from({ length: MAX_GRANT_SCOPES }, () => ({ tag: TAG, kind: "master" }));
    expect(parseGrantBody(enc({ device: DEVICE, scopes: max }))?.scopes).toHaveLength(
      MAX_GRANT_SCOPES,
    );
    for (const bad of [
      { device: DEVICE, scopes: [...max, scope] },
      { device: DEVICE, scopes: [] },
      { device: DEVICE, scopes: [{ ...scope, label: "x" }] },
      { device: DEVICE, scopes: [{ tag: TAG }] },
      { device: DEVICE, scopes: [{ tag: "control", kind: "period" }] },
      { device: DEVICE, scopes: [{ tag: "3rd period", kind: "period" }] },
      { device: DEVICE, scopes: [null] },
      { device: DEVICE, scopes: [[]] },
      { device: DEVICE, scopes: [scope], extra: true },
      { device: `${DEVICE}!`, scopes: [scope] },
      { device: "A".repeat(257), scopes: [scope] },
    ]) {
      expect(parseGrantBody(enc(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });

  it("revoke: a bounded device key; retire-scope: a UUID tag", () => {
    expect(parseRevokeBody(enc({ device: DEVICE }))).toBe(DEVICE);
    expect(parseRevokeBody(enc({ device: DEVICE, why: "lost" }))).toBeNull();
    expect(parseRetireBody(enc({ tag: TAG }))).toBe(TAG);
    for (const tag of [
      TAG.toUpperCase(),
      "control",
      "3rd period",
      `${TAG}\u0000`,
      `${TAG}x`,
      "",
      1,
    ]) {
      expect(parseRetireBody(enc({ tag })), String(tag)).toBeNull();
    }
  });

  it("recovery-wrap: an opaque base64 blob; over 4 KiB is too_large", () => {
    expect(parseRecoveryWrapBody(enc({ blob: "c2FsdA.YmxvYg" }))).toEqual({
      blob: "c2FsdA.YmxvYg",
    });
    expect(parseRecoveryWrapBody(enc({ blob: "A".repeat(MAX_BLOB_LENGTH + 1) }))).toBe("too_large");
    for (const bad of [{ blob: "" }, { blob: "a b" }, { blob: "{}" }, { blob: "A", label: "x" }]) {
      expect(parseRecoveryWrapBody(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("pairing bodies (EU-4)", () => {
  const badSids = [SID.toUpperCase(), `${SID}0`, SID.slice(1), `${SID.slice(1)}g`, "", 1, null];

  it("sid: exactly {sid} of 32 lower-case hex characters", () => {
    expect(parsePairingSidBody(enc({ sid: SID }))).toBe(SID);
    for (const sid of badSids) {
      expect(parsePairingSidBody(enc({ sid })), String(sid)).toBeNull();
    }
    for (const bad of [{ sid: SID, label: "x" }, {}, [SID], "null", "nope"]) {
      expect(parsePairingSidBody(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("request-put: {sid, blob}; a blob over 4 KiB is too_large", () => {
    expect(parsePairingRequestBody(enc({ sid: SID, blob: "c2VhbGVk" }))).toEqual({
      sid: SID,
      blob: "c2VhbGVk",
    });
    expect(parsePairingRequestBody(enc({ sid: SID, blob: "A".repeat(MAX_BLOB_LENGTH) }))).toEqual({
      sid: SID,
      blob: "A".repeat(MAX_BLOB_LENGTH),
    });
    expect(parsePairingRequestBody(enc({ sid: SID, blob: "A".repeat(MAX_BLOB_LENGTH + 1) }))).toBe(
      "too_large",
    );
    for (const bad of [
      { sid: SID, blob: '{"signPk":"x"}' },
      { sid: SID, blob: "" },
      { sid: SID, blob: "c2VhbGVk", label: "B" },
      { sid: SID },
      { blob: "c2VhbGVk" },
      ...badSids.map((sid) => ({ sid, blob: "c2VhbGVk" })),
    ]) {
      expect(parsePairingRequestBody(enc(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it("grant-put: teacher → owner, para → member; strict scopes and blob", () => {
    const scope = { tag: TAG, kind: "period" };
    const good = { sid: SID, device: DEVICE, role: "teacher", scopes: [scope], blob: "Z3JhbnQ" };
    expect(parsePairingGrantBody(enc(good))).toEqual({ ...good, role: "owner" });
    expect(parsePairingGrantBody(enc({ ...good, role: "para" }))).toEqual({
      ...good,
      role: "member",
    });
    expect(parsePairingGrantBody(enc({ ...good, blob: "A".repeat(MAX_BLOB_LENGTH + 1) }))).toBe(
      "too_large",
    );
    for (const bad of [
      { ...good, label: "Para phone" },
      { ...good, role: "owner" },
      { ...good, role: "member" },
      { ...good, role: "Teacher" },
      { ...good, scopes: [] },
      { ...good, scopes: [{ tag: TAG.toUpperCase(), kind: "period" }] },
      { ...good, scopes: [{ tag: "3rd period", kind: "period" }] },
      { ...good, scopes: [{ ...scope, label: "x" }] },
      { ...good, scopes: Array.from({ length: MAX_GRANT_SCOPES + 1 }, () => scope) },
      { ...good, device: `${DEVICE}!` },
      { ...good, sid: SID.toUpperCase() },
      { ...good, blob: '{"wrappedMasterKeyB64":"x"}' },
      // A malformed body with a big blob is still a 400, not a 413.
      { ...good, role: "x", blob: "A".repeat(MAX_BLOB_LENGTH + 1) },
      (({ blob: _b, ...rest }) => rest)(good),
    ]) {
      expect(parsePairingGrantBody(enc(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });
});
