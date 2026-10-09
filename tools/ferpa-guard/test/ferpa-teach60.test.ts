// FERPA-guard — TEACH-60 (EU-4, device-enrollment spec §4.2, §4.3, §5.3, §5.5,
// §5.6, §11 EU-4, rev 2.2 change log). The pairing mailbox routes — open,
// request-put, request-get, grant-put, grant-get — driven with signed requests
// and the real crypto layer:
// - a full E1 handshake (teacher, then para) through inject: B ends up holding
//   MK (or only the period DEK) and reads its streams;
// - the grant JSON never crosses the relay bare: no request, response, store
//   argument or log line carries it, and the relay refuses a bare-JSON blob;
// - sid is never in a URL: no pairing route has a path parameter;
// - first write wins; the grant goes only to the recorded request signer (a
//   wrong signer gets 404; `device ≠ request signer` gets 409);
// - a para pairing is a member with period kind only (para + master is 409);
// - a taken slot is 404; a blob over 4 KiB is 413; TTL 10 minutes, swept on
//   every control route;
// - 30/min per trusted client IP on the pairing routes (grant-get polling);
// - the identical 404 preamble; strict bodies (lower-case UUID tags);
// - no sid, key, tag, blob or request value in any log line (4xx incl. 409, 5xx);
// - static: only packages/crypto reaches sealScopeKeyToDevice, and outside it no
//   code seals or opens a pairing blob except through the typed helpers.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  completeDeviceEnrollment,
  completeParaEnrollment,
  createEnrollmentRequest,
  fromBase64,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  newPairingSecret,
  openEnrollmentRequest,
  openParaGrant,
  openTeacherGrant,
  pairingKey,
  pairingSid,
  ParaKeyring,
  sealEnrollmentRequest,
  sealParaGrant,
  sealTeacherGrant,
  sodiumReady,
  TeacherKeyring,
  toBase64,
  utf8,
} from "@teacher-assistant/crypto";
import { newOpaqueId, newScopeTag, SYNC_HEADERS, type ScopeTag } from "@teacher-assistant/schema";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";
import { collectFiles, fileContains, scanCodeForPattern } from "../src/checks.js";
import { containsBytes } from "./bytes.js";
import { expectCleanLogs } from "./relay-logs.js";
import { makeSigner, type Signer } from "./relay-signer.js";

beforeAll(async () => {
  await sodiumReady();
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const OPEN = "/sync/enroll/pairing/open";
const REQUEST_PUT = "/sync/enroll/pairing/request-put";
const REQUEST_GET = "/sync/enroll/pairing/request-get";
const GRANT_PUT = "/sync/enroll/pairing/grant-put";
const GRANT_GET = "/sync/enroll/pairing/grant-get";
const PAIRING_ROUTES = [OPEN, REQUEST_PUT, REQUEST_GET, GRANT_PUT, GRANT_GET] as const;
type PairingRoute = (typeof PAIRING_ROUTES)[number];

const NPM_PEER = "172.18.0.15";
const TRUST = ["172.18.0.0/16"];
const CLIENT_IP = "203.0.113.60";
const ERR_MSG = "ERRMSG_T60_SENTINEL";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Req {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  payload?: Buffer;
  remoteAddress: string;
}

/** A signed control request (scope `control` unless overridden). */
function control(
  signer: Signer,
  url: string,
  body: unknown,
  scope = "control",
  ip = CLIENT_IP,
): Req {
  const raw = utf8(typeof body === "string" ? body : JSON.stringify(body));
  return {
    method: "POST",
    url,
    headers: { ...signer.sign("POST", url, scope, raw), "x-forwarded-for": ip },
    payload: Buffer.from(raw),
    remoteAddress: NPM_PEER,
  };
}

/** A signed data-route request for `doc` under `scope`. */
function data(
  signer: Signer,
  method: "GET" | "POST",
  scope: string,
  doc: string,
  updates?: string[],
): Req {
  const url = `/sync/${doc}`;
  const raw = method === "POST" ? utf8(JSON.stringify({ updates })) : new Uint8Array(0);
  return {
    method,
    url,
    headers: { ...signer.sign(method, url, scope, raw), "x-forwarded-for": CLIENT_IP },
    ...(method === "POST" ? { payload: Buffer.from(raw) } : {}),
    remoteAddress: NPM_PEER,
  };
}

/** Every request value that must never reach a log line. */
function requestValues(req: Req): string[] {
  return [
    req.headers[SYNC_HEADERS.device] as string,
    req.headers[SYNC_HEADERS.nonce] as string,
    req.headers[SYNC_HEADERS.signature] as string,
    CLIENT_IP,
  ].filter((v) => v !== undefined);
}

/** A response with record_id removed, plus the headers a client could compare. */
function shape(res: { statusCode: number; json(): unknown; headers: Record<string, unknown> }) {
  const body = res.json() as Record<string, unknown>;
  expect(body.record_id).toMatch(UUID);
  const { record_id: _drop, ...rest } = body;
  return {
    status: res.statusCode,
    body: rest,
    type: res.headers["content-type"],
    length: res.headers["content-length"],
  };
}

/**
 * The store, with every argument it is handed recorded — what the relay could
 * persist or act on. The grant must reach it only as an opaque blob.
 */
function recording(store: RelayStore): { store: RelayStore; seen: string[] } {
  const seen: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        seen.push(JSON.stringify(args));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, seen };
}

let codeSeq = 0;

async function enrollOwner(store: RelayStore, signer: Signer): Promise<void> {
  const hash = `seed-${++codeSeq}`;
  await store.issueOwnerCode(hash, new Date("9999-01-01T00:00:00Z"));
  expect(await store.redeemOwnerCode(hash, signer.publicKeyB64)).not.toBe("refused");
}

/**
 * Teacher device A: an active owner holding master M and period P, with its
 * keyring. `traffic` collects every request and response body that crosses the relay.
 */
async function deployment(base: RelayStore = new InMemoryRelayStore()) {
  const { store, seen } = recording(base);
  const lines: string[] = [];
  const app = buildApp(store, {
    trustProxy: TRUST,
    logStream: { write: (l: string) => void lines.push(l) },
  });
  const a = makeSigner();
  const master = newScopeTag();
  const period = generatePeriodKey(newScopeTag());
  const keyring = new TeacherKeyring(master, generateMasterKey());
  keyring.addPeriodKey(period);
  await enrollOwner(store, a);
  expect(
    await store.grantScopes(a.publicKeyB64, [
      { tag: master, kind: "master" },
      { tag: period.scopeTag, kind: "period" },
    ]),
  ).toBe("ok");
  const traffic: string[] = [];
  const urls: string[] = [];
  const send = async (req: Req) => {
    urls.push(req.url);
    traffic.push(req.payload?.toString("utf8") ?? "");
    const res = await app.inject(req);
    traffic.push(res.body);
    return res;
  };
  return { app, store, seen, lines, a, master, period, keyring, traffic, urls, send };
}

type Deployment = Awaited<ReturnType<typeof deployment>>;

/** New device B: its box keypair, its signer (relay identity), and its pairing request. */
function newDevice() {
  const box = generateDeviceKeypair();
  const signer = makeSigner();
  const { request, verificationCode } = createEnrollmentRequest({
    boxPublicKey: box.publicKey,
    signingPublicKey: fromBase64(signer.publicKeyB64),
  });
  return { box, signer, request, verificationCode };
}

/** Steps 1–3 of F2: A opens, B posts its sealed request, A reads and opens it. */
async function openAndRequest(env: Deployment) {
  const secret = newPairingSecret();
  const sid = pairingSid(secret);
  const key = pairingKey(secret);
  const b = newDevice();
  expect((await env.send(control(env.a, OPEN, { sid }))).statusCode).toBe(200);
  const requestBlob = toBase64(sealEnrollmentRequest(key, sid, b.request));
  const put = await env.send(control(b.signer, REQUEST_PUT, { sid, blob: requestBlob }));
  expect(put.statusCode).toBe(200);
  expect(put.json()).toEqual({});
  const got = await env.send(control(env.a, REQUEST_GET, { sid }));
  expect(got.statusCode).toBe(200);
  const opened = openEnrollmentRequest(key, sid, fromBase64((got.json() as { blob: string }).blob));
  // The request A opened names B's relay identity: the key that signed request-put.
  expect(opened.signingPublicKeyB64).toBe(b.signer.publicKeyB64);
  return { sid, key, b, opened, requestBlob };
}

/** Everything that must never cross the relay bare for this grant. */
function grantSecrets(grant: object): string[] {
  return [JSON.stringify(grant), ...Object.values(grant).filter((v) => !UUID.test(v as string))];
}

describe("TEACH-60 — full E1 handshake through the relay (inject)", () => {
  it("teacher: B gets MK sealed to it, becomes an owner, and reads A's master stream", async () => {
    const env = await deployment();
    const { sid, key, b, opened, requestBlob } = await openAndRequest(env);
    const masterDocId = newOpaqueId();

    const grant = approveDeviceEnrollment(env.keyring, opened, b.verificationCode, masterDocId);
    const grantBlob = toBase64(sealTeacherGrant(key, sid, grant));
    const put = await env.send(
      control(env.a, GRANT_PUT, {
        sid,
        device: opened.signingPublicKeyB64,
        role: "teacher",
        scopes: [
          { tag: env.master, kind: "master" },
          { tag: env.period.scopeTag, kind: "period" },
        ],
        blob: grantBlob,
      }),
    );
    expect(put.statusCode).toBe(200);
    expect(await env.store.deviceRole(b.signer.publicKeyB64)).toBe("owner");

    const got = await env.send(control(b.signer, GRANT_GET, { sid }));
    expect(got.statusCode).toBe(200);
    const received = openTeacherGrant(key, sid, fromBase64((got.json() as { blob: string }).blob));
    expect(received).toEqual(grant);
    const { mk, masterScopeTag } = completeDeviceEnrollment(b.box, received);
    const bKeyring = new TeacherKeyring(masterScopeTag, mk);

    // A writes to the master doc; B pulls and decrypts it.
    const aad = utf8(masterDocId);
    const update = toBase64(env.keyring.sealUpdate(env.master, aad, utf8("synthetic")));
    const push = await env.send(data(env.a, "POST", env.master, masterDocId, [update]));
    expect(push.statusCode).toBe(200);
    const pull = await env.send(data(b.signer, "GET", env.master, masterDocId));
    expect(pull.statusCode).toBe(200);
    const [blob] = (pull.json() as { updates: string[] }).updates;
    expect(
      new TextDecoder().decode(bKeyring.openUpdate(env.master, aad, fromBase64(blob as string))),
    ).toBe("synthetic");

    // The session is gone: a second grant-get is the 404.
    expect((await env.send(control(b.signer, GRANT_GET, { sid }))).statusCode).toBe(404);

    // The grant JSON never crossed the relay bare (requests, responses, store
    // arguments, logs); B's box key and nonce only inside the sealed request.
    const bare = [
      ...grantSecrets(grant),
      b.request.devicePublicKeyB64,
      b.request.nonceB64,
      JSON.stringify(b.request),
    ];
    for (const value of bare) {
      expect(env.traffic.join("\n")).not.toContain(value);
      expect(env.seen.join("\n")).not.toContain(value);
    }
    expectCleanLogs(env.lines, [...bare, sid, grantBlob, requestBlob, b.signer.publicKeyB64]);
    // The blobs the relay held decode to ciphertext with no grant field in it.
    for (const blob of [grantBlob, requestBlob]) {
      for (const value of bare) {
        expect(containsBytes(fromBase64(blob), utf8(value))).toBe(false);
      }
    }
    // sid never in a URL: every request went to a bare route.
    expect(env.urls.filter((u) => u.includes(sid))).toEqual([]);
  });

  it("para: B becomes a member holding only the period DEK; master stays 404", async () => {
    const env = await deployment();
    const { sid, key, b, opened } = await openAndRequest(env);
    const paraDocId = newOpaqueId();
    const grant = approveParaEnrollment(
      env.keyring,
      env.period.scopeTag,
      opened,
      b.verificationCode,
      paraDocId,
    );
    const blob = toBase64(sealParaGrant(key, sid, grant));
    const body = {
      sid,
      device: opened.signingPublicKeyB64,
      role: "para",
      scopes: [{ tag: env.period.scopeTag, kind: "period" }],
      blob,
    };
    // Para + master kind is 409 and enrolls nothing.
    for (const scopes of [
      [{ tag: env.master, kind: "master" }],
      [...body.scopes, { tag: env.master, kind: "master" }],
    ]) {
      const res = await env.send(control(env.a, GRANT_PUT, { ...body, scopes }));
      expect(res.statusCode).toBe(409);
      expect(shape(res).body).toEqual({ error: "conflict" });
    }
    expect(await env.store.deviceRole(b.signer.publicKeyB64)).toBeUndefined();

    expect((await env.send(control(env.a, GRANT_PUT, body))).statusCode).toBe(200);
    expect(await env.store.deviceRole(b.signer.publicKeyB64)).toBe("member");
    const got = await env.send(control(b.signer, GRANT_GET, { sid }));
    const received = openParaGrant(key, sid, fromBase64((got.json() as { blob: string }).blob));
    const dek = completeParaEnrollment(b.box, received);
    expect(new ParaKeyring([dek]).scopes()).toEqual([env.period.scopeTag]);
    // A teacher-grant reader refuses the para blob.
    expect(() => openTeacherGrant(key, sid, fromBase64(blob))).toThrow();

    expect((await env.send(data(b.signer, "GET", env.period.scopeTag, paraDocId))).statusCode).toBe(
      200,
    );
    expect((await env.send(data(b.signer, "GET", env.master, newOpaqueId()))).statusCode).toBe(404);
    for (const value of grantSecrets(grant)) {
      expect(env.traffic.join("\n")).not.toContain(value);
      expect(env.seen.join("\n")).not.toContain(value);
    }
  });
});

describe("TEACH-60 — the grant goes only to the recorded request signer", () => {
  it("first write wins: a second request-put (any key, B included) is 404 and changes nothing", async () => {
    const env = await deployment();
    const { sid, requestBlob, b } = await openAndRequest(env);
    for (const signer of [makeSigner(), b.signer, env.a]) {
      const res = await env.send(control(signer, REQUEST_PUT, { sid, blob: "b3RoZXI" }));
      expect(res.statusCode).toBe(404);
    }
    const got = await env.send(control(env.a, REQUEST_GET, { sid }));
    expect((got.json() as { blob: string }).blob).toBe(requestBlob);
  });

  it("device ≠ request signer → 409; a wrong signer on request-get, grant-put or grant-get → 404", async () => {
    const env = await deployment();
    const { sid, key, b, opened } = await openAndRequest(env);
    const other = makeSigner();
    const otherOwner = makeSigner();
    await enrollOwner(env.store, otherOwner);
    const grant = approveDeviceEnrollment(env.keyring, opened, b.verificationCode, newOpaqueId());
    const body = {
      sid,
      device: b.signer.publicKeyB64,
      role: "teacher",
      scopes: [{ tag: env.master, kind: "master" }],
      blob: toBase64(sealTeacherGrant(key, sid, grant)),
    };

    const mismatch = await env.send(
      control(env.a, GRANT_PUT, { ...body, device: other.publicKeyB64 }),
    );
    expect(mismatch.statusCode).toBe(409);
    expect(shape(mismatch).body).toEqual({ error: "conflict" });
    expect(await env.store.deviceRole(other.publicKeyB64)).toBeUndefined();

    // Not the opener: another owner gets the 404 on A's session.
    expect((await env.send(control(otherOwner, REQUEST_GET, { sid }))).statusCode).toBe(404);
    expect((await env.send(control(otherOwner, GRANT_PUT, body))).statusCode).toBe(404);
    expect(await env.store.deviceRole(b.signer.publicKeyB64)).toBeUndefined();

    expect((await env.send(control(env.a, GRANT_PUT, body))).statusCode).toBe(200);
    // Not the request signer: the opener, another owner, a stranger.
    for (const signer of [env.a, otherOwner, other]) {
      expect((await env.send(control(signer, GRANT_GET, { sid }))).statusCode).toBe(404);
    }
    // A second grant-put for the same session is the 404 (already granted).
    expect((await env.send(control(env.a, GRANT_PUT, body))).statusCode).toBe(404);
    expect((await env.send(control(b.signer, GRANT_GET, { sid }))).statusCode).toBe(200);
  });

  it("taken, unknown and expired sessions are 404; a blob over 4 KiB is 413", async () => {
    let t = Date.parse("2026-10-09T12:00:00Z");
    const env = await deployment(new InMemoryRelayStore({ now: () => new Date(t) }));
    const sid = pairingSid(newPairingSecret());
    const unknown = pairingSid(newPairingSecret());
    const b = makeSigner();

    expect((await env.send(control(env.a, OPEN, { sid }))).statusCode).toBe(200);
    // Taken: a second open of the same sid.
    expect((await env.send(control(env.a, OPEN, { sid }))).statusCode).toBe(404);
    for (const route of [REQUEST_GET, GRANT_GET] as const) {
      expect((await env.send(control(env.a, route, { sid: unknown }))).statusCode).toBe(404);
    }
    expect(
      (await env.send(control(b, REQUEST_PUT, { sid: unknown, blob: "cmVx" }))).statusCode,
    ).toBe(404);

    const big = await env.send(control(b, REQUEST_PUT, { sid, blob: "A".repeat(4097) }));
    expect(big.statusCode).toBe(413);
    expect(shape(big).body).toEqual({ error: "payload_too_large" });
    expect(
      (await env.send(control(b, REQUEST_PUT, { sid, blob: "A".repeat(4096) }))).statusCode,
    ).toBe(200);
    const bigGrant = await env.send(
      control(env.a, GRANT_PUT, {
        sid,
        device: b.publicKeyB64,
        role: "teacher",
        scopes: [{ tag: env.master, kind: "master" }],
        blob: "A".repeat(4097),
      }),
    );
    expect(bigGrant.statusCode).toBe(413);
    expect(await env.store.deviceRole(b.publicKeyB64)).toBeUndefined();

    // TTL 10 minutes: one millisecond past it, every step is the 404.
    t += 10 * 60_000;
    expect((await env.send(control(env.a, REQUEST_GET, { sid }))).statusCode).toBe(404);
    t -= 10 * 60_000;
    // The sweep on that route deleted it: back inside the window, it is still gone.
    expect((await env.send(control(env.a, REQUEST_GET, { sid }))).statusCode).toBe(404);
    expect((await env.send(control(env.a, OPEN, { sid }))).statusCode).toBe(200);
  });
});

describe("TEACH-60 — identical 404 preamble, strict bodies, no path parameters", () => {
  it("unsigned, bad signature, a data scope, and a non-owner on owner routes: all the identical 404", async () => {
    const env = await deployment();
    const stranger = makeSigner();
    const { sid } = await openAndRequest(env);
    const revoked = makeSigner();
    await enrollOwner(env.store, revoked);
    expect(await env.store.revoke(revoked.publicKeyB64)).toBe("ok");

    const reference = shape(await env.app.inject(control(env.a, "/sync/enroll/pairing/nope", {})));
    expect(reference).toMatchObject({ status: 404, body: { error: "not_found" } });

    const bodies: Record<PairingRoute, unknown> = {
      [OPEN]: { sid: pairingSid(newPairingSecret()) },
      [REQUEST_PUT]: { sid, blob: "cmVx" },
      [REQUEST_GET]: { sid },
      [GRANT_PUT]: {
        sid,
        device: stranger.publicKeyB64,
        role: "para",
        scopes: [{ tag: env.period.scopeTag, kind: "period" }],
        blob: "Z3JhbnQ",
      },
      [GRANT_GET]: { sid },
    };
    for (const route of PAIRING_ROUTES) {
      const body = bodies[route];
      const callers: [string, () => Req][] = [
        [
          "bad signature",
          () => {
            const r = control(env.a, route, body);
            return { ...r, headers: { ...r.headers, [SYNC_HEADERS.signature]: "AAAA" } };
          },
        ],
        [
          "unsigned",
          () => ({
            method: "POST",
            url: route,
            headers: { "content-type": "application/json" },
            payload: Buffer.from(JSON.stringify(body)),
            remoteAddress: NPM_PEER,
          }),
        ],
        ["owner, data scope", () => control(env.a, route, body, env.period.scopeTag)],
      ];
      if (route === OPEN || route === REQUEST_GET || route === GRANT_PUT) {
        callers.push(
          ["unknown key", () => control(stranger, route, body)],
          ["revoked owner", () => control(revoked, route, body)],
          // A malformed body from a non-owner is still the 404, never the 400.
          ["non-owner, malformed body", () => control(stranger, route, { label: "Para phone" })],
        );
      }
      for (const [name, make] of callers) {
        expect(shape(await env.app.inject(make())), `${route} ${name}`).toEqual(reference);
      }
    }
    expect(await env.store.deviceRole(stranger.publicKeyB64)).toBeUndefined();
  });

  it("strict bodies: an unknown field, a label, a bad sid or an upper-case tag is 400", async () => {
    const env = await deployment();
    const { sid, b } = await openAndRequest(env);
    const scope = { tag: env.period.scopeTag, kind: "period" };
    const grant = {
      sid,
      device: b.signer.publicKeyB64,
      role: "para",
      scopes: [scope],
      blob: "Z3JhbnQ",
    };
    const bad: [PairingRoute, Signer, unknown][] = [
      [OPEN, env.a, { sid: pairingSid(newPairingSecret()), label: "Laptop" }],
      [OPEN, env.a, { sid: sid.toUpperCase() }],
      [OPEN, env.a, { sid: "3rd period" }],
      [OPEN, env.a, {}],
      [REQUEST_PUT, b.signer, { sid, blob: "cmVx", label: "Para phone" }],
      [REQUEST_PUT, b.signer, { sid, blob: '{"devicePublicKeyB64":"x"}' }],
      [REQUEST_GET, env.a, { sid, extra: 1 }],
      [GRANT_PUT, env.a, { ...grant, label: "Para phone" }],
      [GRANT_PUT, env.a, { ...grant, scopes: [{ ...scope, label: "3rd period" }] }],
      [GRANT_PUT, env.a, { ...grant, scopes: [{ ...scope, tag: scope.tag.toUpperCase() }] }],
      [GRANT_PUT, env.a, { ...grant, scopes: [{ tag: "P3 - J.S. IEP", kind: "period" }] }],
      [GRANT_PUT, env.a, { ...grant, role: "member" }],
      // A bare grant JSON as the blob: the relay never carries one.
      [GRANT_PUT, env.a, { ...grant, blob: JSON.stringify({ wrappedDekB64: "x" }) }],
      [GRANT_PUT, env.a, { ...grant, blob: { wrappedDekB64: "x" } }],
      [GRANT_GET, b.signer, { sid, device: b.signer.publicKeyB64 }],
    ];
    for (const [route, signer, body] of bad) {
      const res = await env.app.inject(control(signer, route, body));
      expect(res.statusCode, `${route} ${JSON.stringify(body).slice(0, 80)}`).toBe(400);
      expect(shape(res).body).toEqual({ error: "bad_request" });
    }
    expect(await env.store.deviceRole(b.signer.publicKeyB64)).toBeUndefined();
  });

  it("no pairing route has a path parameter: an id in the URL is an unknown route", async () => {
    const env = await deployment();
    const { sid } = await openAndRequest(env);
    for (const route of PAIRING_ROUTES) {
      for (const url of [`${route}/${sid}`, `/sync/enroll/pairing/${sid}`]) {
        expect((await env.app.inject(control(env.a, url, { sid }))).statusCode, url).toBe(404);
      }
    }
  });
});

describe("TEACH-60 — sweep and rate limit", () => {
  it("each pairing route calls sweepExpired once, after the preamble, before it acts", async () => {
    const base = new InMemoryRelayStore();
    const order: string[] = [];
    const spy = Object.assign(base, {
      sweepExpired: async () => {
        order.push("sweep");
        return InMemoryRelayStore.prototype.sweepExpired.call(base);
      },
    });
    const env = await deployment(spy);
    order.length = 0;
    const { sid, b } = await openAndRequest(env);
    expect(order).toEqual(["sweep", "sweep", "sweep"]); // open, request-put, request-get
    order.length = 0;
    const grant = {
      sid,
      device: b.signer.publicKeyB64,
      role: "para",
      scopes: [{ tag: env.period.scopeTag, kind: "period" }],
      blob: "Z3JhbnQ",
    };
    expect((await env.app.inject(control(env.a, GRANT_PUT, grant))).statusCode).toBe(200);
    expect((await env.app.inject(control(b.signer, GRANT_GET, { sid }))).statusCode).toBe(200);
    // Also when the body is refused (400) or the store finds nothing (404).
    expect((await env.app.inject(control(env.a, OPEN, { label: "x" }))).statusCode).toBe(400);
    expect((await env.app.inject(control(b.signer, GRANT_GET, { sid }))).statusCode).toBe(404);
    expect(order).toEqual(["sweep", "sweep", "sweep", "sweep"]);
  });

  it("grant-get: 30 a minute per trusted client IP, then 429 {error, record_id}; another IP is unaffected", async () => {
    const env = await deployment();
    const b = makeSigner();
    const sid = pairingSid(newPairingSecret());
    for (let i = 0; i < 30; i++) {
      expect((await env.app.inject(control(b, GRANT_GET, { sid }))).statusCode).toBe(404);
    }
    const limited = await env.app.inject(control(b, GRANT_GET, { sid }));
    expect(limited.statusCode).toBe(429);
    expect(shape(limited).body).toEqual({ error: "rate_limited" });
    const elsewhere = await env.app.inject(
      control(b, GRANT_GET, { sid }, "control", "198.51.100.7"),
    );
    expect(elsewhere.statusCode).toBe(404);
    const line = env.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.status === 429);
    expect(line).toMatchObject({ route: GRANT_GET });
    expectCleanLogs(env.lines, [sid, b.publicKeyB64, CLIENT_IP, "198.51.100.7"]);
  });

  it("every pairing route is limited at 30 a minute per IP", async () => {
    const env = await deployment();
    for (const route of PAIRING_ROUTES) {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push((await env.app.inject(control(makeSigner(), route, {}))).statusCode);
      }
      // Each route has its own counter: the first 30 pass, the 31st is limited.
      expect(statuses.slice(0, 30).includes(429), route).toBe(false);
      expect(statuses[30], route).toBe(429);
    }
  });
});

describe("TEACH-60 — logs never carry a sid, key, tag, blob or request value", () => {
  it("each 4xx (400, 404, 409, 413, 415) on every pairing route: clean logs; 409 logs route + status", async () => {
    const env = await deployment();
    const { sid, b } = await openAndRequest(env);
    const BLOB = "BLOBT60SENTINEL";
    const grant = {
      sid,
      device: b.signer.publicKeyB64,
      role: "para",
      scopes: [{ tag: env.period.scopeTag, kind: "period" }],
      blob: BLOB,
    };
    const valid: Record<PairingRoute, [Signer, unknown]> = {
      [OPEN]: [env.a, { sid: pairingSid(newPairingSecret()) }],
      [REQUEST_PUT]: [b.signer, { sid, blob: BLOB }],
      [REQUEST_GET]: [env.a, { sid }],
      [GRANT_PUT]: [env.a, grant],
      [GRANT_GET]: [b.signer, { sid }],
    };
    const cases: [number, Req][] = [];
    for (const route of PAIRING_ROUTES) {
      const [signer, body] = valid[route];
      cases.push([400, control(signer, route, { sid, label: "LABEL_T60_SENTINEL" })]);
      cases.push([404, control(signer, route, body, env.master)]);
      const r = control(signer, route, body);
      cases.push([415, { ...r, headers: { ...r.headers, "content-type": "application/xml" } }]);
    }
    cases.push([404, control(b.signer, REQUEST_PUT, { sid, blob: BLOB })]); // taken
    cases.push([409, control(env.a, GRANT_PUT, { ...grant, device: env.a.publicKeyB64 })]);
    cases.push([
      409,
      control(env.a, GRANT_PUT, { ...grant, scopes: [{ tag: env.master, kind: "master" }] }),
    ]);
    cases.push([413, control(b.signer, REQUEST_PUT, { sid, blob: `${BLOB}${"A".repeat(4096)}` })]);
    cases.push([413, control(env.a, GRANT_PUT, { ...grant, blob: `${BLOB}${"A".repeat(4096)}` })]);
    const forbidden = [sid, BLOB, env.master, env.period.scopeTag, b.signer.publicKeyB64];
    for (const [status, req] of cases) {
      const res = await env.app.inject(req);
      expect(res.statusCode, `${req.url} ${status}`).toBe(status);
      expect(Object.keys(res.json() as object).sort()).toEqual(["error", "record_id"]);
      expect(res.body).not.toContain(sid);
      forbidden.push(...requestValues(req));
    }
    const logged409 = env.lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.status === 409);
    expect(logged409.map((l) => l.route)).toEqual([GRANT_PUT, GRANT_PUT]);
    expectCleanLogs(env.lines, [...forbidden, "LABEL_T60_SENTINEL"]);
  });

  it("forced 5xx on every pairing route: a store error carrying the sid and keys → 503, clean log", async () => {
    const methods: Record<PairingRoute, keyof RelayStore> = {
      [OPEN]: "openPairing",
      [REQUEST_PUT]: "putPairingRequest",
      [REQUEST_GET]: "getPairingRequest",
      [GRANT_PUT]: "completePairing",
      [GRANT_GET]: "takePairingGrant",
    };
    const sid = pairingSid(newPairingSecret());
    const BLOB = "BLOBT60FAIL";
    const tag: ScopeTag = newScopeTag();
    for (const route of PAIRING_ROUTES) {
      const owner = route === OPEN || route === REQUEST_GET || route === GRANT_PUT;
      const failing: string[] = [methods[route], "sweepExpired", ...(owner ? ["deviceRole"] : [])];
      for (const method of failing) {
        const base = new InMemoryRelayStore();
        const env = await deployment(base);
        const b = makeSigner();
        Object.assign(base, {
          [method]: () =>
            Promise.reject(
              Object.assign(
                new Error(
                  `${ERR_MSG} ${sid} ${env.a.publicKeyB64} ${b.publicKeyB64} ${tag} ${BLOB}`,
                ),
                { code: "23505", detail: `Key (sid)=(${sid}) already exists.` },
              ),
            ),
        });
        const lines: string[] = [];
        const app = buildApp(base, {
          trustProxy: TRUST,
          logStream: { write: (l: string) => void lines.push(l) },
        });
        const body = {
          [OPEN]: { sid },
          [REQUEST_PUT]: { sid, blob: BLOB },
          [REQUEST_GET]: { sid },
          [GRANT_PUT]: {
            sid,
            device: b.publicKeyB64,
            role: "teacher",
            scopes: [{ tag, kind: "period" }],
            blob: BLOB,
          },
          [GRANT_GET]: { sid },
        }[route];
        const req = control(owner ? env.a : b, route, body);
        const res = await app.inject(req);
        expect(res.statusCode, `${route} ${method}`).toBe(503);
        expect(shape(res).body).toEqual({ error: "unavailable" });
        expect(res.body).not.toContain(ERR_MSG);
        const line = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((l) => l.level === 50);
        expect(line, `${route} ${method}`).toMatchObject({ route, status: 503, sqlstate: "23505" });
        expectCleanLogs(lines, [
          ERR_MSG,
          sid,
          env.a.publicKeyB64,
          b.publicKeyB64,
          tag,
          BLOB,
          ...requestValues(req),
        ]);
      }
    }
  });
});

describe("TEACH-60 — static: key sealing and pairing blobs stay inside packages/crypto", () => {
  const isTest = (f: string) =>
    /\.test\.tsx?$/.test(f) || f.includes(`${join("tools", "ferpa-guard", "test")}`);
  const sources = ["apps", "packages", "services", "tools"]
    .flatMap((d) => collectFiles(join(repoRoot, d), [".ts", ".tsx"]))
    .filter((f) => !isTest(f));
  const cryptoDir = join(repoRoot, "packages", "crypto", "src");
  const outside = sources.filter((f) => !f.startsWith(cryptoDir));
  const inside = sources.filter((f) => f.startsWith(cryptoDir));

  it("the scan sees the source tree", () => {
    expect(outside.some((f) => f.endsWith(join("sync-relay", "src", "app.ts")))).toBe(true);
    expect(inside.some((f) => f.endsWith("keyring.ts"))).toBe(true);
  });

  it("nothing outside packages/crypto reaches sealScopeKeyToDevice (or its two wrappers)", () => {
    expect(
      scanCodeForPattern(
        outside,
        /\b(sealScopeKeyToDevice|sealMasterKeyToDevice|sealPeriodKeyToDevice)\b/,
      ),
    ).toEqual([]);
  });

  it("inside packages/crypto, only the keyring and the approve functions reach it", () => {
    const hits = scanCodeForPattern(inside, /\bsealScopeKeyToDevice\b/).map((h) => h.file);
    expect([...new Set(hits)].map((f) => f.slice(cryptoDir.length + 1))).toEqual(["keyring.ts"]);
    const wrappers = scanCodeForPattern(
      inside,
      /\b(sealMasterKeyToDevice|sealPeriodKeyToDevice)\b/,
    );
    expect([...new Set(wrappers.map((h) => h.file.slice(cryptoDir.length + 1)))].sort()).toEqual([
      "enrollment.ts",
      "keyring.ts",
    ]);
  });

  it("outside packages/crypto, no code seals or opens a raw pairing blob — the typed helpers only", () => {
    const clients = outside.filter((f) => fileContains(f, "@teacher-assistant/crypto"));
    // Any mention — a call, a member access (`c.sealPairing`), or an import, aliased or not.
    expect(scanCodeForPattern(clients, /\b(sealPairing|openPairing)\b/)).toEqual([]);
  });
});
