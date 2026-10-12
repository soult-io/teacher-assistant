// Relay unit tests. Deliberately crypto-free: this package must NEVER import
// @teacher-assistant/crypto (it never decrypts), and the FERPA-guard suite scans
// every .ts here — including tests — for that import. Signed-request behaviour
// (round-trip, H-PUB-3 zero-existence, identity-clean error bodies) is proven in
// tools/ferpa-guard and packages/sync, which may use the crypto layer to forge
// valid signatures. Here we cover what needs no key: health + the auth gate
// rejecting unsigned requests.

import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { listeningMessage } from "./logging.js";
import { sodiumReady } from "./sodium-verify.js";
import { InMemoryRelayStore } from "./store.js";

beforeAll(async () => {
  await sodiumReady();
});

describe("sync-relay app", () => {
  it("serves health", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "sync-relay" });
  });

  it("rejects an unsigned pull with 401 and an identity-clean body", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({ method: "GET", url: "/sync/some-opaque-doc?since=0" });
    expect(res.statusCode).toBe(401);
    // Body is exactly {error, record_id} — no student payload (H-PUB-4).
    expect(Object.keys(res.json()).sort()).toEqual(["error", "record_id"]);
  });

  it("rejects an unsigned push with 401", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({
      method: "POST",
      url: "/sync/some-opaque-doc",
      headers: { "content-type": "application/json" },
      payload: Buffer.from(JSON.stringify({ updates: [] })),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── TEACH-55 (EU-0): trusted proxy + identity-clean error logging ───────────────

const PROXY_CIDR = ["172.18.0.0/16"];
const NPM_PEER = "172.18.0.15";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Pino's own fields plus the only fields an EU-0 log line may carry. */
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

function captureLogs() {
  const lines: string[] = [];
  return { lines, logStream: { write: (line: string) => void lines.push(line) } };
}

function expectCleanLogs(lines: readonly string[], sentinels: readonly string[]): void {
  const all = lines.join("\n");
  for (const s of sentinels) {
    expect(all).not.toContain(s);
  }
  for (const line of lines) {
    const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
    expect(keys.filter((k) => !ALLOWED_LOG_KEYS.has(k))).toEqual([]);
  }
}

function expectErrorBody(res: { json(): unknown }, error: string): string {
  const body = res.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
  expect(body.error).toBe(error);
  expect(body.record_id).toMatch(UUID);
  return body.record_id as string;
}

/** The one log line carrying this record_id, parsed. */
function lineFor(lines: readonly string[], recordId: string): Record<string, unknown> {
  const hits = lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.record_id === recordId);
  expect(hits).toHaveLength(1);
  return hits[0] as Record<string, unknown>;
}

/** A test-only route that reports what the relay believes the client IP is. */
function withIpProbe(app: ReturnType<typeof buildApp>) {
  app.get("/__ip", async (req) => ({ ip: req.ip }));
  return app;
}

describe("TEACH-55 — trusted proxy", () => {
  it("X-Forwarded-For from a peer inside TRUST_PROXY sets req.ip", async () => {
    const app = withIpProbe(buildApp(new InMemoryRelayStore(), { trustProxy: PROXY_CIDR }));
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: NPM_PEER,
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json()).toEqual({ ip: "203.0.113.7" });
  });

  it("a spoofed X-Forwarded-For from a peer outside TRUST_PROXY is ignored", async () => {
    const app = withIpProbe(buildApp(new InMemoryRelayStore(), { trustProxy: PROXY_CIDR }));
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: "198.51.100.9",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json()).toEqual({ ip: "198.51.100.9" });
  });

  it("a forged hop chained through the proxy cannot replace the real client", async () => {
    // Client 203.0.113.7 sends "XFF: 10.9.9.9"; NPM appends the client it saw.
    const app = withIpProbe(buildApp(new InMemoryRelayStore(), { trustProxy: PROXY_CIDR }));
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: NPM_PEER,
      headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.7" },
    });
    expect(res.json()).toEqual({ ip: "203.0.113.7" });
  });

  it("an IPv4-mapped IPv6 peer inside the IPv4 CIDR is trusted; outside it is not", async () => {
    const app = withIpProbe(buildApp(new InMemoryRelayStore(), { trustProxy: PROXY_CIDR }));
    const via = (remoteAddress: string) =>
      app.inject({
        method: "GET",
        url: "/__ip",
        remoteAddress,
        headers: { "x-forwarded-for": "203.0.113.7" },
      });
    expect((await via("::ffff:172.18.0.15")).json()).toEqual({ ip: "203.0.113.7" });
    expect((await via("::ffff:198.51.100.9")).json()).toEqual({ ip: "::ffff:198.51.100.9" });
  });

  it("with no TRUST_PROXY, X-Forwarded-For is never honoured", async () => {
    const app = withIpProbe(buildApp(new InMemoryRelayStore()));
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      remoteAddress: NPM_PEER,
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(res.json()).toEqual({ ip: NPM_PEER });
  });

  it("rate limits key on the trusted client IP: two forwarded clients get independent limits", async () => {
    const app = buildApp(new InMemoryRelayStore(), { trustProxy: PROXY_CIDR });
    const hit = (client: string) =>
      app.inject({
        method: "GET",
        url: "/health",
        remoteAddress: NPM_PEER,
        headers: { "x-forwarded-for": client },
      });
    for (let i = 0; i < 300; i++) {
      expect((await hit("203.0.113.7")).statusCode).toBe(200);
    }
    const limited = await hit("203.0.113.7");
    expect(limited.statusCode).toBe(429);
    expectErrorBody(limited, "rate_limited");
    // Same proxy peer, different real client: not limited.
    expect((await hit("203.0.113.8")).statusCode).toBe(200);
  });

  it("rejects a trust-all trustProxy passed straight to buildApp", () => {
    for (const bad of [[], ["*"], ["0.0.0.0/0"], ["true"]]) {
      expect(() => buildApp(new InMemoryRelayStore(), { trustProxy: bad })).toThrow();
    }
  });
});

describe("TEACH-55 — error responses are {error, record_id}; logs carry no request data", () => {
  const DOC = "doc-SENTINEL-4f1c";
  const UA = "UA-SENTINEL-agent";
  const XFF = "203.0.113.77";
  const QUERY = "QSENTINEL";
  const sentinels = [DOC, UA, XFF, QUERY, "/sync/doc", "x-forwarded-for", "user-agent"];

  it("the production log level is pinned at info", () => {
    const app = buildApp(new InMemoryRelayStore(), { logStream: captureLogs().logStream });
    expect(app.log.level).toBe("info");
    const prod = buildApp(new InMemoryRelayStore());
    expect(prod.log.level).toBe("info");
  });

  it("forced 500 on every route: generic body, log line = record_id + route template + status", async () => {
    const routes = [
      { method: "GET" as const, url: "/health", template: "/health" },
      { method: "GET" as const, url: `/sync/${DOC}?since=${QUERY}`, template: "/sync/:docId" },
      { method: "POST" as const, url: `/sync/${DOC}?x=${QUERY}`, template: "/sync/:docId" },
      {
        method: "POST" as const,
        url: `/sync/enroll/redeem?x=${QUERY}`,
        template: "/sync/enroll/redeem",
      },
      // TEACH-59 (EU-3) owner control routes.
      ...[
        "/sync/devices/list",
        "/sync/devices/grant",
        "/sync/devices/revoke",
        "/sync/devices/retire-scope",
        "/sync/devices/recovery-wrap",
        // TEACH-60 (EU-4) pairing mailbox routes.
        "/sync/enroll/pairing/open",
        "/sync/enroll/pairing/request-put",
        "/sync/enroll/pairing/request-get",
        "/sync/enroll/pairing/grant-put",
        "/sync/enroll/pairing/grant-get",
      ].map((template) => ({
        method: "POST" as const,
        url: `${template}?x=${QUERY}`,
        template,
      })),
    ];
    for (const r of routes) {
      const { lines, logStream } = captureLogs();
      const app = buildApp(new InMemoryRelayStore(), { logStream, trustProxy: PROXY_CIDR });
      app.addHook("preHandler", async () => {
        throw Object.assign(new Error(`boom ${DOC} ERRMSG_SENTINEL`), { code: "EBOOM_SENTINEL" });
      });
      const res = await app.inject({
        method: r.method,
        url: r.url,
        remoteAddress: NPM_PEER,
        headers: {
          "user-agent": UA,
          "x-forwarded-for": XFF,
          "content-type": "application/json",
        },
        ...(r.method === "POST" ? { payload: Buffer.from('{"updates":["BODYSENTINEL"]}') } : {}),
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("ERRMSG_SENTINEL");
      const recordId = expectErrorBody(res, "internal");
      expect(lineFor(lines, recordId)).toMatchObject({ route: r.template, status: 500 });
      expect(lineFor(lines, recordId).sqlstate).toBeUndefined();
      expectCleanLogs(lines, [
        ...sentinels,
        "ERRMSG_SENTINEL",
        "EBOOM_SENTINEL",
        "BODYSENTINEL",
        "boom",
      ]);
      await app.close();
    }
  });

  it("a forced database error logs its SQLSTATE and nothing else from the error", async () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    app.addHook("preHandler", async () => {
      throw Object.assign(new Error(`relation ${DOC} ERRMSG_SENTINEL`), { code: "42P01" });
    });
    const res = await app.inject({ method: "GET", url: `/sync/${DOC}` });
    expect(res.statusCode).toBe(500);
    const recordId = expectErrorBody(res, "internal");
    expect(lineFor(lines, recordId)).toMatchObject({ status: 500, sqlstate: "42P01" });
    expectCleanLogs(lines, [DOC, "ERRMSG_SENTINEL", "relation"]);
  });

  it("4xx on every route and framework path: bodies {error, record_id}, logs clean", async () => {
    const longDoc = `${DOC}${"x".repeat(120)}`;
    const cases = [
      // 401 — unsigned request on each /sync route
      {
        req: { method: "GET" as const, url: `/sync/${DOC}?since=${QUERY}` },
        status: 401,
        error: "unauthorized",
      },
      {
        req: {
          method: "POST" as const,
          url: `/sync/${DOC}`,
          headers: { "content-type": "application/json" },
          payload: Buffer.from("{}"),
        },
        status: 401,
        error: "unauthorized",
      },
      // 401 — unsigned owner-code redeem (TEACH-58)
      {
        req: {
          method: "POST" as const,
          url: "/sync/enroll/redeem",
          headers: { "content-type": "application/json" },
          payload: Buffer.from('{"code":"BODYSENTINEL"}'),
        },
        status: 401,
        error: "unauthorized",
      },
      // 404 — unsigned owner control route (TEACH-59): the identical not-found
      {
        req: {
          method: "POST" as const,
          url: "/sync/devices/grant",
          headers: { "content-type": "application/json" },
          payload: Buffer.from('{"device":"BODYSENTINEL","scopes":[]}'),
        },
        status: 404,
        error: "not_found",
        unlogged: true, // like the data-route 404 and the 401s: answered, not logged
      },
      // 404 — unsigned pairing route (TEACH-60): the same identical not-found
      {
        req: {
          method: "POST" as const,
          url: "/sync/enroll/pairing/request-put",
          headers: { "content-type": "application/json" },
          payload: Buffer.from('{"sid":"BODYSENTINEL","blob":"BODYSENTINEL"}'),
        },
        status: 404,
        error: "not_found",
        unlogged: true,
      },
      // 404 — no such route (the default Fastify body echoes the path)
      {
        req: { method: "GET" as const, url: `/nope/${DOC}?q=${QUERY}` },
        status: 404,
        error: "not_found",
      },
      { req: { method: "DELETE" as const, url: `/sync/${DOC}` }, status: 404, error: "not_found" },
      // 413 — body over the limit (content-type parser, before the handler)
      {
        req: {
          method: "POST" as const,
          url: `/sync/${DOC}`,
          headers: { "content-type": "application/json" },
          payload: Buffer.alloc(1_048_577, 0x41),
        },
        status: 413,
        error: "payload_too_large",
      },
      // 414 — doc id over maxParamLength (the default body echoes the path)
      {
        req: { method: "GET" as const, url: `/sync/${longDoc}` },
        status: 414,
        error: "uri_too_long",
      },
      // 415 — unsupported content type
      {
        req: {
          method: "POST" as const,
          url: `/sync/${DOC}`,
          headers: { "content-type": "application/xml" },
          payload: "BODYSENTINEL",
        },
        status: 415,
        error: "unsupported_media_type",
      },
      // 400 — malformed percent-encoding in the path
      {
        req: { method: "GET" as const, url: `/sync/${DOC}%zz` },
        status: 400,
        error: "bad_request",
      },
    ];
    for (const c of cases) {
      const { lines, logStream } = captureLogs();
      const app = buildApp(new InMemoryRelayStore(), { logStream, trustProxy: PROXY_CIDR });
      const res = await app.inject({
        ...c.req,
        remoteAddress: NPM_PEER,
        headers: {
          ...("headers" in c.req ? c.req.headers : {}),
          "user-agent": UA,
          "x-forwarded-for": XFF,
        },
      });
      expect(res.statusCode, `${c.req.method} ${c.req.url.slice(0, 40)}`).toBe(c.status);
      const recordId = expectErrorBody(res, c.error);
      expect(res.body).not.toContain(DOC);
      expectCleanLogs(lines, [...sentinels, "BODYSENTINEL", longDoc]);
      // Framework-raised 4xx go through the error handler and are logged safely.
      if (c.status !== 401 && !("unlogged" in c)) {
        expect(lineFor(lines, recordId)).toMatchObject({ status: c.status });
        const route = lineFor(lines, recordId).route;
        expect(["/sync/:docId", "unmatched"]).toContain(route);
      }
      await app.close();
    }
  });

  it("429 is {error, record_id} and its log line is clean", async () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    let res = await app.inject({
      method: "GET",
      url: `/sync/${DOC}`,
      headers: { "user-agent": UA },
    });
    for (let i = 0; i < 300; i++) {
      res = await app.inject({ method: "GET", url: `/sync/${DOC}`, headers: { "user-agent": UA } });
    }
    expect(res.statusCode).toBe(429);
    const recordId = expectErrorBody(res, "rate_limited");
    expect(lineFor(lines, recordId)).toMatchObject({ status: 429, route: "/sync/:docId" });
    expectCleanLogs(lines, [DOC, UA, "127.0.0.1"]);
  });

  it("431 (oversized headers, handled before routing) is {error, record_id} and logs clean", async () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(
          `GET /sync/${DOC} HTTP/1.1\r\nHost: x\r\nX-Big: ${"H".repeat(20_000)}\r\nUser-Agent: ${UA}\r\n\r\n`,
        );
      });
      let out = "";
      sock.on("data", (d) => {
        out += d.toString("utf8");
      });
      sock.on("close", () => resolve(out));
      sock.on("error", reject);
    });
    await app.close();
    expect(raw).toMatch(/^HTTP\/1\.1 431 /);
    const body = JSON.parse(raw.slice(raw.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
    expect(body.error).toBe("header_too_large");
    expect(lineFor(lines, body.record_id as string)).toMatchObject({
      status: 431,
      route: "unmatched",
    });
    expectCleanLogs(lines, [DOC, UA, "HHHHHHHH"]);
  });
});

describe("TEACH-55 — log message guard", () => {
  it("any message off the allowlist is replaced; interpolation args are dropped", () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    app.log.warn("Reply was already sent in /sync/doc-SENTINEL (POST)");
    app.log.info({ record_id: "r" }, "lookup %s", "doc-SENTINEL");
    app.log.info("sync-relay listening on http://0.0.0.0:8931 (store: postgres)");
    app.log.error({ status: 500 }, "request failed");
    const msgs = lines.map((l) => (JSON.parse(l) as { msg?: string }).msg);
    expect(msgs).toEqual([
      "(log message redacted)",
      "(log message redacted)",
      "sync-relay listening on http://0.0.0.0:8931 (store: postgres)",
      "request failed",
    ]);
    expect(lines.join("\n")).not.toContain("SENTINEL");
  });

  it("the startup line passes the guard for both stores (the deploy checks it)", () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    for (const kind of ["memory", "postgres"] as const) {
      app.log.info(listeningMessage("http://0.0.0.0:8931", kind));
    }
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual([
      "sync-relay listening on http://0.0.0.0:8931 (store: memory)",
      "sync-relay listening on http://0.0.0.0:8931 (store: postgres)",
    ]);
  });

  it("an {err} or bare Error with no message cannot surface err.message as msg", () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    app.log.warn({ err: new Error("in /sync/doc-SENTINEL (POST)") });
    app.log.warn(new Error("in /sync/doc-SENTINEL (GET)"));
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("SENTINEL");
  });

  it("an object-only log cannot carry msg/url/headers: only the allowed fields survive", () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    app.log.info({
      msg: "/sync/doc-SENTINEL",
      url: "/sync/doc-SENTINEL",
      headers: { a: "SENTINEL" },
    });
    app.log.info(
      { record_id: "r1", route: "/sync/:docId", status: 400, extra: "SENTINEL" },
      "request rejected",
    );
    expect(lines.join("\n")).not.toContain("SENTINEL");
    expectCleanLogs(lines, []);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ record_id: "r1", status: 400 });
  });

  it("a route that sends twice (FST_ERR_REP_ALREADY_SENT) logs no filled path", async () => {
    const { lines, logStream } = captureLogs();
    const app = buildApp(new InMemoryRelayStore(), { logStream });
    app.get("/twice/:id", async (_req, reply) => {
      reply.send({ ok: true });
      return "second value";
    });
    const res = await app.inject({ method: "GET", url: "/twice/doc-SENTINEL?q=QSENTINEL" });
    expect(res.statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("SENTINEL");
  });
});
