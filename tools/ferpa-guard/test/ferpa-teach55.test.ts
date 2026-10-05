// FERPA-guard — TEACH-55 (EU-0, device-enrollment spec §5.5/§5.6). Signed
// requests drive every existing relay route to a forced 5xx and to each 4xx it
// can return, with the log stream captured. H-PUB-4: no log line may carry the
// filled path, doc id, scope, device key, nonce, signature, client IP, header,
// body, or an error message — only {record_id, route template, status,
// sqlstate}. Also: the reserved `control` scope is never a data scope (404).

import { sodiumReady, utf8 } from "@teacher-assistant/crypto";
import { SYNC_HEADERS } from "@teacher-assistant/schema";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSigner, type Signer } from "./relay-signer.js";

beforeAll(async () => {
  await sodiumReady();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOC = "doc-T55-SENTINEL-0a1b";
const SCOPE = "scope-T55-SENTINEL-2c3d";
const CLIENT_IP = "203.0.113.55";
const NPM_PEER = "172.18.0.15";
const TRUST = ["172.18.0.0/16"];
const ERR_MSG = "ERRMSG_T55_SENTINEL";
const CIPHERTEXT = Buffer.from("CIPHERTEXT_T55_SENTINEL").toString("base64url");
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

type Req = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  payload?: Buffer;
};

function signed(signer: Signer, method: "GET" | "POST", scope: string, body?: unknown): Req {
  const path = method === "GET" ? `/sync/${DOC}?since=0` : `/sync/${DOC}`;
  const raw = body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
  return {
    method,
    url: path,
    headers: { ...signer.sign(method, path, scope, raw), "x-forwarded-for": CLIENT_IP },
    ...(body === undefined ? {} : { payload: Buffer.from(raw) }),
  };
}

/** Every value the request carried that must never reach a log line. */
function requestValues(req: Req): string[] {
  // Not the timestamp header (it can equal pino's own `time`) or content-type.
  const h = req.headers;
  const carried = [
    SYNC_HEADERS.device,
    SYNC_HEADERS.scope,
    SYNC_HEADERS.nonce,
    SYNC_HEADERS.signature,
    "x-forwarded-for",
  ].map((k) => {
    const v = h[k];
    expect(v, k).toBeDefined();
    return v as string;
  });
  return [DOC, SCOPE, CLIENT_IP, CIPHERTEXT, ERR_MSG, `/sync/${DOC}`, ...carried];
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

function expectErrorBody(res: { json(): unknown }, error: string): void {
  const body = res.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
  expect(body.error).toBe(error);
  expect(body.record_id).toMatch(UUID);
}

/** A store whose database fails with a pg-shaped error carrying request data in its message. */
function failingStore(): RelayStore {
  const fail = () =>
    Promise.reject(
      Object.assign(new Error(`${ERR_MSG} for ${DOC} in ${SCOPE}`), { code: "08006" }),
    );
  return {
    isAuthorized: () => Promise.resolve(true),
    authorize: () => Promise.resolve(),
    docScope: fail,
    append: fail,
    fetch: fail,
  };
}

describe("TEACH-55 — forced 5xx on every signed route: clean logs", () => {
  for (const method of ["GET", "POST"] as const) {
    it(`${method} /sync/:docId store failure → 503; the log line is record_id + route + status + sqlstate`, async () => {
      const { lines, logStream } = captureLogs();
      const app = buildApp(failingStore(), { logStream, trustProxy: TRUST });
      const signer = makeSigner();
      const req = signed(
        signer,
        method,
        SCOPE,
        method === "POST" ? { updates: [CIPHERTEXT] } : undefined,
      );
      const res = await app.inject({ ...req, remoteAddress: NPM_PEER });
      expect(res.statusCode).toBe(503);
      expectErrorBody(res, "unavailable");
      const line = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.level === 50);
      expect(line).toMatchObject({
        record_id: (res.json() as { record_id: string }).record_id,
        route: "/sync/:docId",
        status: 503,
        sqlstate: "08006",
      });
      expectCleanLogs(lines, [...requestValues(req), signer.publicKeyB64]);
      await app.close();
    });

    it(`${method} /sync/:docId unexpected throw → 500 through the error handler; clean logs`, async () => {
      const { lines, logStream } = captureLogs();
      const store = new InMemoryRelayStore();
      const app = buildApp(store, { logStream, trustProxy: TRUST });
      app.addHook("onSend", async (_req, reply) => {
        if (reply.statusCode === 200) {
          throw new Error(`${ERR_MSG} ${DOC}`);
        }
      });
      const signer = makeSigner();
      await store.authorize(signer.publicKeyB64, SCOPE);
      const req = signed(
        signer,
        method,
        SCOPE,
        method === "POST" ? { updates: [CIPHERTEXT] } : undefined,
      );
      const res = await app.inject({ ...req, remoteAddress: NPM_PEER });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(ERR_MSG);
      expectCleanLogs(lines, [...requestValues(req), signer.publicKeyB64]);
      await app.close();
    });
  }
});

describe("TEACH-55 — each signed 4xx: {error, record_id} and clean logs", () => {
  it("400 (push body not base64 ciphertext), 401 (bad signature), 404 (unauthorized scope)", async () => {
    const store = new InMemoryRelayStore();
    const { lines, logStream } = captureLogs();
    const app = buildApp(store, { logStream, trustProxy: TRUST });
    const owner = makeSigner();
    const stranger = makeSigner();
    await store.authorize(owner.publicKeyB64, SCOPE);
    const forbidden: string[] = [owner.publicKeyB64, stranger.publicKeyB64];

    const bad = signed(owner, "POST", SCOPE, { updates: ["not base64 BODY_T55!"] });
    const r400 = await app.inject({ ...bad, remoteAddress: NPM_PEER });
    expect(r400.statusCode).toBe(400);
    expectErrorBody(r400, "bad_request");
    forbidden.push(...requestValues(bad), "BODY_T55");

    const tampered = signed(owner, "GET", SCOPE);
    tampered.headers = { ...tampered.headers, [SYNC_HEADERS.scope]: `${SCOPE}-x` };
    const r401 = await app.inject({ ...tampered, remoteAddress: NPM_PEER });
    expect(r401.statusCode).toBe(401);
    expectErrorBody(r401, "unauthorized");
    forbidden.push(...requestValues(tampered));

    const probe = signed(stranger, "GET", SCOPE);
    const r404 = await app.inject({ ...probe, remoteAddress: NPM_PEER });
    expect(r404.statusCode).toBe(404);
    expectErrorBody(r404, "not_found");
    forbidden.push(...requestValues(probe));

    expectCleanLogs(lines, forbidden);
    await app.close();
  });
});

describe("TEACH-55 — the `control` scope is reserved", () => {
  it("a device authorized for `control` still gets the zero-existence 404 on /sync/:docId", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const signer = makeSigner();
    await store.authorize(signer.publicKeyB64, "control");
    for (const method of ["GET", "POST"] as const) {
      const res = await app.inject(
        signed(
          signer,
          method,
          "control",
          method === "POST" ? { updates: [CIPHERTEXT] } : undefined,
        ),
      );
      expect(res.statusCode).toBe(404);
      expectErrorBody(res, "not_found");
    }
    expect(await store.docScope(DOC)).toBeUndefined();
  });
});
