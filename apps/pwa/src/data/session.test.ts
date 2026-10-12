// @vitest-environment node
//
// Node realm: this suite drives the real libsodium crypto path, which rejects a
// foreign-realm Uint8Array (jsdom's TextEncoder produces one). fake-indexeddb is
// still installed globally by the setup file, so IndexedDbPersistence works here.
import { AuthRequiredError } from "@teacher-assistant/auth";
import {
  generateMasterKey,
  generatePeriodKey,
  ParaKeyring,
  sodiumReady,
  TeacherKeyring,
} from "@teacher-assistant/crypto";
import { asTimestamp, newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { buildWeeklyDashboard, renderHeader } from "@teacher-assistant/store";
import { EncryptedStream, InMemoryPersistence } from "@teacher-assistant/sync";
import type { VerifiedAuthenticationResponse } from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoDateOf } from "./date.js";
import { IndexedDbPersistence } from "./indexeddb-persistence.js";
import type { PasskeyGateway } from "./passkey.js";
import { bootstrapParaSession, bootstrapTeacherSession } from "./session.js";
import { scoreMutator } from "./writes.js";

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
    // 24 MASTER points: the current-week mix (2 scored, 1 no-data) PLUS the prior-week
    // Goal Detail histories (U4). The 2 para captures do NOT live here — they are in the
    // Period-DEK para doc (asserted via readParaQueue below), NOT the master points map.
    expect(session.records.points).toHaveLength(24);
    expect(session.records.points.some((p) => p.scorer === "para")).toBe(false);
    // The two seeded para captures await validation in the para doc (master-truth queue).
    expect(session.readParaQueue()).toHaveLength(2);
    expect(session.records.periods).toHaveLength(2);
    expect(session.records.probes).toHaveLength(6); // one per active goal + the proposed goal's

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

  it("captures a scored point through the M5 write path and re-reads it", async () => {
    const session = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      now: NOW,
    });
    const goal = session.records.goals.find((g) => g.goal_text === "Multiply fractions");
    if (goal === undefined) {
      throw new Error("expected the Multiply fractions goal");
    }

    await session.capture(
      scoreMutator({
        goalId: goal.goal_id,
        studentId: goal.student_id,
        adminDate: isoDateOf(NOW),
        entryTs: asTimestamp(NOW.getTime()),
        numerator: 5,
        denominatorUsed: 5,
        setting: "math_resource",
      }),
    );

    const after = session.readRecords();
    // Key on the captured week — "Multiply fractions" also carries prior-week
    // history points, so match the point just written for THIS week's admin date.
    const scored = after.points.find(
      (p) => p.goal_id === goal.goal_id && p.state === "scored" && p.admin_date === isoDateOf(NOW),
    );
    expect(scored?.numerator).toBe(5);
    expect(scored?.computed_value).toBe(1);
    // The goal now reads scored, not owes.
    const dash = buildWeeklyDashboard({
      goals: after.goals,
      points: after.points,
      asOf: NOW,
      isNonInstructional: () => false,
    });
    expect(dash.header.scored).toBe(3);
    expect(dash.header.owe).toBe(1);
  });

  it("enters a para-device session that reads ONLY the para doc (roster/administer/pending)", async () => {
    const persistence = new InMemoryPersistence();
    const teacher = await bootstrapTeacherSession({ persistence, now: NOW });
    const para = await bootstrapParaSession(teacher.paraHandoff);

    expect(para.role).toBe("para");
    expect(para.paraRecords.roster.length).toBeGreaterThan(0); // the published 3rd-period roster
    expect(para.paraRecords.pending).toHaveLength(2); // the two seeded para captures
    // The para doc is the projection ONLY: no goal-definition fields are representable.
    const keys = new Set(Object.keys(para.paraRecords));
    expect(keys.has("goals")).toBe(false);
    expect(keys.has("points")).toBe(false);
    // Every pending point is a para capture that is NOT yet validated (C-4).
    for (const p of para.paraRecords.pending) {
      expect(p.scorer).toBe("para");
      expect(p.validated_by).toBeUndefined();
    }
  });

  it("SECURITY INVARIANT: a ParaKeyring cannot open the master stream (key boundary, #9)", async () => {
    await sodiumReady();
    // A master stream sealed under MK, carrying a plaintext marker.
    const masterScope = newScopeTag();
    const masterKeyring = new TeacherKeyring(masterScope, generateMasterKey());
    const docId = newOpaqueId();
    const masterStream = new EncryptedStream(docId, masterScope, masterKeyring);
    masterStream.transact((doc) => doc.getMap("m").set("k", "Two-step equations"));
    const masterSnapshot = masterStream.encryptedSnapshot();

    // A para keyring holds ONLY a Period DEK — never the master scope key.
    const paraKeyring = new ParaKeyring([generatePeriodKey(newScopeTag())]);
    // Attempting to open the master ciphertext with the para keyring fails closed:
    // key possession, not a filter, is the boundary — zero plaintext crosses.
    const paraOnMaster = new EncryptedStream(docId, masterScope, paraKeyring);
    expect(() => paraOnMaster.integrateRemote(masterSnapshot)).toThrow();
    // The master content never materialized in the para stream's doc.
    expect(JSON.stringify(paraOnMaster.doc.toJSON())).not.toContain("Two-step equations");
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

describe("bootstrapTeacherSession — offline-first when the relay fails", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("unlocks + reconciles to offline when every relay pull 404s (un-enrolled device — the ta-qa repro)", async () => {
    // The relay is REACHABLE but 404s this device's streams (H-PUB-3: a device the
    // relay has no ACL grant for gets the same 404 as an unknown doc). Unlock must
    // still succeed from the local encrypted store, and the best-effort reconcile must
    // degrade to offline WITHOUT throwing — it must never surface as a passkey failure.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not_found", record_id: "r" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const session = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      relayBaseUrl: "https://relay.example",
      now: NOW,
    });
    // Local store opened + projections available regardless of the relay.
    expect(session.role).toBe("teacher");
    expect(session.records.students).toHaveLength(4);
    expect(session.readParaQueue()).toHaveLength(2);

    await expect(session.sync()).resolves.toBe(false); // offline, no throw
  });

  it("unlocks + reconciles to offline for BOTH streams when the relay is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const teacher = await bootstrapTeacherSession({
      persistence: new InMemoryPersistence(),
      relayBaseUrl: "https://relay.example",
      now: NOW,
    });
    expect(teacher.records.students).toHaveLength(4);
    await expect(teacher.sync()).resolves.toBe(false);

    // The para session bootstraps and degrades offline too (the second stream).
    const para = await bootstrapParaSession(teacher.paraHandoff);
    expect(para.role).toBe("para");
    expect(para.paraRecords.roster.length).toBeGreaterThan(0);
    await expect(para.sync()).resolves.toBe(false);
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
