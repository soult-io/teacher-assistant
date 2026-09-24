import { describe, expect, it } from "vitest";
import {
  assertJourney,
  deriveJourneyStatus,
  JOURNEY_STATUS,
  makeUnverified,
  mapTestStatus,
} from "./model.mjs";

describe("mapTestStatus", () => {
  it("maps Playwright outcome to journey status", () => {
    expect(mapTestStatus({ outcome: "expected" })).toBe("passed");
    expect(mapTestStatus({ outcome: "unexpected" })).toBe("failed");
    expect(mapTestStatus({ outcome: "flaky" })).toBe("flaky");
    expect(mapTestStatus({ outcome: "skipped" })).toBe("skipped");
  });
  it("falls back to status when outcome is absent", () => {
    expect(mapTestStatus({ status: "passed" })).toBe("passed");
    expect(mapTestStatus({ status: "skipped" })).toBe("skipped");
    expect(mapTestStatus({ status: "timedOut" })).toBe("failed");
    expect(mapTestStatus({})).toBe("failed");
  });
});

describe("deriveJourneyStatus (worst wins)", () => {
  it("all passed → passed", () => {
    expect(deriveJourneyStatus([{ status: "passed" }, { status: "passed" }])).toBe("passed");
  });
  it("any failed → failed, even beside a pass", () => {
    expect(deriveJourneyStatus([{ status: "passed" }, { status: "failed" }])).toBe("failed");
  });
  it("flaky outranks passed but not failed", () => {
    expect(deriveJourneyStatus([{ status: "passed" }, { status: "flaky" }])).toBe("flaky");
    expect(deriveJourneyStatus([{ status: "flaky" }, { status: "failed" }])).toBe("failed");
  });
  it("no browsers → unverified", () => {
    expect(deriveJourneyStatus([])).toBe("unverified");
  });
});

describe("makeUnverified", () => {
  it("has no run/browsers/steps and cannot claim a pass", () => {
    const j = makeUnverified({ id: "J9", name: "Future journey" }, "teacher-assistant");
    expect(j.status).toBe(JOURNEY_STATUS.UNVERIFIED);
    expect(j.run).toBeNull();
    expect(j.browsers).toEqual([]);
    expect(j.steps).toEqual([]);
    expect(j.product).toBe("teacher-assistant");
  });
});

describe("assertJourney (loud validation)", () => {
  const good = {
    id: "J1",
    name: "Score",
    product: "p",
    status: "passed",
    browsers: [],
    steps: [],
    run: { ci_run_id: "1" },
  };
  it("passes a well-formed journey through unchanged", () => {
    expect(assertJourney(good)).toBe(good);
  });
  it("rejects an unknown status", () => {
    expect(() => assertJourney({ ...good, status: "green" })).toThrow(/unknown status/);
  });
  it("rejects a verified journey with no run provenance", () => {
    expect(() => assertJourney({ ...good, run: null })).toThrow(/not bound to a run id/);
  });
  it("rejects a verified journey whose provenance has no run id (nulls are not a binding)", () => {
    expect(() => assertJourney({ ...good, run: { ci_run_id: null, commit_sha: null } })).toThrow(
      /not bound to a run id/,
    );
  });
  it("rejects an unverified journey that carries run provenance", () => {
    expect(() => assertJourney({ ...good, status: "unverified", run: { ci_run_id: "1" } })).toThrow(
      /unverified but carries run/,
    );
  });
  it("accepts a step still that is a served path or an explicit null", () => {
    const steps = [
      { index: 0, screenshot: "stills/J1-chromium-00.jpg", screenshot_truncated: false },
      { index: 1, screenshot: "stills/J1-chromium-01.jpg", screenshot_truncated: true },
      { index: 2, screenshot: "stills/J1-chromium-02.jpg", screenshot_truncated: null },
      { index: 3, screenshot: null, screenshot_truncated: null },
    ];
    expect(assertJourney({ ...good, steps }).steps).toBe(steps);
  });
  it("rejects a step still that is neither a path nor null", () => {
    for (const bad of [undefined, "", 7, { src: "x.jpg" }]) {
      const step = { index: 0, screenshot: bad, screenshot_truncated: null };
      expect(() => assertJourney({ ...good, steps: [step] })).toThrow(
        /screenshot must be a path or null/,
      );
    }
  });
  it("rejects a truncation flag that is not a boolean/null, or set with no still", () => {
    const bads = [
      { screenshot: "stills/J1-chromium-00.jpg", screenshot_truncated: undefined },
      { screenshot: "stills/J1-chromium-00.jpg", screenshot_truncated: "yes" },
      { screenshot: null, screenshot_truncated: false },
      { screenshot: null, screenshot_truncated: undefined },
    ];
    for (const bad of bads) {
      expect(() => assertJourney({ ...good, steps: [{ index: 0, ...bad }] })).toThrow(
        /screenshot_truncated must be/,
      );
    }
  });
  it("accepts a walkthrough recording as the card's video", () => {
    const video = { src: "videos/J1-walkthrough.webm", recording: "walkthrough" };
    expect(assertJourney({ ...good, video }).video).toBe(video);
  });
  it("rejects any other recording as the card's video (the fast one is raw evidence only)", () => {
    for (const recording of [undefined, "gating"]) {
      expect(() =>
        assertJourney({ ...good, video: { src: "videos/J1-chromium.webm", recording } }),
      ).toThrow(/must be a walkthrough recording/);
    }
  });
  it("rejects a missing id or name", () => {
    expect(() => assertJourney({ ...good, id: "" })).toThrow(/string id/);
    expect(() => assertJourney({ ...good, name: undefined })).toThrow(/missing a name/);
  });
});
