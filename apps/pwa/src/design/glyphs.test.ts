import { describe, expect, it } from "vitest";
import { chipForDashboardState, SCORE_LATER, STATUS_CHIPS } from "./glyphs.js";

describe("status glyphs (design §E)", () => {
  it("uses the settled TRACK glyph set", () => {
    expect(STATUS_CHIPS.logged.glyph).toBe("●");
    expect(STATUS_CHIPS.owes.glyph).toBe("○");
    expect(STATUS_CHIPS.nodata.glyph).toBe("⊘");
    expect(STATUS_CHIPS.mastery.glyph).toBe("★");
    expect(STATUS_CHIPS.pending.glyph).toBe("⏳");
    expect(STATUS_CHIPS.incomplete.glyph).toBe("◐");
    expect(STATUS_CHIPS.queued.glyph).toBe("◷");
  });

  it("score-later is a clock, distinct from every status glyph (TEACH-47)", () => {
    expect(SCORE_LATER.glyph).toBe("🕐");
    expect(SCORE_LATER.label).toBe("Collected — score later");
    // Not ⏳ (para pending) and not ◷ (queued) — nor any other status glyph.
    const statusGlyphs: readonly string[] = Object.values(STATUS_CHIPS).map((c) => c.glyph);
    expect(statusGlyphs).not.toContain(SCORE_LATER.glyph);
  });

  it("maps each dashboard state to the right chip", () => {
    expect(chipForDashboardState("has_point")).toEqual({ glyph: "●", className: "logged" });
    expect(chipForDashboardState("documented_no_data")).toEqual({
      glyph: "⊘",
      className: "nodata",
    });
    expect(chipForDashboardState("owes")).toEqual({ glyph: "○", className: "owes" });
  });
});
