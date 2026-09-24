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
//
// Headless recordings draw no mouse, so a walkthrough draws its own interaction
// overlay (`overlayRuntime`): before every UI action a cursor glides to the target, a
// ring is held on it, and a caption names the action ("Click · Save"); a click ripples
// where it lands, and a field being typed into keeps a focus ring. The test harness
// injects it (an init script per document, re-attached before each action) — never the
// app. It lives in a shadow root on <html>, outside the view and every dialog, so the
// hold logic never sees it as a new screen; it takes no pointer events and no layout.

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
/** Walkthrough overlay: how long the cursor takes to glide to the next target (ms). */
const OVERLAY_GLIDE_MS = 450;
/**
 * Walkthrough overlay: how long the target stays ringed before the action starts (ms).
 * slowMo (WALKTHROUGH_SLOWMO_MS) then adds ~300ms before a click lands, so the ring is
 * up ~600ms at the click.
 */
export const OVERLAY_HIGHLIGHT_MS = 300;
/** Walkthrough overlay: bound on drawing it — the target is already attached (ms). */
const OVERLAY_DRAW_TIMEOUT_MS = 2000;

/** Page actions that load a document: no target to point at, only the screen hold. */
const NAVIGATIONS: ReadonlySet<string> = new Set(["goBack", "goForward", "goto", "reload"]);

/** How the walkthrough overlay shows one Locator action. */
interface ActionOverlay {
  /** "click": ring until the click lands. "focus": ring while the field keeps focus. */
  kind: "click" | "focus" | "other";
  /** The caption's verb, from the action's own arguments where they name it. */
  verb: string | ((args: readonly unknown[]) => string);
  /** A pointer action: Playwright scrolls its target into view, so the overlay does first. */
  scroll: boolean;
}

/**
 * Walkthrough: the Locator methods that drive the UI — each is held first and pointed
 * at by the overlay as its row says. One table, so a wrapped action always has a row.
 */
const LOCATOR_ACTION_OVERLAY = {
  check: { kind: "click", verb: "Check", scroll: true },
  clear: { kind: "focus", verb: "Type", scroll: false },
  click: { kind: "click", verb: "Click", scroll: true },
  dblclick: { kind: "click", verb: "Double-click", scroll: true },
  dragTo: { kind: "other", verb: "Drag", scroll: true },
  fill: { kind: "focus", verb: "Type", scroll: false },
  hover: { kind: "other", verb: "Hover", scroll: true },
  press: {
    kind: "focus",
    verb: (args) => (typeof args[0] === "string" ? `Press ${args[0]}` : "Press"),
    scroll: false,
  },
  pressSequentially: { kind: "focus", verb: "Type", scroll: false },
  selectOption: { kind: "other", verb: "Select", scroll: false },
  selectText: { kind: "focus", verb: "Select text", scroll: false },
  setChecked: {
    kind: "click",
    verb: (args) => (args[0] === false ? "Uncheck" : "Check"),
    scroll: true,
  },
  setInputFiles: { kind: "other", verb: "Upload", scroll: false },
  tap: { kind: "click", verb: "Click", scroll: true },
  type: { kind: "focus", verb: "Type", scroll: false },
  uncheck: { kind: "click", verb: "Uncheck", scroll: true },
  // Locator declares toString; every object literal already has one, so it is no row.
} satisfies Partial<Record<Exclude<keyof Locator & string, "toString">, ActionOverlay>>;
const LOCATOR_ACTIONS = Object.keys(LOCATOR_ACTION_OVERLAY) as (keyof Locator & string)[];
/** A page action with a selector not in the table (page.focus) is shown like a hover. */
const FALLBACK_OVERLAY: ActionOverlay = { kind: "other", verb: "Hover", scroll: false };
/** Walkthrough: the Page methods that drive the UI; each is held first. */
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
export async function screenSignature(page: Page): Promise<string | null> {
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

/** A point on the screen, in CSS pixels from the viewport's top-left. */
interface Point {
  x: number;
  y: number;
}

/** Per walkthrough page: what the recording has shown so far. */
interface WalkthroughState {
  /** The screen last held for the viewer. */
  signature: string | null;
  /** Where the overlay's cursor last pointed; carried into a newly loaded document. */
  cursor: Point | null;
  /** An action is running: an action it calls itself (clear() calls fill()) is not re-shown. */
  acting: boolean;
}

/** Only pages in this map (walkthrough) are ever held or given the overlay. */
const walkthroughPages = new WeakMap<Page, WalkthroughState>();

/**
 * Before a UI action: if the screen changed since it was last held, hold it now, so a
 * screen reached mid-step (a view opened by a click, a sheet) is on screen at least
 * WALKTHROUGH_STEP_HOLD_MS before the action that leaves it. No-op off walkthrough.
 */
async function holdIfNewScreen(page: Page): Promise<void> {
  const held = walkthroughPages.get(page);
  if (!held) return;
  // Sampled again after each hold: a screen that arrived DURING the hold (an async
  // swap still landing) gets its own full hold before the action.
  for (let i = 0; i < WALKTHROUGH_MAX_HOLDS; i++) {
    const signature = await screenSignature(page);
    if (signature === null || signature === held.signature) return;
    // Recorded BEFORE the hold, so an action's own re-check sees the screen as held.
    held.signature = signature;
    await holdForViewer(page);
  }
}

/** End of a step: always hold, and record the screen held so the next action skips it. */
async function holdStepEnd(page: Page): Promise<void> {
  const held = walkthroughPages.get(page);
  if (held) held.signature = await screenSignature(page);
  await holdForViewer(page);
}

/** What the overlay draws for one action: the ring's style and the caption's verb. */
interface PointRequest {
  kind: ActionOverlay["kind"];
  verb: string;
  scroll: boolean;
  /** The cursor's last position, for a document that has not drawn it yet. */
  from: Point | null;
  glideMs: number;
  highlightMs: number;
}

/** Where the overlay pointed, and how long to wait for the glide and the highlight. */
interface PointResult extends Point {
  waitMs: number;
}

/**
 * In the page: the walkthrough's interaction overlay. Called with no arguments (the
 * per-document init script) it only installs; with a target it installs if needed and
 * points at the target: the cursor glides there, then the ring and caption appear.
 *
 * Self-contained on purpose — Playwright serialises it into the page. Everything it
 * draws is in a shadow root on <html> (outside the app's root, the view and any
 * dialog), fixed, pointer-events:none, at the top z-index: it covers nothing for
 * hit-testing, moves no layout, and a re-render of the app cannot remove it.
 */
function overlayRuntime(target?: Element, req?: PointRequest): PointResult | null {
  interface Overlay {
    host: HTMLElement;
    cursor: HTMLElement;
    ring: HTMLElement;
    caption: HTMLElement;
    root: ShadowRoot;
    target: Element | null;
    at: Point | null;
    releaseTimer: number | undefined;
  }
  const w = window as unknown as { __walkthroughOverlay?: Overlay };
  /** The click ripple's animation (ms). */
  const RIPPLE_MS = 550;
  /** A ring no click or focus lets go of (a select, a hover) is hidden after this (ms). */
  const OTHER_RING_MS = 1200;

  const hideRing = (o: Overlay): void => {
    o.ring.style.opacity = "0";
    o.caption.style.opacity = "0";
    delete o.host.dataset.ringShownAt;
    delete o.host.dataset.ringKind;
  };

  const install = (): Overlay => {
    const existing = w.__walkthroughOverlay;
    if (existing) {
      if (!existing.host.isConnected) document.documentElement?.append(existing.host);
      return existing;
    }
    const host = document.createElement("walkthrough-overlay");
    host.style.cssText =
      "position:fixed;inset:0;display:block;pointer-events:none;z-index:2147483647;contain:strict;margin:0;padding:0;border:0;background:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      * { box-sizing: border-box; pointer-events: none; }
      [part~="cursor"] { position: absolute; left: 0; top: 0; width: 26px; height: 30px;
        opacity: 0; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      /* Pink: a colour the app never uses, so the ring never reads as app UI. */
      [part~="ring"] { position: absolute; border-radius: 10px; opacity: 0; }
      [part~="ring"] { border: 3px solid #ec4899; box-shadow: 0 0 0 4px rgba(236,72,153,.3); }
      :host([data-ring-kind="focus"]) [part~="ring"] { border-style: dashed; }
      [part~="caption"] { position: absolute; left: 0; top: 0; max-width: calc(100vw - 16px);
        padding: 4px 10px; border-radius: 999px; background: rgba(17,24,39,.9); color: #fff;
        font: 600 13px/18px system-ui, sans-serif; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; opacity: 0; }
      [part~="ripple"] { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px;
        border-radius: 50%; border: 3px solid #ec4899; background: rgba(236,72,153,.25);
        animation: ripple ${RIPPLE_MS}ms ease-out forwards; }
      @keyframes ripple { from { transform: scale(.2); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    </style>
    <div part="ring"></div><div part="caption"></div>
    <svg part="cursor" viewBox="0 0 26 30" aria-hidden="true">
      <path d="M1.5 1.5 L1.5 24 L7.5 18.5 L11.5 27.5 L15.5 25.8 L11.6 17 L19.5 17 Z"
        fill="#111827" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    </svg>`;
    const part = (name: string): HTMLElement => {
      const el = root.querySelector<HTMLElement>(`[part~="${name}"]`);
      if (!el) throw new Error(`overlay part ${name} missing`);
      return el;
    };
    const o: Overlay = {
      host,
      root,
      cursor: part("cursor"),
      ring: part("ring"),
      caption: part("caption"),
      target: null,
      at: null,
      releaseTimer: undefined,
    };
    w.__walkthroughOverlay = o;
    // The click itself: a ripple where it lands.
    window.addEventListener(
      "pointerdown",
      (e) => {
        const ripple = document.createElement("div");
        ripple.setAttribute("part", "ripple");
        ripple.style.left = `${e.clientX}px`;
        ripple.style.top = `${e.clientY}px`;
        o.root.append(ripple);
        setTimeout(() => ripple.remove(), RIPPLE_MS + 50);
      },
      { capture: true, passive: true },
    );
    // Then the ring lets go — at the click, before the app handles it, so a screen the
    // click opens is never painted with the old target's ring and caption on it.
    window.addEventListener(
      "click",
      () => {
        if (o.host.dataset.ringKind !== "focus") hideRing(o);
      },
      { capture: true, passive: true },
    );
    // A typed-into field keeps its ring only while it has focus.
    document.addEventListener(
      "focusout",
      (e) => {
        if (o.host.dataset.ringKind === "focus" && e.target === o.target) hideRing(o);
      },
      true,
    );
    const mount = (): void => {
      document.documentElement?.append(host);
    };
    // An init script can run before the parser has made <html>.
    if (document.documentElement) mount();
    else document.addEventListener("readystatechange", mount, { once: true });
    return o;
  };

  const o = install();
  if (!target || !req) return null;

  // Point where the action will land: on screen, at the target's centre.
  // A pointer action scrolls its target into view anyway; that scroll is done now, so
  // the ring is drawn where the action lands. Other actions never scroll the page.
  let box = target.getBoundingClientRect();
  const offScreen =
    box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth;
  if (offScreen && req.scroll) {
    target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    box = target.getBoundingClientRect();
  }
  const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max);
  const to = {
    x: clamp(box.left + box.width / 2, innerWidth - 1),
    y: clamp(box.top + box.height / 2, innerHeight - 1),
  };

  // A field already ringed and focused (clear() then typing) is not pointed at twice.
  if (
    req.kind === "focus" &&
    o.target === target &&
    o.host.dataset.ringKind === "focus" &&
    document.activeElement === target
  ) {
    return { ...to, waitMs: 0 };
  }

  clearTimeout(o.releaseTimer);
  hideRing(o);
  o.target = target;

  // The cursor: from where it last was (in this document or the one before) to here.
  const from = o.at ?? req.from ?? { x: innerWidth / 2, y: innerHeight * 0.6 };
  const glideMs = Math.hypot(to.x - from.x, to.y - from.y) < 4 ? 0 : req.glideMs;
  o.cursor.style.transition = "none";
  o.cursor.style.transform = `translate(${from.x}px, ${from.y}px)`;
  o.cursor.style.opacity = "1";
  void o.cursor.getBoundingClientRect(); // commit the start before the glide
  o.cursor.style.transition = `transform ${glideMs}ms cubic-bezier(.4,0,.2,1)`;
  o.cursor.style.transform = `translate(${to.x}px, ${to.y}px)`;
  o.at = to;

  // The caption names the action by the target's accessible name, as a person reads it.
  const clean = (text: string | null | undefined): string =>
    (text ?? "").replace(/\s+/g, " ").trim();
  const el = target as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null };
  const labelledBy = (target.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  const isField = ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
  const name = [
    target.getAttribute("aria-label"),
    labelledBy,
    Array.from(el.labels ?? [], (label) => label.textContent).join(" "),
    target.getAttribute("placeholder"),
    target.getAttribute("title"),
    isField ? "" : el.innerText,
    target.getAttribute("alt"),
  ]
    .map(clean)
    .find((text) => text.length > 0);
  const short = name && name.length > 40 ? `${name.slice(0, 39)}…` : name;

  setTimeout(() => {
    if (o.target !== target) return;
    const pad = 4;
    const now = target.isConnected ? target.getBoundingClientRect() : box;
    Object.assign(o.ring.style, {
      left: `${now.left - pad}px`,
      top: `${now.top - pad}px`,
      width: `${now.width + pad * 2}px`,
      height: `${now.height + pad * 2}px`,
      opacity: "1",
    });
    o.caption.textContent = short ? `${req.verb} · ${short}` : req.verb;
    const cap = o.caption.getBoundingClientRect();
    const below = now.bottom + pad + 8;
    const top = below + cap.height <= innerHeight - 8 ? below : now.top - pad - 8 - cap.height;
    const left = Math.min(Math.max(to.x - cap.width / 2, 8), innerWidth - cap.width - 8);
    o.caption.style.transform = `translate(${left}px, ${Math.max(8, top)}px)`;
    o.caption.style.opacity = "1";
    o.host.dataset.ringKind = req.kind;
    o.host.dataset.ringShownAt = String(performance.now());
    // An action that neither clicks nor keeps focus (a select, a hover) lets go on its own.
    if (req.kind === "other") {
      o.releaseTimer = window.setTimeout(() => hideRing(o), req.highlightMs + OTHER_RING_MS);
    }
  }, glideMs);

  return { ...to, waitMs: glideMs + req.highlightMs };
}

/**
 * Show the viewer what the next action touches: glide the cursor to `target`, ring it,
 * caption it, and wait out the glide and the highlight. Best effort — the overlay can
 * never fail or replace the action; a target it cannot reach is left to the action.
 */
async function pointAt(
  target: Locator,
  action: string,
  args: readonly unknown[],
  state: WalkthroughState,
): Promise<void> {
  const overlay: ActionOverlay =
    (LOCATOR_ACTION_OVERLAY as Record<string, ActionOverlay>)[action] ?? FALLBACK_OVERLAY;
  const request: PointRequest = {
    kind: overlay.kind,
    verb: typeof overlay.verb === "function" ? overlay.verb(args) : overlay.verb,
    scroll: overlay.scroll,
    from: state.cursor,
    glideMs: OVERLAY_GLIDE_MS,
    highlightMs: OVERLAY_HIGHLIGHT_MS,
  };
  const result = await target
    .evaluate(overlayRuntime, request, { timeout: OVERLAY_DRAW_TIMEOUT_MS })
    .catch(() => null);
  if (!result) return;
  state.cursor = { x: result.x, y: result.y };
  if (result.waitMs > 0) {
    await target
      .page()
      .waitForTimeout(result.waitMs)
      .catch(() => undefined);
  }
}

/**
 * One UI action in a walkthrough: hold a screen not yet held, point the overlay at the
 * action's target (if it has one), then run it. Off walkthrough — and for an action
 * another action calls — it just runs.
 */
async function walkthroughAction(
  page: Page,
  target: Locator | null,
  action: string,
  args: readonly unknown[],
  run: () => Promise<unknown>,
): Promise<unknown> {
  const state = walkthroughPages.get(page);
  if (!state || state.acting) return run();
  if (target) {
    // Wait for the action's own target first: when it belongs to a screen still
    // arriving (an async swap), that screen is sampled — and held — before the
    // action, not missed. A target that never comes is left to the action to report.
    await target
      .waitFor({ state: "attached", timeout: WALKTHROUGH_TARGET_WAIT_MS })
      .catch(() => undefined);
  }
  await holdIfNewScreen(page);
  state.acting = true;
  try {
    if (target) await pointAt(target, action, args, state);
    return await run();
  } finally {
    state.acting = false;
  }
}

let actionsWrapped = false;

/**
 * Route every UI action through `walkthroughAction`. Playwright has no before-action
 * hook, so the public Locator and Page methods are wrapped on their prototypes, once
 * per worker. Only pages registered in `walkthroughPages` are ever held or pointed at.
 */
function wrapActionsOnce(page: Page): void {
  if (actionsWrapped) return;
  actionsWrapped = true;
  wrapActions(Object.getPrototypeOf(page) as Page, PAGE_ACTIONS, (self, action, args, run) => {
    // A page action with a selector (page.click("#save")) points at that element.
    const [selector, ...rest] = args;
    const target =
      typeof selector === "string" && !NAVIGATIONS.has(action) ? self.locator(selector) : null;
    return walkthroughAction(self, target, action, target ? rest : args, run);
  });
  wrapActions(
    Object.getPrototypeOf(page.locator("body")) as Locator,
    LOCATOR_ACTIONS,
    (self, action, args, run) => walkthroughAction(self.page(), self, action, args, run),
  );
}

/** Replace each named method on `proto` with one that runs through `around`. */
function wrapActions<T extends object>(
  proto: T,
  names: readonly (keyof T & string)[],
  around: (
    self: T,
    action: string,
    args: unknown[],
    run: () => Promise<unknown>,
  ) => Promise<unknown>,
): void {
  const methods = proto as Record<string, unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = function (this: T, ...args: unknown[]) {
      return around(this, name, args, () => original.apply(this, args) as Promise<unknown>);
    };
  }
}

/**
 * Put `text` into a text field. The gating run fills it in one call; a walkthrough
 * types it at a person's pace so the recording shows the text being entered.
 */
export async function enterText(locator: Locator, text: string): Promise<void> {
  if (!walkthroughPages.has(locator.page())) {
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
      walkthroughPages.set(page, {
        signature: await screenSignature(page),
        cursor: null,
        acting: false,
      });
      // Every later document gets the overlay as it loads. Registered after the sync
      // frame, and drawn only at the first action, so it never shifts the recording's
      // time zero.
      // Top frame only: an iframe's own overlay is drawn when an action targets it.
      await page.addInitScript({
        content: `if (window === window.top) (${overlayRuntime.toString()})()`,
      });
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
    walkthroughPages.delete(page);
  },
});
