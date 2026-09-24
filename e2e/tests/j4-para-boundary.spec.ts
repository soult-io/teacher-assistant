// J4 — Para capture → teacher validate (the FERPA boundary). The highest-risk
// surface: an aide (para JT) enters scores on a locked, period-scoped device, and the
// teacher must OK every one before it becomes a record. This journey proves the
// boundary the way the DOM can honestly witness it:
//
//   "the para UI surfaces only Period-DEK fields; the para doc is ciphertext at rest."
//
// It does NOT — and must not — claim "the para cannot decrypt the master record": the
// DOM cannot witness a decrypt throw. That cryptographic key-scope proof is the
// active-attempt assertion in tools/ferpa-guard/test/ferpa-m13.test.ts (it opens the
// master scope with a ParaKeyring and asserts NoKeyForScopeError, no plaintext). This
// e2e is the UI-separation half and the at-rest-ciphertext half of the same boundary.
//
// One browser context, one synthetic caseload, a role TOGGLE (App.tsx onRole/setRole):
// the para session renders from its OWN Period-DEK `{period}/para-visible` doc, not a
// filter over the teacher's decrypted master records. That is the data-layer separation
// this journey can witness — the para-visible doc simply does not carry the master
// fields. The cryptographic key boundary itself (a ParaKeyring cannot decrypt master)
// is out of scope here and proven at the unit level (ferpa-m13). The step(...) titles
// and expect() messages are the journey card's step labels and assertions, written
// verbatim as human-readable evidence.
//
// SYNTHETIC DATA ONLY (SyntheticPasskeyGateway + buildSyntheticSeed, clock pinned).

import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/journey";
import { unlockToDashboard } from "./support/track";

// The fresh capture target — student AB's "Add integers" goal (P2 = 3rd period, JT's
// class). Chosen deliberately: its master goal_text ("Add integers") DIFFERS from its
// non-PII catalog topic ("Integer operations"), so asserting the goal_text is absent
// while the topic is present is a real separation test, not a coincidence. The
// administer label is built ONLY from the catalog: `<topic> · <standard> · <N> items`.
const TOPIC = "Integer operations";
// The catalog administer label: `<topic> · <standard> · <N> items`. AB has two active
// P2 goals, so a system ordinal (` · Probe N`, a non-PII sequence number — never a
// teacher attribute) is appended for disambiguation; the catalog base below is the
// stable substring the assertions match on, ordinal-agnostic.
const ADMINISTER_LABEL = "Integer operations · NS.A.1 · 5 items";
// The unique row filter — only AB's Integer-operations row carries this topic.
const ROW_FILTER = TOPIC;
// The master-side goal_text for that same goal — teacher-key material the para device
// holds no key for; it must never appear on the para surface.
const GOAL_TEXT = "Add integers";
// The para enters 3 of 5 = 60%. Kept OFF the 80% criterion on purpose, so a stray
// "80%" on the para surface would be the criterion leaking, not the para's own tally.
const PARA_CORRECT = 3;
const PROBE_DEFAULT_TOTAL = "5";
const PARA_VALUE = "60%";

/** The para surface (list + any open capture sheet live inside this container). */
function paraSurface(page: Page): Locator {
  return page.getByTestId("para-surface");
}

/** The administer row for a goal, by its (catalog-only) administer label. */
function administerRow(page: Page, label: string): Locator {
  return page.getByTestId("para-admin-row").filter({ hasText: label });
}

test.describe("J4 — Para capture → teacher validate (the FERPA boundary)", () => {
  test("para surfaces only Period-DEK fields, captures pending; teacher validates; para doc is ciphertext at rest", async ({
    page,
    step,
  }) => {
    await unlockToDashboard(page);

    await step(
      "Switch to the para (JT) role — renders from the period-scoped para-visible doc, not a filter over the teacher's records",
      async () => {
        await page.getByTestId("role-para").click();
        await expect(
          paraSurface(page),
          "the para device shows its one assigned class (3rd period · Math 81 Resource · JT) and nothing else",
        ).toContainText("scoped to this class only");
        // The reassurance copy itself says "no other students, no trends, no export" —
        // so this journey proves the ABSENCE of trend/export DATA (below), never the mere
        // absence of those words, which legitimately appear in that banner.
      },
    );

    await step(
      "Open the capture sheet for AB · Integer operations — the aide administers the assigned probe",
      async () => {
        await administerRow(page, ROW_FILTER).getByTestId("para-score").click();
        await expect(
          page.getByTestId("para-capture-sheet"),
          "the para capture sheet opens for the catalog-labelled probe",
        ).toBeVisible();
      },
    );

    const surface = paraSurface(page);

    await step(
      "The para surface shows ONLY period-scoped, non-PII fields: initials, catalog administer-label, setting picklist, closed observation chips",
      async () => {
        await expect(
          administerRow(page, ROW_FILTER),
          "the administer label is the non-PII catalog only: topic · KY standard · N items",
        ).toContainText(ADMINISTER_LABEL);
        // Roster is period-scoped: AB and CD (3rd period) only.
        await expect(
          surface.getByText("AB").first(),
          "the student's initials show (AB)",
        ).toBeVisible();
        // Setting picklist (closed enum): Resource / Gen-ed / Home.
        await expect(
          surface.getByRole("button", { name: "Resource" }),
          "the setting picklist is a closed chip set (Resource / Gen-ed / Home)",
        ).toBeVisible();
        // Observation chips are a LOCKED closed enum — first and last of the set prove it renders.
        await expect(
          surface.getByRole("button", { name: "Independent", exact: true }),
          "the observation chips are a closed enum (e.g. Independent …)",
        ).toBeVisible();
        await expect(
          surface.getByRole("button", { name: "Self-corrected", exact: true }),
          "… through Self-corrected — a fixed set, no free-text alternative",
        ).toBeVisible();
        // Teacher-only content is explicitly WITHHELD, not silently dropped.
        await expect(
          surface.getByText("teacher-only — not on this device"),
          "student notes are labelled teacher-only — the para device holds no key for them",
        ).toBeVisible();
      },
    );

    await step(
      "Negative space — no master (teacher-key) field is present anywhere on the para surface",
      async () => {
        await expect(
          surface.getByText(GOAL_TEXT, { exact: true }),
          `the goal text "${GOAL_TEXT}" (master, MK-scope) never appears — only its catalog topic "${TOPIC}" does`,
        ).toHaveCount(0);
        await expect(
          surface.getByText("Multiply fractions", { exact: true }),
          "no other goal's master goal_text appears either (Multiply fractions)",
        ).toHaveCount(0);
        await expect(
          surface.getByText("Scientific notation"),
          "a goal from a period with no para (Scientific notation, P4) is entirely absent",
        ).toHaveCount(0);
        await expect(
          surface.getByText("80%"),
          "the criterion percentage (80%) is not shown — the para holds no goal definition",
        ).toHaveCount(0);
        await expect(
          surface.getByText(/criterion/i),
          "nothing labelled 'criterion' appears — criterion level/consistency are master-only",
        ).toHaveCount(0);
        await expect(
          surface.getByText("4 consecutive probes"),
          "the criterion-consistency phrase is absent",
        ).toHaveCount(0);
        await expect(
          surface.getByText("solves the target skill"),
          "the goal's behaviour component (a KY IEP field) is absent",
        ).toHaveCount(0);
        await expect(
          surface.getByText("given a 5-item probe"),
          "the goal's condition/circumstance text (a KY IEP field) is absent",
        ).toHaveCount(0);
        // Other-period students (EF, GH are P4 — no para) are not on this device's roster.
        await expect(
          surface.getByText("EF", { exact: true }),
          "no other-period student initials appear (EF is P4)",
        ).toHaveCount(0);
        await expect(
          surface.getByText("GH", { exact: true }),
          "no other-period student initials appear (GH is P4)",
        ).toHaveCount(0);
        // Trend / mastery / export are DATA surfaces that never render for the para role.
        await expect(
          surface.getByTestId("auto-statement"),
          "no draft IC statement is produced on the para surface",
        ).toHaveCount(0);
        await expect(
          surface.getByTestId("statement-variant"),
          "no on-trend / not-on-trend / indeterminate statement variant is present",
        ).toHaveCount(0);
        await expect(
          surface.getByTestId("copy-to-ic"),
          "no export-to-Infinite-Campus control is reachable from the para surface",
        ).toHaveCount(0);
        await expect(
          surface.getByTestId("mastery-candidate"),
          "no mastery flag is surfaced to the para",
        ).toHaveCount(0);
      },
    );

    await step(
      "Zero free-text inputs — every para input is a bounded numeric field; no text box, textarea, or contenteditable",
      async () => {
        await expect(
          surface.locator('input[type="text"]'),
          "there is no free-text input on the para surface",
        ).toHaveCount(0);
        await expect(surface.locator("textarea"), "there is no textarea").toHaveCount(0);
        await expect(
          surface.locator('[contenteditable="true"]'),
          "there is no contenteditable region",
        ).toHaveCount(0);
        // Stronger: every <input> present is an integer numeric field (# correct / total),
        // clamped by the capture engine — the para types no prose, by design.
        await expect(
          surface.locator('input:not([inputmode="numeric"])'),
          "every input the para can touch is inputmode=numeric — a bounded integer, never free text",
        ).toHaveCount(0);
      },
    );

    await step(
      "The denominator is pre-locked to the probe default (5) — the para administers the assigned probe, and cannot silently redefine its size",
      async () => {
        await expect(
          surface.getByLabel("total items"),
          "the total defaults to the probe's expected denominator (5); a different total would land flagged off-basis for the teacher, not redefine the goal's denominator",
        ).toHaveValue(PROBE_DEFAULT_TOTAL);
      },
    );

    await step(
      "The no-data reasons are Absent / Behavior / No time ONLY — Testing and No-School are the teacher's call, absent here",
      async () => {
        await surface.getByRole("button", { name: "No data" }).click();
        await expect(
          surface.getByRole("button", { name: "Absent" }),
          "Absent is an allowed para no-data reason",
        ).toBeVisible();
        await expect(
          surface.getByRole("button", { name: "Behavior" }),
          "Behavior is an allowed para no-data reason",
        ).toBeVisible();
        await expect(
          surface.getByRole("button", { name: "No time" }),
          "No time is an allowed para no-data reason",
        ).toBeVisible();
        await expect(
          surface.getByRole("button", { name: "Testing" }),
          "Testing is NOT offered to the para — it is a teacher determination",
        ).toHaveCount(0);
        await expect(
          surface.getByRole("button", { name: "No School" }),
          "No-School is NOT offered to the para — it is a teacher determination",
        ).toHaveCount(0);
        // Back to the score mode to save the capture.
        await surface.getByRole("button", { name: "Back" }).click();
      },
    );

    await step("Capture the score (3 of 5 = 60%) — it lands ⏳ pending, not a record", async () => {
      const plus = surface.getByRole("button", { name: "plus", exact: true });
      for (let i = 0; i < PARA_CORRECT; i++) {
        await plus.click();
      }
      await expect(
        surface.getByText(PARA_VALUE),
        "the sheet computes 3 / 5 = 60% live from the steppers (never a typed raw percent)",
      ).toBeVisible();
      await surface.getByRole("button", { name: "Save (pending)" }).click();
      await expect(
        page.getByTestId("para-capture-sheet"),
        "the capture sheet closes after saving",
      ).toHaveCount(0);
      await expect(
        administerRow(page, ROW_FILTER).getByTestId("para-pending"),
        "AB · Integer operations now reads ⏳ pending on the para device — awaiting the teacher's OK",
      ).toBeVisible();
    });

    await step(
      "At-rest strengthener — the para doc reaches IndexedDB as CIPHERTEXT only (no plaintext field bytes)",
      async () => {
        // Read every persisted stream blob from the app's only at-rest store (ta-sync /
        // streams — ciphertext PersistedStreams keyed by opaque docId) and scan the raw
        // bytes for a distinctive field that IS in the decrypted para doc: the administer
        // topic "Integer operations". If encryption at rest holds, those UTF-8 bytes never
        // appear in any stored blob. This proves AT-REST ENCRYPTION, *not* key scope — the
        // key-scope (para-cannot-decrypt-master) proof is the ferpa-guard unit test.
        const scan = await page.evaluate(async (needleStr: string) => {
          const openDb = (): Promise<IDBDatabase> =>
            new Promise((resolve, reject) => {
              const req = indexedDB.open("ta-sync");
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error ?? new Error("open failed"));
            });
          const db = await openDb();
          if (!db.objectStoreNames.contains("streams")) {
            return { entries: 0, bytesScanned: 0, found: false };
          }
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const tx = db.transaction("streams", "readonly");
            const req = tx.objectStore("streams").getAll();
            req.onsuccess = () => resolve(req.result as unknown[]);
            req.onerror = () => reject(req.error ?? new Error("getAll failed"));
          });
          // Each stored value is a PersistedStream: ciphertext { pending: Uint8Array[],
          // cursor, snapshot? }. Collect every ciphertext blob (pending updates + snapshot).
          const toBytes = (b: unknown): Uint8Array | null =>
            b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : null;
          const blobs = values
            .flatMap((v) => {
              const ps = v as { pending?: unknown[]; snapshot?: unknown };
              return [...(ps.pending ?? []), ps.snapshot];
            })
            .map(toBytes)
            .filter((b): b is Uint8Array => b !== null);
          // Decode each blob byte-for-byte to latin1 (lossless: 1 byte → 1 char) and look
          // for the ASCII needle. A plaintext field would show up verbatim; ciphertext
          // does not.
          const asLatin1 = (u8: Uint8Array): string => {
            let s = "";
            for (const byte of u8) {
              s += String.fromCharCode(byte);
            }
            return s;
          };
          const bytesScanned = blobs.reduce((n, b) => n + b.length, 0);
          const found = blobs.some((b) => asLatin1(b).includes(needleStr));
          return { entries: values.length, bytesScanned, found };
        }, TOPIC);

        expect(
          scan.entries,
          "the app persisted encrypted streams to IndexedDB (the scan has real data to inspect)",
        ).toBeGreaterThan(0);
        expect(
          scan.bytesScanned,
          "the scan actually walked ciphertext bytes — it did not silently pass on an empty read",
        ).toBeGreaterThan(0);
        expect(
          scan.found,
          `the para field "${TOPIC}" never appears as plaintext in any at-rest blob — the para doc is ciphertext on disk`,
        ).toBe(false);
      },
    );

    await step(
      "Back to the teacher role: the para's pending point appears in the validation queue — itemized, its value visible, individually correctable",
      async () => {
        await page.getByTestId("role-teacher").click();
        await page.getByTestId("validate-note").click();
        const row = page.getByTestId("para-pending-row").filter({ hasText: GOAL_TEXT });
        await expect(
          row,
          `the teacher (who holds the master key) sees the goal by its real name — "${GOAL_TEXT}"`,
        ).toBeVisible();
        await expect(row, "the captured value is shown for review (3/5 = 60%)").toContainText(
          PARA_VALUE,
        );
        await expect(
          row,
          "the entry is attributed to the opaque device handle JT — never a person name",
        ).toContainText("JT");
        await expect(
          row.getByTestId("para-confirm"),
          "the point is individually confirmable — one row, one Confirm",
        ).toBeVisible();
        await expect(
          row.getByTestId("para-fix"),
          "and individually correctable — a Fix per row, not a blind accept-all",
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /confirm all/i }),
          "there is no bulk confirm-all — every para value is reviewed on its own",
        ).toHaveCount(0);
      },
    );

    await step(
      "Confirm the para point — it promotes to master truth and drops from the queue",
      async () => {
        await page
          .getByTestId("para-pending-row")
          .filter({ hasText: GOAL_TEXT })
          .getByTestId("para-confirm")
          .click();
        await expect(
          page.getByTestId("para-pending-row").filter({ hasText: GOAL_TEXT }),
          `the confirmed "${GOAL_TEXT}" point leaves the validation queue — it is now a master record`,
        ).toHaveCount(0);
      },
    );

    await step(
      "Back on the para device: the point is consumed/tombstoned, and NO validated value, trend, or history is written back to the para doc",
      async () => {
        await page.getByTestId("role-para").click();
        const surfaceAfter = paraSurface(page);
        await expect(
          administerRow(page, ROW_FILTER).getByTestId("para-pending"),
          "the ⏳ pending mark is gone — the teacher's validation tombstoned (consumed) the para's pending point",
        ).toHaveCount(0);
        await expect(
          administerRow(page, ROW_FILTER).getByTestId("para-score"),
          "the row returns to a plain administer row — the para holds only a tombstone, carrying no value",
        ).toBeVisible();
        await expect(
          surfaceAfter.getByText(/\d+%/),
          "the validated value (60%) is NOT written back — no percentage is visible on the para device",
        ).toHaveCount(0);
        await expect(
          surfaceAfter.getByText(/validated/i),
          "no validated/trend/history record flows back to the para-visible doc",
        ).toHaveCount(0);
        await expect(
          surfaceAfter.getByTestId("auto-statement"),
          "still no statement, trend, or export on the para device after validation",
        ).toHaveCount(0);
      },
    );
  });
});
