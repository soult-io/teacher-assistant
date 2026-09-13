// @vitest-environment node
//
// Node realm: this suite drives the real libsodium crypto path, which rejects a
// foreign-realm Uint8Array (jsdom's TextEncoder produces one). fake-indexeddb is
// still installed globally by the setup file, so IndexedDbPersistence works here.
import { AuthRequiredError } from "@teacher-assistant/auth";
import { buildWeeklyDashboard, renderHeader } from "@teacher-assistant/store";
import { InMemoryPersistence } from "@teacher-assistant/sync";
import type { VerifiedAuthenticationResponse } from "@simplewebauthn/server";
import { beforeEach, describe, expect, it } from "vitest";
import { IndexedDbPersistence } from "./indexeddb-persistence.js";
import type { PasskeyGateway } from "./passkey.js";
import { bootstrapTeacherSession } from "./session.js";

const NOW = new Date("2026-09-14T12:00:00Z");

// A distinctive plaintext value that lives in the synthetic seed; it must NEVER
// appear in the at-rest bytes (FERPA hard-stop #10/#11).
const PLAINTEXT_MARKER = "Two-step equations";

describe("bootstrapTeacherSession — U1 acceptance", () => {
  it("unlocks and renders live projections from the synthetic seed", async () => {
    const session = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
    });

    expect(session.role).toBe("teacher");
    expect(session.records.students).toHaveLength(4);
    expect(session.records.goals).toHaveLength(6);
    expect(session.records.points).toHaveLength(4); // 2 scored, 1 no-data, 1 pending-para
    expect(session.records.periods).toHaveLength(2);

    const dashboard = buildWeeklyDashboard({
      goals: session.records.goals,
      points: session.records.points,
      asOf: NOW,
      isNonInstructional: () => false,
    });

    // Five active goals appear; the one proposed/baseline goal is excluded.
    expect(dashboard.rows).toHaveLength(5);
    expect(dashboard.header).toEqual({ scored: 2, collectable: 4, excused: 1, owe: 2 });
    expect(renderHeader(dashboard.header)).toBe("2 of 4 collectable scored · 1 excused · 2 owe");
  });

  it("refuses to unlock without a verified passkey authentication (M0-AUTH gate)", async () => {
    const denying: PasskeyGateway = {
      authenticate: () => Promise.resolve({ verified: false } as VerifiedAuthenticationResponse),
    };
    await expect(
      bootstrapTeacherSession({
        gateway: denying,
        persistence: new InMemoryPersistence(),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

/** Read every stored value out of the ciphertext IndexedDB store. */
function readAllPersisted(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ta-sync");
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction("streams", "readonly").objectStore("streams").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
    open.onerror = () => reject(open.error);
  });
}

/** Flatten every ciphertext blob in the persisted state into one latin1 string for scanning. */
function bytesAsString(values: unknown[]): string {
  const chunks: string[] = [];
  for (const value of values) {
    const state = value as { pending?: Uint8Array[]; snapshot?: Uint8Array };
    const blobs = [...(state.pending ?? []), ...(state.snapshot ? [state.snapshot] : [])];
    for (const blob of blobs) {
      chunks.push(String.fromCharCode(...blob));
    }
  }
  return chunks.join("");
}

describe("at-rest persistence is ciphertext-only (FERPA #10/#11)", () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const del = indexedDB.deleteDatabase("ta-sync");
      del.onsuccess = () => resolve();
      del.onerror = () => resolve();
      del.onblocked = () => resolve();
    });
  });

  it("stores encrypted blobs and no plaintext student data", async () => {
    await bootstrapTeacherSession({ persistence: new IndexedDbPersistence(), now: NOW });

    const persisted = await readAllPersisted();
    expect(persisted.length).toBeGreaterThan(0);

    const atRest = bytesAsString(persisted);
    expect(atRest.length).toBeGreaterThan(0); // something was actually stored
    expect(atRest).not.toContain(PLAINTEXT_MARKER); // ciphertext only — no plaintext goal text
    expect(atRest).not.toContain("Scientific notation");
  });
});
