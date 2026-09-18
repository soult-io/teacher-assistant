import { describe, expect, it } from "vitest";
import {
  aggregate,
  escapeHtml,
  fillTemplate,
  pillClass,
  renderBars,
  renderCallouts,
  renderCiPills,
  renderSection,
  renderTiles,
} from "./lib.mjs";

describe("escapeHtml", () => {
  it("escapes the four HTML-significant characters", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
  it("stringifies non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("aggregate", () => {
  it("sums per-package numbers to totals + package count", () => {
    const packages = [
      { pass: 107, files: 8 },
      { pass: 100, files: 16 },
      { pass: 36, files: 7 },
    ];
    expect(aggregate(packages)).toEqual({ unitTotal: 243, fileTotal: 31, pkgCount: 3 });
  });
});

describe("renderBars", () => {
  it("makes the top package full-width and scales the rest relative to it", () => {
    const html = renderBars([
      { label: "domain-core", sub: "engine", pass: 100, barClass: "eng" },
      { label: "store", sub: "projections", pass: 25 },
    ]);
    expect(html).toContain('class="barrow eng"');
    expect(html).toContain("domain-core<span>engine</span>");
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:25%"');
    expect(html).toContain('<div class="val tnum">25</div>');
  });
  it("does not divide by zero when every count is zero", () => {
    expect(renderBars([{ label: "x", sub: "y", pass: 0 }])).toContain('style="width:0%"');
  });
  it("tolerates a missing sub", () => {
    expect(renderBars([{ label: "x", pass: 1 }])).toContain("x<span></span>");
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

describe("renderTiles", () => {
  it("renders a tile per entry with variant class and escaped value/label", () => {
    const html = renderTiles([
      { value: 287, label: "tests passing", variant: "accent" },
      { value: 39, label: "files & <stuff>" },
    ]);
    expect(html).toContain('<div class="tile accent"><div class="n tnum">287</div>');
    expect(html).toContain("files &amp; &lt;stuff&gt;");
  });
});

describe("renderCallouts", () => {
  it("tints info callouts and passes trusted html through", () => {
    const html = renderCallouts([
      { kind: "info", heading: "Deep", html: "the <b>engine</b>" },
      { kind: "", heading: "Gaps", html: "scaffolds" },
    ]);
    expect(html).toContain('<div class="callout info"><h4>Deep</h4><p>the <b>engine</b></p></div>');
    expect(html).toContain('<div class="callout"><h4>Gaps</h4><p>scaffolds</p></div>');
  });
});

describe("renderSection", () => {
  it("wraps a body with title and optional meta", () => {
    const html = renderSection({ title: "Test suite", meta: "live", body: "<p>x</p>" });
    expect(html).toContain("<h2>Test suite</h2>");
    expect(html).toContain('<span class="k">live</span>');
    expect(html).toContain("<p>x</p>");
  });
  it("omits the meta span when meta is absent", () => {
    const html = renderSection({ title: "T", body: "b" });
    expect(html).not.toContain('class="k"');
  });
});

describe("fillTemplate", () => {
  it("substitutes known tokens and leaves unknown ones visible", () => {
    expect(fillTemplate("a={{A}} b={{B}} c={{MISSING}}", { A: 1, B: "x" })).toBe(
      "a=1 b=x c={{MISSING}}",
    );
  });
  it("does not re-escape HTML-valued tokens (trusted)", () => {
    expect(fillTemplate("{{BARS}}", { BARS: '<div class="barrow"></div>' })).toBe(
      '<div class="barrow"></div>',
    );
  });
});
