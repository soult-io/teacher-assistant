// Offline-first unlock/sync regression (BUG: ta-qa "Unlock failed. Check your
// passkey" on a reachable relay that 404s an un-enrolled device's stream).
//
// The relay returns a byte-identical 404 for BOTH an unknown doc and a scope the
// device is not authorized for (H-PUB-3, app.ts). A pull that 404s must therefore
// degrade to an EMPTY pull — no updates, unchanged cursor, NO throw — so a relay
// failure can never break the offline-first guarantee (open the local encrypted
// store and proceed). Other non-2xx stay real errors.

import {
  generatePeriodKey,
  generateSigningKeypair,
  ParaKeyring,
  sodiumReady,
  utf8,
} from "@teacher-assistant/crypto";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { EncryptedStream } from "./doc.js";
import { SyncEngine } from "./engine.js";
import { RelayRequestError } from "./errors.js";
import { InMemoryPersistence } from "./persistence.js";
import { RelayClient, type Transport } from "./relay-client.js";

beforeAll(async () => {
  await sodiumReady();
});

const jsonBody = (value: unknown): Uint8Array => utf8(JSON.stringify(value));

/** A transport with per-method canned responses (no real relay). */
function cannedTransport(
  onGet: () => { status: number; body: Uint8Array },
  onPost: () => { status: number; body: Uint8Array },
): Transport {
  return async (req) => (req.method === "GET" ? onGet() : onPost());
}

describe("RelayClient.pull — 404 is an empty pull, not an error", () => {
  it("returns no updates and the unchanged cursor on a 404 (does not throw)", async () => {
    const client = new RelayClient({
      transport: cannedTransport(
        () => ({ status: 404, body: jsonBody({ error: "not_found", record_id: "r1" }) }),
        () => ({ status: 200, body: jsonBody({ cursor: "unused" }) }),
      ),
      signingKeypair: generateSigningKeypair(),
    });

    const fromStart = await client.pull("doc-1", "scope-1", null);
    expect(fromStart).toEqual({ cursor: "", updates: [] });

    // A non-null cursor is preserved unchanged (we integrated nothing).
    const fromCursor = await client.pull("doc-1", "scope-1", "c-7");
    expect(fromCursor).toEqual({ cursor: "c-7", updates: [] });
  });

  it("still throws RelayRequestError on other non-2xx (e.g. 500)", async () => {
    const client = new RelayClient({
      transport: cannedTransport(
        () => ({ status: 500, body: jsonBody({ error: "server_error", record_id: "r2" }) }),
        () => ({ status: 200, body: jsonBody({ cursor: "unused" }) }),
      ),
      signingKeypair: generateSigningKeypair(),
    });
    await expect(client.pull("doc-1", "scope-1", null)).rejects.toBeInstanceOf(RelayRequestError);
  });
});

describe("SyncEngine.sync — a 404 pull still pushes the local backlog", () => {
  it("integrates nothing on the 404 pull, then uploads pending and clears it", async () => {
    // GET (pull) 404s like an un-enrolled device; POST (push) is accepted. Before the
    // fix, pull() threw and sync() aborted BEFORE the push — the backlog never left the
    // device (a never-synced doc could never sync up).
    const pushed: Uint8Array[][] = [];
    const transport: Transport = async (req) => {
      if (req.method === "GET") {
        return { status: 404, body: jsonBody({ error: "not_found", record_id: "r" }) };
      }
      pushed.push([req.body]);
      return { status: 200, body: jsonBody({ cursor: "c-1" }) };
    };

    const period = generatePeriodKey(newScopeTag());
    const stream = new EncryptedStream(newOpaqueId(), period.scopeTag, new ParaKeyring([period]));
    const engine = new SyncEngine(
      stream,
      new RelayClient({ transport, signingKeypair: generateSigningKeypair() }),
      new InMemoryPersistence(),
    );

    await engine.capture((doc) => doc.getMap("points").set("p1", 1));
    expect(engine.pendingCount).toBe(1);

    await expect(engine.sync()).resolves.toBeUndefined(); // no throw
    expect(engine.pendingCount).toBe(0); // backlog was pushed
    expect(pushed).toHaveLength(1);
  });
});
