// @vitest-environment node
//
// EU-6 (TEACH-66) — locking the sessions and the persistent relay identity
// (device-enrollment-spec rev 2.4 §3.1, §11 EU-6; EU-5 FERPA carry-forward):
//   - lock destroys EVERY keyring, the para keyring included, and no key buffer
//     created during bootstrap survives it through any other holder;
//   - the RelayClient signs with the device's persistent identity, the same across
//     reloads, and signs nothing once the device is locked.
// Node realm, as session.test.ts (libsodium rejects a foreign-realm Uint8Array).

import { KeyringDestroyedError, sodiumReady, toBase64 } from "@teacher-assistant/crypto";
import { SYNC_HEADERS } from "@teacher-assistant/schema";
import { InMemoryPersistence, type RequestSigner } from "@teacher-assistant/sync";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapParaSession, bootstrapTeacherSession } from "./session.js";

// Record every key buffer the crypto layer hands out during a bootstrap, so the test can
// prove each one is zeroized by lock — whoever else still holds a reference to it.
const keyBuffers = vi.hoisted(() => [] as Uint8Array[]);

vi.mock("@teacher-assistant/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("@teacher-assistant/crypto")>();
  const keep = <T extends Uint8Array>(buf: T): T => {
    keyBuffers.push(buf);
    return buf;
  };
  return {
    ...real,
    generateMasterKey: () => keep(real.generateMasterKey()),
    generatePeriodKey: (tag: Parameters<typeof real.generatePeriodKey>[0]) => {
      const pk = real.generatePeriodKey(tag);
      keep(pk.dek);
      return pk;
    },
    generateDeviceKeypair: () => {
      const kp = real.generateDeviceKeypair();
      keep(kp.privateKey);
      return kp;
    },
    generateSigningKeypair: () => {
      const kp = real.generateSigningKeypair();
      keep(kp.privateKey);
      return kp;
    },
    completeDeviceEnrollment: (...args: Parameters<typeof real.completeDeviceEnrollment>) => {
      const out = real.completeDeviceEnrollment(...args);
      keep(out.mk);
      return out;
    },
    completeParaEnrollment: (...args: Parameters<typeof real.completeParaEnrollment>) => {
      const out = real.completeParaEnrollment(...args);
      keep(out.dek);
      return out;
    },
  };
});

const NOW = new Date("2026-09-14T12:00:00Z");

/** A test device signer that can be locked, like UnlockedDevice. */
function lockableSigner(): RequestSigner & { lock(): void } {
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  let locked = false;
  return {
    publicKey,
    sign: () => {
      if (locked) {
        throw new Error("locked");
      }
      return new Uint8Array(64);
    },
    lock: () => {
      locked = true;
    },
  };
}

/** Stub fetch: answer every relay call with 404 (an empty pull) and record the identity header. */
function stubRelay(): string[] {
  const devices: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      devices.push(headers[SYNC_HEADERS.device] ?? "");
      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
  return devices;
}

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  keyBuffers.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lock destroys every keyring, para included", () => {
  it("after lock, teacher and para writes throw KeyringDestroyedError", async () => {
    const teacher = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
    });
    const para = await bootstrapParaSession(teacher.paraHandoff);
    teacher.lock();
    para.lock();
    await expect(teacher.capture(() => {})).rejects.toThrow(KeyringDestroyedError);
    // The para capture first integrates the persisted para ciphertext; the destroyed
    // keyring refuses that decrypt, which surfaces as the sync layer's IntegrateError.
    await expect(para.capturePara(() => {})).rejects.toThrow(/integrate|destroyed/);
    teacher.lock(); // idempotent
    para.lock();
  });

  it("no key buffer created during bootstrap survives the lock", async () => {
    const teacher = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
    });
    const para = await bootstrapParaSession(teacher.paraHandoff);
    expect(keyBuffers.length).toBeGreaterThanOrEqual(8);
    expect(keyBuffers.some((b) => b.some((x) => x !== 0))).toBe(true);
    teacher.lock();
    para.lock();
    const survivors = keyBuffers.filter((b) => b.some((x) => x !== 0));
    expect(survivors).toHaveLength(0);
  });
});

describe("the persistent relay identity", () => {
  it("both streams sign as the device, and the same identity is used after a reload", async () => {
    const sent = stubRelay();
    const device = lockableSigner();
    const first = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
      device,
    });
    await first.sync();
    first.lock();
    const second = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
      device,
    });
    await second.sync();
    second.lock();
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(new Set(sent)).toEqual(new Set([toBase64(device.publicKey)]));
  });

  it("a locked device signs nothing: sync degrades to offline and sends no request", async () => {
    const sent = stubRelay();
    const device = lockableSigner();
    const session = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
      device,
    });
    device.lock();
    expect(await session.sync()).toBe(false);
    expect(sent).toHaveLength(0);
    session.lock();
  });

  it("without a device (the pre-EU-7 synthetic path) both streams share one throwaway identity", async () => {
    const sent = stubRelay();
    const session = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
    });
    await session.sync();
    session.lock();
    expect(new Set(sent).size).toBe(1);
  });
});
