import { describe, expect, it } from "vitest";
import {
  aggregate,
  escapeHtml,
  fillTemplate,
  parseVitestReport,
  pillClass,
  renderBars,
  renderCiPills,
} from "./lib.mjs";

describe("escapeHtml", () => {
  it("escapes the four HTML-significant characters", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
  it("stringifies non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("parseVitestReport", () => {
  it("reads pass count and FILE count (testResults.length, not suites)", () => {
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

describe("aggregate", () => {
  it("sums the snapshot's real per-package numbers to 287 pass / 39 files / 9 pkgs", () => {
    // Independently transcribed from the live suites @ main 593a9d3.
    const packages = [
      { pass: 107, files: 8 },
      { pass: 100, files: 16 },
      { pass: 36, files: 7 },
      { pass: 17, files: 3 },
      { pass: 10, files: 1 },
      { pass: 6, files: 1 },
      { pass: 4, files: 1 },
      { pass: 4, files: 1 },
      { pass: 3, files: 1 },
    ];
    expect(aggregate(packages)).toEqual({ unitTotal: 287, fileTotal: 39, pkgCount: 9 });
  });
});

describe("renderBars", () => {
  it("makes the top package full-width and scales the rest relative to it", () => {
    const html = renderBars([
      { label: "domain-core", sub: "engine", pass: 100, barClass: "eng" },
      { label: "store", sub: "projections", pass: 25 },
    ]);
    // 100/100 -> 100%, 25/100 -> 25%.
    expect(html).toContain('class="barrow eng"');
    expect(html).toContain("domain-core<span>engine</span>");
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('<div class="val tnum">25</div>');
  });
  it("does not divide by zero when every count is zero", () => {
    const html = renderBars([{ label: "x", sub: "y", pass: 0 }]);
    expect(html).toContain('style="width:0%"');
  });
});

describe("pillClass / renderCiPills", () => {
  it("maps conclusions to pass/fail/note", () => {
    expect(pillClass("success")).toBe("pass");
    expect(pillClass("failure")).toBe("fail");
    expect(pillClass("in_progress")).toBe("note");
    expect(pillClass(undefined)).toBe("note");
  });
  it("renders a pill per status with escaped labels", () => {
    const html = renderCiPills([
      { label: "verify", conclusion: "success" },
      { label: "e2e", conclusion: "failure" },
    ]);
    expect(html).toContain('<span class="pill pass"><span class="dot"></span>verify</span>');
    expect(html).toContain('<span class="pill fail"><span class="dot"></span>e2e</span>');
  });
});

describe("fillTemplate", () => {
  it("substitutes known tokens and leaves unknown ones visible", () => {
    const out = fillTemplate("a={{A}} b={{B}} c={{MISSING}}", { A: 1, B: "x" });
    expect(out).toBe("a=1 b=x c={{MISSING}}");
  });
  it("does not re-escape HTML-valued tokens (bars/pills are trusted)", () => {
    const out = fillTemplate("{{BARS}}", { BARS: '<div class="barrow"></div>' });
    expect(out).toBe('<div class="barrow"></div>');
  });
});
