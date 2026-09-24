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

import { test as base, type Page, type TestInfo } from "@playwright/test";
import { STEP_STILL_ATTACHMENT } from "../../reporters/evidence-reporter";

export { expect } from "@playwright/test";

/** Resolution cap: a still never exceeds this height (px), however long the page. */
export const STILL_MAX_HEIGHT_PX = 4000;
/** JPEG quality for stills — keeps each file small enough to serve per step. */
const STILL_JPEG_QUALITY = 70;

export interface StepStillsOptions {
  /** Take a full-page still at the end of every journey step (canonical browser only). */
  stepStills: boolean;
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

export const test = base.extend<StepStillsOptions & { step: JourneyStep }>({
  stepStills: [false, { option: true }],
  step: async ({ page, stepStills }, use, testInfo) => {
    let index = 0;
    const step: JourneyStep = <T>(title: string, body: () => Promise<T>) =>
      base.step(title, async (): Promise<T> => {
        const stepIndex = index++;
        if (!stepStills) return body();
        let result: T;
        try {
          result = await body();
        } catch (err) {
          // A failing step still gets its still: the screen it failed on is the most
          // useful evidence on a red card. A capture error must not mask the real one.
          await captureStill(page, testInfo, stepIndex).catch((captureErr: unknown) =>
            noteMissingStill(testInfo, title, captureErr),
          );
          throw err;
        }
        await captureStill(page, testInfo, stepIndex).catch((captureErr: unknown) =>
          noteMissingStill(testInfo, title, captureErr),
        );
        return result;
      });
    await use(step);
  },
});
