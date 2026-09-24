// J3 — Weekly close-out (confirm a para point → draft IC statement). The weekly
// payoff: a point a para entered sits PENDING until the teacher confirms it; only then
// does it count, lift the monitoring-complete tally, and become part of the record that
// goes to Infinite Campus. Goal Detail then shows the draft IC statement in its TRUE
// state — held at INDETERMINATE under the data gate, making no trend claim it cannot
// defend — and a goal that reaches criterion is flagged for the teacher, never
// auto-closed.
//
// The step(...) titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import type { Page } from "@playwright/test";
import { expect, test } from "./support/journey";
import { goalRow, unlockToDashboard } from "./support/track";

// The clean, on-basis para capture the teacher confirms (student AB). Its short master
// history (2 scored points) keeps the post-confirm statement under the ≥8-point gate.
const GOAL = "Two-step equations";
// A DIFFERENT goal (student CD) whose run has reached criterion — the mastery-candidate
// case (integrity #9). Its statement is ALSO indeterminate (only 5 scored points): the
// consistency window and the trend gate deliberately diverge.
const MASTERY_GOAL = "Multiply fractions";
// The current (pinned) instructional week and the seed's IEP-end horizon. The IEP-end
// date is what an ON-TREND statement would project mastery to; asserting it is ABSENT
// from the indeterminate statement proves no predicted mastery date was emitted.
const THIS_WEEK = "2026-05-13";
const IEP_END = "2026-07-22";

/** The ARC history (audit) card on Goal Detail — scoped so row asserts never catch a chart label. */
function historyCard(page: Page) {
  return page.locator(".card").filter({ hasText: "ARC history (audit)" });
}

/** Back to the Weekly Dashboard from a Goal Detail / validation screen. */
async function backToDashboard(page: Page): Promise<void> {
  await page.locator("button.back").first().click();
  await expect(page.getByTestId("header-line")).toBeVisible();
}

test.describe("J3 — Weekly close-out (confirm a para point → draft IC statement)", () => {
  test("pending para point → Confirm → counted + export-eligible → INDETERMINATE draft IC statement", async ({
    page,
    step,
  }) => {
    // Capture what the "Copy to IC" / "Copy for IC" buttons write to the clipboard, so we
    // can prove the exported value is exactly the value shown in-app — deterministically
    // and identically on Chromium and Firefox (no clipboard permission needed). Registered
    // before the app loads; a no-op fallback if the override is refused.
    await page.addInitScript(() => {
      const w = window as unknown as { __copied?: string[] };
      w.__copied = [];
      const capture = (text: string): Promise<void> => {
        (w.__copied as string[]).push(String(text));
        return Promise.resolve();
      };
      try {
        if (navigator.clipboard) {
          Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value: capture,
          });
        } else {
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: capture },
          });
        }
      } catch {
        // Native clipboard left in place; the on-screen text assertions still hold.
      }
    });

    await unlockToDashboard(page);

    const monitoringComplete = page.getByTestId("monitoring-complete");
    const oweCount = page.getByTestId("owe-count");
    const validateNote = page.getByTestId("validate-note");

    await step(
      "Weekly Dashboard opens: 2 monitoring points in, 2 goals owe, 2 para points await the teacher's OK",
      async () => {
        await expect(
          page.getByTestId("header-line"),
          "the three-state header reads 2 of 4 collectable scored · 1 excused · 2 owe",
        ).toHaveText("2 of 4 collectable scored · 1 excused · 2 owe");
        await expect(monitoringComplete, "monitoring-complete tally starts at 2").toHaveText("2");
        await expect(oweCount, "2 goals still owe a point").toHaveText("2");
        await expect(
          validateNote,
          "2 para points are queued as awaiting the teacher's OK",
        ).toContainText("2 para points awaiting your OK");
        await expect(
          goalRow(page, GOAL).getByText("⏳ para point — awaiting your OK"),
          `${GOAL} is an owes row carrying a pending para point — not yet counted`,
        ).toBeVisible();
      },
    );

    await step(
      "Confirm gate — before Confirm, no copy-to-IC path reaches the unconfirmed para point",
      async () => {
        // Open the goal's export surface (Goal Detail) BEFORE confirming. The pending para
        // value lives in the para doc, never master truth, so it is absent from the audit
        // history and from the statement's data — the statement is drawn from 2 points only.
        await goalRow(page, GOAL)
          .getByRole("button", { name: `trend and history ${GOAL}` })
          .click();
        await expect(
          historyCard(page).locator("tbody tr"),
          "the ARC history shows only the 2 teacher-scored points — the pending para point is NOT a counted record",
        ).toHaveCount(2);
        await expect(
          historyCard(page).getByText(THIS_WEEK),
          "there is no counted point this week yet — the unconfirmed para point never entered the export record",
        ).toHaveCount(0);
        await expect(
          page.getByTestId("statement-variant"),
          "the draft IC statement is INDETERMINATE on 2 points — it makes no trend claim it cannot defend",
        ).toHaveText("Indeterminate");
        await backToDashboard(page);
      },
    );

    await step(
      "Open the para-validation queue: the point entered by JT is pending, itemized, individually confirmable",
      async () => {
        await validateNote.click();
        await expect(
          page.getByTestId("para-pending-row"),
          "both para captures are listed for confirmation — one row each, values shown (no collapsed confirm-all)",
        ).toHaveCount(2);
        const row = page.getByTestId("para-pending-row").filter({ hasText: GOAL });
        await expect(
          row.getByLabel("pending"),
          `${GOAL}'s para point is ⏳ pending until the teacher OKs it`,
        ).toBeVisible();
        await expect(row, "the row shows the value the para entered (3/5 = 60%)").toContainText(
          "60%",
        );
        await expect(row, "the entry is attributed to the para handle JT").toContainText("JT");
        await expect(
          row.getByTestId("para-confirm"),
          "the point is individually confirmable — Confirm and Fix per row",
        ).toBeVisible();
        await expect(
          row.getByTestId("para-fix"),
          "each row is also individually correctable",
        ).toBeVisible();
      },
    );

    await step(
      "Confirm the para point: it drops from the queue — promoted to master truth",
      async () => {
        await page
          .getByTestId("para-pending-row")
          .filter({ hasText: GOAL })
          .getByTestId("para-confirm")
          .click();
        await expect(
          page.getByTestId("para-pending-row").filter({ hasText: GOAL }),
          `${GOAL}'s confirmed point leaves the queue`,
        ).toHaveCount(0);
        await expect(
          page.getByTestId("para-pending-row"),
          "one para point (the other student) is still awaiting confirmation — each stands alone",
        ).toHaveCount(1);
        await backToDashboard(page);
      },
    );

    await step("Confirming updates the monitoring-complete count and clears the owe", async () => {
      await expect(
        monitoringComplete,
        "monitoring-complete incremented 2 → 3 — the confirmed para point now counts",
      ).toHaveText("3");
      await expect(
        oweCount,
        "the owe-count decremented 2 → 1 — the goal's week is closed",
      ).toHaveText("1");
      await expect(
        goalRow(page, GOAL).getByRole("img", { name: "scored" }),
        `${GOAL} row flipped to ● counted`,
      ).toBeVisible();
      await expect(validateNote, "one para point remains awaiting the teacher's OK").toContainText(
        "1 para point awaiting your OK",
      );
    });

    await step(
      "Goal Detail: the confirmed para point is now a counted, export-eligible record (in-app value == export value)",
      async () => {
        await goalRow(page, GOAL)
          .getByRole("button", { name: `trend and history ${GOAL}` })
          .click();
        await expect(
          historyCard(page).locator("tbody tr"),
          "the ARC history now holds 3 counted points — the confirmed para point joined the record",
        ).toHaveCount(3);
        // Disambiguated by admin date: every seeded point has a distinct admin_date, so this
        // week's row is the confirmed para point alone (its 60% coincides with an older week's
        // value, hence the date match, not a %-match).
        const paraRow = historyCard(page).locator("tbody tr", { hasText: THIS_WEEK });
        await expect(
          paraRow,
          "this week's counted point is the para's 3/5 = 60%, scored by the para and validated by the teacher",
        ).toContainText("60%");
        await expect(paraRow, "the counted point records the para as scorer").toContainText("para");
        await expect(paraRow, "the counted point records the teacher as validator").toContainText(
          "teacher",
        );
      },
    );

    await step(
      "Under the data gate the statement holds at INDETERMINATE — no trend, no predicted mastery date",
      async () => {
        await expect(
          page.getByTestId("statement-variant"),
          "3 scored points is under the 8-point gate — the statement is INDETERMINATE, not ON-TREND / NOT-ON-TREND",
        ).toHaveText("Indeterminate");
        const statement = page.getByTestId("auto-statement");
        await expect(
          statement,
          "the statement says more data are needed before a trend toward 80% can be claimed",
        ).toContainText("additional data are needed to establish a reliable trend toward 80%");
        await expect(
          page.getByTestId("indeterminate-hint"),
          "the gate math is surfaced: 5 more scored points are needed for a defensible trend (8 minimum)",
        ).toContainText("Needs 5 more scored data points for a defensible trend (8 minimum).");
        await expect(
          statement,
          "no ON-TREND / NOT-ON-TREND claim is made — the words 'on track' never appear",
        ).not.toContainText(/on track/i);
        await expect(
          statement,
          `no predicted mastery date — the IEP-end horizon (${IEP_END}) is never projected in an indeterminate statement`,
        ).not.toContainText(IEP_END);
        await expect(
          statement,
          "no prior-period percentage delta — an indeterminate statement claims no reporting-period trend",
        ).not.toContainText(/previous reporting period/i);
      },
    );

    await step("The value copied to IC is exactly the value shown in-app", async () => {
      const shown = (
        (await page.getByTestId("auto-statement").locator(".stmttext").textContent()) ?? ""
      ).trim();
      expect(shown, "the on-screen draft statement is non-empty").not.toBe("");
      await page.getByTestId("copy-to-ic").click();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { __copied?: string[] }).__copied?.at(-1) ?? null,
            ),
          {
            message:
              "the text placed on the clipboard for IC equals the draft statement shown in-app — no divergence between what the teacher sees and what is exported",
          },
        )
        .toBe(shown);
    });

    await step(
      "Two-grade-worlds guard: no MYP / Toddle value appears anywhere on the IEP screen",
      async () => {
        await expect(
          page.getByText(/MYP|Toddle/i),
          "the IEP monitoring surface never shows an MYP/Toddle value — the grade-worlds stay separate",
        ).toHaveCount(0);
        await backToDashboard(page);
      },
    );

    await step(
      "Mastery is teacher-acknowledged: a criterion-met goal is FLAGGED, never auto-closed (integrity #9)",
      async () => {
        // A separate goal whose run has reached criterion. The window is met, yet the app
        // only observes it — it surfaces a candidate flag and an Acknowledge action; the
        // status does not auto-flip to mastered and the goal is not closed.
        await goalRow(page, MASTERY_GOAL)
          .getByRole("button", { name: `trend and history ${MASTERY_GOAL}` })
          .click();
        const candidate = page.getByTestId("mastery-candidate");
        await expect(
          candidate,
          `${MASTERY_GOAL} reached criterion — a mastery-candidate flag is surfaced for the teacher`,
        ).toBeVisible();
        await expect(candidate, "the criterion window is reported as met").toContainText(
          "Criterion window met",
        );
        await expect(
          candidate.getByRole("button", { name: "Acknowledge for ARC" }),
          "acknowledging is the teacher's action — the goal is not auto-acknowledged",
        ).toBeVisible();
        await expect(
          candidate,
          "the app states it never closes the goal — retiring is the teacher's call at ARC",
        ).toContainText("never closes the goal");
        await expect(
          page.getByTestId("mastery-acknowledged"),
          "status did NOT auto-flip to mastered — no acknowledged/closed banner is shown",
        ).toHaveCount(0);
        await expect(
          page.getByTestId("statement-variant"),
          "the gates diverge: the consistency window is met, yet on 5 points the trend statement stays INDETERMINATE",
        ).toHaveText("Indeterminate");
      },
    );
  });
});
