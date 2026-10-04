// FERPA-guard — TEACH-49, the durable (Postgres) relay store. A database adds a
// new failure mode: the store can throw. These tests pin that a store failure is
// identity-clean on the wire AND in the logs (H-PUB-4): the response is exactly
// {error, record_id}, and the log line carries that opaque record_id (plus a
// 5-character SQLSTATE) — never the doc id, scope, device key, ciphertext, or
// the database's error message. Also: request logging stays off, and a doc bound
// to another scope between the ACL check and the write is the same 404.

import { sodiumReady, utf8 } from "@teacher-assistant/crypto";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";
import { makeSigner } from "./relay-signer.js";

beforeAll(async () => {
  await sodiumReady();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOC = "doc-opaque-1234";
const SCOPE = "scope-opaque-5678";
const DB_MESSAGE_MARKER = "DB_DETAIL_MARKER";
const CIPHERTEXT = Buffer.from("CIPHERTEXT_MARKER").toString("base64url");

function captureLogs() {
  const lines: string[] = [];
  return { lines, logStream: { write: (line: string) => void lines.push(line) } };
}

/** A store whose database "goes away": every read throws a pg-shaped error. */
function brokenStore(): RelayStore {
  const fail = () =>
    Promise.reject(
      Object.assign(new Error(`terminating connection for ${DOC} ${DB_MESSAGE_MARKER}`), {
        code: "57P01",
      }),
    );
  return {
    isAuthorized: () => Promise.resolve(true),
    authorize: () => Promise.resolve(),
    docScope: fail,
    append: fail,
    fetch: fail,
  };
}

function pushRequest(signer: ReturnType<typeof makeSigner>, docId: string, updates: string[]) {
  const path = `/sync/${encodeURIComponent(docId)}`;
  const body = utf8(JSON.stringify({ updates }));
  return {
    method: "POST" as const,
    url: path,
    headers: signer.sign("POST", path, SCOPE, body),
    payload: Buffer.from(body),
  };
}

function pullRequest(signer: ReturnType<typeof makeSigner>, docId: string) {
  const path = `/sync/${encodeURIComponent(docId)}?since=0`;
  return {
    method: "GET" as const,
    url: path,
    headers: signer.sign("GET", path, SCOPE, new Uint8Array(0)),
  };
}

function expectNoRequestData(logs: string[], signerKey: string): void {
  const all = logs.join("\n");
  for (const leak of [DOC, SCOPE, signerKey, CIPHERTEXT, DB_MESSAGE_MARKER, "terminating"]) {
    expect(all).not.toContain(leak);
  }
}

describe("TEACH-49 — a store failure is identity-clean on the wire and in the logs", () => {
  for (const kind of ["pull", "push"] as const) {
    it(`${kind}: 503 {error, record_id}; the log line holds only record_id + SQLSTATE`, async () => {
      const { lines, logStream } = captureLogs();
      const app = buildApp(brokenStore(), { logStream });
      const signer = makeSigner();
      const res = await app.inject(
        kind === "pull" ? pullRequest(signer, DOC) : pushRequest(signer, DOC, [CIPHERTEXT]),
      );

      expect(res.statusCode).toBe(503);
      const body = res.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
      expect(body.error).toBe("unavailable");
      expect(body.record_id).toMatch(UUID);

      const errorLines = lines.map((l) => JSON.parse(l)).filter((l) => l.level >= 50);
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatchObject({
        record_id: body.record_id,
        sqlstate: "57P01",
        msg: "sync store unavailable",
      });
      expectNoRequestData(lines, signer.publicKeyB64);
      await app.close();
    });
  }
});

describe("TEACH-49 — request logging stays off", () => {
  it("a successful push and pull write no request data to the log", async () => {
    const { lines, logStream } = captureLogs();
    const store = new InMemoryRelayStore();
    const app = buildApp(store, { logStream });
    const signer = makeSigner();
    await store.authorize(signer.publicKeyB64, SCOPE);

    expect((await app.inject(pushRequest(signer, DOC, [CIPHERTEXT]))).statusCode).toBe(200);
    const pulled = await app.inject(pullRequest(signer, DOC));
    expect(pulled.json()).toEqual({ cursor: "1", updates: [CIPHERTEXT] });
    expectNoRequestData(lines, signer.publicKeyB64);
    await app.close();
  });
});

describe("TEACH-49 — write-time scope binding keeps the zero-existence 404", () => {
  it("a doc bound to another scope between the ACL check and the write → the same 404", async () => {
    // docScope says "unbound", but the atomic append finds it bound elsewhere.
    const racing: RelayStore = {
      isAuthorized: () => Promise.resolve(true),
      authorize: () => Promise.resolve(),
      docScope: () => Promise.resolve(undefined),
      append: () => Promise.resolve(undefined),
      fetch: () => Promise.resolve({ cursor: "0", updates: [] }),
    };
    const app = buildApp(racing);
    const signer = makeSigner();
    const res = await app.inject(pushRequest(signer, DOC, [CIPHERTEXT]));
    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json()).sort()).toEqual(["error", "record_id"]);
    expect(res.json().error).toBe("not_found");
  });

  it("a doc id containing NUL is an unknown doc (404) and never reaches the store", async () => {
    let lookedUp = false;
    const store = new InMemoryRelayStore();
    const app = buildApp({
      isAuthorized: () => Promise.resolve(true),
      authorize: () => Promise.resolve(),
      docScope: (id) => {
        lookedUp = true;
        return store.docScope(id);
      },
      append: (...args) => store.append(...args),
      fetch: (...args) => store.fetch(...args),
    });
    const res = await app.inject(pullRequest(makeSigner(), "doc\u0000x"));
    expect(res.statusCode).toBe(404);
    expect(lookedUp).toBe(false);
  });

  it("a push whose updates are not base64 ciphertext is rejected (400)", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const signer = makeSigner();
    await store.authorize(signer.publicKeyB64, SCOPE);
    for (const bad of ["not base64!", "abc\u0000", "\ud800"]) {
      const res = await app.inject(pushRequest(signer, DOC, [bad]));
      expect(res.statusCode).toBe(400);
    }
    expect(await store.docScope(DOC)).toBeUndefined();
  });
});
