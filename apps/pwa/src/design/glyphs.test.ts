import { describe, expect, it } from "vitest";
import { chipForDashboardState, STATUS_CHIPS } from "./glyphs.js";

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

  it("maps each dashboard state to the right chip", () => {
    expect(chipForDashboardState("has_point")).toEqual({ glyph: "●", className: "logged" });
    expect(chipForDashboardState("documented_no_data")).toEqual({
      glyph: "⊘",
      className: "nodata",
    });
    expect(chipForDashboardState("owes")).toEqual({ glyph: "○", className: "owes" });
  });
});
