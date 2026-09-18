// Shared setup for the TRACK teacher-journey e2e (J1, J6). Both journeys unlock the
// same synthetic caseload and drive the same Quick-Score surface, so the unlock + the
// row locator live here once.
//
// SYNTHETIC DATA ONLY: the app boots on SyntheticPasskeyGateway + buildSyntheticSeed
// (no real student record), which is what keeps the captured video/trace FERPA-safe.

import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A fixed clock for the synthetic seed. buildSyntheticSeed(now) dates every seeded
 * probe relative to `now` (the admin dates, the trend history, the owes week), so
 * pinning Date makes the dashboard deterministic across runs and both browsers. Noon
 * UTC on a plain instructional weekday — isoDateOf() is UTC, so midday avoids any
 * date-rollover edge, and the calendar marks no week non-instructional.
 */
export const FIXED_NOW = new Date("2026-05-13T12:00:00.000Z");

/** A phone viewport — the 3-tap Quick-Score loop is the mobile (<900px) path. */
export const PHONE = { width: 390, height: 844 } as const;

/**
 * Pin the clock, put the app in the phone layout, and unlock to the Weekly Dashboard
 * on the synthetic caseload. Leaves the page on the owes-first dashboard with the
 * three-state header rendered.
 */
export async function unlockToDashboard(page: Page): Promise<void> {
  // setFixedTime must run before the app's first `new Date()` (read once at mount).
  await page.clock.setFixedTime(FIXED_NOW);
  await page.setViewportSize(PHONE);
  await page.goto("/");
  await page.getByTestId("unlock").click();
  await expect(page.getByTestId("header-line")).toBeVisible();
}

/**
 * The dashboard row for a goal, located by its title. Stable as the row's state changes
 * (owes → scored → ⊘) because the goal title text never moves.
 */
export function goalRow(page: Page, goalText: string): Locator {
  return page.getByTestId("goal-row").filter({ hasText: goalText });
}
