import { describe, expect, it } from "vitest";
import { parseVitestReport } from "./counts.mjs";

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
