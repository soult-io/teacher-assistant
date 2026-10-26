// FERPA-guard — TEACH-75 (EU-8) HARD conditions (device-enrollment-spec rev 2.7 §4.2,
// §7 and §11 EU-8, rev 2.4 §13 EU-8 (A-4), rev 2.3 additions (A-4, A-5, A-6), DN-1a label):
//   1. The device name travels only inside the AEAD_K request blob: the request-put body is
//      exactly {sid, blob}; no control body carries a name.
//   2. A checks the name (fixed list, teacher role in release 1) right after opening the
//      request with K, before anything is granted; grant-put is never called for a bad name.
//   3. A-4: 3 matching-code tries, all against the one request fetched; the 3rd miss zeroizes
//      S and K and never reaches grant-put or a seal to boxPk; never hints at the code.
//   4. Approving needs a fresh unlock (the full ceremony), even when unlocked.
//   5. S, K, the sid, the request and the counter are memory-only; the new device's record
//      holds only stage and time; a lock abandons both sides.
//   6. A-5: in-app scanner with a bundled decoder; the QR is the raw code, never a link.
//   7. A-6: the Teacher/Para switch renders only in a QA build. Release 1: no para pairing.
//   8. C10: the A3 passphrase box is not focused on load. Typed grant helpers only.
// Static checks on the app source; the behaviour is proven in apps/pwa
// (device/pairing.test.ts end to end against the real relay, app/pairing/*.test.tsx,
// App.pairing.test.tsx).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEnrollmentRequest,
  generateDeviceKeypair,
  generateSigningKeypair,
  newPairingSecret,
  openLabelledEnrollmentRequest,
  pairingKey,
  pairingSid,
  PairingError,
  sealLabelledEnrollmentRequest,
  sodiumReady,
} from "@teacher-assistant/crypto";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pwaSrc = join(repoRoot, "apps", "pwa", "src");

function source(...parts: string[]): string {
  return readFileSync(join(pwaSrc, ...parts), "utf8");
}

/** Code only: drop // line comments, so a check never matches the explaining prose. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** The text of a method or function from its signature to the next blank-line-separated member. */
function member(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

/** From a signature to the end of its class member (the next line that starts "  }"). */
function method(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n  }\n", start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const pairing = () => code(source("device", "pairing.ts"));

beforeAll(async () => {
  await sodiumReady();
});

describe("TEACH-75 HARD — the device name only inside AEAD_K", () => {
  it("the sealed request blob never contains the name, and a tampered blob fails", () => {
    const secret = newPairingSecret();
    const key = pairingKey(secret);
    const sid = pairingSid(secret);
    const { request } = createEnrollmentRequest({
      boxPublicKey: generateDeviceKeypair().publicKey,
      signingPublicKey: generateSigningKeypair().publicKey,
    });
    const blob = sealLabelledEnrollmentRequest(key, sid, request, "School computer");
    expect(Buffer.from(blob).toString("latin1")).not.toContain("School computer");
    expect(Buffer.from(blob).toString("base64")).not.toContain("School");
    const tampered = blob.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => openLabelledEnrollmentRequest(key, sid, tampered)).toThrow(PairingError);
  });

  it("the request-put body is exactly {sid, blob}; no control body names a device", () => {
    const control = code(source("device", "control-client.ts"));
    const put = member(control, "async putPairingRequest(");
    expect(put).toContain("{ sid, blob }");
    expect(control).not.toMatch(/label|displayName/);
  });

  it("B seals its request only with the labelled helper; nobody uses the unlabelled one", () => {
    const text = pairing();
    expect(text).toContain("sealLabelledEnrollmentRequest(key, sid, request, label)");
    expect(text).not.toMatch(/\b(sealEnrollmentRequest|openEnrollmentRequest)\b/);
  });
});

describe("TEACH-75 HARD — A checks the name before anything is granted", () => {
  it("poll() opens with K, then checks list and role, before keeping the request", () => {
    const poll = method(pairing(), "async poll(): Promise<PollOutcome> {");
    const opened = poll.indexOf("openLabelledEnrollmentRequest(");
    const check = poll.indexOf("!isDeviceLabel(label) || labelRole(label) !== this.#role");
    const kept = poll.indexOf("this.#arrived = {");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(opened);
    expect(kept).toBeGreaterThan(check);
    // The bad-name branch abandons; grant-put is reached only from #grant.
    expect(poll.slice(check, kept)).toContain("this.abandon();");
    expect(poll).not.toContain("putPairingGrant");
    expect(pairing().match(/putPairingGrant\(/g)).toHaveLength(1);
  });

  it("release 1 adds teacher devices only", () => {
    expect(pairing()).toContain('readonly #role = "teacher" as const;');
    const whose = code(source("app", "pairing", "AddDeviceFlow.tsx"));
    expect(whose).not.toMatch(/para/i);
  });
});

describe("TEACH-75 HARD — matching code (A-4) and the fresh unlock", () => {
  it("3 tries, compared against the one request held; the 3rd miss abandons", () => {
    const text = pairing();
    expect(text).toContain("export const MATCH_TRIES = 3;");
    const check = method(text, "checkCode(typed: string): CodeOutcome {");
    expect(check).toContain("verificationCodeMatches(this.#arrived.request, typed)");
    const miss = check.indexOf("this.#misses >= MATCH_TRIES");
    expect(check.indexOf("this.abandon();", miss)).toBeGreaterThan(miss);
    // The request is fetched once: a held request is returned without a relay read.
    const poll = method(text, "async poll(): Promise<PollOutcome> {");
    expect(poll.indexOf("if (this.#arrived !== null")).toBeLessThan(
      poll.indexOf("getPairingRequest("),
    );
  });

  it("abandon() zeroizes S and K and drops the sid, the request and the matched code", () => {
    const abandon = method(pairing(), "abandon(): void {");
    for (const expected of [
      "zeroize(this.#secret)",
      "zeroize(this.#key)",
      "this.#sid = null;",
      "this.#arrived = null;",
      "this.#matched = null;",
    ]) {
      expect(abandon).toContain(expected);
    }
  });

  it("approve() needs a matched code, then the full unlock, before the grant is built", () => {
    const approve = method(
      pairing(),
      "async approve(passphrase?: string): Promise<ApproveOutcome> {",
    );
    const guard = approve.indexOf("matched === null");
    const unlock = approve.indexOf("await unlockDevice(");
    const grant = approve.indexOf("this.#grant(fresh");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(unlock).toBeGreaterThan(guard);
    expect(grant).toBeGreaterThan(unlock);
    expect(approve).toContain("fresh.lock();");
    // The grant comes from the freshly opened vault and is sealed with the typed helper.
    const build = method(pairing(), "async #grant(");
    expect(build).toContain("fresh.readGrant(");
    expect(build).toContain("sealTeacherGrant(key, sid, grant)");
    expect(build).toContain("keyring.destroy();");
  });

  it("the matching-code screens never show or hint at the expected code", () => {
    const flow = code(source("app", "pairing", "useAddDevice.ts"));
    expect(flow).not.toMatch(/verificationCode|deviceVerificationCode/);
    expect(code(source("device", "pairing-copy.ts"))).not.toMatch(/\$\{.*code/i);
  });
});

describe("TEACH-75 HARD — memory only; a lock abandons both sides", () => {
  it("the pairing never writes the record itself: only the vault (stage pairing) and the grant", () => {
    const text = pairing();
    expect(text).not.toMatch(/store\.(update|create)\(/);
    expect(text).toContain('stage: "pairing",');
    expect(text).toContain("storePairedGrant(");
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./);
  });

  it("B keeps only sid and K, and zeroizes S as soon as they are derived", () => {
    const begin = method(pairing(), "begin(code: string): boolean {");
    expect(begin.indexOf("zeroize(secret)")).toBeGreaterThan(begin.indexOf("pairingKey(secret)"));
    expect(begin).not.toContain("this.#secret");
  });

  it("the App's lock abandons the trusted side and discards the new device's keys", () => {
    const app = code(source("App.tsx"));
    const lock = app.slice(
      app.indexOf("const lock = useCallback("),
      app.indexOf("useEffect(", app.indexOf("const lock = useCallback(")),
    );
    expect(lock).toContain("approverRef.current?.abandon();");
    expect(lock).toContain("heldJoin.discard()");
    expect(lock).toContain("setupRef.current?.end();");
  });

  it("an unmounted add-device screen abandons its session", () => {
    const flow = code(source("app", "pairing", "useAddDevice.ts"));
    expect(flow).toContain("useEffect(() => end, [end]);");
  });
});

describe("TEACH-75 HARD — scanner, QR, role switch, C10", () => {
  it("A-5: the scanner uses the bundled decoder; the QR is the raw code, never a link", () => {
    const scanner = code(source("app", "pairing", "QrScanner.tsx"));
    expect(scanner).toContain('import jsQR from "jsqr";');
    const qr = code(source("app", "pairing", "QrCode.tsx"));
    expect(qr).toContain('import qrcode from "qrcode-generator";');
    expect(qr).toContain('qr.addData(qrPayload(code), "Alphanumeric");');
    expect(qr).not.toMatch(/https?:|location|dangerouslySetInnerHTML|toDataURL|createDataURL/);
    // No deep link into pairing: nothing reads the URL fragment or query for a code.
    for (const file of [
      ["App.tsx"],
      ["app", "pairing", "JoinFlow.tsx"],
      ["app", "pairing", "useJoin.ts"],
    ]) {
      expect(code(source(...file)), file.join("/")).not.toMatch(/location\.(hash|search|href)/);
    }
  });

  it("A-6: the Teacher/Para switch renders only behind the QA build flag", () => {
    const shell = code(source("app", "AppShell.tsx"));
    const renders = shell.match(/<RoleSeg /g) ?? [];
    // Read inline, so the build folds it to a constant and drops RoleSeg (CI's bundle
    // check, tools/synthetic-seed-check.sh, proves the prod image has no switch).
    const guarded =
      shell.match(/import\.meta\.env\.VITE_TA_SYNTHETIC === "1" \? \(?\s*<RoleSeg /g) ?? [];
    expect(renders.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(renders.length);
  });

  it("C10: the A3 passphrase box is not focused on load", () => {
    const flow = code(source("app", "pairing", "AddDeviceFlow.tsx"));
    expect(flow).not.toMatch(/autoFocus|\.focus\(/);
  });

  it("the grant crosses the relay only through the typed helpers", () => {
    const text = pairing();
    expect(text).toContain("sealTeacherGrant(");
    expect(text).toContain("openTeacherGrant(");
    expect(text).not.toMatch(/JSON\.stringify\(grant\)/);
  });
});
