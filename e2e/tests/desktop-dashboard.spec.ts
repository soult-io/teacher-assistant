// Desktop dashboard (TEACH-43). On a laptop or monitor (>=900px) every grouping shows the
// same simple student cards — no graph until the teacher clicks ↗, which opens the
// full-screen Goal Detail; Back returns to the dashboard in the grouping they left.
// Runs at the two designed desktop sizes, 1280×800 (a 13–15" laptop) and 1920×1080 (a
// monitor), so the journey stills show the layout at both.
//
// Not a jN- file on purpose: the walkthrough recording (playwright.config.ts) replays
// jN- journeys at the phone size only. The gating run still takes a still per step.
//
// SYNTHETIC DATA ONLY — the same seeded caseload as the phone journeys (./support/track).

import type { Page } from "@playwright/test";
import { expect, test } from "./support/journey";
import { FIXED_NOW } from "./support/track";

const SIZES = [
  { label: "1280×800 laptop", width: 1280, height: 800 },
  { label: "1920×1080 monitor", width: 1920, height: 1080 },
] as const;

async function unlockDesktop(page: Page, size: { width: number; height: number }) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.setViewportSize(size);
  await page.goto("/");
  await page.getByTestId("unlock").click();
  await expect(page.locator(".phone.shell .main")).toBeVisible();
}

/** Horizontal overflow of the real scroll container (`.main .screen`), in px. */
async function screenOverflow(page: Page): Promise<number> {
  return page.locator(".main .screen").evaluate((el) => el.scrollWidth - el.clientWidth);
}

async function groupBy(page: Page, label: string) {
  const toggle = page.getByTestId("group-toggle");
  while (!((await toggle.textContent()) ?? "").includes(label)) {
    await toggle.click();
  }
  await expect(toggle).toHaveText(`Group: ${label}`);
}

/** The labels of the dashboard's card sections, in order. */
function sectionLabels(page: Page) {
  return page.getByTestId("dashboard-body").locator(".cardsection > .grouplabel");
}

test.describe("Desktop dashboard — student cards in every grouping, graph only on ↗", () => {
  for (const size of SIZES) {
    test(`${size.label}: cards in all three groupings; ↗ opens Goal Detail; Back keeps the grouping`, async ({
      page,
      step,
    }) => {
      await unlockDesktop(page, size);

      await step(
        "Lands on 'Group: owes-first' — student cards, no graph, nothing pre-selected",
        async () => {
          await expect(
            page.getByTestId("group-toggle"),
            "the dashboard opens on owes-first",
          ).toHaveText("Group: owes-first");
          await expect(sectionLabels(page), "owes-first is two card sections").toHaveText([
            "Owes a point",
            "Done this week",
          ]);
          await expect(
            page.getByTestId("dashboard-body").locator(".scard").first(),
            "the sections hold student cards",
          ).toBeVisible();
          await expect(page.getByTestId("detail-pane"), "no detail pane").toHaveCount(0);
          await expect(page.getByTestId("goal-row"), "no flat goal rows").toHaveCount(0);
          await expect(
            page.getByRole("img", { name: "progress trend" }),
            "no graph on the dashboard",
          ).toHaveCount(0);
          expect(await screenOverflow(page), "no sideways scroll").toBeLessThanOrEqual(1);
        },
      );

      await step("Group: by period — one card section per period", async () => {
        await groupBy(page, "by period");
        await expect(sectionLabels(page), "a section per period, in period order").toHaveText([
          /^Period P2/,
          /^Period P4/,
        ]);
        await expect(
          page
            .getByTestId("dashboard-body")
            .locator(".cardsection")
            .first()
            .locator(".scard .name"),
          "P2 holds AB and CD's cards",
        ).toHaveText(["AB", "CD"]);
        await expect(page.getByTestId("goal-row"), "still no flat goal rows").toHaveCount(0);
        expect(await screenOverflow(page), "no sideways scroll").toBeLessThanOrEqual(1);
      });

      await step("Group: by student — the same cards in one grid", async () => {
        await groupBy(page, "by student");
        await expect(
          page.getByTestId("dashboard-body"),
          "by student is the card grid itself",
        ).toHaveClass(/scardgrid/);
        await expect(
          page.getByTestId("dashboard-body").locator(".scard"),
          "one card per student",
        ).toHaveCount(3);
        expect(await screenOverflow(page), "no sideways scroll").toBeLessThanOrEqual(1);
      });

      await step(
        "Back to by period, then ↗ on AB's Goal 2 opens the full-screen Goal Detail",
        async () => {
          await groupBy(page, "by period");
          await page
            .getByRole("button", { name: "trend and history Goal 2, Add integers" })
            .click();
          await expect(
            page.getByRole("heading", { level: 1 }),
            "Goal Detail for Goal 2 · Add integers",
          ).toHaveText(/^Goal 2.*Add integers$/);
          await expect(
            page.getByRole("img", { name: "progress trend" }),
            "the graph shows here, on Goal Detail",
          ).toBeVisible();
          await expect(page.getByTestId("dashboard-body"), "the dashboard is replaced").toHaveCount(
            0,
          );
        },
      );

      await step("‹ Dashboard returns to 'Group: by period', not owes-first", async () => {
        await page.getByRole("button", { name: "‹ Dashboard" }).click();
        await expect(page.getByTestId("group-toggle"), "the grouping is kept").toHaveText(
          "Group: by period",
        );
        await expect(sectionLabels(page), "the period sections are back").toHaveText([
          /^Period P2/,
          /^Period P4/,
        ]);
      });
    });
  }
});
