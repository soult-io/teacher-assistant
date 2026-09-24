// The journey test API: Playwright's `test` extended with a `step` fixture that wraps
// `test.step` and attaches a full-page still of the page at the end of every step.
// The verification dashboard renders those stills beside each step, so a reader can
// follow the flow screen by screen instead of scrubbing a ~2s video.
//
// Stills are opt-in per Playwright project (`stepStills` in playwright.config.ts) —
// only the canonical browser (chromium) takes them; the other engines run the same
// steps without the capture cost.
//
// The stills are screenshots of the synthetic caseload only (see ./track.ts), the
// same FERPA-safe data the run's video and trace already show.
//
// Walkthrough mode (`walkthrough` option, set only by the E2E_WALKTHROUGH project in
// playwright.config.ts) re-runs the same journeys at human pace for the recording the
// dashboard plays: every step ends with a hold so its screen can be read, and
// `enterText` types character by character instead of filling. The gating run leaves
// the option off, so none of this slows it.

import { test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  RECORDING_START_ANNOTATION,
  STEP_STILL_ATTACHMENT,
} from "../../reporters/evidence-reporter";

export { expect } from "@playwright/test";

/** Resolution cap: a still never exceeds this height (px), however long the page. */
const STILL_MAX_HEIGHT_PX = 4000;
/** JPEG quality for stills — keeps each file small enough to serve per step. */
const STILL_JPEG_QUALITY = 70;

/** Walkthrough: how long the screen stays still at the end of each step (ms). */
export const WALKTHROUGH_STEP_HOLD_MS = 1500;
/** Walkthrough: delay between typed characters (ms) — a person typing, not a paste. */
export const WALKTHROUGH_TYPE_DELAY_MS = 80;

export interface StepStillsOptions {
  /** Take a full-page still at the end of every journey step (canonical browser only). */
  stepStills: boolean;
  /** Human-pace recording mode: hold at the end of each step, type per character. */
  walkthrough: boolean;
}

type JourneyStep = <T>(title: string, body: () => Promise<T>) => Promise<T>;

async function captureStill(page: Page, testInfo: TestInfo, index: number): Promise<void> {
  const width = page.viewportSize()?.width ?? 1280;
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const path = testInfo.outputPath(`step-still-${String(index).padStart(2, "0")}.jpg`);
  await page.screenshot({
    path,
    type: "jpeg",
    quality: STILL_JPEG_QUALITY,
    fullPage: true,
    clip: { x: 0, y: 0, width, height: Math.min(pageHeight, STILL_MAX_HEIGHT_PX) },
  });
  // Attached INSIDE the step body so the reporter attributes it to this step.
  await testInfo.attach(STEP_STILL_ATTACHMENT, { path, contentType: "image/jpeg" });
}

/**
 * A still that could not be taken stays absent — the dashboard shows the step with no
 * still, never a placeholder. The annotation records why, in the run's own report.
 */
function noteMissingStill(testInfo: TestInfo, title: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  testInfo.annotations.push({
    type: "step-still-missing",
    description: `${title}: ${reason}`,
  });
}

/**
 * Pin the recording's time zero. A page's video starts at its first frame that differs
 * from the blank page — not at page creation or test start — so paint a plain grey
 * frame now (a white one would not count) and stamp the instant: the reporter measures
 * step offsets from it, and a seek then lands on the step's own first frame in this
 * recording instead of part-way into it.
 */
async function markRecordingStart(page: Page, testInfo: TestInfo): Promise<void> {
  await page.setContent(
    '<!doctype html><title>walkthrough</title><body style="background:#e5e7eb"></body>',
  );
  testInfo.annotations.push({
    type: RECORDING_START_ANNOTATION,
    description: new Date().toISOString(),
  });
}

/** Hold the current screen so a viewer can read it before the next step starts. */
async function holdForViewer(page: Page): Promise<void> {
  // A closed page (the step's own failure) has nothing left to show; the hold must
  // never replace the step's real result.
  await page.waitForTimeout(WALKTHROUGH_STEP_HOLD_MS).catch(() => undefined);
}

/**
 * Put `text` into a text field. The gating run fills it in one call; a walkthrough
 * types it at a person's pace so the recording shows the text being entered.
 */
export async function enterText(locator: Locator, text: string): Promise<void> {
  const { walkthrough } = base.info().project.use as Partial<StepStillsOptions>;
  if (!walkthrough) {
    await locator.fill(text);
    return;
  }
  await locator.clear();
  await locator.pressSequentially(text, { delay: WALKTHROUGH_TYPE_DELAY_MS });
}

export const test = base.extend<StepStillsOptions & { step: JourneyStep }>({
  stepStills: [false, { option: true }],
  walkthrough: [false, { option: true }],
  step: async ({ page, stepStills, walkthrough }, use, testInfo) => {
    if (walkthrough) await markRecordingStart(page, testInfo);
    let index = 0;
    const step: JourneyStep = <T>(title: string, body: () => Promise<T>) =>
      base.step(title, async (): Promise<T> => {
        const stepIndex = index++;
        if (walkthrough) {
          try {
            return await body();
          } finally {
            await holdForViewer(page);
          }
        }
        if (!stepStills) return body();
        try {
          return await body();
        } finally {
          // A failing step still gets its still: the screen it failed on is the most
          // useful evidence on a red card. The capture's own error is caught and noted,
          // so it never replaces the step's result or its real error.
          await captureStill(page, testInfo, stepIndex).catch((captureErr: unknown) =>
            noteMissingStill(testInfo, title, captureErr),
          );
        }
      });
    await use(step);
  },
});
