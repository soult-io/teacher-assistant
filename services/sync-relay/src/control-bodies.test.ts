// TEACH-59 (EU-3): the strict owner-route body parsers (spec §5.3).

import { describe, expect, it } from "vitest";
import {
  MAX_BLOB_LENGTH,
  MAX_GRANT_SCOPES,
  parseGrantBody,
  parseListBody,
  parseRecoveryWrapBody,
  parseRetireBody,
  parseRevokeBody,
} from "./control-bodies.js";

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const DEVICE = "q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80";

describe("control bodies", () => {
  it("list: exactly {}", () => {
    expect(parseListBody(enc({}))).toBe(true);
    for (const bad of [{ a: 1 }, [], "null", "1", "nope", ""]) {
      expect(parseListBody(enc(bad)), JSON.stringify(bad)).toBe(false);
    }
  });

  it("grant: {device, scopes 1..16 of exactly {tag, kind}}", () => {
    const scope = { tag: "T", kind: "period" };
    expect(parseGrantBody(enc({ device: DEVICE, scopes: [scope] }))).toEqual({
      device: DEVICE,
      scopes: [scope],
    });
    const max = Array.from({ length: MAX_GRANT_SCOPES }, (_, i) => ({
      tag: `t${i}`,
      kind: "master",
    }));
    expect(parseGrantBody(enc({ device: DEVICE, scopes: max }))?.scopes).toHaveLength(
      MAX_GRANT_SCOPES,
    );
    for (const bad of [
      { device: DEVICE, scopes: [...max, scope] },
      { device: DEVICE, scopes: [] },
      { device: DEVICE, scopes: [{ ...scope, label: "x" }] },
      { device: DEVICE, scopes: [{ tag: "T" }] },
      { device: DEVICE, scopes: [null] },
      { device: DEVICE, scopes: [[]] },
      { device: DEVICE, scopes: [scope], extra: true },
      { device: `${DEVICE}!`, scopes: [scope] },
      { device: "A".repeat(257), scopes: [scope] },
    ]) {
      expect(parseGrantBody(enc(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });

  it("revoke and retire-scope: a single bounded identifier", () => {
    expect(parseRevokeBody(enc({ device: DEVICE }))).toBe(DEVICE);
    expect(parseRevokeBody(enc({ device: DEVICE, why: "lost" }))).toBeNull();
    expect(parseRetireBody(enc({ tag: "x".repeat(256) }))).toBe("x".repeat(256));
    expect(parseRetireBody(enc({ tag: "x".repeat(257) }))).toBeNull();
    expect(parseRetireBody(enc({ tag: "a\u0000" }))).toBeNull();
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
