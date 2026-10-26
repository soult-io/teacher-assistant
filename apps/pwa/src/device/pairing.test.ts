// @vitest-environment node
//
// EU-8 (TEACH-75) — adding a teacher device by pairing, F2 E1, in process end to end
// (device-enrollment-spec rev 2.7 DN-2, §4.2, §7 and §11 EU-8, §13 A-4 and rev 2.4 EU-8;
// the FERPA and data-model conditions carried from EU-7). The real relay runs in process; a
// fake authenticator stands in for WebAuthn; each device has its own IndexedDB factory, as
// two browser profiles would. Most cases use Tier P for speed; one runs Tier W end to end.
// Node realm: libsodium rejects a foreign-realm Uint8Array.

import {
  createEnrollmentRequest,
  decodePairingSecret,
  encodePairingSecret,
  fromBase64,
  generateDeviceKeypair,
  generateSigningKeypair,
  newPairingSecret,
  pairingKey,
  pairingSid,
  sealLabelledEnrollmentRequest,
  sodiumReady,
  toBase64,
} from "@teacher-assistant/crypto";
import {
  InMemoryPersistence,
  keypairSigner,
  RelayClient,
  type Transport,
} from "@teacher-assistant/sync";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readManifest } from "../data/manifest.js";
import {
  bootstrapTeacherSession,
  openStream,
  type Session,
  teacherKeyringFromGrant,
} from "../data/session.js";
import { android, FakePasskey } from "../test/fake-passkey.js";
import { type Relay, relay } from "../test/in-process-relay.js";
import { ControlClient } from "./control-client.js";
import { browserDevicePort } from "./device-port.js";
import { DeviceStore } from "./device-store.js";
import { FirstSetup, readDeviceStatus } from "./first-setup.js";
import type { DeviceLabel } from "./passkey-prf.js";
import { MATCH_TRIES, PairingApprover, PairingJoin } from "./pairing.js";
import { PAIRING_TTL_MS } from "./pairing-limits.js";
import { memorySetupLock, SetupBusyError, type SetupLockPort } from "./setup-lock.js";
import { unlockDevice, type UnlockedDevice, WrongPassphraseError } from "./vault.js";

// Tier W steps run Argon2id MODERATE (about 2 s per call on a CI runner).
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
const ANDROID = android({ standaloneMedia: true });
const PRF_A = new Uint8Array(32).fill(7);
const PRF_B = new Uint8Array(32).fill(9);

let clock = new Date("2026-10-26T15:00:00Z").getTime();
const now = () => clock;

interface Device {
  readonly store: DeviceStore;
  readonly passkey: FakePasskey;
  readonly persistence: InMemoryPersistence;
}

function newDevice(prf: Uint8Array | null): Device {
  return {
    store: new DeviceStore(new IDBFactory()),
    passkey: new FakePasskey(prf),
    persistence: new InMemoryPersistence(),
  };
}

/** A: a finished first device (F1), unlocked, its session open and synced. */
async function trustedDevice(r: Relay, prf: Uint8Array | null = PRF_A) {
  const d = newDevice(prf);
  const setup = new FirstSetup({
    store: d.store,
    passkey: d.passkey,
    transport: r.transport(),
    persistence: d.persistence,
    synthetic: false,
    platform: ANDROID,
    now,
  });
  setup.setLabel("School computer");
  const tier = await setup.createPasskey();
  await setup.sealVault(tier === "passphrase" ? PASSPHRASE : undefined);
  expect(await setup.redeem(await r.issueCode())).toBe("first");
  await setup.finish();
  const recovery = await setup.issueRecoveryCode();
  expect(await setup.confirmRecoveryCode(recovery.split("-").slice(-2).join(""))).toBe(true);
  setup.device.lock();
  const device = await unlockDevice({
    store: d.store,
    passkey: d.passkey,
    ...(tier === "passphrase" ? { passphrase: PASSPHRASE } : {}),
  });
  const session = await openSession(d, device, r.transport());
  expect(await session.sync()).toBe(true);
  return { ...d, device, session, tier };
}

async function openSession(d: Device, device: UnlockedDevice, transport: Transport) {
  const port = browserDevicePort({
    synthetic: false,
    store: d.store,
    passkey: d.passkey,
    transport,
    persistence: d.persistence,
  });
  return bootstrapTeacherSession({
    vault: await port.teacherVault(device),
    persistence: d.persistence,
    transport,
  });
}

function approver(
  a: Device & { readonly device: UnlockedDevice; readonly session: Session },
  transport: Transport,
) {
  return new PairingApprover({
    store: a.store,
    passkey: a.passkey,
    transport,
    device: a.device,
    session: a.session,
    now,
  });
}

function joiner(b: Device, transport: Transport, setupLock: SetupLockPort = memorySetupLock()) {
  return new PairingJoin({
    store: b.store,
    passkey: b.passkey,
    transport,
    setupLock,
    platform: ANDROID,
    now,
  });
}

/** B up to the matching code: scan, name, passkey, vault. */
async function prepareB(join: PairingJoin, code: string, label: DeviceLabel = "Phone") {
  expect(join.begin(code)).toBe(true);
  join.setLabel(label);
  const tier = await join.createPasskey();
  return join.sealVault(tier === "passphrase" ? PASSPHRASE : undefined);
}

/** Open a session on A and return its square code. */
async function openCode(pa: PairingApprover): Promise<string> {
  const opened = await pa.open();
  if (opened.kind !== "open") {
    throw new Error(`open failed: ${opened.kind}`);
  }
  return opened.code;
}

function bodiesTo(r: Relay, suffix: string): string[] {
  return r.sent.filter((s) => s.path.endsWith(suffix)).map((s) => s.body);
}

beforeAll(async () => {
  await sodiumReady();
});

afterEach(() => {
  mintedMasterKeys.count = 0;
  clock = new Date("2026-10-26T15:00:00Z").getTime();
});

describe("F2 pairing, in process, end to end", () => {
  it("adds the phone: shared MK, both devices named in master, data syncs, B pulled master first", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());

    const square = await openCode(pa);
    expect(square.replace(/-/g, "")).toHaveLength(52);
    expect(square).not.toMatch(/[:/]/); // A-5: the raw secret, never a link

    const { code } = await prepareB(join, square);
    // B shows the code before anything is posted (§4.2 step 2).
    expect(bodiesTo(r, "/request-put")).toHaveLength(0);
    expect((await b.store.load())?.setupStage?.stage).toBe("pairing");

    expect(await pa.poll()).toEqual({ kind: "waiting" });
    expect(await join.postRequest()).toBe("waiting");
    expect(await pa.poll()).toEqual({ kind: "arrived", label: "Phone" });
    expect(await join.poll()).toBe("waiting");

    expect(pa.checkCode(code)).toBe("match");
    const assertionsBefore = a.passkey.assertions;
    expect(await pa.approve()).toEqual({ kind: "added", label: "Phone" });
    expect(a.passkey.assertions).toBe(assertionsBefore + 1); // the fresh unlock gesture

    expect(await join.poll()).toBe("done");
    expect((await b.store.load())?.setupStage?.stage).toBe("done");

    // The relay: B is an owner holding both of A's scopes, with their kinds.
    const listed = await r.store.listDevices();
    const bKey = toBase64(join.device.publicKey);
    const bRow = listed.find((d) => d.device === bKey);
    expect(bRow?.role).toBe("owner");
    const aRow = listed.find((d) => d.device === toBase64(a.device.publicKey));
    expect(bRow?.scopes.map((s) => [s.tag, s.kind]).sort()).toEqual(
      aRow?.scopes.map((s) => [s.tag, s.kind]).sort(),
    );
    expect(mintedMasterKeys.count).toBe(1); // only A's F1 minted an MK

    // B opens its session: master is pulled before the manifest is read (data-model, EU-7).
    const bSession = await openSession(b, join.device, r.transport());
    const bGrant = await join.device.readGrant(b.store);
    const aGrant = await a.device.readGrant(a.store);
    if (bGrant?.role !== "teacher" || aGrant?.role !== "teacher") {
      throw new Error("expected teacher grants");
    }
    expect(bGrant.grant.masterDocId).toBe(aGrant.grant.masterDocId);
    expect(bGrant.grant.masterScopeTag).toBe(aGrant.grant.masterScopeTag);
    expect(bSession.pairingScopes()).toEqual(a.session.pairingScopes());

    // Direct manifest check (data-model condition): one stream; both devices named; the
    // period key unwraps under a keyring built from B's own grant.
    const bMaster = await masterDoc(b, join.device, r.transport());
    const manifest = readManifest(bMaster);
    expect(manifest.streams.size).toBe(1);
    expect(manifest.devices.get(toBase64(a.device.publicKey))).toMatchObject({
      label: "School computer",
      role: "teacher",
    });
    expect(manifest.devices.get(bKey)).toEqual({
      label: "Phone",
      role: "teacher",
      enrolledAt: clock,
    });
    expect(manifest.periodKeys.size).toBe(1);
    expect([...manifest.periodKeys.keys()]).toEqual([...manifest.streams.keys()]);
    const keyring = teacherKeyringFromGrant(join.device.boxKeypair(), bGrant.grant);
    for (const [tag, wrapped] of manifest.periodKeys) {
      keyring.addWrappedPeriodKey(tag, fromBase64(wrapped));
      expect(keyring.hasScope(tag)).toBe(true);
    }
    keyring.destroy();

    // A record captured on B reaches A.
    await bSession.capture((doc) => doc.getMap("eu8_probe").set("from", "b"));
    expect(await bSession.sync()).toBe(true);
    expect(await a.session.sync()).toBe(true);
    const aMaster = await masterDoc(a, a.device, r.transport());
    expect(aMaster.getMap("eu8_probe").get("from")).toBe("b");

    bSession.lock();
    a.session.lock();
  });

  it("the device name reaches the relay only inside the sealed request", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    const { code } = await prepareB(join, square, "Home computer");
    await join.postRequest();
    expect((await pa.poll()).kind).toBe("arrived");
    pa.checkCode(code);
    expect((await pa.approve()).kind).toBe("added");
    expect(await join.poll()).toBe("done");

    const putBodies = bodiesTo(r, "/request-put");
    expect(putBodies).toHaveLength(1);
    expect(Object.keys(JSON.parse(putBodies[0] ?? "{}")).sort()).toEqual(["blob", "sid"]);
    for (const sent of r.sent) {
      expect(sent.body).not.toContain("Home computer");
      expect(sent.body).not.toContain("School computer");
      expect(sent.body).not.toContain("label");
      expect(sent.path).not.toContain(pairingSid(decodePairingSecret(square)));
    }
    a.session.lock();
  });

  it("Tier W: approving needs the passphrase again; a wrong one keeps the session", async () => {
    const r = relay();
    const a = await trustedDevice(r, null);
    expect(a.tier).toBe("passphrase");
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    expect(pa.checkCode(code)).toBe("match");
    await expect(pa.approve("wrong7pass")).rejects.toThrow(WrongPassphraseError);
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    expect(await pa.approve(PASSPHRASE)).toEqual({ kind: "added", label: "Phone" });
    expect(await join.poll()).toBe("done");
    a.session.lock();
  });
});

/** The device's master doc, opened from its own grant and local ciphertext. */
async function masterDoc(d: Device, device: UnlockedDevice, transport: Transport) {
  const stored = await device.readGrant(d.store);
  if (stored?.role !== "teacher") {
    throw new Error("no teacher grant");
  }
  const keyring = teacherKeyringFromGrant(device.boxKeypair(), stored.grant);
  const relayClient = new RelayClient({ transport, signer: device });
  const master = await openStream(
    stored.grant.masterDocId,
    stored.grant.masterScopeTag,
    keyring,
    relayClient,
    d.persistence,
  );
  await master.engine.sync();
  return master.stream.doc;
}

describe("A refuses before grant-put (spec §4.2 step 3, §11 EU-8)", () => {
  /** B posts a hand-made request with any label, under the real K. */
  async function postCrafted(r: Relay, code: string, label: string) {
    const secret = decodePairingSecret(code);
    const sid = pairingSid(secret);
    const key = pairingKey(secret);
    const signing = generateSigningKeypair();
    const { request } = createEnrollmentRequest({
      boxPublicKey: generateDeviceKeypair().publicKey,
      signingPublicKey: signing.publicKey,
    });
    const blob = toBase64(sealLabelledEnrollmentRequest(key, sid, request, label));
    const client = new ControlClient(
      new RelayClient({ transport: r.transport(), signer: keypairSigner(signing) }),
    );
    expect(await client.putPairingRequest(sid, blob)).toBe("ok");
  }

  for (const label of ["Laptop", "Para phone", "Para tablet"]) {
    it(`"${label}" (out of list or wrong role) is rejected and grant-put is never called`, async () => {
      const r = relay();
      const a = await trustedDevice(r);
      const pa = approver(a, r.transport());
      const square = await openCode(pa);
      await postCrafted(r, square, label);
      expect(await pa.poll()).toEqual({ kind: "interrupted" });
      expect(pa.over).toBe(true);
      expect(pa.checkCode("0000-0000-0000-0000")).toBe("stopped");
      await expect(pa.approve()).rejects.toThrow();
      expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
      a.session.lock();
    });
  }

  it("a tampered request blob fails AEAD: interrupted, no grant-put", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    // The relay hands A a request blob with one bit flipped.
    const flipping: Transport = async (req) => {
      const res = await r.transport()(req);
      if (!req.path.endsWith("/request-get") || res.status !== 200) {
        return res;
      }
      const { blob } = JSON.parse(new TextDecoder().decode(res.body)) as { blob: string };
      const bytes = fromBase64(blob);
      bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 1;
      return {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ blob: toBase64(bytes) })),
      };
    };
    const tampered = new PairingApprover({
      store: a.store,
      passkey: a.passkey,
      transport: flipping,
      device: a.device,
      session: a.session,
      now,
    });
    const square = await openCode(tampered);
    const join = joiner(b, r.transport());
    await prepareB(join, square);
    expect(await join.postRequest()).toBe("waiting");
    expect(await tampered.poll()).toEqual({ kind: "interrupted" });
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    a.session.lock();
  });
});

describe("matching code (A-4)", () => {
  it("approve is impossible until a matching code was typed", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    const assertions = a.passkey.assertions;
    await expect(pa.approve()).rejects.toThrow("type the matching code first");
    expect(a.passkey.assertions).toBe(assertions); // no unlock ceremony started
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    a.session.lock();
  });

  it("3 wrong codes stop the session: no grant-put, nothing sealed, S and K gone", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    const requestGets = bodiesTo(r, "/request-get").length;
    const wrong = code.replace(/^./, code.startsWith("0") ? "1" : "0");
    expect(MATCH_TRIES).toBe(3);
    expect(pa.checkCode(wrong)).toBe("mismatch");
    expect(pa.checkCode(wrong)).toBe("mismatch");
    expect(pa.checkCode(wrong)).toBe("stopped");
    expect(pa.over).toBe(true);
    // The right code no longer helps: the request is gone from memory.
    expect(pa.checkCode(code)).toBe("stopped");
    await expect(pa.approve()).rejects.toThrow();
    expect(await pa.poll()).toEqual({ kind: "interrupted" });
    expect(bodiesTo(r, "/request-get")).toHaveLength(requestGets); // fetched once, never again
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    // B never gets a grant: its 10 minutes run out and it discards itself.
    clock += PAIRING_TTL_MS;
    expect(await join.poll()).toBe("interrupted");
    expect(await b.store.load()).toBeNull();
    a.session.lock();
  });

  it("every try compares against the one request fetched; a typo then the right code passes", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    await pa.poll();
    expect(bodiesTo(r, "/request-get")).toHaveLength(1); // the request is fetched once
    expect(pa.checkCode("ffff-ffff-ffff-ffff")).toBe("mismatch");
    expect(pa.checkCode(code.toUpperCase().replace(/-/g, " "))).toBe("match");
    expect((await pa.approve()).kind).toBe("added");
    a.session.lock();
  });
});

describe("timeouts, cancels and locks", () => {
  it("B: a taken, expired or unknown slot is 'interrupted' and B discards its new keys", async () => {
    const r = relay();
    const b = newDevice(PRF_B);
    const join = joiner(b, r.transport());
    // A code that was never opened on the relay.
    const unknown = encodePairingSecret(newPairingSecret());
    await prepareB(join, unknown);
    expect(await b.store.load()).not.toBeNull();
    expect(await join.postRequest()).toBe("interrupted");
    expect(await b.store.load()).toBeNull();
    expect(() => join.device).toThrow();
  });

  it("A: past 10 minutes the session is over ('Time ran out')", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    expect((await pa.open()).kind).toBe("open");
    clock += PAIRING_TTL_MS;
    expect(await pa.poll()).toEqual({ kind: "expired" });
    expect(pa.over).toBe(true);
    a.session.lock();
  });

  it("A: abandon (a lock or Cancel) ends the session; nothing more is fetched or granted", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    await prepareB(join, square);
    await join.postRequest();
    pa.abandon();
    expect(await pa.poll()).toEqual({ kind: "interrupted" });
    expect(bodiesTo(r, "/request-get")).toHaveLength(0);
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    a.session.lock();
  });

  it("A: a lock during the approve's unlock ceremony grants nothing", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const join = joiner(b, r.transport());
    let pa: PairingApprover | null = null;
    const passkey = {
      create: a.passkey.create.bind(a.passkey),
      assert: async (id: Uint8Array) => {
        pa?.abandon(); // the App's lock lands while the passkey prompt is up
        return a.passkey.assert(id);
      },
    };
    pa = new PairingApprover({
      store: a.store,
      passkey,
      transport: r.transport(),
      device: a.device,
      session: a.session,
      now,
    });
    const square = await openCode(pa);
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    expect(pa.checkCode(code)).toBe("match");
    expect(await pa.approve()).toEqual({ kind: "interrupted" });
    expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
    a.session.lock();
  });

  // FERPA gate B-1: abandon() zeroizes K in place. A lock that lands during any wait after
  // the fresh unlock must stop the grant: no seal under a zeroed K, no grant-put.
  for (const during of ["the grant read", "the name write"] as const) {
    it(`A: a lock during ${during} sends nothing`, async () => {
      const r = relay();
      const a = await trustedDevice(r);
      const b = newDevice(PRF_B);
      const join = joiner(b, r.transport());
      let pa: PairingApprover | null = null;
      let armed = false;
      const passkey = {
        create: a.passkey.create.bind(a.passkey),
        assert: async (id: Uint8Array) => {
          const result = await a.passkey.assert(id);
          armed = true; // the fresh unlock has its gesture; what follows is #grant
          return result;
        },
      };
      const load = a.store.load.bind(a.store);
      a.store.load = async () => {
        if (armed && during === "the grant read") {
          pa?.abandon(); // the App's lock lands while readGrant waits on IndexedDB
        }
        return load();
      };
      let named = 0;
      const session = {
        pairingScopes: () => a.session.pairingScopes(),
        addDevice: async (...args: Parameters<Session["addDevice"]>) => {
          named += 1;
          if (during === "the name write") {
            pa?.abandon(); // the lock lands while the name is being written
          }
          await a.session.addDevice(...args);
        },
      };
      pa = new PairingApprover({
        store: a.store,
        passkey,
        transport: r.transport(),
        device: a.device,
        session,
        now,
      });
      const square = await openCode(pa);
      const { code } = await prepareB(join, square);
      await join.postRequest();
      await pa.poll();
      expect(pa.checkCode(code)).toBe("match");
      expect(await pa.approve()).toEqual({ kind: "interrupted" });
      expect(bodiesTo(r, "/grant-put")).toHaveLength(0);
      // A lock during the grant read stops before the name is written, too.
      expect(named).toBe(during === "the grant read" ? 0 : 1);
      a.session.lock();
    });
  }

  it("A: an open() abandoned while the relay answers keeps no secret and reports over", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    let pa: PairingApprover | null = null;
    const transport: Transport = async (req) => {
      const res = await r.transport()(req);
      if (req.path.endsWith("/pairing/open")) {
        pa?.abandon(); // a lock or Cancel while the open call was out
      }
      return res;
    };
    pa = new PairingApprover({
      store: a.store,
      passkey: a.passkey,
      transport,
      device: a.device,
      session: a.session,
      now,
    });
    expect(await pa.open()).toEqual({ kind: "offline" });
    expect(pa.over).toBe(true);
    expect(await pa.poll()).toEqual({ kind: "interrupted" });
    expect(bodiesTo(r, "/request-get")).toHaveLength(0);
    a.session.lock();
  });

  it("A: approve runs once at a time", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const b = newDevice(PRF_B);
    const pa = approver(a, r.transport());
    const join = joiner(b, r.transport());
    const square = await openCode(pa);
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    pa.checkCode(code);
    const first = pa.approve();
    await expect(pa.approve()).rejects.toThrow("already running");
    expect((await first).kind).toBe("added");
    expect(bodiesTo(r, "/grant-put")).toHaveLength(1);
    a.session.lock();
  });

  it("B: request-put goes out once, however often it is asked (an effect re-run)", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const join = joiner(b, r.transport());
    await prepareB(join, square);
    const [one, two] = await Promise.all([join.postRequest(), join.postRequest()]);
    expect([one, two, await join.postRequest()]).toEqual(["waiting", "waiting", "waiting"]);
    expect(bodiesTo(r, "/request-put")).toHaveLength(1);
    expect(await b.store.load()).not.toBeNull();
    a.session.lock();
  });

  it("B: a request-put with no answer keeps waiting (it may have landed), and pairs if it did", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const join = joiner(b, r.transport({ dropResponse: (path) => path.endsWith("/request-put") }));
    const { code } = await prepareB(join, square);
    expect(await join.postRequest()).toBe("waiting");
    expect(await b.store.load()).not.toBeNull();
    await pa.poll();
    pa.checkCode(code);
    expect((await pa.approve()).kind).toBe("added");
    expect(await join.poll()).toBe("done");
    a.session.lock();
  });

  it("B: a discard (lock or cancel) wipes the half-made device and releases the setup lock", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const lock = memorySetupLock();
    const join = joiner(b, r.transport(), lock);
    await prepareB(join, square);
    expect(await lock.held()).toBe(true);
    await join.discard();
    expect(await b.store.load()).toBeNull();
    expect(await lock.held()).toBe(false);
    expect(await join.postRequest()).toBe("interrupted");
    a.session.lock();
  });

  it("B: a square code that does not decode is refused before anything is made", () => {
    const b = newDevice(PRF_B);
    const join = joiner(b, relay().transport());
    expect(join.begin("not a code")).toBe(false);
  });
});

describe("two setups or pairings at the same time (TEACH-75 decision)", () => {
  it("two new devices on one square code: the first wins, the second is interrupted and wiped", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b1 = newDevice(PRF_B);
    const b2 = newDevice(new Uint8Array(32).fill(3));
    const j1 = joiner(b1, r.transport());
    const j2 = joiner(b2, r.transport());
    const first = await prepareB(j1, square);
    const second = await prepareB(j2, square, "Tablet");
    expect(await j1.postRequest()).toBe("waiting");
    expect(await j2.postRequest()).toBe("interrupted");
    expect(await b2.store.load()).toBeNull();
    // A sees only the first device; the second device's code never matches it.
    expect(await pa.poll()).toEqual({ kind: "arrived", label: "Phone" });
    expect(pa.checkCode(second.code)).toBe("mismatch");
    expect(pa.checkCode(first.code)).toBe("match");
    expect((await pa.approve()).kind).toBe("added");
    expect(await j1.poll()).toBe("done");
    a.session.lock();
  });

  it("the relay holds at most 3 open pairings: a 4th open is 'too_many'", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    for (let i = 0; i < 3; i += 1) {
      expect((await approver(a, r.transport()).open()).kind).toBe("open");
    }
    expect(await approver(a, r.transport()).open()).toEqual({ kind: "too_many" });
    a.session.lock();
  });

  it("an approver opens once: a second open on the same session is refused", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    expect((await pa.open()).kind).toBe("open");
    await expect(pa.open()).rejects.toThrow("opens once");
    a.session.lock();
  });

  it("one profile, two windows: the second window cannot start a passkey while the first pairs", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const lock = memorySetupLock(); // one profile: both windows see the same lock
    const window1 = joiner(b, r.transport(), lock);
    const window2 = joiner(b, r.transport(), lock);
    await prepareB(window1, square);
    expect(window2.begin(square)).toBe(true);
    window2.setLabel("Tablet");
    await expect(window2.createPasskey()).rejects.toThrow(SetupBusyError);
    expect(b.passkey.names).toHaveLength(1); // no second, orphan passkey
    // The second window's status read leaves the live pairing alone.
    expect(await readDeviceStatus(b.store, now(), lock)).toEqual({ kind: "busy" });
    expect(await b.store.load()).not.toBeNull();
    a.session.lock();
  });

  it("a pairing no window runs any more (closed or crashed) is wiped at the next open", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const lock = memorySetupLock();
    await prepareB(joiner(b, r.transport(), lock), square);
    const crashed = memorySetupLock(); // the browser released the dead window's lock
    expect(await readDeviceStatus(b.store, now(), crashed)).toEqual({
      kind: "none",
      cleared: true,
      pairing: true,
    });
    expect(await b.store.load()).toBeNull();
    a.session.lock();
  });

  it("first setup takes the same lock: pairing in a second window waits for it", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const lock = memorySetupLock();
    const f1 = new FirstSetup({
      store: b.store,
      passkey: b.passkey,
      transport: r.transport(),
      persistence: b.persistence,
      synthetic: false,
      platform: ANDROID,
      now,
      setupLock: lock,
    });
    f1.setLabel("Phone");
    await f1.createPasskey();
    const join = joiner(b, r.transport(), lock);
    join.begin(square);
    join.setLabel("Phone");
    await expect(join.createPasskey()).rejects.toThrow(SetupBusyError);
    f1.end();
    expect(await lock.held()).toBe(false);
    a.session.lock();
  });

  it("two first devices set up at once with two codes: one mints the MK, the other is recovery", async () => {
    const r = relay();
    const devices = [newDevice(PRF_A), newDevice(PRF_B)];
    const setups = devices.map(
      (d) =>
        new FirstSetup({
          store: d.store,
          passkey: d.passkey,
          transport: r.transport(),
          persistence: d.persistence,
          synthetic: false,
          platform: ANDROID,
          now,
        }),
    );
    for (const setup of setups) {
      setup.setLabel("School computer");
      await setup.createPasskey();
      await setup.sealVault();
    }
    const codes = [await r.issueCode(), await r.issueCode()];
    const modes = await Promise.all(setups.map((s, i) => s.redeem(codes[i] ?? "")));
    expect([...modes].sort()).toEqual(["first", "recovery"]);
    const firstIndex = modes.indexOf("first");
    await setups[firstIndex]?.finish();
    await expect(setups[1 - firstIndex]?.finish()).rejects.toThrow(
      "only a first-device redeem can mint the master key",
    );
    expect(mintedMasterKeys.count).toBe(1);
    const masters = (await r.store.listDevices()).flatMap((d) =>
      d.scopes.filter((s) => s.kind === "master"),
    );
    expect(new Set(masters.map((s) => s.tag)).size).toBe(1);
  });
});

describe("the pairing record", () => {
  it("B's record holds no secret: no S, K, sid, code or name in any field", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const join = joiner(b, r.transport());
    const { code } = await prepareB(join, square);
    const record = await b.store.load();
    const text = JSON.stringify(record, (_k, v: unknown) =>
      v instanceof Uint8Array ? toBase64(v) : v,
    );
    const secret = decodePairingSecret(square);
    for (const needle of [
      square,
      square.replace(/-/g, ""),
      toBase64(secret),
      toBase64(pairingKey(secret)),
      pairingSid(secret),
      code,
      "Phone",
    ]) {
      expect(text).not.toContain(needle);
    }
    expect(Object.keys(record?.setupStage ?? {}).sort()).toEqual(["at", "stage"]);
    a.session.lock();
  });

  it("a stored grant and stage `done` land in one record write", async () => {
    const r = relay();
    const a = await trustedDevice(r);
    const pa = approver(a, r.transport());
    const square = await openCode(pa);
    const b = newDevice(PRF_B);
    const writes: unknown[] = [];
    const update = b.store.update.bind(b.store);
    b.store.update = async (change) => {
      const next = await update(change);
      writes.push({ grant: next.grant !== undefined, stage: next.setupStage?.stage });
      return next;
    };
    const join = joiner(b, r.transport());
    const { code } = await prepareB(join, square);
    await join.postRequest();
    await pa.poll();
    pa.checkCode(code);
    await pa.approve();
    expect(await join.poll()).toBe("done");
    expect(writes).toContainEqual({ grant: true, stage: "done" });
    expect(writes).not.toContainEqual({ grant: true, stage: "pairing" });
    a.session.lock();
  });
});
