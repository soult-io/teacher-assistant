// J1 — Score a probe (the 3-tap daily loop). The motion a teacher repeats ~20×/day:
// open an owed goal, set # correct, save. The value is COMPUTED from #correct/total
// (the teacher never types a percent); the denominator is pre-filled from the assigned
// probe; and the row leaves the owes group as the owe-count decrements live.
//
// The test.step titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import { expect, test } from "./support/journey";
import { goalRow, unlockToDashboard } from "./support/track";

test.describe("J1 — Score a probe (3-tap loop)", () => {
  test("owed goal → + → Save: computes the %, flips to scored, decrements the owe-count", async ({
    page,
    step,
  }) => {
    await unlockToDashboard(page);

    const GOAL = "Two-step equations";
    const oweCount = page.getByTestId("owe-count");
    const sheet = page.getByTestId("quick-score-sheet");
    const computed = page.getByTestId("computed-value");

    await step("Weekly Dashboard opens owes-first — 2 goals owe a point", async () => {
      await expect(oweCount, "owe-count header reads 2 before scoring").toHaveText("2");
      await expect(
        goalRow(page, GOAL).getByRole("img", { name: "owes" }),
        `${GOAL} starts as an amber ○ owes row`,
      ).toBeVisible();
    });

    await step("Tap 1 of 3 — tap the owed goal row to open Quick-Score", async () => {
      await goalRow(page, GOAL)
        .getByRole("button", { name: `score ${GOAL}` })
        .click();
      await expect(sheet, "Quick-Score sheet opens over the dashboard").toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "total items" }),
        "denominator pre-filled from the assigned 5-item probe",
      ).toHaveValue("5");
      await expect(computed, "0 of 5 correct computes to 0% on open").toHaveText("0%");
    });

    await step(
      "Tap 2 of 3 — tap + to set 4 of 5 correct; the sheet computes 80% live",
      async () => {
        const plus = page.getByTestId("stepper-plus");
        for (let i = 0; i < 4; i++) {
          await plus.click();
        }
        await expect(
          page.getByRole("textbox", { name: "number correct" }),
          "# correct set to 4 with the + stepper",
        ).toHaveValue("4");
        await expect(computed, "computed value = 80% from 4/5, never typed").toHaveText("80%");
      },
    );

    await step("The percent is a computed display, not a typeable field", async () => {
      await expect(
        sheet.locator("input"),
        "the sheet has exactly two inputs — # correct and total — and no percent field to type into",
      ).toHaveCount(2);
    });

    await step(
      "Tap 3 of 3 — Save: the row flips ○→● scored and leaves the owes group",
      async () => {
        await page.getByTestId("save-score").click();
        await expect(sheet, "the sheet closes on Save").toBeHidden();
        await expect(
          goalRow(page, GOAL).getByRole("img", { name: "scored" }),
          `${GOAL} row flipped to ● scored`,
        ).toBeVisible();
        await expect(
          goalRow(page, GOAL).getByRole("img", { name: "owes" }),
          `${GOAL} is no longer an owes row`,
        ).toHaveCount(0);
        await expect(goalRow(page, GOAL), `${GOAL} row shows the computed 80%`).toContainText(
          "80%",
        );
      },
    );

    await step("The owe-count decrements live (2 → 1)", async () => {
      await expect(oweCount, "owe-count header decremented from 2 to 1 after scoring").toHaveText(
        "1",
      );
    });
  });
});
