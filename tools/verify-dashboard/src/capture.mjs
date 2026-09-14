// Screenshot capture of the real running app, driven with Playwright against a
// `vite preview` of the built PWA. Unlock is one click on the SyntheticPasskey
// gateway (getByTestId("unlock")). Selectors match accessible NAMES: the goal
// detail trigger's name is its aria-label "trend and history <goal>", NOT the
// "Trend & history" title. Every selector miss THROWS — a blank/wrong shot must
// fail the run loudly, not slip through (the failure mode of the old harness).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const MOBILE = { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 };
const SETTLE_MS = 450; // let a sheet/route transition settle before the shot

const paraButton = (page) => page.getByRole("button", { name: /^Para/ });

async function shot(page, outDir, name) {
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  shot ${name}`);
}

async function openLock(page, baseURL) {
  await page.goto(baseURL, { waitUntil: "load" });
  await page.getByTestId("unlock").waitFor({ state: "visible" });
}

async function unlock(page, baseURL) {
  await openLock(page, baseURL);
  await page.getByTestId("unlock").click();
  // The role toggle lives in the app-shell status bar and is present after
  // unlock in both the mobile and desktop layouts — a universal readiness gate.
  await paraButton(page).waitFor({ state: "visible" });
}

async function captureMobile(context, baseURL, outDir) {
  const page = await context.newPage();

  await openLock(page, baseURL);
  await shot(page, outDir, "lock");

  await page.getByTestId("unlock").click();
  await paraButton(page).waitFor({ state: "visible" });
  await shot(page, outDir, "dashboard");

  const group = page.getByRole("button", { name: /^Group:/ });
  await group.click(); // owes-first -> by-period
  await group.click(); // by-period -> by-student
  await shot(page, outDir, "by-student");

  await unlock(page, baseURL);
  await page
    .getByRole("button", { name: /^score /i })
    .first()
    .click();
  await shot(page, outDir, "quickscore");
  await page.getByRole("button", { name: "No data" }).click();
  await shot(page, outDir, "nodata");

  await unlock(page, baseURL);
  await page
    .getByRole("button", { name: /^trend and history/i })
    .first()
    .click();
  await shot(page, outDir, "goal-detail");

  await unlock(page, baseURL);
  await page.getByRole("button", { name: "+ New goal" }).click();
  await shot(page, outDir, "new-goal");

  await unlock(page, baseURL);
  await paraButton(page).click();
  await shot(page, outDir, "para");

  await page.close();
}

async function captureDesktop(context, baseURL, outDir) {
  const page = await context.newPage();

  await unlock(page, baseURL);
  await shot(page, outDir, "desktop-dashboard");

  await paraButton(page).click();
  await shot(page, outDir, "desktop-para");

  await page.close();
}

/** Capture all mobile + desktop views to `outDir` as `<name>.png`. */
export async function captureScreens(baseURL, outDir) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const mobile = await browser.newContext(MOBILE);
    await captureMobile(mobile, baseURL, outDir);
    await mobile.close();

    const desktop = await browser.newContext(DESKTOP);
    await captureDesktop(desktop, baseURL, outDir);
    await desktop.close();
  } finally {
    await browser.close();
  }
}
