import { expect, type Page, test } from "@playwright/test";

/**
 * Wide-monitor desktop layout guard.
 *
 * The desktop shell centers the content column (`.screen-inner`) inside the main
 * column (`.main`, the area right of the 15rem sidebar) and caps its width at
 * `--content-max`, which steps up on wide viewports.
 *
 * Two things the owner flagged at 2560px, both guarded here:
 *   1. Outer gutter. A 2000px cap left only ~160px each side — too tight. The cap is
 *      pulled to 1760px so a balanced ~280px gutter remains. This test fails if the
 *      column ever balloons back toward full width (gutter collapses) OR is collapsed
 *      to a fixed narrow strip.
 *   2. Component padding. The card/cell/stat padding was tuned for the ~1180px column
 *      and never scaled, so text sat pinned to the edges on a wide column. It now scales
 *      on the same breakpoint ladder as the cap; this test measures the real computed
 *      padding/gaps in a browser (jsdom has no layout engine) and fails if they stop
 *      scaling — while proving 1280px is NOT inflated.
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

/** Computed value of a CSS length property (px) for the first match of `selector`. */
async function computedPx(page: Page, selector: string, prop: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, p) => Number.parseFloat(getComputedStyle(el).getPropertyValue(p)) || 0, prop);
}

test.describe("wide-monitor content column", () => {
  test("2560px: balanced ~280px gutter, capped column, no overflow", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await unlockToDesktopShell(page);
    const g = await columnGeometry(page);

    // Scales well past the old fixed 1180px cap, but stays capped near 1760px so a
    // generous gutter remains (the fix pulled 2000 -> 1760 after owner review).
    expect(g.innerWidth).toBeGreaterThanOrEqual(1700);
    expect(g.innerWidth).toBeLessThanOrEqual(1820);
    // The owner's #1 complaint: gutter too tight. Guard a real floor (~280px each side).
    expect(g.leftGap).toBeGreaterThanOrEqual(220);
    // Centered: the two side gaps match within a scrollbar's width.
    expect(Math.abs(g.leftGap - g.rightGap)).toBeLessThanOrEqual(16);
    // No horizontal overflow in the real scroll container (`.main .screen`).
    expect(g.screenOverflow).toBeLessThanOrEqual(1);
  });

  test("2560px: component padding scaled up off the edges", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1440 });
    await unlockToDesktopShell(page);

    // Root cause #2: padding must scale on a wide column, not stay at the 1180px values.
    // Wide-end targets: .headline 1.25rem/20px top, .mddetail 1.4rem/22.4px,
    // .three gap 0.8rem/12.8px, .md gap 2rem/32px.
    expect(await computedPx(page, ".headline", "padding-top")).toBeGreaterThanOrEqual(18);
    expect(
      await computedPx(page, '[data-testid="detail-pane"]', "padding-top"),
    ).toBeGreaterThanOrEqual(20);
    expect(await computedPx(page, ".three", "column-gap")).toBeGreaterThanOrEqual(11);
    expect(await computedPx(page, ".md", "column-gap")).toBeGreaterThanOrEqual(28);
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

  test("1280px: laptop fills the column and padding is NOT inflated", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await unlockToDesktopShell(page);
    const g = await columnGeometry(page);

    // At 1280 the main column (~1040px) is narrower than the base 1180px cap, so
    // the content fills it (only the content padding + scrollbar gutter remain).
    expect(g.innerWidth / g.mainWidth).toBeGreaterThanOrEqual(0.85);
    expect(g.screenOverflow).toBeLessThanOrEqual(1);
    // 1280 is below the first wide breakpoint (1400), so padding stays at the base
    // value (.headline 0.9rem/14.4px) — proving the scaling does not over-inflate laptops.
    expect(await computedPx(page, ".headline", "padding-top")).toBeLessThanOrEqual(16);
  });
});
