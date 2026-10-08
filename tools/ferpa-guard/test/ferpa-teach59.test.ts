// FERPA-guard — TEACH-59 (EU-3, device-enrollment spec §5.3, §5.4, §5.6,
// §11 EU-3). The owner control routes — list, grant, revoke, retire-scope,
// recovery-wrap — driven with signed requests:
// - a non-owner (unknown key, member, revoked owner, bad or missing signature,
//   non-control scope) gets the identical 404 on every route — the same status,
//   body shape, content type and length as an unknown route and a data-route 404
//   (the rate-limit headers differ from an unknown route's; the route list is
//   public, so that reveals nothing about ownership or streams);
// - `revoked` is permanent; a revoked device gets 404 on the data routes;
// - a grant replayed after a revoke is refused on a fresh buildApp (empty nonce
//   cache);
// - the last active owner cannot be revoked;
// - retire-scope refuses the master scope with 409 (N3);
// - strict bodies: an unknown field (a label) is 400;
// - the expiry sweep runs on every control route;
// - no device key, scope tag, blob, nonce, signature, client IP or error
//   message reaches a log line on any 4xx (409 included) or a forced 5xx.

import { sodiumReady, utf8 } from "@teacher-assistant/crypto";
import { SYNC_HEADERS } from "@teacher-assistant/schema";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSigner, type Signer } from "./relay-signer.js";

beforeAll(async () => {
  await sodiumReady();
});

const LIST = "/sync/devices/list";
const GRANT = "/sync/devices/grant";
const REVOKE = "/sync/devices/revoke";
const RETIRE = "/sync/devices/retire-scope";
const WRAP = "/sync/devices/recovery-wrap";
const OWNER_ROUTES = [LIST, GRANT, REVOKE, RETIRE, WRAP] as const;

const NPM_PEER = "172.18.0.15";
const TRUST = ["172.18.0.0/16"];
const CLIENT_IP = "203.0.113.59";
// Scope tags are random UUIDs (newScopeTag); these are fixed ones, unique enough to
// search the log for.
const MASTER = "5e59a5e1-7a65-4d3a-9f00-0000000000a1";
const PERIOD = "5e59a5e1-7a65-4d3a-9f00-0000000000b2";
const DOC = "doc-T59-SENTINEL";
const BLOB = "WRAPT59SENTINEL.c2FsdA";
const ERR_MSG = "ERRMSG_T59_SENTINEL";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_LOG_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "reqId",
  "msg",
  "record_id",
  "route",
  "status",
  "sqlstate",
]);

interface Req {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  payload?: Buffer;
  remoteAddress: string;
}

/** A signed control request (scope `control` unless overridden). */
function control(signer: Signer, url: string, body: unknown, scope = "control"): Req {
  const raw = utf8(typeof body === "string" ? body : JSON.stringify(body));
  return {
    method: "POST",
    url,
    headers: { ...signer.sign("POST", url, scope, raw), "x-forwarded-for": CLIENT_IP },
    payload: Buffer.from(raw),
    remoteAddress: NPM_PEER,
  };
}

/** A signed data-route request for DOC under `scope`. */
function data(signer: Signer, method: "GET" | "POST", scope: string): Req {
  const url = `/sync/${DOC}`;
  const raw = method === "POST" ? utf8(JSON.stringify({ updates: ["AAAA"] })) : new Uint8Array(0);
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
  ];
}

function expectCleanLogs(lines: readonly string[], forbidden: readonly string[]): void {
  const all = lines.join("\n");
  for (const value of forbidden) {
    expect(all).not.toContain(value);
  }
  for (const line of lines) {
    const extra = Object.keys(JSON.parse(line) as object).filter((k) => !ALLOWED_LOG_KEYS.has(k));
    expect(extra).toEqual([]);
  }
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

let codeSeq = 0;

/** Enroll `signer` as an owner through the store's public API (a throwaway code). */
async function enrollOwner(store: RelayStore, signer: Signer): Promise<void> {
  const hash = `seed-${++codeSeq}`;
  await store.issueOwnerCode(hash, new Date("9999-01-01T00:00:00Z"));
  expect(await store.redeemOwnerCode(hash, signer.publicKeyB64)).not.toBe("refused");
}

/** Enroll `signer` as a member holding PERIOD, through a pairing opened by `owner`. */
async function enrollMember(store: RelayStore, owner: Signer, signer: Signer): Promise<void> {
  const sid = `sid-${++codeSeq}`;
  expect(await store.openPairing(sid, owner.publicKeyB64)).toBe(true);
  expect(await store.putPairingRequest(sid, signer.publicKeyB64, "req")).toBe(true);
  expect(
    await store.completePairing(
      sid,
      owner.publicKeyB64,
      signer.publicKeyB64,
      "member",
      [{ tag: PERIOD, kind: "period" }],
      "grant",
    ),
  ).toBe("ok");
}

function setup(store: RelayStore = new InMemoryRelayStore()) {
  const lines: string[] = [];
  const app = buildApp(store, {
    trustProxy: TRUST,
    logStream: { write: (l: string) => void lines.push(l) },
  });
  return { app, store, lines };
}

/** An owner holding MASTER and PERIOD, plus a member holding PERIOD. */
async function deployment(store?: RelayStore) {
  const env = setup(store);
  const owner = makeSigner();
  const member = makeSigner();
  await enrollOwner(env.store, owner);
  expect(
    await env.store.grantScopes(owner.publicKeyB64, [
      { tag: MASTER, kind: "master" },
      { tag: PERIOD, kind: "period" },
    ]),
  ).toBe("ok");
  await enrollMember(env.store, owner, member);
  return { ...env, owner, member };
}

/** A valid body for each owner route. */
function validBody(route: (typeof OWNER_ROUTES)[number], target: string): unknown {
  switch (route) {
    case LIST:
      return {};
    case GRANT:
      return { device: target, scopes: [{ tag: PERIOD, kind: "period" }] };
    case REVOKE:
      return { device: target };
    case RETIRE:
      return { tag: PERIOD };
    case WRAP:
      return { blob: BLOB };
  }
}

describe("TEACH-59 — non-owners get the identical 404 on every owner route", () => {
  it("unknown key, member, revoked owner, bad signature, unsigned, non-control scope", async () => {
    const { app, store, owner, member } = await deployment();
    const revoked = makeSigner();
    await enrollOwner(store, revoked);
    expect(await store.revoke(revoked.publicKeyB64)).toBe("ok");
    const before = await store.listDevices();

    // The reference 404s: an unknown route, and a data route the caller may not read.
    const reference = shape(await app.inject(control(owner, "/sync/devices/nope", {})));
    expect(reference).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(shape(await app.inject(data(makeSigner(), "GET", PERIOD)))).toEqual(reference);

    for (const route of OWNER_ROUTES) {
      const body = validBody(route, member.publicKeyB64);
      const callers: [string, () => Req][] = [
        ["unknown key", () => control(makeSigner(), route, body)],
        ["member", () => control(member, route, body)],
        ["revoked owner", () => control(revoked, route, body)],
        [
          "bad signature",
          () => {
            const r = control(owner, route, body);
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
        ["owner, data scope", () => control(owner, route, body, PERIOD)],
        // A malformed body from a non-owner is still the 404, never the 400.
        ["member, malformed body", () => control(member, route, { label: "Para phone" })],
      ];
      for (const [name, make] of callers) {
        const res = await app.inject(make());
        expect(shape(res), `${route} ${name}`).toEqual(reference);
      }
    }
    // Nothing changed.
    expect(await store.listDevices()).toEqual(before);
    expect(await store.getRecoveryWrap()).toBeUndefined();
  });
});

describe("TEACH-59 — revoke", () => {
  it("a revoked device gets 404 on the data routes, and revoked is permanent", async () => {
    const { app, store, owner, member } = await deployment();
    expect((await app.inject(data(member, "POST", PERIOD))).statusCode).toBe(200);
    expect((await app.inject(data(member, "GET", PERIOD))).statusCode).toBe(200);

    const res = await app.inject(control(owner, REVOKE, { device: member.publicKeyB64 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});

    const get = await app.inject(data(member, "GET", PERIOD));
    const post = await app.inject(data(member, "POST", PERIOD));
    const stranger = shape(await app.inject(data(makeSigner(), "GET", PERIOD)));
    expect(shape(get)).toEqual(stranger);
    expect(shape(post)).toEqual(stranger);

    // Permanent: a fresh grant is refused, the listing still says revoked, and a
    // repeat revoke is an idempotent 200.
    const regrant = await app.inject(
      control(owner, GRANT, {
        device: member.publicKeyB64,
        scopes: [{ tag: PERIOD, kind: "period" }],
      }),
    );
    expect(regrant.statusCode).toBe(409);
    expect((await app.inject(data(member, "GET", PERIOD))).statusCode).toBe(404);
    expect(
      (await app.inject(control(owner, REVOKE, { device: member.publicKeyB64 }))).statusCode,
    ).toBe(200);
    const listed = (await store.listDevices()).find((d) => d.device === member.publicKeyB64);
    expect(listed).toMatchObject({ status: "revoked", scopes: [] });
  });

  it("the last active owner cannot be revoked (409 last_owner); a second owner can be", async () => {
    const { app, store, owner } = await deployment();
    const self = await app.inject(control(owner, REVOKE, { device: owner.publicKeyB64 }));
    expect(self.statusCode).toBe(409);
    expect(shape(self).body).toEqual({ error: "last_owner" });
    expect(await store.deviceRole(owner.publicKeyB64)).toBe("owner");

    const second = makeSigner();
    await enrollOwner(store, second);
    expect(
      (await app.inject(control(owner, REVOKE, { device: second.publicKeyB64 }))).statusCode,
    ).toBe(200);
    // The remaining owner is the last one again.
    expect(
      (await app.inject(control(owner, REVOKE, { device: owner.publicKeyB64 }))).statusCode,
    ).toBe(409);
    // An owner revoking ITSELF while another owner remains is allowed.
    const third = makeSigner();
    await enrollOwner(store, third);
    expect(
      (await app.inject(control(third, REVOKE, { device: third.publicKeyB64 }))).statusCode,
    ).toBe(200);
    expect(await store.deviceRole(third.publicKeyB64)).toBeUndefined();
  });

  it("a grant replayed after the revoke is refused on a fresh buildApp (empty nonce cache)", async () => {
    const { app, store, owner } = await deployment();
    const para = makeSigner();
    await enrollMember(store, owner, para);
    const other = "5e59a5e1-7a65-4d3a-9f00-0000000000c3";
    const grant = control(owner, GRANT, {
      device: para.publicKeyB64,
      scopes: [{ tag: other, kind: "period" }],
    });
    expect((await app.inject(grant)).statusCode).toBe(200);
    expect(await store.isAuthorized(para.publicKeyB64, other)).toBe(true);
    expect(
      (await app.inject(control(owner, REVOKE, { device: para.publicKeyB64 }))).statusCode,
    ).toBe(200);

    // Same app: the nonce cache refuses the replay (identical 404).
    expect((await app.inject(grant)).statusCode).toBe(404);
    // A restarted relay (fresh buildApp, empty nonce cache): the signature and
    // timestamp still verify, but revoked is permanent, so the store refuses.
    const restarted = setup(store).app;
    const replay = await restarted.inject(grant);
    expect(replay.statusCode).toBe(409);
    expect(await store.isAuthorized(para.publicKeyB64, other)).toBe(false);
    expect(await store.deviceRole(para.publicKeyB64)).toBeUndefined();
    expect((await restarted.inject(data(para, "GET", other))).statusCode).toBe(404);
  });
});

describe("TEACH-59 — grant, list, retire-scope, recovery-wrap", () => {
  it("grant enforces the scope-kind invariants with 409; ok grants open the data route", async () => {
    const { app, store, owner, member } = await deployment();
    const grant = (device: string, scopes: unknown) =>
      app.inject(control(owner, GRANT, { device, scopes }));

    const conflicts: [string, string, unknown][] = [
      ["member gets master", member.publicKeyB64, [{ tag: MASTER, kind: "master" }]],
      [
        "second master",
        owner.publicKeyB64,
        [{ tag: "5e59a5e1-7a65-4d3a-9f00-0000000000d4", kind: "master" }],
      ],
      ["master re-granted as period", member.publicKeyB64, [{ tag: MASTER, kind: "period" }]],
      ["unknown device", makeSigner().publicKeyB64, [{ tag: PERIOD, kind: "period" }]],
    ];
    for (const [name, device, scopes] of conflicts) {
      const res = await grant(device, scopes);
      expect(res.statusCode, name).toBe(409);
      expect(shape(res).body, name).toEqual({ error: "conflict" });
    }

    const next = "5e59a5e1-7a65-4d3a-9f00-0000000000e5";
    expect((await grant(member.publicKeyB64, [{ tag: next, kind: "period" }])).statusCode).toBe(
      200,
    );
    expect((await app.inject(data(member, "GET", next))).statusCode).toBe(200);

    // Retired tags cannot be granted to anyone new.
    expect((await app.inject(control(owner, RETIRE, { tag: next }))).statusCode).toBe(200);
    const late = makeSigner();
    await enrollOwner(store, late);
    expect((await grant(late.publicKeyB64, [{ tag: next, kind: "period" }])).statusCode).toBe(409);
  });

  it("list returns devices, roles, statuses and scope kinds — no labels", async () => {
    const { app, owner, member } = await deployment();
    const res = await app.inject(control(owner, LIST, {}));
    expect(res.statusCode).toBe(200);
    const { devices } = res.json() as { devices: unknown[] };
    expect(devices).toHaveLength(2);
    expect(devices).toContainEqual({
      device: owner.publicKeyB64,
      role: "owner",
      status: "active",
      scopes: [
        { tag: MASTER, kind: "master", retired: false },
        { tag: PERIOD, kind: "period", retired: false },
      ].sort((a, b) => (a.tag < b.tag ? -1 : 1)),
    });
    expect(devices).toContainEqual({
      device: member.publicKeyB64,
      role: "member",
      status: "active",
      scopes: [{ tag: PERIOD, kind: "period", retired: false }],
    });
  });

  it("retire-scope: master → 409 master_scope; period → read-only (append 404, fetch 200); unknown → 404", async () => {
    const { app, store, owner, member } = await deployment();
    expect((await app.inject(data(member, "POST", PERIOD))).statusCode).toBe(200);

    const master = await app.inject(control(owner, RETIRE, { tag: MASTER }));
    expect(master.statusCode).toBe(409);
    expect(shape(master).body).toEqual({ error: "master_scope" });
    const masterRow = (await store.listDevices())
      .flatMap((d) => d.scopes)
      .find((s) => s.tag === MASTER);
    expect(masterRow?.retired).toBe(false);

    expect((await app.inject(control(owner, RETIRE, { tag: PERIOD }))).statusCode).toBe(200);
    const append = await app.inject(data(member, "POST", PERIOD));
    expect(shape(append)).toEqual(shape(await app.inject(data(makeSigner(), "GET", PERIOD))));
    expect((await app.inject(data(member, "GET", PERIOD))).statusCode).toBe(200);

    const unknown = await app.inject(
      control(owner, RETIRE, { tag: "5e59a5e1-7a65-4d3a-9f00-0000000000f6" }),
    );
    expect(shape(unknown)).toEqual(
      shape(await app.inject(control(owner, "/sync/devices/nope", {}))),
    );
  });

  it("recovery-wrap: stored (≤ 4 KiB); > 4 KiB → 413", async () => {
    const { app, store, owner } = await deployment();
    expect((await app.inject(control(owner, WRAP, { blob: BLOB }))).statusCode).toBe(200);
    expect(await store.getRecoveryWrap()).toBe(BLOB);
    const big = await app.inject(control(owner, WRAP, { blob: "A".repeat(4097) }));
    expect(big.statusCode).toBe(413);
    expect(shape(big).body).toEqual({ error: "payload_too_large" });
    expect((await app.inject(control(owner, WRAP, { blob: "A".repeat(4096) }))).statusCode).toBe(
      200,
    );
    expect(await store.getRecoveryWrap()).toBe("A".repeat(4096));
  });
});

describe("TEACH-59 — strict bodies: an unknown field is 400, no labels", () => {
  it("each route refuses extra fields, missing fields and wrong types", async () => {
    const { app, store, owner, member } = await deployment();
    const device = member.publicKeyB64;
    const scope = { tag: PERIOD, kind: "period" };
    const bad: Record<(typeof OWNER_ROUTES)[number], unknown[]> = {
      [LIST]: [{ label: "x" }, [], "null", "not json", ""],
      [GRANT]: [
        { device, scopes: [scope], label: "Para phone" },
        { device, scopes: [{ ...scope, label: "3rd period" }] },
        { device, scopes: [] },
        {
          device,
          scopes: Array.from({ length: 17 }, (_, i) => ({
            tag: `5e59a5e1-7a65-4d3a-9f00-${String(i).padStart(12, "0")}`,
            kind: "period",
          })),
        },
        { device, scopes: [{ tag: PERIOD, kind: "member" }] },
        { device, scopes: [{ tag: "", kind: "period" }] },
        { device, scopes: [{ tag: "x".repeat(257), kind: "period" }] },
        { device, scopes: [{ tag: "a\u0000b", kind: "period" }] },
        // A tag is an opaque UUID: a label-shaped value, or the reserved control scope, is 400.
        { device, scopes: [{ tag: "P3 - J.S. IEP", kind: "period" }] },
        { device, scopes: [{ tag: "control", kind: "period" }] },
        { device, scopes: [{ tag: `${PERIOD} `, kind: "period" }] },
        { device, scopes: scope },
        { device: "not a key!", scopes: [scope] },
        { scopes: [scope] },
      ],
      [REVOKE]: [{ device, label: "x" }, { device: 1 }, {}, { device: "" }],
      [RETIRE]: [
        { tag: PERIOD, name: "x" },
        { tag: 7 },
        {},
        { tag: "x".repeat(257) },
        { tag: "3rd period" },
        { tag: "control" },
      ],
      [WRAP]: [{ blob: BLOB, label: "x" }, { blob: "" }, { blob: "has space" }, { blob: 1 }, {}],
    };
    const before = await store.listDevices();
    for (const route of OWNER_ROUTES) {
      for (const body of bad[route]) {
        const res = await app.inject(control(owner, route, body));
        expect(res.statusCode, `${route} ${JSON.stringify(body)?.slice(0, 60)}`).toBe(400);
        expect(shape(res).body).toEqual({ error: "bad_request" });
      }
    }
    expect(await store.listDevices()).toEqual(before);
    expect(await store.getRecoveryWrap()).toBeUndefined();
  });

  it("no route has a path parameter: an identifier in the URL is an unknown route", async () => {
    const { app, owner, member } = await deployment();
    for (const route of OWNER_ROUTES) {
      const res = await app.inject(control(owner, `${route}/${member.publicKeyB64}`, {}));
      expect(res.statusCode, route).toBe(404);
    }
  });
});

describe("TEACH-59 — the expiry sweep runs on every control route", () => {
  it("each owner route calls sweepExpired once, before it acts", async () => {
    const base = new InMemoryRelayStore();
    const order: string[] = [];
    const spy = Object.assign(base, {
      sweepExpired: async () => {
        order.push("sweep");
        return InMemoryRelayStore.prototype.sweepExpired.call(base);
      },
    });
    const { app, owner, member } = await deployment(spy);
    for (const route of OWNER_ROUTES) {
      order.length = 0;
      const res = await app.inject(control(owner, route, validBody(route, member.publicKeyB64)));
      expect(res.statusCode, route).toBe(200);
      expect(order, route).toEqual(["sweep"]);
    }
    // Also when the body is then refused (400) or the store refuses (409).
    order.length = 0;
    expect((await app.inject(control(owner, LIST, { label: "x" }))).statusCode).toBe(400);
    expect((await app.inject(control(owner, RETIRE, { tag: MASTER }))).statusCode).toBe(409);
    expect(order).toEqual(["sweep", "sweep"]);
  });

  it("an expired pairing session is gone after any owner route", async () => {
    let t = Date.parse("2026-10-09T12:00:00Z");
    const store = new InMemoryRelayStore({ now: () => new Date(t) });
    const { app, owner } = await deployment(store);
    expect(await store.openPairing("sid-sweep", owner.publicKeyB64)).toBe(true);
    t += 11 * 60_000;
    expect((await app.inject(control(owner, LIST, {}))).statusCode).toBe(200);
    t -= 11 * 60_000; // were the row still there, it would read as open again
    expect(await store.getPairingRequest("sid-sweep", owner.publicKeyB64)).toBeUndefined();
    expect(await store.putPairingRequest("sid-sweep", makeSigner().publicKeyB64, "r")).toBe(false);
  });
});

describe("TEACH-59 — logs never carry a key, tag, blob or request value", () => {
  it("each 4xx (400, 404, 409, 413, 415, 429) on every owner route: clean logs; 409 logs route + status", async () => {
    const { app, owner, member, lines } = await deployment();
    const forbidden = [MASTER, PERIOD, BLOB, owner.publicKeyB64, member.publicKeyB64, DOC];
    const cases: [number, Req][] = [];
    for (const route of OWNER_ROUTES) {
      cases.push([400, control(owner, route, { label: "LABEL_T59_SENTINEL" })]);
      cases.push([404, control(member, route, validBody(route, member.publicKeyB64))]);
      const r = control(owner, route, validBody(route, member.publicKeyB64));
      cases.push([415, { ...r, headers: { ...r.headers, "content-type": "application/xml" } }]);
    }
    cases.push([409, control(owner, REVOKE, { device: owner.publicKeyB64 })]);
    cases.push([409, control(owner, RETIRE, { tag: MASTER })]);
    cases.push([
      409,
      control(owner, GRANT, {
        device: member.publicKeyB64,
        scopes: [{ tag: MASTER, kind: "master" }],
      }),
    ]);
    cases.push([413, control(owner, WRAP, { blob: `${BLOB}${"A".repeat(4096)}` })]);
    for (const [status, req] of cases) {
      const res = await app.inject(req);
      expect(res.statusCode, `${req.url} ${status}`).toBe(status);
      expect(Object.keys(res.json() as object).sort()).toEqual(["error", "record_id"]);
      forbidden.push(...requestValues(req));
    }
    const logged409 = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.status === 409);
    expect(logged409.map((l) => l.route).sort()).toEqual([GRANT, RETIRE, REVOKE].sort());
    expectCleanLogs(lines, [...forbidden, "LABEL_T59_SENTINEL"]);
  });

  it("429 on an owner route: {error, record_id}, clean log", async () => {
    const { app, owner, lines } = await deployment();
    let last = await app.inject(control(owner, LIST, {}));
    for (let i = 0; i < 300 && last.statusCode !== 429; i++) {
      last = await app.inject(control(owner, LIST, {}));
    }
    expect(last.statusCode).toBe(429);
    expect(shape(last).body).toEqual({ error: "rate_limited" });
    const line = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.status === 429);
    expect(line).toMatchObject({ route: LIST });
    expectCleanLogs(lines, [owner.publicKeyB64, CLIENT_IP, MASTER, PERIOD]);
  });

  it("forced 5xx on every owner route: a store error carrying the values → 503, clean log", async () => {
    const methods = {
      [LIST]: "listDevices",
      [GRANT]: "grantScopes",
      [REVOKE]: "revoke",
      [RETIRE]: "retireScope",
      [WRAP]: "putRecoveryWrap",
    } as const;
    for (const route of OWNER_ROUTES) {
      for (const method of [methods[route], "sweepExpired", "deviceRole"] as const) {
        const base = new InMemoryRelayStore();
        const { owner, member } = await deployment(base);
        const failing = Object.assign(base, {
          [method]: () =>
            Promise.reject(
              Object.assign(
                new Error(
                  `${ERR_MSG} ${owner.publicKeyB64} ${member.publicKeyB64} ${PERIOD} ${BLOB}`,
                ),
                { code: "23503", detail: `Key (scope_tag)=(${PERIOD}) is not present.` },
              ),
            ),
        });
        const { app, lines } = setup(failing);
        const req = control(owner, route, validBody(route, member.publicKeyB64));
        const res = await app.inject(req);
        expect(res.statusCode, `${route} ${method}`).toBe(503);
        expect(shape(res).body).toEqual({ error: "unavailable" });
        expect(res.body).not.toContain(ERR_MSG);
        const line = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((l) => l.level === 50);
        expect(line, `${route} ${method}`).toMatchObject({ route, status: 503, sqlstate: "23503" });
        expectCleanLogs(lines, [
          ERR_MSG,
          owner.publicKeyB64,
          member.publicKeyB64,
          PERIOD,
          MASTER,
          BLOB,
          ...requestValues(req),
        ]);
      }
    }
  });
});
