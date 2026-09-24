// The journey test API: Playwright's `test` extended with a `step` fixture that wraps
// `test.step` and attaches a full-height still of the page at the end of every step.
// The verification dashboard renders those stills beside each step, so a reader can
// follow the flow screen by screen instead of scrubbing a ~2s video.
//
// Full height: the app scrolls inside an inner container, not the document, so a
// `fullPage` screenshot is only ever one viewport. `captureStill` instead grows the
// viewport by the scroll containers' hidden height, takes the still, and puts the
// viewport and every scroll position back — see `captureStill`.
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
// or another view before the step's own end. slowMo only pauses briefly after each
// action (WALKTHROUGH_SLOWMO_MS), so the walkthrough also holds before any UI action that would leave a screen
// not yet held — see `holdIfNewScreen`. Typing and clicks within one screen keep the
// ordinary slowMo pace.

import { test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import {
  RECORDING_START_ANNOTATION,
  STEP_STILL_ATTACHMENT,
  STEP_STILL_META_ATTACHMENT,
  type StillMeta,
} from "../../reporters/evidence-reporter";

export { expect } from "@playwright/test";

/** Resolution cap: a still never exceeds this height (px), however long the page. */
const STILL_MAX_HEIGHT_PX = 4000;
/** JPEG quality for stills — keeps each file small enough to serve per step. */
const STILL_JPEG_QUALITY = 70;
/**
 * Growing the viewport can itself re-flow the page (a sheet sized as a share of the
 * screen grows with it), so the hidden height is re-measured and the viewport grown
 * again, up to this many times.
 */
const STILL_GROW_PASSES = 4;

/** Walkthrough: how long the screen stays still at the end of each step (ms). */
const WALKTHROUGH_STEP_HOLD_MS = 1500;
/** Walkthrough: delay between typed characters (ms) — a person typing, not a paste. */
const WALKTHROUGH_TYPE_DELAY_MS = 80;

/** Walkthrough: where the app shell (AppShell.tsx) mounts the view on screen. */
const VIEW_SELECTORS = {
  /** The screen container; its children are the view. */
  container: "#screen",
  /** The desktop shell's inner column, one level deeper, when present. */
  inner: ":scope > .screen-inner",
  /** No container (the lock screen): the app root's children are the view. */
  root: "#root",
};
/** Walkthrough: how long a held action first waits for its target to exist (ms). */
const WALKTHROUGH_TARGET_WAIT_MS = 10_000;
/** Walkthrough: holds in a row before one action, while the screen keeps changing. */
const WALKTHROUGH_MAX_HOLDS = 3;

/** Walkthrough: the Locator and Page methods that drive the UI; each is held first. */
const LOCATOR_ACTIONS: readonly (keyof Locator & string)[] = [
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
];
const PAGE_ACTIONS: readonly (keyof Page & string)[] = [
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
];

export interface StepStillsOptions {
  /** Take a full-height still at the end of every journey step (canonical browser only). */
  stepStills: boolean;
  /** Human-pace recording mode: hold at the end of each step, type per character. */
  walkthrough: boolean;
}

type JourneyStep = <T>(title: string, body: () => Promise<T>) => Promise<T>;

/**
 * In the page: how many pixels of the screen are hidden below a fold — the most any
 * on-screen vertical scroller hides (the app's `#screen`, an open sheet; on another
 * app, whatever plays those roles), plus the document's own overflow. Generic on
 * purpose: no selector, no per-journey tuning.
 */
function measureHidden(): number {
  let most = 0;
  for (const el of Array.from(document.body.getElementsByTagName("*"))) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (!el.checkVisibility()) continue;
    // Off-screen (a closed sheet slid away) is not part of the still.
    const box = el.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= window.innerHeight || box.height === 0) continue;
    most = Math.max(most, el.scrollHeight - el.clientHeight);
  }
  const root = document.scrollingElement ?? document.documentElement;
  return most + Math.max(0, root.scrollHeight - window.innerHeight);
}

/** The window, carrying the scroll offsets `saveAndResetScroll` recorded for `restoreScroll`. */
type StillScrollWindow = Window & { __stillScroll?: [Element, number][] };

/**
 * In the page: record every vertical scroll offset (the document's and each scrolled
 * element's) and scroll all of them to the top, so a grown viewport shows the screen
 * from its first line. The offsets are kept on the window for `restoreScroll`.
 */
function saveAndResetScroll(): void {
  const w = window as StillScrollWindow;
  const saved: [Element, number][] = [];
  for (const el of [
    document.scrollingElement ?? document.documentElement,
    ...Array.from(document.body.getElementsByTagName("*")),
  ]) {
    if (el.scrollTop > 0) {
      saved.push([el, el.scrollTop]);
      el.scrollTop = 0;
    }
  }
  w.__stillScroll = saved;
}

/** In the page: put back the scroll offsets `saveAndResetScroll` recorded. */
function restoreScroll(): void {
  const w = window as StillScrollWindow;
  for (const [el, top] of w.__stillScroll ?? []) el.scrollTop = top;
  delete w.__stillScroll;
}

/**
 * Put the page back after a capture, even one that failed part-way: the viewport first
 * (scroll offsets are only valid at the original height), then every scroll offset.
 * Each runs even if the other fails; the first failure is then reported.
 */
async function restorePage(page: Page, viewport: { width: number; height: number }): Promise<void> {
  const errors: unknown[] = [];
  await page.setViewportSize(viewport).catch((err: unknown) => errors.push(err));
  await page.evaluate(restoreScroll).catch((err: unknown) => errors.push(err));
  if (errors.length > 0) throw errors[0];
}

/**
 * Take the step's full-height still. The viewport is grown (width unchanged) until
 * every on-screen scroller shows everything or the height cap is reached, the still is
 * taken as a plain viewport screenshot, and then the viewport and every scroll offset
 * are put back exactly — the next step, and the run's video, see the page as it was.
 *
 * A still that could not show the whole screen (over the cap, content that does not
 * grow with the viewport, such as a fixed-height list) is attached with
 * `truncated: true` — cut off, never silently.
 */
async function captureStill(page: Page, testInfo: TestInfo, index: number): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("page has no fixed viewport to grow");
  const path = testInfo.outputPath(`step-still-${String(index).padStart(2, "0")}.jpg`);
  await page.evaluate(saveAndResetScroll);
  let meta: StillMeta;
  try {
    let height = viewport.height;
    let hiddenPx = await page.evaluate(measureHidden);
    for (let pass = 0; pass < STILL_GROW_PASSES && hiddenPx > 0; pass++) {
      const next = Math.min(height + hiddenPx, STILL_MAX_HEIGHT_PX);
      if (next <= height) break;
      height = next;
      await page.setViewportSize({ width: viewport.width, height });
      const before = hiddenPx;
      hiddenPx = await page.evaluate(measureHidden);
      // Content that does not grow with the viewport: growing further shows nothing new.
      if (hiddenPx >= before) break;
    }
    // CSS pixels: one still pixel per page pixel on any device scale, so the height
    // cap bounds the file too.
    await page.screenshot({ path, type: "jpeg", quality: STILL_JPEG_QUALITY, scale: "css" });
    meta = { width: viewport.width, height, truncated: hiddenPx > 0 };
  } finally {
    await restorePage(page, viewport);
  }
  // Attached INSIDE the step body so the reporter attributes both to this step.
  await testInfo.attach(STEP_STILL_ATTACHMENT, { path, contentType: "image/jpeg" });
  await testInfo.attach(STEP_STILL_META_ATTACHMENT, {
    body: JSON.stringify(meta),
    contentType: "application/json",
  });
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
 * the document and URL, the mounted view elements, each open dialog/sheet, and how
 * many elements the view and each dialog hold (a row added or removed, a sheet
 * switching mode). Elements
 * are compared by identity, not markup — a new view mounts a new element, while the
 * same view re-rendering (a typed character, a ticked box) keeps its own. Null when
 * the page cannot answer (closed, mid-navigation): no hold is better than a crash.
 */
async function screenSignature(page: Page): Promise<string | null> {
  return page
    .evaluate((selectors) => {
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
      const container = document.querySelector(selectors.container);
      const holder = container?.querySelector(selectors.inner) ?? container;
      const viewParent = holder ?? document.querySelector(selectors.root) ?? document.body;
      for (const view of Array.from(viewParent?.children ?? [])) {
        parts.push(`view:${idOf(view)}`);
      }
      // Typed text and a changed number add or remove no elements; a new row does.
      parts.push(`elements:${viewParent?.getElementsByTagName("*").length ?? 0}`);
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], dialog[open]',
      );
      for (const dialog of Array.from(dialogs)) {
        if (dialog.checkVisibility()) {
          parts.push(`dialog:${idOf(dialog)}:${dialog.getElementsByTagName("*").length}`);
        }
      }
      return parts.join("|");
    }, VIEW_SELECTORS)
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
  // Sampled again after each hold: a screen that arrived DURING the hold (an async
  // swap still landing) gets its own full hold before the action.
  for (let i = 0; i < WALKTHROUGH_MAX_HOLDS; i++) {
    const signature = await screenSignature(page);
    if (signature === null || signature === held.signature) return;
    // Recorded BEFORE the hold: a nested action (clear() calls fill()) must not hold again.
    held.signature = signature;
    await holdForViewer(page);
  }
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
  wrapActions(Object.getPrototypeOf(page) as Page, PAGE_ACTIONS, (self) => holdIfNewScreen(self));
  wrapActions(
    Object.getPrototypeOf(page.locator("body")) as Locator,
    LOCATOR_ACTIONS,
    async (self) => {
      if (!heldScreens.has(self.page())) return;
      // Wait for the action's own target first: when it belongs to a screen still
      // arriving (an async swap), that screen is sampled — and held — before the
      // action, not missed. A target that never comes is left to the action to report.
      await self
        .waitFor({ state: "attached", timeout: WALKTHROUGH_TARGET_WAIT_MS })
        .catch(() => undefined);
      await holdIfNewScreen(self.page());
    },
  );
}

/** Replace each named method on `proto` with one that awaits `before(this)` first. */
function wrapActions<T extends object>(
  proto: T,
  names: readonly (keyof T & string)[],
  before: (self: T) => Promise<void>,
): void {
  const methods = proto as Record<string, unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = async function (this: T, ...args: unknown[]) {
      await before(this);
      return original.apply(this, args);
    };
  }
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
