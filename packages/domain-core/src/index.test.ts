import { describe, expect, it } from "vitest";
import { compareCodePoints } from "./index.js";

// Smoke test — proves the vitest wiring is live from day one so the first real
// domain module (M4 instructional-weeks) arrives into a green harness.
describe("domain-core scaffold", () => {
  it("compareCodePoints orders deterministically by code point", () => {
    expect(compareCodePoints("a", "b")).toBe(-1);
    expect(compareCodePoints("b", "a")).toBe(1);
    expect(compareCodePoints("a", "a")).toBe(0);
    expect([..."cab"].sort(compareCodePoints).join("")).toBe("abc");
  });
});
