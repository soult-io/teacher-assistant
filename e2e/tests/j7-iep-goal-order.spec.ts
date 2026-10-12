// J7 — Goals in IEP order (TEACH-41). Each student's goals list by the IEP's own goal
// number, not A–Z: the synthetic seed numbers AB's "Two-step equations" Goal 1 and
// "Add integers" Goal 2, so IEP order is the REVERSE of alphabetical — the still shows
// the difference at a glance. Unlabeled goals (EF) show their text alone, never
// "Goal ?".
//
// The step(...) titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import { enterText, expect, test } from "./support/journey";
import { goalActionName, goalRow, unlockToDashboard } from "./support/track";

test.describe("J7 — Goals listed in IEP order", () => {
  test("by student, by period and on Goal Detail: Goal 1 before Goal 2, not A–Z; a duplicate number stays flagged until fixed", async ({
    page,
    step,
  }) => {
    await unlockToDashboard(page);
    const toggle = page.getByTestId("group-toggle");

    await step(
      "Group by student — AB reads Goal 1 · Two-step equations before Goal 2 · Add integers (IEP order, not A–Z)",
      async () => {
        while (!((await toggle.textContent()) ?? "").includes("by student")) {
          await toggle.click();
        }
        const ab = page.locator(".scard").filter({ has: page.locator(".name", { hasText: "AB" }) });
        await expect(
          ab.locator(".sgoal .g"),
          "AB's goals list by IEP number: Goal 1 first, though 'Add integers' is first A–Z",
        ).toHaveText([/^Goal 1.*Two-step equations/, /^Goal 2.*Add integers/]);
        const cd = page.locator(".scard").filter({ has: page.locator(".name", { hasText: "CD" }) });
        await expect(
          cd.locator(".sgoal .g"),
          "CD's goals list by IEP number: Goal 1 · Number line before Goal 2 · Multiply fractions",
        ).toHaveText([/^Goal 1.*Number line/, /^Goal 2.*Multiply fractions/]);
        const ef = page.locator(".scard").filter({ has: page.locator(".name", { hasText: "EF" }) });
        await expect(
          ef.locator(".sgoal .g"),
          "an unlabeled goal shows its text alone — never 'Goal ?'",
        ).toHaveText(["Scientific notation"]);
      },
    );

    await step(
      "Group by period — within P2 the same IEP order holds for each student",
      async () => {
        while (!((await toggle.textContent()) ?? "").includes("by period")) {
          await toggle.click();
        }
        await expect(
          page.getByTestId("goal-row").locator(".rowtitle"),
          "rows read AB Goal 1, AB Goal 2, CD Goal 1, CD Goal 2, then P4's EF",
        ).toHaveText([
          "Two-step equations",
          "Add integers",
          "Number line",
          "Multiply fractions",
          "Scientific notation",
        ]);
        await expect(
          goalRow(page, "Add integers").locator(".rowmeta"),
          "the IEP goal # leads the grey meta line",
        ).toContainText(/^Goal 2 ·/);
      },
    );

    await step("Goal Detail is titled 'Goal 1 · Two-step equations'", async () => {
      await goalRow(page, "Two-step equations")
        .getByRole("button", { name: goalActionName("trend and history", "Two-step equations") })
        .click();
      await expect(
        page.getByRole("heading", { level: 1 }),
        "the heading carries the IEP goal # before the goal text",
      ).toHaveText(/^Goal 1.*Two-step equations$/);
      await expect(
        page.getByTestId("goal-label-edit"),
        "a small 'edit' link opens the inline IEP goal # box",
      ).toHaveText("edit");
    });

    await step(
      "Give Two-step equations the same Goal 2 — Goal Detail and its IC-copy area warn 'AB has two Goal 2 — check before entering'",
      async () => {
        await page.getByTestId("goal-label-edit").click();
        await enterText(page.getByTestId("goal-label-input"), "2");
        await page.getByTestId("goal-label-input").press("Enter");
        await expect(
          page.getByTestId("detail-dup-warning"),
          "Goal Detail names both duplicate goals",
        ).toContainText("AB has two Goal 2 — Two-step equations and Add integers");
        await expect(
          page.getByTestId("ic-dup-warning"),
          "every IC-copy area carries the duplicate warning while it exists",
        ).toHaveText(Array(2).fill("AB has two Goal 2 — check before entering"));
      },
    );

    await step(
      "Back on the dashboard the duplicate cue stays on BOTH of AB's Goal 2 rows — not only at save time",
      async () => {
        await page.getByRole("button", { name: "‹ Dashboard" }).click();
        for (const goal of ["Two-step equations", "Add integers"]) {
          await expect(
            goalRow(page, goal).getByTestId("dup-label-cue"),
            `${goal} shows the lasting "two Goal 2" cue`,
          ).toHaveText("⚠ two Goal 2");
        }
        await expect(
          page.getByTestId("dup-label-cue"),
          "only the two duplicates are flagged",
        ).toHaveCount(2);
      },
    );

    await step("Renumber one goal — the cue clears everywhere", async () => {
      await goalRow(page, "Two-step equations")
        .getByRole("button", { name: goalActionName("trend and history", "Two-step equations") })
        .click();
      await page.getByTestId("goal-label-edit").click();
      await enterText(page.getByTestId("goal-label-input"), "1");
      await page.getByTestId("goal-label-input").press("Enter");
      await expect(page.getByTestId("detail-dup-warning"), "no duplicate remains").toHaveCount(0);
      await page.getByRole("button", { name: "‹ Dashboard" }).click();
      await expect(page.getByTestId("dup-label-cue"), "the cue is gone from every row").toHaveCount(
        0,
      );
    });
  });
});
