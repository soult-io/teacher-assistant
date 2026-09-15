import { expect, type Page, test } from "@playwright/test";

/**
 * Wide-monitor desktop layout guard.
 *
 * The desktop shell centers the content column (`.screen-inner`) inside the main
 * column (`.main`, the area right of the 15rem sidebar). Originally the column was
 * capped at a fixed 1180px, which on a 2560px display stranded ~570px of dead grey
 * either side — the owner's "wonky margins". The fix scales the cap up in steps on
 * wide viewports so the column fills most of the main area with balanced, modest
 * margins, while staying capped on laptops. This proves the built app actually lays
 * out that way in a real browser (jsdom has no layout engine) and fails if the cap
 * is ever collapsed back to a fixed width.
 */

async function unlockToDesktopShell(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("unlock").click();
  // The desktop shell (sidebar + main) only exists post-unlock at >=900px.
  await expect(page.locator(".phone.shell .main")).toBeVisible();
}

async function columnGeometry(page: Page): Promise<{
  mainWidth: number;
  innerWidth: number;
  leftGap: number;
  rightGap: number;
  screenOverflow: number;
}> {
  const main = await page.locator(".main").boundingBox();
  const inner = await page.locator(".screen-inner").first().boundingBox();
  if (main === null || inner === null) {
    throw new Error("expected .main and .screen-inner to be laid out");
  }
  // The shell ancestor `.phone` has `overflow: hidden`, so horizontal overflow is
  // clipped there and never reaches documentElement. The real horizontal scroll
  // container is `.main .screen`, so measure the overflow on that element to catch
  // an inner column (a wide grid/table) that outgrows the content area.
  const screenOverflow = await page
    .locator(".main .screen")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  return {
    mainWidth: main.width,
    innerWidth: inner.width,
    leftGap: inner.x - main.x,
    rightGap: main.x + main.width - (inner.x + inner.width),
    screenOverflow,
  };
}

test.describe("wide-monitor content column", () => {
  test("2560px: content fills most of the main column, balanced margins", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await unlockToDesktopShell(page);
    const g = await columnGeometry(page);

    // Scales well past the old fixed 1180px cap (the bug left it at ~1180 here).
    expect(g.innerWidth).toBeGreaterThanOrEqual(1800);
    // Fills most of the main column rather than stranding a narrow strip.
    expect(g.innerWidth / g.mainWidth).toBeGreaterThanOrEqual(0.75);
    // Centered: the two side gaps match within a scrollbar's width.
    expect(Math.abs(g.leftGap - g.rightGap)).toBeLessThanOrEqual(16);
    // No horizontal overflow in the real scroll container (`.main .screen`).
    expect(g.screenOverflow).toBeLessThanOrEqual(1);
  });

  test("1920px: content column scaled up, still balanced", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await unlockToDesktopShell(page);
    const g = await columnGeometry(page);

    expect(g.innerWidth).toBeGreaterThanOrEqual(1500);
    expect(g.innerWidth / g.mainWidth).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(g.leftGap - g.rightGap)).toBeLessThanOrEqual(16);
    expect(g.screenOverflow).toBeLessThanOrEqual(1);
  });

  test("1280px: laptop cap still fills the column (no regression)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await unlockToDesktopShell(page);
    const g = await columnGeometry(page);

    // At 1280 the main column (~1040px) is narrower than the base 1180px cap, so
    // the content fills it (only the content padding + scrollbar gutter remain).
    expect(g.innerWidth / g.mainWidth).toBeGreaterThanOrEqual(0.85);
    expect(g.screenOverflow).toBeLessThanOrEqual(1);
  });
});
