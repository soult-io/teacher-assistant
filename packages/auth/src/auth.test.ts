import {
  approveDeviceEnrollment,
  createEnrollmentRequest,
  generateDeviceKeypair,
  generateMasterKey,
  sodiumReady,
  TeacherKeyring,
  utf8,
} from "@teacher-assistant/crypto";
import {
  asTimestamp,
  newOpaqueId,
  newScopeTag,
  type RecordEnvelope,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { PROD_RP, QA_RP, rpConfigForHost } from "./config.js";
import { AuthThrottle } from "./throttle.js";
import { AuthRequiredError, unlockTeacherKeyring } from "./unlock.js";
import { beginAuthentication, beginRegistration } from "./webauthn.js";

beforeAll(async () => {
  await sodiumReady();
});

describe("RP config (posture B)", () => {
  it("maps the confirmed hosts and fails closed for anything else", () => {
    expect(rpConfigForHost("ta.stabpablo.com")).toBe(PROD_RP);
    expect(rpConfigForHost("ta-qa.stabpablo.com:443")).toBe(QA_RP);
    expect(() => rpConfigForHost("evil.example.com")).toThrow();
  });
});

describe("passkey ceremony config (H-PUB-1)", () => {
  it("registration requires user verification + a discoverable credential", async () => {
    const opts = await beginRegistration(PROD_RP, { id: new Uint8Array([1, 2, 3]), name: "acct" });
    expect(opts.rp.id).toBe("ta.stabpablo.com");
    expect(opts.authenticatorSelection?.userVerification).toBe("required");
    expect(opts.authenticatorSelection?.residentKey).toBe("required");
    expect(opts.challenge.length).toBeGreaterThan(0);
  });

  it("authentication requires user verification", async () => {
    const opts = await beginAuthentication(QA_RP);
    expect(opts.userVerification).toBe("required");
    expect(opts.rpId).toBe("ta-qa.stabpablo.com");
  });
});

describe("rate-limiting + lockout (H-PUB-5)", () => {
  it("locks out after maxFailures and recovers after the lockout window", () => {
    let now = 1_000;
    const throttle = new AuthThrottle(
      { maxFailures: 3, windowMs: 60_000, lockoutMs: 10_000 },
      () => now,
    );
    const key = "acct:opaque-id";
    expect(throttle.check(key).allowed).toBe(true);
    throttle.recordFailure(key);
    throttle.recordFailure(key);
    throttle.recordFailure(key);
    expect(throttle.check(key).allowed).toBe(false);
    now += 5_000;
    expect(throttle.check(key).allowed).toBe(false);
    now += 5_001;
    expect(throttle.check(key).allowed).toBe(true);
  });

  it("guardAll blocks if either account or IP is locked; success clears state", () => {
    let now = 0;
    const throttle = new AuthThrottle(
      { maxFailures: 1, windowMs: 60_000, lockoutMs: 1_000 },
      () => now,
    );
    throttle.recordFailure("ip:203.0.113.5");
    expect(throttle.guardAll(["acct:a", "ip:203.0.113.5"]).allowed).toBe(false);
    now += 1_001;
    expect(throttle.guardAll(["acct:a", "ip:203.0.113.5"]).allowed).toBe(true);
    throttle.recordSuccess("ip:203.0.113.5");
    expect(throttle.check("ip:203.0.113.5").allowed).toBe(true);
  });
});

describe("auth unlocks device-held wrapped keys", () => {
  it("refuses to unlock without a verified passkey auth, then unlocks with one", () => {
    const masterScope = newScopeTag();
    const trusted = new TeacherKeyring(masterScope, generateMasterKey());
    const device = generateDeviceKeypair();
    const { request, verificationCode } = createEnrollmentRequest(device);
    const grant = approveDeviceEnrollment(trusted, request, verificationCode);

    expect(() =>
      unlockTeacherKeyring({ authenticationVerified: false, deviceKeypair: device, grant }),
    ).toThrow(AuthRequiredError);

    const keyring = unlockTeacherKeyring({
      authenticationVerified: true,
      deviceKeypair: device,
      grant,
    });
    const env: RecordEnvelope = {
      record_id: newOpaqueId(),
      record_type: "goal",
      scope_tag: masterScope,
      crdt_version: {},
      created_ts: asTimestamp(0),
      updated_ts: asTimestamp(0),
      size: 0,
      deleted: false,
    };
    const blob = trusted.encryptRecord(env, utf8("unlocked"));
    expect(new TextDecoder().decode(keyring.decryptRecord(env, blob))).toBe("unlocked");
  });
});
