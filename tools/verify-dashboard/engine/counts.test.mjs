import { describe, expect, it } from "vitest";
import { deriveE2eCount, parseVitestReport } from "./counts.mjs";

describe("parseVitestReport", () => {
  it("reads pass count and FILE count (testResults.length, not describe blocks)", () => {
    const report = {
      numPassedTests: 107,
      numTotalTestSuites: 49, // must be ignored — counts describes, not files
      testResults: [{}, {}, {}, {}, {}, {}, {}, {}], // 8 files
    };
    expect(parseVitestReport(report)).toEqual({ pass: 107, files: 8 });
  });
  it("defaults missing fields to zero", () => {
    expect(parseVitestReport({})).toEqual({ pass: 0, files: 0 });
    expect(parseVitestReport(null)).toEqual({ pass: 0, files: 0 });
  });
});

describe("deriveE2eCount", () => {
  it("counts every journey bound to a real run (any non-unverified status ran)", () => {
    const journeys = [
      { status: "passed" },
      { status: "flaky" },
      { status: "failed" },
      { status: "skipped" },
    ];
    expect(deriveE2eCount(journeys)).toBe(4);
  });

  it("counts only the verified journeys when some are UNVERIFIED", () => {
    const journeys = [{ status: "passed" }, { status: "passed" }, { status: "unverified" }];
    expect(deriveE2eCount(journeys)).toBe(2);
  });

  it("degrades to null (not a silent 0) when NO journey is verified", () => {
    // No evidence / no run bound → every card UNVERIFIED. The tile must degrade
    // honestly like the cards, never assert a real "0 checks ran".
    expect(deriveE2eCount([{ status: "unverified" }, { status: "unverified" }])).toBeNull();
    expect(deriveE2eCount([])).toBeNull();
  });

  it("returns null for a non-array input", () => {
    expect(deriveE2eCount(undefined)).toBeNull();
    expect(deriveE2eCount(null)).toBeNull();
  });
});
