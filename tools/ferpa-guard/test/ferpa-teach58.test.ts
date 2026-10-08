// FERPA-guard — TEACH-58 (EU-2, device-enrollment spec §5.3, §5.5, §5.6, §5.7,
// §11 EU-2). POST /sync/enroll/redeem driven with signed requests:
// - every redeem failure (wrong, used, expired, malformed code; revoked key; a
//   key the relay already knows — PL ruling 2026-10-05: an active member is
//   never promoted; bad signature; non-control scope) is the identical 401;
// - lockout per trusted req.ip and global; more than 20 failures in 24 h
//   invalidate every unused code;
// - with an active owner a redeem is `recovery` and cannot add a second master;
// - the code, its hash, the device key and every request value stay out of the
//   log on each 4xx and on a forced 5xx; the operator CLI's code never reaches
//   the app log.

import { sodiumReady, utf8 } from "@teacher-assistant/crypto";
import { SYNC_HEADERS } from "@teacher-assistant/schema";
import { ISSUE_OWNER_CODE, runAdmin } from "@teacher-assistant/sync-relay/admin";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import {
  formatOwnerCode,
  newOwnerCode,
  ownerCodeHash,
} from "@teacher-assistant/sync-relay/owner-code";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSigner, type Signer } from "./relay-signer.js";

beforeAll(async () => {
  await sodiumReady();
});

const ROUTE = "/sync/enroll/redeem";
const NPM_PEER = "172.18.0.15";
const TRUST = ["172.18.0.0/16"];
const MINUTE = 60_000;
const ERR_MSG = "ERRMSG_T58_SENTINEL";
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

/** One clock for the store (code expiry) and the app (lockout). */
function testClock() {
  let t = Date.parse("2026-10-08T12:00:00Z");
  return {
    ms: () => t,
    date: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function setup(store?: RelayStore) {
  const clock = testClock();
  const lines: string[] = [];
  const s = store ?? new InMemoryRelayStore({ now: clock.date });
  const app = buildApp(s, {
    trustProxy: TRUST,
    now: clock.ms,
    logStream: { write: (l: string) => void lines.push(l) },
  });
  /** Issue a fresh code valid for `ttlMs`; returns the printed form. */
  const issue = async (ttlMs = 24 * 60 * MINUTE) => {
    const code = newOwnerCode();
    await s.issueOwnerCode(ownerCodeHash(code) as string, new Date(clock.ms() + ttlMs));
    return formatOwnerCode(code);
  };
  return { app, store: s, clock, lines, issue };
}

interface RedeemReq {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Buffer;
  remoteAddress: string;
}

/** A signed redeem from client `ip` (forwarded by the trusted NPM peer). */
function redeem(
  signer: Signer,
  body: unknown,
  ip = "203.0.113.58",
  opts: { scope?: string; peer?: string } = {},
): RedeemReq {
  const raw = utf8(typeof body === "string" ? body : JSON.stringify(body));
  return {
    method: "POST",
    url: ROUTE,
    headers: {
      ...signer.sign("POST", ROUTE, opts.scope ?? "control", raw),
      "x-forwarded-for": ip,
    },
    payload: Buffer.from(raw),
    remoteAddress: opts.peer ?? NPM_PEER,
  };
}

/** Every value a request carried that must never reach a log line. */
function requestValues(req: RedeemReq): string[] {
  return [
    req.headers[SYNC_HEADERS.device] as string,
    req.headers[SYNC_HEADERS.nonce] as string,
    req.headers[SYNC_HEADERS.signature] as string,
    req.headers["x-forwarded-for"] as string,
  ];
}

/** Every form of a code that must never reach a log line. */
function codeValues(printed: string): string[] {
  const canonical = printed.replaceAll("-", "");
  return [printed, canonical, ownerCodeHash(printed) as string];
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

/** The 401 with record_id removed, plus the headers a client could compare. */
function shape(res: {
  statusCode: number;
  json(): unknown;
  headers: Record<string, unknown>;
}): unknown {
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

/** Outlast both lockout windows so the next failure is counted on its own. */
const QUIET = 16 * MINUTE;

describe("TEACH-58 — redeem: first device and recovery", () => {
  it("first redeem on an empty deployment: mode first, the signer is an owner", async () => {
    const { app, store, issue } = setup();
    const signer = makeSigner();
    const res = await app.inject(redeem(signer, { code: await issue() }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "first", recovery_wrap: null });
    expect(await store.deviceRole(signer.publicKeyB64)).toBe("owner");
  });

  it("with an active owner and a master scope: mode recovery + the wrap; a second master is refused", async () => {
    const { app, store, issue } = setup();
    const first = makeSigner();
    expect((await app.inject(redeem(first, { code: await issue() }))).statusCode).toBe(200);
    expect(await store.grantScopes(first.publicKeyB64, [{ tag: "M", kind: "master" }])).toBe("ok");
    await store.putRecoveryWrap("WRAP_T58");
    const second = makeSigner();
    const res = await app.inject(redeem(second, { code: await issue() }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "recovery", recovery_wrap: "WRAP_T58" });
    expect(await store.grantScopes(second.publicKeyB64, [{ tag: "M2", kind: "master" }])).toBe(
      "second_master",
    );
  });

  it("an active owner without a master scope still makes a later redeem `recovery`", async () => {
    const { app, issue } = setup();
    expect((await app.inject(redeem(makeSigner(), { code: await issue() }))).statusCode).toBe(200);
    const res = await app.inject(redeem(makeSigner(), { code: await issue() }));
    expect(res.json()).toEqual({ mode: "recovery", recovery_wrap: null });
  });

  it("a replayed redeem is refused, also on a fresh app with an empty nonce cache", async () => {
    const { app, store, issue } = setup();
    const req = redeem(makeSigner(), { code: await issue() });
    expect((await app.inject(req)).statusCode).toBe(200);
    expect((await app.inject(req)).statusCode).toBe(401);
    const restarted = buildApp(store, { trustProxy: TRUST });
    expect((await restarted.inject(req)).statusCode).toBe(401);
  });
});

describe("TEACH-58 — every redeem failure is the identical 401", () => {
  it("wrong, used, expired, malformed, revoked, known member (PL ruling), known owner, bad signature, wrong scope", async () => {
    const { app, store, clock, issue } = setup();
    const owner = makeSigner();
    expect((await app.inject(redeem(owner, { code: await issue() }))).statusCode).toBe(200);
    expect(await store.grantScopes(owner.publicKeyB64, [{ tag: "P", kind: "period" }])).toBe("ok");

    // A member (para) device, enrolled through pairing.
    const member = makeSigner();
    expect(await store.openPairing("sid-1", owner.publicKeyB64)).toBe(true);
    expect(await store.putPairingRequest("sid-1", member.publicKeyB64, "req")).toBe(true);
    expect(
      await store.completePairing(
        "sid-1",
        owner.publicKeyB64,
        member.publicKeyB64,
        "member",
        [{ tag: "P", kind: "period" }],
        "grant",
      ),
    ).toBe("ok");
    // A revoked device.
    const revoked = makeSigner();
    expect((await app.inject(redeem(revoked, { code: await issue() }))).statusCode).toBe(200);
    expect(await store.revoke(revoked.publicKeyB64)).toBe("ok");

    const used = await issue();
    expect((await app.inject(redeem(makeSigner(), { code: used }))).statusCode).toBe(200);
    const expiring = await issue(MINUTE);
    const live = await issue();

    const attempts: [string, () => RedeemReq][] = [
      ["wrong", () => redeem(makeSigner(), { code: formatOwnerCode(newOwnerCode()) })],
      ["used", () => redeem(makeSigner(), { code: used })],
      ["expired", () => redeem(makeSigner(), { code: expiring })],
      ["malformed", () => redeem(makeSigner(), { code: "not-a-code" })],
      ["revoked key", () => redeem(revoked, { code: live })],
      ["active member (PL ruling)", () => redeem(member, { code: live })],
      ["active owner", () => redeem(owner, { code: live })],
      [
        "bad signature",
        () => {
          const r = redeem(makeSigner(), { code: live });
          return { ...r, headers: { ...r.headers, [SYNC_HEADERS.signature]: "AAAA" } };
        },
      ],
      ["non-control scope", () => redeem(makeSigner(), { code: live }, undefined, { scope: "P" })],
    ];
    clock.advance(2 * MINUTE); // `expiring` is now expired
    const shapes = [];
    for (const [name, make] of attempts) {
      clock.advance(QUIET);
      const res = await app.inject(make());
      expect(res.statusCode, name).toBe(401);
      shapes.push(shape(res));
    }
    expect(shapes[0]).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    for (const sh of shapes) {
      expect(sh).toEqual(shapes[0]);
    }
    // The member was not promoted; `live` survived every refusal and still redeems.
    expect(await store.deviceRole(member.publicKeyB64)).toBe("member");
    clock.advance(QUIET);
    expect((await app.inject(redeem(makeSigner(), { code: live }))).json()).toMatchObject({
      mode: "recovery",
    });
  });

  it("a body that is not exactly {code: string} is 400 (strict body)", async () => {
    const { app, issue } = setup();
    const code = await issue();
    for (const body of [{ code, extra: 1 }, {}, { code: 42 }, [code], "not json", "null"]) {
      const res = await app.inject(redeem(makeSigner(), body));
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("TEACH-58 — lockout on the trusted req.ip and globally", () => {
  it("per IP: 5 failures lock that client (keyed on the forwarded IP); a valid code is not consumed", async () => {
    const { app, store, clock, issue } = setup();
    const live = await issue();
    const wrong = () => ({ code: formatOwnerCode(newOwnerCode()) });
    // One failure from elsewhere starts the global window, which then expires
    // while A is still inside its own: A locks, the global key does not.
    await app.inject(redeem(makeSigner(), wrong(), "198.51.100.1"));
    clock.advance(14 * MINUTE);
    for (let i = 0; i < 3; i++) {
      expect((await app.inject(redeem(makeSigner(), wrong(), "203.0.113.1"))).statusCode).toBe(401);
    }
    clock.advance(2 * MINUTE);
    for (let i = 0; i < 2; i++) {
      expect((await app.inject(redeem(makeSigner(), wrong(), "203.0.113.1"))).statusCode).toBe(401);
    }
    const signer = makeSigner();
    const locked = await app.inject(redeem(signer, { code: live }, "203.0.113.1"));
    expect(locked.statusCode).toBe(429);
    expect(Object.keys(locked.json() as object).sort()).toEqual(["error", "record_id"]);
    expect(await store.deviceRole(signer.publicKeyB64)).toBeUndefined();
    // A spoofed X-Forwarded-For from an untrusted peer is keyed on that peer, not on A.
    const spoofed = await app.inject(
      redeem(makeSigner(), wrong(), "203.0.113.1", { peer: "198.51.100.200" }),
    );
    expect(spoofed.statusCode).toBe(401);
    // Another client is not locked out: the valid code redeems.
    const other = makeSigner();
    const ok = await app.inject(redeem(other, { code: live }, "203.0.113.2"));
    expect(ok.statusCode).toBe(200);
  });

  it("per IP: the lockout lasts 15 minutes", async () => {
    const { app, clock, issue } = setup();
    const live = await issue();
    for (let i = 0; i < 5; i++) {
      await app.inject(redeem(makeSigner(), { code: "wrong" }, "203.0.113.1"));
    }
    clock.advance(15 * MINUTE - 1);
    expect((await app.inject(redeem(makeSigner(), { code: live }, "203.0.113.1"))).statusCode).toBe(
      429,
    );
    clock.advance(1);
    expect((await app.inject(redeem(makeSigner(), { code: live }, "203.0.113.1"))).statusCode).toBe(
      200,
    );
  });

  it("global: 5 failures from 5 different IPs lock every client", async () => {
    const { app, issue } = setup();
    const live = await issue();
    for (let i = 0; i < 5; i++) {
      await app.inject(redeem(makeSigner(), { code: "wrong" }, `203.0.113.${10 + i}`));
    }
    const res = await app.inject(redeem(makeSigner(), { code: live }, "198.51.100.77"));
    expect(res.statusCode).toBe(429);
  });

  it("global: the 21st failure in 24 h invalidates every unused code; the log line is clean", async () => {
    const { app, clock, issue, lines } = setup();
    const live = await issue();
    for (let i = 0; i < 21; i++) {
      if (i % 4 === 0) {
        clock.advance(QUIET);
      }
      const res = await app.inject(redeem(makeSigner(), { code: "wrong" }, `203.0.113.${i}`));
      expect(res.statusCode).toBe(401);
    }
    clock.advance(QUIET);
    expect((await app.inject(redeem(makeSigner(), { code: live }))).statusCode).toBe(401);
    const burned = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === "owner codes invalidated");
    expect(burned).toHaveLength(1);
    expect(burned[0]).toMatchObject({ route: ROUTE });
    expectCleanLogs(lines, codeValues(live));
    // The operator reissues; a new code works.
    clock.advance(QUIET);
    expect((await app.inject(redeem(makeSigner(), { code: await issue() }))).statusCode).toBe(200);
  });
});

describe("TEACH-58 — logs never carry the code, its hash or any request value", () => {
  it("each 4xx (400, 401, 404, 413, 415, 429): {error, record_id} bodies, clean logs", async () => {
    const { app, issue, lines, clock } = setup();
    const live = await issue();
    const forbidden = codeValues(live);
    const cases: [number, RedeemReq][] = [
      [400, redeem(makeSigner(), { code: live, extra: "BODY_T58_SENTINEL" })],
      [401, redeem(makeSigner(), { code: live }, undefined, { scope: "SCOPE_T58_SENTINEL" })],
      [
        413,
        (() => {
          const r = redeem(makeSigner(), { code: live });
          return { ...r, payload: Buffer.concat([r.payload, Buffer.alloc(1_048_577, 0x20)]) };
        })(),
      ],
      [
        415,
        (() => {
          const r = redeem(makeSigner(), { code: live });
          return { ...r, headers: { ...r.headers, "content-type": "application/xml" } };
        })(),
      ],
    ];
    for (const [status, req] of cases) {
      clock.advance(QUIET);
      const res = await app.inject(req);
      expect(res.statusCode).toBe(status);
      expect(Object.keys(res.json() as object).sort()).toEqual(["error", "record_id"]);
      forbidden.push(...requestValues(req));
    }
    // 404: the route only takes POST; GET is an unmatched route.
    const get = await app.inject({ method: "GET", url: `${ROUTE}?code=${live}` });
    expect(get.statusCode).toBe(404);
    // 429: lockout.
    clock.advance(QUIET);
    for (let i = 0; i < 5; i++) {
      await app.inject(redeem(makeSigner(), { code: live.slice(0, 5) }));
    }
    const locked = redeem(makeSigner(), { code: live });
    expect((await app.inject(locked)).statusCode).toBe(429);
    forbidden.push(...requestValues(locked));
    expectCleanLogs(lines, [...forbidden, "BODY_T58_SENTINEL", "SCOPE_T58_SENTINEL"]);
    const logged429 = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.status === 429);
    expect(logged429).toMatchObject({ route: ROUTE });
  });

  it("forced 5xx: a store error carrying the code and hash (message and detail) → 503, clean log", async () => {
    const code = formatOwnerCode(newOwnerCode());
    const hash = ownerCodeHash(code) as string;
    const failing = Object.assign(new InMemoryRelayStore(), {
      redeemOwnerCode: () =>
        Promise.reject(
          Object.assign(new Error(`${ERR_MSG} ${code} ${hash}`), {
            code: "23505",
            detail: `Key (code_sha256)=(${hash}) already exists.`,
          }),
        ),
    });
    const { app, lines } = setup(failing);
    const req = redeem(makeSigner(), { code });
    const res = await app.inject(req);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(hash);
    const line = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.level === 50);
    expect(line).toMatchObject({ route: ROUTE, status: 503, sqlstate: "23505" });
    expectCleanLogs(lines, [...codeValues(code), ...requestValues(req), ERR_MSG]);
  });

  it("forced 5xx in the expiry sweep or the wrap read: 503, clean log", async () => {
    const code = formatOwnerCode(newOwnerCode());
    for (const method of ["sweepExpired", "getRecoveryWrap"] as const) {
      const base = new InMemoryRelayStore();
      await base.issueOwnerCode(ownerCodeHash(code) as string, new Date(Date.now() + 1e12));
      await base.issueOwnerCode("seed", new Date(Date.now() + 1e12));
      expect(await base.redeemOwnerCode("seed", "dev-owner")).toBe("first");
      const failing = Object.assign(base, {
        [method]: () => Promise.reject(new Error(`${ERR_MSG} ${code}`)),
      });
      const { app, lines } = setup(failing);
      const req = redeem(makeSigner(), { code });
      expect((await app.inject(req)).statusCode, method).toBe(503);
      expectCleanLogs(lines, [...codeValues(code), ...requestValues(req), ERR_MSG]);
    }
  });

  it("CLI in-process → signed redeem: the printed code and its hash never reach the app log", async () => {
    const { app, store, lines } = setup();
    let printed = "";
    const exit = await runAdmin({
      argv: [ISSUE_OWNER_CODE],
      stdout: {
        write: (t: string) => {
          printed += t;
        },
      },
      stderr: { write: () => {} },
      isTTY: true,
      stdoutIsContainerLog: false,
      openStore: async () => ({ store, close: async () => {} }),
    });
    expect(exit).toBe(0);
    const code = /\n {2}(\S+)\n/.exec(printed)?.[1] as string;
    expect(ownerCodeHash(code)).toBeDefined();
    const req = redeem(makeSigner(), { code });
    const res = await app.inject(req);
    expect(res.json()).toEqual({ mode: "first", recovery_wrap: null });
    // The same code again: used, so 401.
    expect((await app.inject(redeem(makeSigner(), { code }))).statusCode).toBe(401);
    expectCleanLogs(lines, [...codeValues(code), ...requestValues(req)]);
  });
});
