// J6 — No data (⊘ not 0). A missed session is a documented gap, never a failing score.
// The commit is blocked until the teacher picks a locked reason; the recorded ⊘ carries
// no numeric value, clears the owe, and on Goal Detail shows as a trend GAP that PAUSES
// (never breaks) the consistency run — never a plotted zero.
//
// The test.step titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import { expect, test } from "@playwright/test";
import { goalRow, unlockToDashboard } from "./support/track";

test.describe("J6 — No-data (⊘ not 0)", () => {
  test("owed goal → No data → required reason → ⊘ recorded, owe clears, gap not a zero", async ({
    page,
  }) => {
    await unlockToDashboard(page);

    const GOAL = "Multiply fractions";
    const oweCount = page.getByTestId("owe-count");
    const sheet = page.getByTestId("quick-score-sheet");
    const record = page.getByTestId("record-no-data");

    await test.step("Open Quick-Score for an owed goal, then switch to No data", async () => {
      await expect(oweCount, "owe-count header reads 2 before recording no-data").toHaveText("2");
      await goalRow(page, GOAL)
        .getByRole("button", { name: `score ${GOAL}` })
        .click();
      await page.getByTestId("no-data").click();
    });

    await test.step("The reason set is the five locked teacher reasons", async () => {
      await expect(
        page.getByTestId("reason-chip"),
        "reason set = No time / Absent / Testing / Behavior / No School",
      ).toHaveText(["No time", "Absent", "Testing", "Behavior", "No School"]);
    });

    await test.step("Commit is blocked until a reason is chosen", async () => {
      await expect(
        record,
        "Record is disabled with no reason selected — a reason is mandatory",
      ).toBeDisabled();
    });

    await test.step("Pick the locked reason 'Testing' → Record enables", async () => {
      await page.getByTestId("reason-chip").filter({ hasText: "Testing" }).click();
      await expect(record, "Record enables once a reason is chosen").toBeEnabled();
    });

    await test.step("Record: the row shows ⊘ (distinct from scored) and the owe clears", async () => {
      await record.click();
      await expect(sheet, "the sheet closes on Record").toBeHidden();
      await expect(
        goalRow(page, GOAL).getByTestId("row-nodata"),
        `${GOAL} row shows a ⊘ no-data marker, not a score`,
      ).toContainText("⊘");
      await expect(
        goalRow(page, GOAL).getByRole("img", { name: "no data" }),
        `${GOAL} status is ⊘ no-data — visibly distinct from ● scored`,
      ).toBeVisible();
      await expect(
        oweCount,
        "owe-count decremented from 2 to 1 — the documented ⊘ cleared the owe",
      ).toHaveText("1");
    });

    await test.step("Goal Detail: ⊘ is a gap in the trend, never a plotted zero", async () => {
      await goalRow(page, GOAL)
        .getByRole("button", { name: `trend and history ${GOAL}` })
        .click();
      const chart = page.locator("svg.trendsvg");
      await expect(chart, "the trend chart renders").toBeVisible();
      await expect(
        chart.getByText("⊘"),
        "the ⊘ probe is drawn as a gap marker on the trend",
      ).toBeVisible();
      await expect(
        chart.locator("circle"),
        "5 scored points are plotted and the ⊘ adds no point — it is never a plotted 0",
      ).toHaveCount(5);
      await expect(
        page.getByText("⊘ no-data probe is shown as a gap, never plotted as a zero."),
        "the trend states the ⊘ is a gap, not a zero",
      ).toBeVisible();
    });

    await test.step("The ⊘ stores no numeric value and PAUSES the consistency run", async () => {
      // The recorded ⊘ is the current week — a TRAILING gap after the 4-of-4 ≥80% run.
      // A ⊘ pauses the run; it must not reset it. (The interleaved-gap bridge is proven
      // by the domain-core consistency unit tests, not re-derived here — spec layering.)
      await expect(
        page.getByTestId("consistency-window"),
        "the 4-of-4 scored ≥80% run is preserved after the ⊘ — the no-data pauses it, never resets it",
      ).toContainText("4 of 4");
      const nodataRow = page.locator("tbody tr", { hasText: "⊘ testing" });
      await expect(
        nodataRow,
        "the ⊘ history row records the reason with no numeric % — never a 0",
      ).toContainText("⊘ testing");
      await expect(nodataRow, "the ⊘ row has no scored total (—), never 0/5").toContainText("—");
    });
  });
});
