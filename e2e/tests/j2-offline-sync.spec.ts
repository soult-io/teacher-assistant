// J2 — Offline capture → reconnect → sync. The offline-first constraint that lets a
// teacher score at home or on a phone with no signal: with the network forced OFF, the
// 3-tap Quick-Score loop (J1) still runs, rows flip to scored IMMEDIATELY, the points
// persist and plot from the LOCAL encrypted store, and reconnecting changes none of the
// entered values.
//
// The guard: this journey FAILS LOUDLY if any step secretly needs the network. Scoring
// runs while context.setOffline(true) makes every request fail, so a hidden network
// dependency would surface as a blocked/erroring step, not pass silently.
//
// SCOPE (confirmed against the built UI): the app shows reachability as ONE global
// status badge ("⚡ offline · syncs later" / "⇅ online"), not a per-row sync mark, and
// it does not auto-push on reconnect. This test asserts what the UI actually does — it
// does not assert a per-row pending-sync mark or an auto-sync-clears-on-reconnect.
//
// The test.step titles and expect() messages are the journey card's step labels and
// assertions — written as human-readable evidence, verbatim.

import { expect, test } from "@playwright/test";
import { goalRow, unlockToDashboard } from "./support/track";

test.describe("J2 — Offline capture → reconnect → sync", () => {
  test("score two probes with the network OFF: rows flip locally, no block/error, reconnect keeps the values", async ({
    page,
  }) => {
    // Any uncaught exception / unhandled rejection while offline is a loud failure of the
    // "the UI never throws offline" guarantee — collect them and assert none at the end.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    const badge = page.getByTestId("offline-badge");
    const oweCount = page.getByTestId("owe-count");
    const sheet = page.getByTestId("quick-score-sheet");
    const computed = page.getByTestId("computed-value");

    // The two goals owing a point this week (owes-first dashboard). Scored OFFLINE below.
    const PROBE_1 = "Two-step equations"; // scored 4 of 5 = 80%
    const PROBE_2 = "Multiply fractions"; // scored 3 of 5 = 60%

    /** The J1 Quick-Score interaction, driven with the network off. */
    async function scoreOffline(goal: string, correct: number, percent: string) {
      await goalRow(page, goal)
        .getByRole("button", { name: `score ${goal}` })
        .click();
      await expect(sheet, `Quick-Score opens for ${goal} with the network off`).toBeVisible();
      const plus = page.getByTestId("stepper-plus");
      for (let i = 0; i < correct; i++) {
        await plus.click();
      }
      await expect(
        computed,
        `${goal} computes ${percent} live from ${correct}/5 while offline — no network to compute it`,
      ).toHaveText(percent);
      await page.getByTestId("save-score").click();
      await expect(
        sheet,
        `the sheet saves and closes offline for ${goal} — never blocks`,
      ).toBeHidden();
    }

    await test.step("Unlock to the Weekly Dashboard — online, 2 goals owe a point", async () => {
      await unlockToDashboard(page);
      await expect(badge, "the status badge reads online at the start").toHaveText("⇅ online");
      await expect(oweCount, "owe-count header reads 2 before scoring").toHaveText("2");
    });

    await test.step("Go offline — the badge flips to offline", async () => {
      await page.context().setOffline(true);
      await expect(
        badge,
        "with the network forced off the badge reads offline · syncs later",
      ).toHaveText("⚡ offline · syncs later");
    });

    await test.step("Score 2 probes with the network OFF — rows flip to scored immediately", async () => {
      await scoreOffline(PROBE_1, 4, "80%");
      await expect(
        goalRow(page, PROBE_1).getByRole("img", { name: "scored" }),
        "row shows 80% and flips to scored, no error, offline",
      ).toBeVisible();
      await expect(goalRow(page, PROBE_1), `${PROBE_1} row shows the computed 80%`).toContainText(
        "80%",
      );
      await expect(oweCount, "owe-count decrements live 2 → 1 while offline").toHaveText("1");

      await scoreOffline(PROBE_2, 3, "60%");
      await expect(
        goalRow(page, PROBE_2).getByRole("img", { name: "scored" }),
        "row shows 60% and flips to scored, no error, offline",
      ).toBeVisible();
      await expect(goalRow(page, PROBE_2), `${PROBE_2} row shows the computed 60%`).toContainText(
        "60%",
      );
      await expect(oweCount, "owe-count decrements live 1 → 0 while offline").toHaveText("0");
    });

    await test.step("The badge stayed offline through both entries — nothing came back online to save them", async () => {
      await expect(
        badge,
        "still offline after scoring — the entries were captured with zero network",
      ).toHaveText("⚡ offline · syncs later");
    });

    await test.step("Open Goal Detail offline — the just-entered point is plotted from the local store", async () => {
      await goalRow(page, PROBE_2)
        .getByRole("button", { name: `trend and history ${PROBE_2}` })
        .click();
      const chart = page.locator("svg.trendsvg");
      await expect(
        chart,
        "the trend chart renders offline — reads work with no network",
      ).toBeVisible();
      await expect(
        chart.locator("circle"),
        "6 points plot: 5 from history + the point just entered offline — read straight from local",
      ).toHaveCount(6);
      await page.getByRole("button", { name: "Dashboard" }).click();
      await expect(oweCount, "back on the Weekly Dashboard").toBeVisible();
    });

    await test.step("Reconnect — the badge flips back to online", async () => {
      await page.context().setOffline(false);
      await expect(badge, "the badge reads online again once the network returns").toHaveText(
        "⇅ online",
      );
    });

    await test.step("After reconnect the entered values are unchanged — both points persisted", async () => {
      await expect(
        goalRow(page, PROBE_1),
        `${PROBE_1} still reads 80% after reconnect — the value was not altered`,
      ).toContainText("80%");
      await expect(
        goalRow(page, PROBE_2),
        `${PROBE_2} still reads 60% after reconnect — the value was not altered`,
      ).toContainText("60%");
      await expect(
        oweCount,
        "both owes stayed cleared across the reconnect — nothing reverted",
      ).toHaveText("0");
    });

    await test.step("The UI never threw while offline", async () => {
      expect(pageErrors, "no uncaught errors during the offline capture + reconnect").toEqual([]);
    });
  });
});
