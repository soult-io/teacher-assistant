import { describe, expect, it } from "vitest";
import { normalizeInitials } from "./index.js";

// Synthetic initials only — never real student data.
describe("normalizeInitials (TEACH-40, data-model §1.2: 2–3 letters only)", () => {
  it.each([
    ["AB", "AB"],
    ["JAS", "JAS"],
    ["ab", "AB"],
    ["j.a.s.", "JAS"],
    ["J. M. S.", "JMS"],
    ["  cd  ", "CD"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(normalizeInitials(raw)).toBe(expected);
  });

  it.each([
    ["full name", "John Smith"],
    ["one letter", "J"],
    ["four letters", "ABCD"],
    ["many letters", "Jonathan"],
    ["digits", "A1"],
    ["only digits", "123"],
    ["empty", ""],
    ["only dots and spaces", ". . ."],
    ["hyphen", "A-B"],
    ["non-ASCII letter", "ÉL"],
    ["letter that upper-cases to ASCII", "ßa"],
    ["ligature", "ﬁx"],
  ])("rejects %s (%j)", (_label, raw) => {
    expect(normalizeInitials(raw)).toBeUndefined();
  });
});
