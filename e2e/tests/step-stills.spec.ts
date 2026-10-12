// The step fixture's full-height still (tests/support/journey.ts), on plain synthetic
// pages — no app, no data. The app scrolls inside an inner container, so a still must
// grow to that container's full height, flag a cut-off at the cap, and hand the page
// back exactly as it was (viewport and scroll), so the next step and the run's video
// are unchanged.

import { readFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import {
  STEP_STILL_ATTACHMENT,
  STEP_STILL_META_ATTACHMENT,
  type StillMeta,
} from "../reporters/evidence-reporter";
import { expect, test } from "./support/journey";

const PHONE = { width: 390, height: 844 };

/** The fixed 100dvh app frame: a header, an inner scroller of `contentPx`, a footer. */
function appFrame(contentPx: number, scrollerCss = "flex: 1;", inner = ""): string {
  return `<!doctype html><style>
    body { margin: 0; }
    .frame { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
    header, footer { height: 50px; flex: none; background: #ccc; }
    .scroller { ${scrollerCss} overflow-y: auto; }
    .content { height: ${contentPx}px; background: linear-gradient(#fff, #36c); }
  </style>
  <div class="frame"><header></header>
    <div class="scroller" id="scroller">${inner}<div class="content"></div></div>
  <footer></footer></div>`;
}

/** The meta the fixture attached for the most recent still. */
function lastStillMeta(testInfo: TestInfo): StillMeta {
  const metas = testInfo.attachments.filter((a) => a.name === STEP_STILL_META_ATTACHMENT);
  const body = metas.at(-1)?.body;
  if (!body) throw new Error("no still meta attached");
  return JSON.parse(body.toString("utf8")) as StillMeta;
}

/** Pixel size read from the JPEG's own frame header (SOF), not from what we claimed. */
function jpegSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  let i = 2;
  while (i < b.length) {
    const marker = b.readUInt16BE(i);
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error(`no JPEG frame header in ${path}`);
}

function lastStillPath(testInfo: TestInfo): string {
  const path = testInfo.attachments.filter((a) => a.name === STEP_STILL_ATTACHMENT).at(-1)?.path;
  if (!path) throw new Error("no still attached");
  return path;
}

async function scrollerTop(page: Page): Promise<number> {
  return page.locator("#scroller").evaluate((el) => el.scrollTop);
}

test.describe("step stills are full height", () => {
  test.beforeEach(async ({ page, stepStills }) => {
    test.skip(!stepStills, "stills are taken on the canonical browser only");
    await page.setViewportSize(PHONE);
  });

  test("a long inner scroller is captured whole and the page is handed back as it was", async ({
    page,
    step,
  }, testInfo) => {
    await page.setContent(appFrame(2000));
    await page.locator("#scroller").evaluate((el) => {
      el.scrollTop = 700;
    });
    await step("a step on a long screen", async () => undefined);

    const meta = lastStillMeta(testInfo);
    // header 50 + content 2000 + footer 50: every pixel of the screen, nothing cut off.
    expect(meta).toEqual({ width: 390, height: 2100, truncated: false });
    expect(jpegSize(lastStillPath(testInfo))).toEqual({ width: 390, height: 2100 });
    expect(page.viewportSize()).toEqual(PHONE);
    expect(await scrollerTop(page)).toBe(700);
  });

  test("a screen that fits the viewport is one viewport tall", async ({ page, step }, testInfo) => {
    await page.setContent(appFrame(300));
    await step("a short screen", async () => undefined);
    expect(lastStillMeta(testInfo)).toEqual({ width: 390, height: 844, truncated: false });
  });

  test("a screen taller than the cap is flagged truncated, never silently cropped", async ({
    page,
    step,
  }, testInfo) => {
    await page.setContent(appFrame(6000));
    await step("a very long screen", async () => undefined);
    expect(lastStillMeta(testInfo)).toEqual({ width: 390, height: 4000, truncated: true });
    expect(jpegSize(lastStillPath(testInfo))).toEqual({ width: 390, height: 4000 });
    expect(page.viewportSize()).toEqual(PHONE);
  });

  test("a scroller that does not grow with the viewport is flagged truncated", async ({
    page,
    step,
  }, testInfo) => {
    // A fixed-height scroller: a taller viewport shows no more of it.
    await page.setContent(appFrame(2000, "height: 600px;"));
    await step("a fixed-height scroller", async () => undefined);
    expect(lastStillMeta(testInfo).truncated).toBe(true);
    expect(page.viewportSize()).toEqual(PHONE);
  });

  test("an open sheet sized to the screen is grown and captured whole", async ({
    page,
    step,
  }, testInfo) => {
    // A bottom sheet capped at 90% of the frame, its content a little taller than that.
    await page.setContent(
      `${appFrame(300)}<div style="position: fixed; left: 0; right: 0; bottom: 0; max-height: 90%; overflow-y: auto"><div style="height: 900px"></div></div>`,
    );
    await step("a tall open sheet", async () => undefined);
    const meta = lastStillMeta(testInfo);
    expect(meta.truncated).toBe(false);
    // 900 / 0.9 = 1000: the viewport the sheet needs to show all of its content.
    expect(meta.height).toBeGreaterThanOrEqual(1000);
    expect(page.viewportSize()).toEqual(PHONE);
  });

  test("a capped inner list that does not grow is flagged truncated", async ({
    page,
    step,
  }, testInfo) => {
    // The main scroller fits; a fixed-height list inside it does not.
    const list =
      '<div style="height: 200px; overflow-y: auto"><div style="height: 900px"></div></div>';
    await page.setContent(appFrame(300, "flex: 1;", list));
    await step("a capped inner list", async () => undefined);
    expect(lastStillMeta(testInfo).truncated).toBe(true);
    expect(page.viewportSize()).toEqual(PHONE);
  });
});
