// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  compareDisplayText,
  compareNumberAware,
  compareOptionalText,
  compareStudentGoal,
  type StudentGoalSortKey,
} from "./display-order.js";

const sorted = (xs: readonly string[], cmp: (a: string, b: string) => number) => [...xs].sort(cmp);

describe("compareDisplayText", () => {
  it("orders case-insensitively (a lowercase goal does not sink below Z)", () => {
    expect(sorted(["Two-step", "add integers", "Zeros"], compareDisplayText)).toEqual([
      "add integers",
      "Two-step",
      "Zeros",
    ]);
  });

  it("ignores surrounding whitespace for the primary key", () => {
    expect(sorted(["  beta", "alpha "], compareDisplayText)).toEqual(["alpha ", "  beta"]);
  });

  it("breaks a case-only tie by raw code point, so the order is total", () => {
    expect(compareDisplayText("ab", "AB")).toBeGreaterThan(0);
    expect(compareDisplayText("AB", "ab")).toBeLessThan(0);
    expect(sorted(["ab", "AB", "Ab"], compareDisplayText)).toEqual(["AB", "Ab", "ab"]);
  });

  it("returns 0 only for identical text", () => {
    expect(compareDisplayText("Add integers", "Add integers")).toBe(0);
    expect(compareDisplayText("Add integers", "Add integers ")).not.toBe(0);
  });
});

describe("compareOptionalText", () => {
  it("sorts a missing value last", () => {
    const xs: (string | null)[] = [null, "P4", "p2", null];
    expect([...xs].sort(compareOptionalText)).toEqual(["p2", "P4", null, null]);
  });

  it("treats two missing values as a tie", () => {
    expect(compareOptionalText(null, null)).toBe(0);
  });
});

describe("compareNumberAware", () => {
  it('sorts "Period 2" before "Period 10"', () => {
    expect(sorted(["Period 10", "Period 2", "Period 1"], compareNumberAware)).toEqual([
      "Period 1",
      "Period 2",
      "Period 10",
    ]);
  });

  it("compares digit runs numerically without Number precision loss", () => {
    expect(compareNumberAware("P99999999999999999999", "P100000000000000000000")).toBeLessThan(0);
  });

  it("is case-insensitive on the text runs", () => {
    expect(sorted(["period 3", "Period 2", "PERIOD 1"], compareNumberAware)).toEqual([
      "PERIOD 1",
      "Period 2",
      "period 3",
    ]);
  });

  it("orders a label that is a prefix of another first", () => {
    expect(sorted(["P2b", "P2", "Pa"], compareNumberAware)).toEqual(["P2", "P2b", "Pa"]);
  });

  it("breaks equal-value ties (leading zeros, case) deterministically", () => {
    expect(compareNumberAware("P02", "P2")).not.toBe(0);
    expect(compareNumberAware("P02", "P2")).toBe(-compareNumberAware("P2", "P02"));
    expect(compareNumberAware("p2", "P2")).toBeGreaterThan(0);
  });
});

describe("compareStudentGoal", () => {
  const key = (k: Partial<StudentGoalSortKey>): StudentGoalSortKey => ({
    initials: "AB",
    periodLabel: "P2",
    studentId: "s-1",
    goalText: "Add integers",
    ...k,
  });

  it("orders initials, then period (none last), then studentId, then goal text", () => {
    const rows = [
      key({ goalText: "two-step equations" }),
      key({ goalText: "Add integers" }),
      key({ initials: "ab", studentId: "s-0" }), // case-only tie on initials → raw tiebreak
      key({ periodLabel: null, studentId: "s-0" }),
      key({ studentId: "s-2", goalText: "Aardvark" }),
      key({ initials: "CD", goalText: "Aardvark" }),
    ];
    expect([...rows].sort(compareStudentGoal)).toEqual([
      key({ goalText: "Add integers" }),
      key({ goalText: "two-step equations" }),
      key({ studentId: "s-2", goalText: "Aardvark" }),
      key({ periodLabel: null, studentId: "s-0" }),
      key({ initials: "ab", studentId: "s-0" }),
      key({ initials: "CD", goalText: "Aardvark" }),
    ]);
  });
});
