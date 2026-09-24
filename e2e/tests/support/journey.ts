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
//
// A step can show more than one screen: a click mid-step opens Goal Detail, a sheet,
// or another view before the step's own end. slowMo only pauses ~300ms after each
// action, so the walkthrough also holds before any UI action that would leave a screen
// not yet held — see `holdIfNewScreen`. Typing and clicks within one screen keep the
// ordinary slowMo pace.

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
const WALKTHROUGH_STEP_HOLD_MS = 1500;
/** Walkthrough: delay between typed characters (ms) — a person typing, not a paste. */
const WALKTHROUGH_TYPE_DELAY_MS = 80;

/** Walkthrough: the app's view container — its children are the view on screen. */
const VIEW_CONTAINER_SELECTOR = "#screen";

/** Walkthrough: the Locator and Page methods that drive the UI; each is held first. */
const LOCATOR_ACTIONS = [
  "check",
  "clear",
  "click",
  "dblclick",
  "dragTo",
  "fill",
  "hover",
  "press",
  "pressSequentially",
  "selectOption",
  "selectText",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
] as const;
const PAGE_ACTIONS = [
  "check",
  "click",
  "dblclick",
  "fill",
  "goBack",
  "goForward",
  "goto",
  "hover",
  "press",
  "reload",
  "selectOption",
  "setChecked",
  "setInputFiles",
  "tap",
  "type",
  "uncheck",
] as const;

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
 * What screen the viewer sees, as a string that changes exactly when the screen does:
 * the document and URL, the mounted view elements, and each open dialog/sheet. Elements
 * are compared by identity, not markup — a new view mounts a new element, while the
 * same view re-rendering (a typed character, a ticked box) keeps its own. Null when
 * the page cannot answer (closed, mid-navigation): no hold is better than a crash.
 */
async function screenSignature(page: Page): Promise<string | null> {
  return page
    .evaluate((containerSelector) => {
      // Per document: a random tag (a reload is a new screen) and element ids.
      const w = window as unknown as {
        __walkthrough?: { doc: string; ids: WeakMap<Element, number>; next: number };
      };
      w.__walkthrough ??= { doc: Math.random().toString(36).slice(2), ids: new WeakMap(), next: 0 };
      const state = w.__walkthrough;
      const idOf = (el: Element): number => {
        let id = state.ids.get(el);
        if (id === undefined) {
          state.next += 1;
          id = state.next;
          state.ids.set(el, id);
        }
        return id;
      };
      const parts = [state.doc, location.href];
      const container = document.querySelector(containerSelector);
      // The desktop shell nests the view one level deeper, in .screen-inner.
      const holder = container?.querySelector(":scope > .screen-inner") ?? container;
      // No container (the lock screen): the app root itself holds the view.
      const views = holder ?? document.getElementById("root") ?? document.body;
      for (const view of Array.from(views?.children ?? [])) parts.push(`view:${idOf(view)}`);
      // A row added or removed (a confirmed point leaving a queue) changes what the view
      // shows; typed text and a changed number do not add or remove elements.
      parts.push(`elements:${views?.getElementsByTagName("*").length ?? 0}`);
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], dialog[open]',
      );
      for (const dialog of Array.from(dialogs)) {
        if (dialog.checkVisibility()) parts.push(`dialog:${idOf(dialog)}`);
      }
      return parts.join("|");
    }, VIEW_CONTAINER_SELECTOR)
    .catch(() => null);
}

/** Per walkthrough page: the screen last held for the viewer. */
const heldScreens = new WeakMap<Page, { signature: string | null }>();

/**
 * Before a UI action: if the screen changed since it was last held, hold it now, so a
 * screen reached mid-step (a view opened by a click, a sheet) is on screen at least
 * WALKTHROUGH_STEP_HOLD_MS before the action that leaves it. No-op off walkthrough.
 */
async function holdIfNewScreen(page: Page): Promise<void> {
  const held = heldScreens.get(page);
  if (!held) return;
  const signature = await screenSignature(page);
  if (signature === null || signature === held.signature) return;
  // Recorded BEFORE the hold: a nested action (clear() calls fill()) must not hold again.
  held.signature = signature;
  await holdForViewer(page);
}

/** End of a step: always hold, and record the screen held so the next action skips it. */
async function holdStepEnd(page: Page): Promise<void> {
  const held = heldScreens.get(page);
  if (held) held.signature = await screenSignature(page);
  await holdForViewer(page);
}

let actionsWrapped = false;

/**
 * Route every UI action through `holdIfNewScreen`. Playwright has no before-action
 * hook, so the public Locator and Page methods are wrapped on their prototypes, once
 * per worker. Only pages registered in `heldScreens` (walkthrough) are ever held.
 */
function wrapActionsOnce(page: Page): void {
  if (actionsWrapped) return;
  actionsWrapped = true;
  const wrap = (proto: object, names: readonly string[], pageOf: (self: never) => Page) => {
    const methods = proto as Record<string, unknown>;
    for (const name of names) {
      const original = methods[name];
      if (typeof original !== "function") continue;
      methods[name] = async function (this: never, ...args: unknown[]) {
        await holdIfNewScreen(pageOf(this));
        return original.apply(this, args);
      };
    }
  };
  wrap(Object.getPrototypeOf(page), PAGE_ACTIONS, (self: Page) => self);
  wrap(Object.getPrototypeOf(page.locator("body")), LOCATOR_ACTIONS, (self: Locator) =>
    self.page(),
  );
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
    if (walkthrough) {
      await markRecordingStart(page, testInfo);
      wrapActionsOnce(page);
      // The grey sync frame counts as held: the first navigation away is not delayed.
      heldScreens.set(page, { signature: await screenSignature(page) });
    }
    let index = 0;
    const step: JourneyStep = <T>(title: string, body: () => Promise<T>) =>
      base.step(title, async (): Promise<T> => {
        const stepIndex = index++;
        if (!stepStills && !walkthrough) return body();
        try {
          return await body();
        } finally {
          // A failing step still gets its still: the screen it failed on is the most
          // useful evidence on a red card. The capture's own error is caught and noted,
          // so it never replaces the step's result or its real error.
          if (stepStills) {
            await captureStill(page, testInfo, stepIndex).catch((captureErr: unknown) =>
              noteMissingStill(testInfo, title, captureErr),
            );
          }
          if (walkthrough) await holdStepEnd(page);
        }
      });
    await use(step);
    heldScreens.delete(page);
  },
});
