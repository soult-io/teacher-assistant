// The walkthrough's interaction overlay (tests/support/journey.ts), on plain synthetic
// pages — no app, no data. Headless recordings draw no mouse, so the walkthrough draws
// its own: a cursor that glides to each action's target, a ring held on the target
// before the action, a ripple on click and a caption naming the action. It must show
// on every click and type, stay out of the page's way (no pointer events, no layout),
// survive navigation and re-renders, never count as a new screen for the TEACH-16
// holds, and never appear in the gating run.

import type { Page } from "@playwright/test";
import { enterText, expect, screenSignature, test } from "./support/journey";

const ORIGIN = "http://overlay.test";

/**
 * A synthetic page whose controls log, at the instant the action reaches them (the
 * first pointerdown or keydown), what the overlay showed: the cursor's tip, the ring's
 * box and kind, how long the ring had been up, the caption, and what is under the
 * target's centre. `extra` is appended to the body.
 */
function html(title: string, extra = ""): string {
  return `<!doctype html><title>${title}</title>
  <style>body { margin: 0; font: 16px sans-serif; } button, input { margin: 24px; font-size: 18px; }</style>
  <h1>${title}</h1>
  <button id="save">Save</button>
  <label for="initials">Student initials</label><input id="initials">
  <a id="next" href="/b">Next</a>
  ${extra}
  <script>
    window.__log = [];
    window.__rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    function snapshot(el, event) {
      const host = document.querySelector("walkthrough-overlay");
      const root = host && host.shadowRoot;
      const part = (name) => root && root.querySelector('[part~="' + name + '"]');
      const cursor = part("cursor"), ring = part("ring"), caption = part("caption");
      const r = window.__rect(el);
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      window.__log.push({
        event, id: el.id, target: r,
        cursor: cursor ? { x: cursor.getBoundingClientRect().left, y: cursor.getBoundingClientRect().top, opacity: getComputedStyle(cursor).opacity } : null,
        ring: ring && host.dataset.ringShownAt ? window.__rect(ring) : null,
        ringKind: host ? host.dataset.ringKind : null,
        ringUpMs: host && host.dataset.ringShownAt ? performance.now() - Number(host.dataset.ringShownAt) : null,
        caption: caption ? caption.textContent : null,
        underCentre: document.elementFromPoint(cx, cy) === el,
      });
    }
    for (const el of document.querySelectorAll("button, input, a")) {
      el.addEventListener("pointerdown", () => snapshot(el, "pointerdown"), { once: true });
      el.addEventListener("keydown", () => snapshot(el, "keydown"), { once: true });
    }
  </script>`;
}

type Snapshot = {
  event: string;
  id: string;
  target: { left: number; top: number; right: number; bottom: number };
  cursor: { x: number; y: number; opacity: string } | null;
  ring: { left: number; top: number; right: number; bottom: number } | null;
  ringKind: string | null;
  ringUpMs: number | null;
  caption: string | null;
  underCentre: boolean;
};

async function serve(p: Page, pages: Record<string, string>): Promise<void> {
  await p.route(`${ORIGIN}/**`, (route) => {
    const body = pages[new URL(route.request().url()).pathname];
    return body
      ? route.fulfill({ contentType: "text/html", body })
      : route.fulfill({ status: 404, body: "" });
  });
}

async function log(p: Page): Promise<Snapshot[]> {
  return p.evaluate(() => (window as unknown as { __log: Snapshot[] }).__log);
}

async function overlayPresent(p: Page): Promise<boolean> {
  return p.evaluate(() => document.querySelector("walkthrough-overlay") !== null);
}

/** The cursor tip sits on the target and the ring surrounds it, up long enough to read. */
function expectPointedAt(s: Snapshot | undefined, kind: string, caption: string): void {
  if (!s) throw new Error("the action never reached its target");
  const { target, cursor, ring } = s;
  expect(cursor, "cursor drawn").not.toBeNull();
  expect(cursor?.opacity, "cursor visible").toBe("1");
  expect(cursor?.x).toBeGreaterThanOrEqual(target.left);
  expect(cursor?.x).toBeLessThanOrEqual(target.right);
  expect(cursor?.y).toBeGreaterThanOrEqual(target.top);
  expect(cursor?.y).toBeLessThanOrEqual(target.bottom);
  expect(ring, "ring shown on the target").not.toBeNull();
  expect(ring?.left).toBeLessThanOrEqual(target.left);
  expect(ring?.top).toBeLessThanOrEqual(target.top);
  expect(ring?.right).toBeGreaterThanOrEqual(target.right);
  expect(ring?.bottom).toBeGreaterThanOrEqual(target.bottom);
  expect(s.ringKind).toBe(kind);
  expect(s.ringUpMs, "ring held before the action").toBeGreaterThanOrEqual(400);
  expect(s.caption).toBe(caption);
  expect(s.underCentre, "the overlay never covers the target for hit-testing").toBe(true);
}

test.describe("walkthrough overlay", () => {
  test.use({ walkthrough: true });

  test("a click glides the cursor to the target, rings it, then ripples", async ({
    page: p,
    step,
  }) => {
    await serve(p, { "/a": html("A") });
    // Nothing is painted into the recording's grey sync frame.
    expect(await overlayPresent(p)).toBe(false);
    await step("click save", async () => {
      await p.goto(`${ORIGIN}/a`);
      const before = await p.locator("#save").evaluate((el) => el.getBoundingClientRect().top);
      await p.locator("#save").click();
      expectPointedAt((await log(p))[0], "click", "Click · Save");
      // No layout shift: the target is where it was without the overlay.
      expect(await p.locator("#save").evaluate((el) => el.getBoundingClientRect().top)).toBe(
        before,
      );
      const ripples = await p.evaluate(
        () =>
          document
            .querySelector("walkthrough-overlay")
            ?.shadowRoot?.querySelectorAll('[part~="ripple"]').length ?? 0,
      );
      expect(ripples, "a click ripple is drawn").toBeGreaterThan(0);
    });
  });

  test("typing shows a focus ring on the field and names it", async ({ page: p, step }) => {
    await serve(p, { "/a": html("A") });
    await step("type initials", async () => {
      await p.goto(`${ORIGIN}/a`);
      await enterText(p.locator("#initials"), "JT");
      expectPointedAt(
        (await log(p)).find((s) => s.event === "keydown"),
        "focus",
        "Type · Student initials",
      );
      await expect(p.locator("#initials")).toHaveValue("JT");
    });
  });

  test("the overlay is out of the page's way", async ({ page: p, step }) => {
    await serve(p, { "/a": html("A") });
    await step("click", async () => {
      await p.goto(`${ORIGIN}/a`);
      await p.locator("#save").click();
      const style = await p.evaluate(() => {
        const host = document.querySelector("walkthrough-overlay");
        if (!host) return null;
        const s = getComputedStyle(host);
        return { pointerEvents: s.pointerEvents, position: s.position, zIndex: s.zIndex };
      });
      expect(style).toEqual({ pointerEvents: "none", position: "fixed", zIndex: "2147483647" });
    });
  });

  test("the overlay is not a new screen: it never adds a hold", async ({ page: p, step }) => {
    await serve(p, { "/a": html("A") });
    await step("click", async () => {
      await p.goto(`${ORIGIN}/a`);
      await p.evaluate(() => document.querySelector("walkthrough-overlay")?.remove());
      const without = await screenSignature(p);
      await p.locator("#save").click();
      expect(await overlayPresent(p)).toBe(true);
      expect(await screenSignature(p)).toBe(without);
    });
  });

  test("it survives a navigation and a re-render", async ({ page: p, step }) => {
    const rerender = `<button id="swap" onclick="document.body.innerHTML = '<button id=after>After</button>'">Swap</button>`;
    await serve(p, { "/a": html("A"), "/b": html("B", rerender) });
    await step("navigate, re-render, click", async () => {
      await p.goto(`${ORIGIN}/a`);
      await p.locator("#next").click();
      await p.waitForURL(`${ORIGIN}/b`);
      // Re-injected into the new document before any action touches it.
      expect(await overlayPresent(p)).toBe(true);
      await p.locator("#save").click();
      expectPointedAt((await log(p))[0], "click", "Click · Save");
      await p.locator("#swap").click();
      await p.locator("#after").click();
      expect(await overlayPresent(p)).toBe(true);
    });
  });
});

test.describe("gating run", () => {
  test("draws no overlay", async ({ page: p, step, walkthrough }) => {
    test.skip(walkthrough, "the gating run only");
    await serve(p, { "/a": html("A") });
    await step("click", async () => {
      await p.goto(`${ORIGIN}/a`);
      await p.locator("#save").click();
      await enterText(p.locator("#initials"), "JT");
      expect(await overlayPresent(p)).toBe(false);
    });
  });
});
