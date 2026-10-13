// @vitest-environment node
//
// EU-6 (TEACH-66) — the device vault in IndexedDB (device-enrollment-spec rev 2.4 DN-1,
// §3.1, §11 EU-6). Node realm: libsodium rejects a foreign-realm Uint8Array; the setup
// file still installs fake-indexeddb globally. A fake passkey port stands in for
// WebAuthn (the browser port is tested in passkey-prf.test.ts).

import {
  deriveTierWKek,
  fromBase64,
  generateKdev,
  openVault,
  sodiumReady,
  stretchPassphrase,
  toBase64,
  utf8,
  type VaultSecrets,
} from "@teacher-assistant/crypto";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { RelayClient, type Transport } from "@teacher-assistant/sync";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_DB_NAME,
  DeviceRecordImmutableError,
  type DeviceRecord,
  DeviceStore,
} from "./device-store.js";
import type { PasskeyAssertion, PasskeyPrfPort } from "./passkey-prf.js";
import type { PlatformEnv } from "./platform.js";
import {
  createDeviceVault,
  DeviceAlreadyEnrolledError,
  DeviceCannotUnlockError,
  DeviceLockedError,
  PassphraseRequiredError,
  probeTier,
  SetupNeedsHomeScreenError,
  UnlockBackoffError,
  UnlockInProgressError,
  unlockBackoffMs,
  unlockDevice,
  WeakPassphraseError,
  WrongPassphraseError,
} from "./vault.js";

// Argon2id MODERATE (256 MiB) takes about 2 s per call on a CI runner; tests here run up to
// four per case, so the 5 s default timeout is too short. The cost itself is never lowered.
vi.setConfig({ testTimeout: 60_000 });

/** A fake authenticator: returns a fixed PRF output (or none) on every UV assertion. */
class FakePasskey implements PasskeyPrfPort {
  assertions = 0;
  constructor(public prf: Uint8Array | null) {}
  create(): Promise<{ credentialId: Uint8Array }> {
    return Promise.resolve({ credentialId: crypto.getRandomValues(new Uint8Array(16)) });
  }
  assert(_credentialId: Uint8Array): Promise<PasskeyAssertion> {
    this.assertions += 1;
    return Promise.resolve({ prf: this.prf === null ? null : new Uint8Array(this.prf) });
  }
}

const ANDROID: PlatformEnv = {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8a) Chrome/130",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
  standaloneMedia: false,
  navigatorStandalone: undefined,
  persist: () => Promise.resolve(true),
};

function deleteDeviceDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DEVICE_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Write a record straight to IndexedDB, bypassing DeviceStore's guards (attacker/test only). */
function rawPut(record: DeviceRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DEVICE_DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("device", "readwrite");
      tx.objectStore("device").put(record, "self");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

async function enrollTierP(store: DeviceStore, prf = new Uint8Array(32).fill(9)) {
  const passkey = new FakePasskey(prf);
  const probe = await probeTier(passkey);
  const { device, persisted } = await createDeviceVault({
    store,
    probe,
    role: "teacher",
    platform: ANDROID,
  });
  return { passkey, device, persisted };
}

async function enrollTierW(store: DeviceStore, passphrase = "abcd1234") {
  const passkey = new FakePasskey(null);
  const probe = await probeTier(passkey);
  const { device } = await createDeviceVault({
    store,
    probe,
    role: "teacher",
    passphrase,
    platform: ANDROID,
  });
  return { passkey, device };
}

function bytesOf(record: DeviceRecord): Uint8Array[] {
  const out: Uint8Array[] = [utf8(JSON.stringify({ ...record, kdev: undefined }))];
  for (const value of Object.values(record)) {
    if (typeof value === "string") {
      try {
        out.push(fromBase64(value));
      } catch {
        // not base64 (tier/role) — the JSON text above covers it
      }
    }
  }
  return out;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** Verify an Ed25519 signature with WebCrypto — independent of the libsodium signer. */
async function verifies(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), "Ed25519", false, [
    "verify",
  ]);
  return crypto.subtle.verify("Ed25519", key, new Uint8Array(signature), new Uint8Array(message));
}

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  await deleteDeviceDb();
});

describe("tier probe at enrollment", () => {
  it("is Tier P only when the test get() returns PRF output", async () => {
    expect((await probeTier(new FakePasskey(new Uint8Array(32).fill(1)))).tier).toBe("prf");
    expect((await probeTier(new FakePasskey(null))).tier).toBe("passphrase");
  });
});

describe("Tier P", () => {
  it("creates, reloads and unlocks to the same identity; signatures verify with WebCrypto", async () => {
    const { passkey, device, persisted } = await enrollTierP(new DeviceStore());
    expect(persisted).toBe(true);
    const signPk = toBase64(device.publicKey);
    device.lock();

    const reloaded = new DeviceStore(); // a fresh connection = a page reload
    const again = await unlockDevice({ store: reloaded, passkey });
    expect(toBase64(again.publicKey)).toBe(signPk);
    const msg = utf8("canonical request");
    expect(await verifies(again.sign(msg), msg, again.publicKey)).toBe(true);
    const record = await reloaded.load();
    expect(record?.tier).toBe("prf");
    expect(record?.signPk).toBe(signPk);
    expect(record?.kdev).toBeUndefined();
    expect(record?.pwSalt).toBeUndefined();
  });

  it("PRF missing at unlock → locked error, never Tier W, even with a passphrase offered", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierP(store);
    passkey.prf = null;
    await expect(unlockDevice({ store, passkey, passphrase: "abcd1234" })).rejects.toThrow(
      DeviceCannotUnlockError,
    );
    expect((await store.load())?.tier).toBe("prf");
  });

  it("a different PRF output (another credential) does not open the vault", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierP(store);
    passkey.prf = new Uint8Array(32).fill(10);
    await expect(unlockDevice({ store, passkey })).rejects.toThrow(DeviceCannotUnlockError);
  });

  it("requires a user-verified assertion on every unlock", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierP(store);
    const before = passkey.assertions;
    (await unlockDevice({ store, passkey })).lock();
    expect(passkey.assertions).toBe(before + 1);
  });
});

describe("the tier is immutable; keys are never regenerated", () => {
  it("a second enrollment on the same device is refused and leaves the record unchanged", async () => {
    const store = new DeviceStore();
    await enrollTierP(store);
    const before = await store.load();
    const probe = await probeTier(new FakePasskey(null));
    await expect(
      createDeviceVault({
        store,
        probe,
        role: "teacher",
        passphrase: "abcd1234",
        platform: ANDROID,
      }),
    ).rejects.toThrow(DeviceAlreadyEnrolledError);
    expect(await store.load()).toEqual(before);
  });

  it("DeviceStore.update refuses to change the tier or either public key", async () => {
    const store = new DeviceStore();
    await enrollTierP(store);
    await expect(store.update((r) => ({ ...r, tier: "passphrase" }))).rejects.toThrow(
      DeviceRecordImmutableError,
    );
    await expect(
      store.update((r) => ({ ...r, signPk: toBase64(new Uint8Array(32)) })),
    ).rejects.toThrow(DeviceRecordImmutableError);
    await expect(
      store.update((r) => ({ ...r, boxPk: toBase64(new Uint8Array(32)) })),
    ).rejects.toThrow(DeviceRecordImmutableError);
    expect((await store.load())?.tier).toBe("prf");
  });
});

describe("Tier W", () => {
  it("rejects a 6-digit PIN and abcdefgh at setup, and stores nothing", async () => {
    for (const passphrase of ["123456", "abcdefgh"]) {
      const store = new DeviceStore();
      const probe = await probeTier(new FakePasskey(null));
      await expect(
        createDeviceVault({ store, probe, role: "teacher", passphrase, platform: ANDROID }),
      ).rejects.toThrow(WeakPassphraseError);
      expect(await store.load()).toBeNull();
    }
  });

  it("accepts abcd1234 and 0123456789", async () => {
    for (const passphrase of ["abcd1234", "0123456789"]) {
      await deleteDeviceDb();
      const store = new DeviceStore();
      const { passkey } = await enrollTierW(store, passphrase);
      const device = await unlockDevice({ store, passkey, passphrase });
      expect(device.locked).toBe(false);
      device.lock();
    }
  });

  it("a passphrase-tier device without a passphrase cannot unlock", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    await expect(unlockDevice({ store, passkey })).rejects.toThrow(PassphraseRequiredError);
  });

  it("a wrong passphrase is refused and counted; a right one resets the count", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    await expect(unlockDevice({ store, passkey, passphrase: "wxyz9876" })).rejects.toThrow(
      WrongPassphraseError,
    );
    expect((await store.load())?.unlockFailures?.count).toBe(1);
    (await unlockDevice({ store, passkey, passphrase: "abcd1234" })).lock();
    expect((await store.load())?.unlockFailures).toBeUndefined();
  });

  it("the KEK cannot be derived without Kdev: a swapped Kdev never opens the vault", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    const record = await store.load();
    if (record === null) {
      throw new Error("expected a record");
    }
    await rawPut({ ...record, kdev: await generateKdev() });
    await expect(unlockDevice({ store, passkey, passphrase: "abcd1234" })).rejects.toThrow(
      WrongPassphraseError,
    );
    const { kdev: _dropped, ...withoutKdev } = record;
    await rawPut(withoutKdev);
    await expect(unlockDevice({ store, passkey, passphrase: "abcd1234" })).rejects.toThrow(
      DeviceCannotUnlockError,
    );
  });

  it("Kdev at rest is a non-extractable HMAC key", async () => {
    const store = new DeviceStore();
    await enrollTierW(store);
    const kdev = (await store.load())?.kdev;
    expect(kdev?.extractable).toBe(false);
    expect(kdev?.algorithm.name).toBe("HMAC");
    if (kdev === undefined) {
      throw new Error("expected Kdev");
    }
    await expect(crypto.subtle.exportKey("raw", kdev)).rejects.toThrow();
  });

  it("the vault record stores no intermediate and no raw key (every field scanned)", async () => {
    const store = new DeviceStore();
    const passphrase = "abcd1234";
    const { passkey, device } = await enrollTierW(store, passphrase);
    await device.storeGrant(store, {
      role: "teacher",
      grant: {
        wrappedMasterKeyB64: toBase64(new Uint8Array(80).fill(5)),
        masterScopeTag: newScopeTag(),
        masterDocId: newOpaqueId(),
      },
    });
    device.lock();
    const record = await store.load();
    if (record === null || record.kdev === undefined || record.pwSalt === undefined) {
      throw new Error("expected a Tier W record");
    }
    const salt = fromBase64(record.pwSalt);
    const stretched = stretchPassphrase(passphrase, salt);
    const kek = await deriveTierWKek(record.kdev, passphrase, salt);
    const secrets: VaultSecrets = openVault(kek, fromBase64(record.vault), {
      tier: "passphrase",
      signPk: fromBase64(record.signPk),
      boxPk: fromBase64(record.boxPk),
    });
    const forbidden = [
      stretched,
      kek,
      secrets.signSk,
      secrets.boxSk,
      secrets.recordKey,
      utf8(passphrase),
    ];
    for (const field of bytesOf(record)) {
      for (const needle of forbidden) {
        expect(contains(field, needle)).toBe(false);
      }
    }
    expect(Object.keys(record).sort()).toEqual(
      [
        "boxPk",
        "credentialId",
        "enrolled",
        "grant",
        "kdev",
        "pwSalt",
        "role",
        "signPk",
        "tier",
        "vault",
        "version",
      ].sort(),
    );
    (await unlockDevice({ store, passkey, passphrase })).lock();
  });
});

describe("on-device backoff after wrong passphrases (defence in depth)", () => {
  it("grows from the third failure and caps at 15 minutes", () => {
    expect(unlockBackoffMs(0)).toBe(0);
    expect(unlockBackoffMs(2)).toBe(0);
    expect(unlockBackoffMs(3)).toBe(30_000);
    expect(unlockBackoffMs(4)).toBe(60_000);
    expect(unlockBackoffMs(20)).toBe(15 * 60_000);
  });

  it("refuses an attempt inside the wait without running the passkey or Argon2id", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    const record = await store.load();
    if (record === null) {
      throw new Error("expected a record");
    }
    const now = 1_000_000;
    await rawPut({ ...record, unlockFailures: { count: 3, lastAt: now - 1_000 } });
    const before = passkey.assertions;
    const err = await unlockDevice({
      store,
      passkey,
      passphrase: "abcd1234",
      now: () => now,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnlockBackoffError);
    expect((err as UnlockBackoffError).retryAfterMs).toBe(29_000);
    expect(passkey.assertions).toBe(before);
  });
});

describe("lock: no signing, no key buffer survives", () => {
  it("zeroizes signSk, boxSk and the record key; sign/boxKeypair/readGrant throw", async () => {
    const store = new DeviceStore();
    const { device } = await enrollTierP(store);
    const box = device.boxKeypair();
    device.lock();
    expect(device.locked).toBe(true);
    expect(box.privateKey.every((b) => b === 0)).toBe(true);
    expect(() => device.sign(utf8("m"))).toThrow(DeviceLockedError);
    expect(() => device.boxKeypair()).toThrow(DeviceLockedError);
    await expect(device.readGrant(store)).rejects.toThrow(DeviceLockedError);
    device.lock(); // idempotent
  });

  it("a RelayClient on a locked device sends nothing", async () => {
    const store = new DeviceStore();
    const { device } = await enrollTierP(store);
    let sent = 0;
    const transport: Transport = () => {
      sent += 1;
      return Promise.resolve({ status: 404, body: new Uint8Array(0) });
    };
    const relay = new RelayClient({ transport, signer: device });
    await relay.pull(newOpaqueId(), newScopeTag(), null);
    expect(sent).toBe(1);
    device.lock();
    await expect(relay.pull(newOpaqueId(), newScopeTag(), null)).rejects.toThrow(DeviceLockedError);
    await expect(relay.push(newOpaqueId(), newScopeTag(), [new Uint8Array(1)])).rejects.toThrow(
      DeviceLockedError,
    );
    expect(sent).toBe(1);
  });
});

describe("the grant at rest is AEAD-protected", () => {
  it("is stored sealed, survives a reload, and needs an unlock to read", async () => {
    const store = new DeviceStore();
    const { passkey, device } = await enrollTierP(store);
    const wrapped = toBase64(new Uint8Array(80).fill(6));
    const grant = {
      role: "teacher" as const,
      grant: {
        wrappedMasterKeyB64: wrapped,
        masterScopeTag: newScopeTag(),
        masterDocId: newOpaqueId(),
      },
    };
    await device.storeGrant(store, grant);
    device.lock();
    const record = await store.load();
    expect(record?.grant).toBeDefined();
    const text = new TextDecoder().decode(fromBase64(record?.grant ?? ""));
    expect(text).not.toContain(wrapped);
    expect(text).not.toContain(grant.grant.masterScopeTag);
    expect(text).not.toContain("wrappedMasterKeyB64");

    const again = await unlockDevice({ store: new DeviceStore(), passkey });
    expect(await again.readGrant(store)).toEqual(grant);
  });

  it("refuses a grant for the other role", async () => {
    const store = new DeviceStore();
    const { device } = await enrollTierP(store);
    await expect(
      device.storeGrant(store, {
        role: "para",
        grant: { wrappedDekB64: "x", scopeTag: newScopeTag(), paraDocId: newOpaqueId() },
      }),
    ).rejects.toThrow();
  });
});

describe("reviewer round 1 fixes", () => {
  it("a clock that moved backwards never adds a wait below the third failure", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    const record = await store.load();
    if (record === null) {
      throw new Error("expected a record");
    }
    await rawPut({ ...record, unlockFailures: { count: 2, lastAt: 5_000_000 } });
    const device = await unlockDevice({ store, passkey, passphrase: "abcd1234", now: () => 1_000 });
    device.lock();
  });

  it("after 3+ failures, a backwards clock restarts the wait from now (not from the future)", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    const record = await store.load();
    if (record === null) {
      throw new Error("expected a record");
    }
    await rawPut({ ...record, unlockFailures: { count: 3, lastAt: 10_000_000 } });
    const first = await unlockDevice({
      store,
      passkey,
      passphrase: "abcd1234",
      now: () => 1_000,
    }).catch((e: unknown) => e);
    expect((first as UnlockBackoffError).retryAfterMs).toBe(30_000);
    const later = await unlockDevice({ store, passkey, passphrase: "abcd1234", now: () => 31_000 });
    later.lock();
  });

  it("refuses a second unlock while one is running", async () => {
    const store = new DeviceStore();
    const { passkey } = await enrollTierW(store);
    const first = unlockDevice({ store, passkey, passphrase: "abcd1234" });
    await expect(unlockDevice({ store, passkey, passphrase: "abcd1234" })).rejects.toThrow(
      UnlockInProgressError,
    );
    (await first).lock();
  });

  it("composed and decomposed accents unlock the same vault (NFC)", async () => {
    const store = new DeviceStore();
    const composed = "caf\u00e9bleu7";
    const { passkey } = await enrollTierW(store, composed);
    const device = await unlockDevice({ store, passkey, passphrase: "cafe\u0301bleu7" });
    device.lock();
  });
});

describe("a refused setup zeroizes the probe's PRF output", () => {
  it("on an already-enrolled device", async () => {
    const store = new DeviceStore();
    await enrollTierP(store);
    const probe = await probeTier(new FakePasskey(new Uint8Array(32).fill(4)), ANDROID);
    await expect(
      createDeviceVault({ store, probe, role: "teacher", platform: ANDROID }),
    ).rejects.toThrow(DeviceAlreadyEnrolledError);
    expect(probe.prf?.every((b) => b === 0)).toBe(true);
  });
});

describe("setup gates (A-3)", () => {
  it("probeTier refuses on iOS outside the Home Screen app before any passkey is created", async () => {
    const passkey = new FakePasskey(new Uint8Array(32).fill(1));
    let created = 0;
    passkey.create = () => {
      created += 1;
      return Promise.resolve({ credentialId: new Uint8Array(16) });
    };
    const ios: PlatformEnv = {
      ...ANDROID,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      platform: "iPhone",
      navigatorStandalone: false,
    };
    await expect(probeTier(passkey, ios)).rejects.toThrow(SetupNeedsHomeScreenError);
    expect(created).toBe(0);
  });

  it("iOS outside the Home Screen app: setup refused, nothing stored, no persist() call", async () => {
    let persistCalls = 0;
    const ios: PlatformEnv = {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605",
      platform: "iPhone",
      maxTouchPoints: 5,
      standaloneMedia: false,
      navigatorStandalone: false,
      persist: () => {
        persistCalls += 1;
        return Promise.resolve(true);
      },
    };
    const store = new DeviceStore();
    const probe = await probeTier(new FakePasskey(new Uint8Array(32).fill(1)));
    await expect(
      createDeviceVault({ store, probe, role: "teacher", platform: ios }),
    ).rejects.toThrow(SetupNeedsHomeScreenError);
    expect(await store.load()).toBeNull();
    expect(persistCalls).toBe(0);
  });

  it("requests persistent storage at setup and reports a refusal without blocking", async () => {
    const store = new DeviceStore();
    const probe = await probeTier(new FakePasskey(new Uint8Array(32).fill(1)));
    const { persisted, device } = await createDeviceVault({
      store,
      probe,
      role: "teacher",
      platform: { ...ANDROID, persist: () => Promise.resolve(false) },
    });
    expect(persisted).toBe(false);
    expect(await store.load()).not.toBeNull();
    device.lock();
  });
});
