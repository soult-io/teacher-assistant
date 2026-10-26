// @vitest-environment node
//
// EU-7 (TEACH-73) — first setup F1, in process, end to end (device-enrollment-spec rev 2.5
// §4.1, §7 EU-7, §11 EU-7 HARD, §13 A-1/A-2/A-8, DN-1a C1/C2/C4/C6/C8). The real relay
// (buildApp over InMemoryRelayStore) is driven through a Fastify-inject transport; a fake
// authenticator stands in for WebAuthn (the browser port is tested in passkey-prf.test.ts).
// Each device gets its own IndexedDB factory, as two browser profiles would.
// Node realm: libsodium rejects a foreign-realm Uint8Array.

import { sodiumReady, unwrapRecoveryBundle } from "@teacher-assistant/crypto";
import {
  InMemoryPersistence,
  type RelayHttpRequest,
  type Transport,
} from "@teacher-assistant/sync";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { newOwnerCode, ownerCodeHash } from "@teacher-assistant/sync-relay/owner-code";
import { InMemoryRelayStore } from "@teacher-assistant/sync-relay/store";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapTeacherSession } from "../data/session.js";
import { browserDevicePort, type DevicePort } from "./device-port.js";
import { DeviceStore } from "./device-store.js";
import {
  FirstSetup,
  readDeviceStatus,
  SETUP_CODE_TTL_MS,
  SetupOfflineError,
} from "./first-setup.js";
import type { PasskeyAssertion, PasskeyPrfPort } from "./passkey-prf.js";
import type { PlatformEnv } from "./platform.js";
import { unlockDevice, type UnlockedDevice } from "./vault.js";

// Every Tier W step runs Argon2id MODERATE (about 2 s per call on a CI runner).
vi.setConfig({ testTimeout: 120_000 });

const mintedMasterKeys = vi.hoisted(() => ({ count: 0 }));

vi.mock("@teacher-assistant/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("@teacher-assistant/crypto")>();
  return {
    ...real,
    generateMasterKey: () => {
      mintedMasterKeys.count += 1;
      return real.generateMasterKey();
    },
  };
});

const PASSPHRASE = "blue7kites";
const NOW = new Date("2026-10-26T15:00:00Z").getTime();

const ANDROID: PlatformEnv = {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8a) Chrome/130",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
  standaloneMedia: true,
  navigatorStandalone: undefined,
  persist: () => Promise.resolve(true),
};

/** A fake authenticator. `prf: null` is Bitwarden: no PRF output, so Tier W (C8). */
class FakePasskey implements PasskeyPrfPort {
  readonly names: string[] = [];
  readonly allowed: Uint8Array[] = [];
  credentialId: Uint8Array | null = null;
  constructor(readonly prf: Uint8Array | null = null) {}
  create(displayName: string): Promise<{ credentialId: Uint8Array }> {
    this.names.push(displayName);
    this.credentialId = crypto.getRandomValues(new Uint8Array(16));
    return Promise.resolve({ credentialId: this.credentialId });
  }
  assert(credentialId: Uint8Array): Promise<PasskeyAssertion> {
    this.allowed.push(credentialId);
    return Promise.resolve({
      prf: this.prf === null ? null : new Uint8Array(this.prf),
      backupEligible: true,
      backedUp: true,
    });
  }
}

type RelayApp = ReturnType<typeof buildApp>;

interface Relay {
  readonly store: InMemoryRelayStore;
  readonly app: RelayApp;
  /** Every request the devices sent: path + parsed body. */
  readonly sent: { readonly path: string; readonly body: string }[];
  transport(options?: { readonly dropResponse?: (path: string) => boolean }): Transport;
  issueCode(): Promise<string>;
}

function relay(): Relay {
  const store = new InMemoryRelayStore();
  const app = buildApp(store, { logStream: { write: () => {} } });
  const sent: { path: string; body: string }[] = [];
  return {
    store,
    app,
    sent,
    transport:
      (options = {}) =>
      async (req: RelayHttpRequest) => {
        const body = new TextDecoder().decode(req.body);
        sent.push({ path: req.path, body });
        const res = await app.inject({
          method: req.method,
          url: req.path,
          headers: req.headers,
          ...(req.method === "GET" ? {} : { payload: body }),
        });
        if (options.dropResponse?.(req.path) === true) {
          throw new TypeError("Failed to fetch"); // committed on the relay, no answer here
        }
        return { status: res.statusCode, body: new Uint8Array(res.rawPayload) };
      },
    issueCode: async () => {
      const code = newOwnerCode();
      const hash = ownerCodeHash(code);
      if (hash === undefined) {
        throw new Error("bad code");
      }
      await store.issueOwnerCode(hash, new Date(Date.now() + 60 * 60_000));
      return code;
    },
  };
}

interface Device {
  readonly store: DeviceStore;
  readonly passkey: FakePasskey;
  readonly persistence: InMemoryPersistence;
  setup(transport: Transport, options?: { synthetic?: boolean; now?: number }): FirstSetup;
}

function device(prf: Uint8Array | null = null): Device {
  const store = new DeviceStore(new IDBFactory());
  const passkey = new FakePasskey(prf);
  const persistence = new InMemoryPersistence();
  return {
    store,
    passkey,
    persistence,
    setup: (transport, options = {}) =>
      new FirstSetup({
        store,
        passkey,
        transport,
        persistence,
        synthetic: options.synthetic ?? false,
        platform: ANDROID,
        now: () => options.now ?? NOW,
      }),
  };
}

/** S1a → S2 → S3: the name, the passkey, the vault (Tier W unless the fake gives PRF). */
async function createUnlock(setup: FirstSetup, passphrase: string | undefined = PASSPHRASE) {
  setup.setLabel("School computer");
  const tier = await setup.createPasskey();
  await setup.sealVault(tier === "passphrase" ? passphrase : undefined);
  return tier;
}

/** The whole of F1 on one device; returns the recovery code. */
async function runF1(setup: FirstSetup, code: string): Promise<string> {
  await createUnlock(setup);
  expect(await setup.redeem(code)).toBe("first");
  await setup.finish();
  const recoveryCode = await setup.issueRecoveryCode();
  const groups = recoveryCode.split("-");
  expect(await setup.confirmRecoveryCode(groups.slice(-2).join(""))).toBe(true);
  return recoveryCode;
}

function parseWrap(blob: string) {
  const [saltB64, blobB64] = blob.split(".");
  return { saltB64: saltB64 ?? "", blobB64: blobB64 ?? "" };
}

beforeAll(async () => {
  await sodiumReady();
});

afterEach(() => {
  mintedMasterKeys.count = 0;
});

describe("F1 in process, end to end (Tier W, Bitwarden-like: no PRF)", () => {
  it("sets up, registers the master tag as kind master, stores the recovery wrap, and syncs", async () => {
    const r = relay();
    const d = device();
    const setup = d.setup(r.transport());
    const code = await r.issueCode();

    expect(await createUnlock(setup)).toBe("passphrase"); // no PRF at the probe → Tier W (C8)
    expect(d.passkey.names).toEqual(["Teacher Assistant — School computer, added Oct 26"]);
    expect((await d.store.load())?.setupStage?.stage).toBe("keys_created");

    expect(await setup.redeem(code)).toBe("first");
    expect((await d.store.load())?.setupStage).toMatchObject({ stage: "redeemed", mode: "first" });
    await setup.finish();
    expect((await d.store.load())?.setupStage?.stage).toBe("scopes_granted");

    const listed = await r.store.listDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.role).toBe("owner");
    const kinds = listed[0]?.scopes.map((s) => s.kind).sort();
    expect(kinds).toEqual(["master", "period"]);

    const recoveryCode = await setup.issueRecoveryCode();
    expect((await d.store.load())?.setupStage?.stage).toBe("recovery_pending");
    const wrap = await r.store.getRecoveryWrap();
    expect(wrap).toBeDefined();
    const bundle = unwrapRecoveryBundle(recoveryCode, parseWrap(wrap ?? ""));
    const stored = await setup.device.readGrant(d.store);
    expect(stored?.role).toBe("teacher");
    if (stored?.role !== "teacher") {
      throw new Error("expected a teacher grant");
    }
    expect(bundle.masterDocId).toBe(stored.grant.masterDocId);
    expect(bundle.masterScopeTag).toBe(stored.grant.masterScopeTag);
    const masterScope = listed[0]?.scopes.find((s) => s.kind === "master");
    expect(masterScope?.tag).toBe(stored.grant.masterScopeTag);

    // S5: a wrong re-type keeps setup unfinished; the right one finishes it.
    expect(await setup.confirmRecoveryCode("AAAA AAAA")).toBe(false);
    expect((await d.store.load())?.setupStage?.stage).toBe("recovery_pending");
    const lastTwo = recoveryCode.split("-").slice(-2).join(" ").toLowerCase();
    expect(await setup.confirmRecoveryCode(lastTwo)).toBe(true);
    expect((await d.store.load())?.setupStage?.stage).toBe("done");
    expect(await setup.confirmRecoveryCode(lastTwo)).toBe(false); // the code is gone from memory

    // The first sync pushes master and para; the relay now holds both docs.
    const port = portFor(d, r.transport());
    const session = await bootstrapTeacherSession({
      vault: await port.teacherVault(setup.device),
      persistence: d.persistence,
      transport: r.transport(),
    });
    expect(await session.sync()).toBe(true);
    expect(await r.store.docScope(stored.grant.masterDocId)).toBe(stored.grant.masterScopeTag);
    session.lock();
    setup.device.lock();
  });

  it("C1: every get() names only this device's credential id", async () => {
    const r = relay();
    const d = device();
    await runF1(d.setup(r.transport()), await r.issueCode());
    const unlocked = await unlockDevice({
      store: d.store,
      passkey: d.passkey,
      passphrase: PASSPHRASE,
    });
    unlocked.lock();
    const id = d.passkey.credentialId;
    expect(id).not.toBeNull();
    expect(d.passkey.allowed.length).toBeGreaterThanOrEqual(2); // the probe, then the unlock
    for (const allowed of d.passkey.allowed) {
      expect([...allowed]).toEqual([...(id ?? [])]);
    }
  });

  it("C4: BE/BS stay in the local record; no relay body carries them or the device name", async () => {
    const r = relay();
    const d = device();
    await runF1(d.setup(r.transport()), await r.issueCode());
    expect((await d.store.load())?.credFlags).toEqual({ be: true, bs: true });
    expect(r.sent.length).toBeGreaterThan(0);
    for (const { body } of r.sent) {
      expect(body).not.toMatch(/"be"|"bs"|credFlags|backupEligible|backedUp/);
      expect(body).not.toContain("School computer");
      expect(body).not.toContain("Teacher Assistant");
    }
  });
});

/** A browser device port over a test device + relay transport (the app's own wiring). */
function portFor(d: Device, transport: Transport, synthetic = false): DevicePort {
  return browserDevicePort({
    synthetic,
    store: d.store,
    passkey: d.passkey,
    transport,
    persistence: d.persistence,
  });
}

describe("session refactor: a reload reopens the same streams", () => {
  it("unlocking again opens the same master and para docs, with what was captured", async () => {
    const r = relay();
    const d = device();
    await runF1(d.setup(r.transport(), { synthetic: true }), await r.issueCode());
    const port = portFor(d, r.transport(), true);

    const first = await port.unlock(PASSPHRASE);
    const s1 = await bootstrapTeacherSession({
      vault: await port.teacherVault(first),
      persistence: d.persistence,
      inProcessPara: true,
    });
    const before = s1.readRecords();
    const goal = before.goals[0];
    expect(goal).toBeDefined();
    await s1.capture((doc) =>
      doc.getMap("goals").set(goal?.goal_id ?? "", { ...goal, goal_text: "Edited" }),
    );
    const paraDocBefore = s1.paraHandoff?.paraDocId;
    s1.lock();
    first.lock();

    // Reload: a fresh unlock and bootstrap over the same at-rest stores.
    const second = await port.unlock(PASSPHRASE);
    const vault = await port.teacherVault(second);
    const s2 = await bootstrapTeacherSession({
      vault,
      persistence: d.persistence,
      inProcessPara: true,
    });
    expect(s2.paraHandoff?.paraDocId).toBe(paraDocBefore);
    expect(s2.readRecords().goals.find((g) => g.goal_id === goal?.goal_id)?.goal_text).toBe(
      "Edited",
    );
    expect(s2.readRecords().students).toHaveLength(before.students.length);
    expect(s2.readParaQueue()).toHaveLength(2);
    s2.lock();
    second.lock();
  });
});

describe("synthetic seed only on a QA/synthetic build", () => {
  it("a production build sets up with an empty caseload and no in-process para device", async () => {
    const r = relay();
    const d = device();
    await runF1(d.setup(r.transport(), { synthetic: false }), await r.issueCode());
    const port = portFor(d, r.transport());
    const handle = await port.unlock(PASSPHRASE);
    const session = await bootstrapTeacherSession({
      vault: await port.teacherVault(handle),
      persistence: d.persistence,
    });
    expect(session.records.students).toHaveLength(0);
    expect(session.records.goals).toHaveLength(0);
    expect(session.readParaQueue()).toHaveLength(0);
    expect(session.paraHandoff).toBeNull();
    session.lock();
    handle.lock();
  });

  it("a synthetic build writes the caseload once, at setup", async () => {
    const r = relay();
    const d = device();
    await runF1(d.setup(r.transport(), { synthetic: true }), await r.issueCode());
    const port = portFor(d, r.transport(), true);
    const handle = await port.unlock(PASSPHRASE);
    const session = await bootstrapTeacherSession({
      vault: await port.teacherVault(handle),
      persistence: d.persistence,
      inProcessPara: true,
    });
    expect(session.records.students).toHaveLength(4);
    expect(session.readParaQueue()).toHaveLength(2);
    session.lock();
    handle.lock();
  });
});

describe('mode: "recovery" never mints an MK', () => {
  it("a second device redeeming a new code gets recovery; finish() refuses and nothing is minted", async () => {
    const r = relay();
    await runF1(device().setup(r.transport()), await r.issueCode());
    mintedMasterKeys.count = 0;

    const second = device();
    const setup = second.setup(r.transport());
    await createUnlock(setup);
    expect(await setup.redeem(await r.issueCode())).toBe("recovery");
    await expect(setup.finish()).rejects.toThrow(/master key/);
    expect(mintedMasterKeys.count).toBe(0);
    expect(await setup.device.readGrant(second.store)).toBeNull();
    const masters = (await r.store.listDevices()).flatMap((d) =>
      d.scopes.filter((s) => s.kind === "master"),
    );
    expect(new Set(masters.map((s) => s.tag)).size).toBe(1);
    setup.device.lock();
  });
});

describe("A-1: wrong and ambiguous redeems", () => {
  it("a wrong code is refused, the vault is kept, and a retry signs with the same key", async () => {
    const r = relay();
    const d = device();
    const setup = d.setup(r.transport());
    await createUnlock(setup);
    const key = (await d.store.load())?.signPk;
    expect(await setup.redeem("0000-0000-0000-0000-0000-0000-00")).toBe("refused");
    expect((await d.store.load())?.signPk).toBe(key);
    expect(await setup.redeem(await r.issueCode())).toBe("first");
    const listed = await r.store.listDevices();
    expect(listed.map((x) => x.device)).toHaveLength(1);
    setup.device.lock();
  });

  it("a redeem with no answer is never blindly retried: the list probe finds it landed", async () => {
    const r = relay();
    const d = device();
    const code = await r.issueCode();
    const dropping = d.setup(r.transport({ dropResponse: (p) => p === "/sync/enroll/redeem" }));
    await createUnlock(dropping);
    expect(await dropping.redeem(code)).toBe("offline");
    const resumed = new FirstSetup(
      {
        store: d.store,
        passkey: d.passkey,
        transport: r.transport(),
        persistence: d.persistence,
        synthetic: false,
        now: () => NOW,
      },
      dropping.device as UnlockedDevice,
    );
    expect(await resumed.redeem(code)).toBe("first");
    expect(r.sent.filter((s) => s.path === "/sync/enroll/redeem")).toHaveLength(1);
    dropping.device.lock();
  });
});

describe("A-2: an unconfirmed recovery code is replaced", () => {
  it("a new code overwrites the relay wrap; the old code no longer opens it", async () => {
    const r = relay();
    const d = device();
    const setup = d.setup(r.transport());
    await createUnlock(setup);
    await setup.redeem(await r.issueCode());
    await setup.finish();
    const old = await setup.issueRecoveryCode();
    const fresh = await setup.issueRecoveryCode();
    const wrap = parseWrap((await r.store.getRecoveryWrap()) ?? "");
    expect(() => unwrapRecoveryBundle(old, wrap)).toThrow();
    expect(unwrapRecoveryBundle(fresh, wrap).masterDocId).toBeDefined();
    expect(await setup.confirmRecoveryCode(old.split("-").slice(-2).join(""))).toBe(false);
    setup.device.lock();
  });

  it("a wrap the relay did not acknowledge yields no code and keeps recovery_pending", async () => {
    const r = relay();
    const d = device();
    const setup = d.setup(
      r.transport({ dropResponse: (p) => p === "/sync/devices/recovery-wrap" }),
    );
    await createUnlock(setup);
    await setup.redeem(await r.issueCode());
    await setup.finish();
    await expect(setup.issueRecoveryCode()).rejects.toThrow(SetupOfflineError);
    expect((await d.store.load())?.setupStage?.stage).toBe("recovery_pending");
    setup.device.lock();
  });
});

describe("offline at the self-grant", () => {
  it("finish() fails without a grant ack, stays redeemed, and a retry reuses the minted MK", async () => {
    const r = relay();
    const d = device();
    const code = await r.issueCode();
    const offline = d.setup(r.transport({ dropResponse: (p) => p === "/sync/devices/grant" }));
    await createUnlock(offline);
    await offline.redeem(code);
    await expect(offline.finish()).rejects.toThrow(SetupOfflineError);
    expect((await d.store.load())?.setupStage?.stage).toBe("redeemed");
    const grantBefore = await offline.device.readGrant(d.store);
    const retry = new FirstSetup(
      {
        store: d.store,
        passkey: d.passkey,
        transport: r.transport(),
        persistence: d.persistence,
        synthetic: false,
        now: () => NOW,
      },
      offline.device as UnlockedDevice,
    );
    retry.setLabel("School computer");
    await retry.finish();
    expect(await offline.device.readGrant(d.store)).toEqual(grantBefore);
    expect(mintedMasterKeys.count).toBe(1);
    offline.device.lock();
  });
});

describe("A-8: resume rules at open", () => {
  it("keys_created past the code's 24 h is wiped; within it, kept", async () => {
    const d = device();
    const setup = d.setup(relay().transport());
    await createUnlock(setup);
    setup.device.lock();
    expect(await readDeviceStatus(d.store, NOW + SETUP_CODE_TTL_MS - 1)).toMatchObject({
      kind: "enrolled",
      stage: "keys_created",
    });
    expect(await readDeviceStatus(d.store, NOW + SETUP_CODE_TTL_MS + 1)).toEqual({
      kind: "none",
      cleared: true,
    });
    expect(await d.store.load()).toBeNull();
  });

  it("a redeemed first setup is never wiped, however old", async () => {
    const r = relay();
    const d = device();
    const setup = d.setup(r.transport());
    await createUnlock(setup);
    await setup.redeem(await r.issueCode());
    setup.device.lock();
    expect(await readDeviceStatus(d.store, NOW + 30 * SETUP_CODE_TTL_MS)).toMatchObject({
      kind: "enrolled",
      stage: "redeemed",
    });
  });

  it("an interrupted recovery is wiped (F5 has no resume after redeem)", async () => {
    const r = relay();
    await runF1(device().setup(r.transport()), await r.issueCode());
    const d = device();
    const setup = d.setup(r.transport());
    await createUnlock(setup);
    expect(await setup.redeem(await r.issueCode())).toBe("recovery");
    setup.device.lock();
    expect(await readDeviceStatus(d.store, NOW)).toEqual({ kind: "none", cleared: true });
  });
});

describe("Tier P (a provider that returns PRF)", () => {
  it("sets up with no passphrase", async () => {
    const r = relay();
    const d = device(new Uint8Array(32).fill(5));
    const setup = d.setup(r.transport());
    expect(await createUnlock(setup)).toBe("prf");
    expect(await setup.redeem(await r.issueCode())).toBe("first");
    await setup.finish();
    expect((await d.store.load())?.tier).toBe("prf");
    setup.device.lock();
  });
});
