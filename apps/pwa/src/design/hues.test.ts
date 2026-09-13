import { describe, expect, it } from "vitest";
import { HUE_CLASSES, hueClassForInitials } from "./hues.js";

describe("student hue map (design §E.2)", () => {
  it("maps the six known synthetic students to their fixed hue", () => {
    expect(hueClassForInitials("AB")).toBe("ab");
    expect(hueClassForInitials("CD")).toBe("cd");
    expect(hueClassForInitials("EF")).toBe("ef");
    expect(hueClassForInitials("GH")).toBe("gh");
    expect(hueClassForInitials("JM")).toBe("jm");
    expect(hueClassForInitials("RT")).toBe("rt");
  });

  it("is case-insensitive", () => {
    expect(hueClassForInitials("ab")).toBe("ab");
  });

  it("falls back deterministically for unknown initials (independent hash values)", () => {
    // sum("ZZ") = ((90)*31 + 90) = 2880; 2880 % 6 = 0 → HUE_CLASSES[0] = "ab"
    expect(hueClassForInitials("ZZ")).toBe("ab");
    // sum("XY") = ((88)*31 + 89) = 2817; 2817 % 6 = 3 → HUE_CLASSES[3] = "gh"
    expect(hueClassForInitials("XY")).toBe("gh");
  });

  it("is stable across calls (never random/per-render)", () => {
    expect(hueClassForInitials("QW")).toBe(hueClassForInitials("QW"));
  });

  it("always returns a valid palette class", () => {
    for (const s of ["AB", "ZZ", "QW", "MN", "PL"]) {
      expect(HUE_CLASSES).toContain(hueClassForInitials(s));
    }
  });
});
